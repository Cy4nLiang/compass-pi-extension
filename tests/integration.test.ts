import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, symlink, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarketCsv } from "../csv.ts";
import { DEFAULT_STRATEGY_YAML } from "../defaults.ts";
import { estimateProfit, normalizeProfitInput } from "../economics.ts";
import {
	configureBudget,
	createLead,
	ensureDefaults,
	generateMarketReport,
	importParsedMarket,
	moveCandidate,
	recordProfitEstimate,
	recordReviewAnalysis,
	recordRisk,
	runStrategy,
	saveStrategyVersion,
	scanMarkets,
} from "../service.ts";
import { CompassRepository, createEmptyStore } from "../store.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("lead can exist before a snapshot and is skipped by market Gate scan", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "test");
	const lead = createLead(store, { marketName: "future clue", keywords: ["seed keyword"], actor: "tester" });
	assert.equal(lead.candidate.stage, "lead");
	assert.equal(store.decisionLog[0].type, "lead");
	assert.deepEqual(scanMarkets(store, {}), []);
});

test("batch scan applies same-cohort percentile normalization", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const weaker = structuredClone(parsed);
	for (const listing of weaker.listings) {
		if (listing.monthlySales !== undefined) listing.monthlySales *= 0.25;
		listing.monthsOnline = (listing.monthsOnline ?? 0) + 24;
	}
	const store = createEmptyStore();
	ensureDefaults(store, "test");
	const strong = importParsedMarket(store, { marketName: "strong market", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	importParsedMarket(store, { marketName: "weak market", parsed: weaker, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	const unsubstantiatedRisk = recordRisk(store, {
		marketRef: strong.market.id,
		certStatus: "pass",
		ipRiskLevel: "pass",
		seasonFlag: "clear",
		policyFlag: "clear",
		logisticsRisk: "pass",
		evidence: [],
		actor: "tester",
	});
	assert.equal(unsubstantiatedRisk.overall, "review");
	assert.match(unsubstantiatedRisk.notes ?? "", /自动降级/);
	const results = scanMarkets(store, { limit: 10 });
	assert.equal(results.length, 2);
	assert.equal(results[0].market.name, "strong market");
	assert.ok(results[0].evaluation.score > results[1].evaluation.score);
	assert.equal(results[0].evaluation.dimensionScores.demand, 100);
	assert.equal(results[1].evaluation.dimensionScores.demand, 0);
});

test("snapshot → economics → review/risk → full GSE → report remains replayable", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-test-"));
	try {
		const repo = new CompassRepository(root);
		const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
		const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });

		const { result } = await repo.update((store) => {
			ensureDefaults(store, "test");
			const imported = importParsedMarket(store, {
				marketName: "yoga mat strap demo",
				parsed,
				capturedAt: "2026-08-22T00:00:00.000Z",
				actor: "tester",
			});
			const screen = runStrategy(store, { marketRef: imported.market.id, mode: "screen", actor: "tester" });
			assert.equal(screen.result.outcome, "pass");

			const profitInput = normalizeProfitInput({
				marketId: imported.market.id,
				salePrice: 25.99,
				purchaseCost: 3.5,
				firstMileCost: 0.9,
				fbaFee: 5.2,
				referralRate: 0.15,
				cvr: 0.12,
				cpc: 0.85,
				portfolioCapital: 20_000,
			});
			recordProfitEstimate(store, profitInput, estimateProfit(profitInput), "tester");
			recordReviewAnalysis(store, {
				marketRef: imported.market.id,
				sourceAsins: ["B0DEMO0007", "B0DEMO0009"],
				reviewCount: 120,
				themes: [{ name: "金属扣滑动", category: "quality", count: 38, fixability: "factory", recommendation: "增加防滑纹" }],
				estimatedRating: 4.4,
				actor: "tester",
			});
			recordRisk(store, {
				marketRef: imported.market.id,
				certStatus: "pass",
				ipRiskLevel: "pass",
				seasonFlag: "clear",
				policyFlag: "clear",
				logisticsRisk: "pass",
				evidence: [{ category: "policy", url: "https://sellercentral.amazon.com/", title: "Amazon policy" }],
				actor: "tester",
			});
			const full = runStrategy(store, { marketRef: imported.market.id, mode: "full", actor: "tester" });
			assert.equal(full.result.outcome, "pass");
			moveCandidate(store, { candidateRef: imported.candidate.id, stage: "deep_research", reason: "粗筛与完整 Gate 均通过", actor: "tester" });
			const report = generateMarketReport(store, imported.market.id);
			assert.match(report.markdown, /罗盘选品报告/);
			assert.match(report.markdown, /决策回放/);
			assert.match(report.markdown, /sellercentral/);
			return { imported, full, report };
		});

		const loaded = await repo.load();
		assert.equal(loaded.markets.length, 1);
		assert.equal(loaded.snapshots.length, 1);
		assert.equal(loaded.snapshots[0].listings.length, parsed.listings.length);
		assert.ok(loaded.snapshots[0].dataFile?.endsWith(".json"));
		const persisted = JSON.parse(await readFile(repo.storePath, "utf8")) as { snapshots: Array<{ listings: unknown[] }> };
		assert.equal(persisted.snapshots[0].listings.length, 0);
		assert.equal(loaded.strategyRuns.length, 2);
		assert.ok(loaded.decisionLog.length >= 7);
		assert.equal(loaded.candidates[0].stage, "deep_research");
		assert.ok(loaded.decisionLog.find((decision) => decision.type === "stage_move")?.strategyVersion);
		assert.equal(result.full.result.outcome, "pass");
		assert.equal(result.report.snapshotId, result.imported.snapshot.id);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("lead markets can record profit, review, and risk evidence without a snapshot", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const lead = createLead(store, { marketName: "no snapshot market", actor: "tester" });
	const input = normalizeProfitInput({ marketId: lead.market.id, salePrice: 20, purchaseCost: 4, fbaFee: 5, cpc: 0.5 });
	const estimate = recordProfitEstimate(store, input, estimateProfit(input), "tester");
	const analysis = recordReviewAnalysis(store, {
		marketRef: lead.market.id,
		sourceAsins: [],
		reviewCount: 0,
		themes: [{ name: "unknown", category: "other", count: 0, fixability: "unknown" }],
		actor: "tester",
	});
	const risk = recordRisk(store, {
		marketRef: lead.market.id,
		certStatus: "pass",
		ipRiskLevel: "pass",
		seasonFlag: "clear",
		policyFlag: "clear",
		logisticsRisk: "pass",
		evidence: [],
		actor: "tester",
	});
	assert.equal(estimate.marketId, lead.market.id);
	assert.equal(analysis.marketId, lead.market.id);
	assert.equal(risk.overall, "review");
	assert.ok(store.decisionLog.every((decision) => decision.snapshotId === undefined));
});

test("yellow risk evidence remains review under the default strategy", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const imported = importParsedMarket(store, { marketName: "yellow risk market", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	recordRisk(store, {
		marketRef: imported.market.id,
		certStatus: "review",
		ipRiskLevel: "review",
		seasonFlag: "strong",
		policyFlag: "review",
		logisticsRisk: "review",
		evidence: [],
		actor: "tester",
	});
	const run = runStrategy(store, { marketRef: imported.market.id, mode: "full", actor: "tester" });
	assert.equal(run.result.outcome, "review");
	assert.equal(run.result.rules.find((rule) => rule.id === "risk_evidence_complete")?.status, "review");
	assert.equal(run.result.rules.find((rule) => rule.id === "seasonality")?.status, "review");
	assert.equal(run.result.rules.find((rule) => rule.id === "certification")?.status, "review");
	assert.equal(run.result.rules.find((rule) => rule.id === "policy_edge")?.status, "review");
});

test("budget configure is a partial update and does not re-enable a disabled source", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const before = store.budgetPools.find((pool) => pool.source === "rainforest");
	assert.equal(before?.enabled, false);
	const after = configureBudget(store, { source: "rainforest", monthlyLimitCny: 500 });
	assert.equal(after.enabled, false);
	assert.equal(after.note, before?.note);
});

test("report labels QRD with the active strategy threshold", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const imported = importParsedMarket(store, { marketName: "dynamic qrd market", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	saveStrategyVersion(store, { yaml: DEFAULT_STRATEGY_YAML.replace("monthly_units_q: 300", "monthly_units_q: 500"), actor: "tester" });
	const report = generateMarketReport(store, imported.market.id);
	assert.match(report.markdown, /QRD\(500\)/);
});

test("corrupted store elements fail with a path-aware diagnostic", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-corrupt-"));
	try {
		const repo = new CompassRepository(root);
		const invalid = { ...createEmptyStore(), candidates: [null] };
		await mkdir(dirname(repo.storePath), { recursive: true });
		await writeFile(repo.storePath, JSON.stringify(invalid), "utf8");
		await assert.rejects(repo.load(), /store\.json.*candidates\[0\]/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("invalid store mutations are rejected before persistence", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-write-validation-"));
	try {
		const repo = new CompassRepository(root);
		await assert.rejects(
			repo.update((store) => {
				store.markets.push({ id: "m", name: "", keywords: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
			}),
			/markets\[0\]\.name/,
		);
		assert.equal((await repo.load()).markets.length, 0);
		assert.throws(() => createLead(createEmptyStore(), { marketName: " ", actor: "tester" }), /市场名称不能为空/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("missing snapshot sidecars degrade to explicit missing-data warnings", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-sidecar-"));
	try {
		const repo = new CompassRepository(root);
		const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
		const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
		await repo.update((store) => {
			ensureDefaults(store, "tester");
			importParsedMarket(store, { marketName: "sidecar market", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
		});
		const metadata = JSON.parse(await readFile(repo.storePath, "utf8")) as { snapshots: Array<{ dataFile?: string }> };
		assert.ok(metadata.snapshots[0].dataFile);
		await rm(join(root, metadata.snapshots[0].dataFile as string), { force: true });
		const loaded = await repo.load();
		assert.equal(loaded.snapshots[0].listings.length, 0);
		assert.match(loaded.snapshots[0].warnings.at(-1) ?? "", /明细文件缺失或损坏/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("stale lock files owned by dead processes are reclaimed", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-stale-lock-"));
	try {
		const repo = new CompassRepository(root);
		await mkdir(repo.dataDir, { recursive: true });
		await writeFile(repo.lockPath, "999999999\nold-token\n", "utf8");
		const old = new Date(Date.now() - 60_000);
		await utimes(repo.lockPath, old, old);
		await repo.update((store) => {
			store.markets.push({ id: "recovered", name: "recovered", keywords: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
		});
		assert.equal((await repo.load()).markets[0].id, "recovered");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("repository serializes concurrent updates and rejects report path escapes", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-concurrency-"));
	const outside = await mkdtemp(join(tmpdir(), "compass-outside-"));
	try {
		const a = new CompassRepository(root);
		const b = new CompassRepository(root);
		const makeMarket = (id: string) => ({ id, name: id, keywords: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
		await Promise.all([
			a.update(async (store) => {
				await new Promise((resolve) => setTimeout(resolve, 25));
				store.markets.push(makeMarket("a"));
			}),
			b.update((store) => {
				store.markets.push(makeMarket("b"));
			}),
		]);
		assert.deepEqual((await a.load()).markets.map((market) => market.id).sort(), ["a", "b"]);
		assert.throws(() => a.resolveOutputPath("README.md"), /reports/);
		await mkdir(join(root, ".pi", "compass"), { recursive: true });
		await symlink(join(outside, "reports"), join(root, ".pi", "compass", "reports"));
		assert.throws(() => a.resolveOutputPath(), /reports/);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

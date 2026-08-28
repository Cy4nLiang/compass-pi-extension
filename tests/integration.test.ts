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
	backtestStrategies,
	configureBudget,
	createLead,
	decideCandidate,
	ensureDefaults,
	generateMarketReport,
	importMarketAndScreen,
	importParsedMarket,
	moveCandidate,
	recordProfitEstimate,
	recordRetroActuals,
	recordReviewAnalysis,
	recordRisk,
	runStrategy,
	saveLesson,
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
			decideCandidate(store, { candidateRef: imported.candidate.id, status: "go", reason: "完整 Gate 通过，利润与风险证据已复核", actor: "tester" });
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
		assert.equal(loaded.candidates[0].decisionStatus, "go");
		assert.match(loaded.candidates[0].decisionReason ?? "", /Gate 通过/);
		assert.match(loaded.candidates[0].gateReason ?? "", /规则通过/);
		assert.equal(loaded.candidates[0].stageReason, "粗筛与完整 Gate 均通过");
		assert.ok(loaded.decisionLog.find((decision) => decision.type === "stage_move")?.strategyVersion);
		assert.equal(loaded.decisionLog.find((decision) => decision.type === "decision")?.decisionStatus, "go");
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

test("automatic retro closes no_go replay branches, actuals, lessons, report, and backtest", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const oldMarket = structuredClone(parsed);
	for (const listing of oldMarket.listings) {
		listing.monthsOnline = 24;
		listing.launchDate = undefined;
	}
	const improved = structuredClone(parsed);
	for (const listing of improved.listings) {
		listing.monthsOnline = 1;
		listing.launchDate = undefined;
	}
	const missing = structuredClone(parsed);
	for (const listing of missing.listings) {
		listing.monthsOnline = undefined;
		listing.launchDate = undefined;
	}
	const store = createEmptyStore();
	ensureDefaults(store, "tester");

	const seedNoGo = (name: string) => {
		const baseline = importMarketAndScreen(store, { marketName: name, parsed: structuredClone(oldMarket), capturedAt: "2026-01-01T00:00:00.000Z", actor: "tester" });
		assert.equal(baseline.screenRun?.result.outcome, "reject");
		decideCandidate(store, { candidateRef: baseline.candidate.id, status: "no_go", reason: "新品占比未达门槛", actor: "tester" });
		return baseline;
	};

	const challengedBase = seedNoGo("retro challenged");
	const challenged = importMarketAndScreen(store, { marketName: challengedBase.market.name, parsed: structuredClone(improved), capturedAt: "2026-01-11T00:00:00.000Z", actor: "tester" }).outcomeCheck;
	assert.equal(challenged?.verdict, "challenged");

	const validatedBase = seedNoGo("retro validated");
	const validated = importMarketAndScreen(store, { marketName: validatedBase.market.name, parsed: structuredClone(oldMarket), capturedAt: "2026-01-11T00:00:00.000Z", actor: "tester" }).outcomeCheck;
	assert.equal(validated?.verdict, "validated");

	const inconclusiveBase = seedNoGo("retro inconclusive");
	const inconclusive = importMarketAndScreen(store, { marketName: inconclusiveBase.market.name, parsed: structuredClone(missing), capturedAt: "2026-01-11T00:00:00.000Z", actor: "tester" }).outcomeCheck;
	assert.equal(inconclusive?.verdict, "inconclusive");

	const go = importMarketAndScreen(store, { marketName: "retro go actuals", parsed: structuredClone(improved), capturedAt: "2026-01-01T00:00:00.000Z", actor: "tester" });
	decideCandidate(store, { candidateRef: go.candidate.id, status: "go", reason: "粗筛通过并批准测试", actor: "tester" });
	const actuals = recordRetroActuals(store, { candidateRef: go.candidate.id, actuals: { dailyUnits: 8, tacos: 0.15, returnRate: 0.04, netMargin: 0.08 }, actor: "tester" });
	assert.equal(actuals.verdict, "validated");
	assert.throws(() => saveLesson(store, { title: "无证据", detail: "不允许", evidence: [], actor: "tester" }), /evidence/);
	const lesson = saveLesson(store, { title: "新品占比回升后需重评", detail: "no_go 的活动度前提翻转时先重跑 Gate", scope: { keywords: ["retro"] }, evidence: [challenged!.id], actor: "tester" });
	assert.equal(lesson.status, "active");
	assert.equal(store.decisionLog.at(-1)?.type, "retro");
	const report = generateMarketReport(store, challengedBase.market.id);
	assert.match(report.markdown, /## 9\. 历史与复盘/);
	assert.match(report.markdown, new RegExp(challenged!.id));

	const strategyV1 = `meta:\n  name: retro-threshold\n  display_name: Retro Threshold\nstages:\n  - stage: market_screen\n    rules:\n      - id: activity\n        when: "new_listing_share_12m >= 0.15"\n        action: require\n        label: activity\nscoring:\n  weights:\n    demand: 1\n`;
	const strategyV2 = strategyV1.replace(">= 0.15", ">= 0.0");
	saveStrategyVersion(store, { yaml: strategyV1, actor: "tester" });
	saveStrategyVersion(store, { yaml: strategyV2, actor: "tester" });
	const backtest = backtestStrategies(store, "retro-threshold@v2", "retro-threshold@v1");
	assert.ok(backtest.flips.some((row) => row.baselineOutcome === "reject" && row.strategyOutcome === "pass"));
	assert.equal(backtest.matrix["reject→pass"] >= 1, true);
});

test("identical file hashes are rejected before duplicate snapshots pollute history", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	importParsedMarket(store, { marketName: "duplicate market", parsed, capturedAt: "2026-01-01T00:00:00.000Z", fileHash: "same-hash", actor: "tester" });
	assert.throws(() => importParsedMarket(store, { marketName: "duplicate market", parsed, capturedAt: "2026-02-01T00:00:00.000Z", fileHash: "same-hash", actor: "tester" }), /重复 CSV/);
	assert.equal(store.snapshots.length, 1);
});

test("legacy schemaVersion 1 stores gain retro collections and write them back lazily", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-retro-migration-"));
	try {
		const repo = new CompassRepository(root);
		const legacy = createEmptyStore() as unknown as Record<string, unknown>;
		delete legacy.outcomeChecks;
		delete legacy.lessons;
		await mkdir(dirname(repo.storePath), { recursive: true });
		await writeFile(repo.storePath, JSON.stringify(legacy), "utf8");
		const loaded = await repo.load();
		assert.deepEqual(loaded.outcomeChecks, []);
		assert.deepEqual(loaded.lessons, []);
		await repo.update(() => false, { shouldSave: () => false });
		const persisted = JSON.parse(await readFile(repo.storePath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(persisted.outcomeChecks, []);
		assert.deepEqual(persisted.lessons, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("legacy schemaVersion 1 stores gain todoResolutions and write them back lazily", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-todo-resolution-migration-"));
	try {
		const repo = new CompassRepository(root);
		const legacy = createEmptyStore() as unknown as Record<string, unknown>;
		delete legacy.todoResolutions;
		await mkdir(dirname(repo.storePath), { recursive: true });
		await writeFile(repo.storePath, JSON.stringify(legacy), "utf8");
		const loaded = await repo.load();
		assert.deepEqual(loaded.todoResolutions, []);
		await repo.update(() => false, { shouldSave: () => false });
		const persisted = JSON.parse(await readFile(repo.storePath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(persisted.todoResolutions, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("todo resolutions survive a full save/load round-trip", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-todo-resolution-roundtrip-"));
	try {
		const repo = new CompassRepository(root);
		const store = createEmptyStore("2026-08-01T00:00:00.000Z");
		ensureDefaults(store, "tester");
		store.todoResolutions = [{
			id: "tdr_roundtrip",
			todoId: "todo_budget_fused_sorftime",
			kind: "budget_fused",
			source: "sorftime",
			titleSnapshot: "预算熔断：sorftime",
			status: "resolved",
			attempts: [{
				submittedAt: "2026-08-01T00:00:00.000Z",
				submittedBy: "compass-web",
				note: "本月接受停摆，不提额",
				evidence: [{ ref: "compass-imports/budget-2026-08.md", note: "月度用量说明" }],
				verdict: "pass",
				verdictReason: "决定明确且给出理由",
				verifiedAt: "2026-08-02T00:00:00.000Z",
				verifiedBy: "compass-agent",
			}],
			reopens: [],
			resolvedAt: "2026-08-02T01:00:00.000Z",
			resolvedBy: "compass-web",
			basis: { month: "2026-08" },
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-02T01:00:00.000Z",
		}];
		await repo.save(store);
		const loaded = await repo.load();
		assert.deepEqual(loaded.todoResolutions, store.todoResolutions);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
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

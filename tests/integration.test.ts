import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, stat, symlink, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarketCsv } from "../csv.ts";
import { outcomeStatistics } from "../history.ts";
import { DEFAULT_STRATEGY_ID, DEFAULT_STRATEGY_YAML } from "../defaults.ts";
import { estimateProfit, normalizeProfitInput } from "../economics.ts";
import {
	backtestStrategies,
	buildStrategyContext,
	cloneStrategy,
	configureBudget,
	createLead,
	decideCandidate,
	ensureDefaults,
	evaluateMarketWithoutPersisting,
	findStrategyVersion,
	gateDefaultsLine,
	generateMarketReport,
	generateRetroReport,
	importMarketAndScreen,
	importParsedMarket,
	latestStrategy,
	latestStrategyIfPresent,
	listRetroDue,
	listStrategies,
	listWorkbenchTodos,
	metricDivergences,
	mainCpcForMarket,
	resolveProfitCpc,
	moveCandidate,
	recordProfitEstimate,
	recordRetroActuals,
	recordReviewAnalysis,
	recordRisk,
	runStrategy,
	saveLesson,
	saveStrategyVersion,
	scanMarkets,
	targetMonthlyUnits,
} from "../service.ts";
import { CompassRepository, createEmptyStore } from "../store.ts";
import type { CompassStore, MarketSnapshot } from "../types.ts";

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

// —— 审计 M103 回归：emptySnapshotPayload 白名单漏登记 → save 静默抹掉 ——
// store.ts 的 emptySnapshotPayload 是「逐字段显式拷贝」的白名单（不是 spread）。
// 给 MarketSnapshot 加了字段却忘了登记，save 会把它悄悄丢掉：不抛错、不告警，
// assertStore 也管不着（它只校验 id/marketId/source/capturedAt/importedAt/
// listings/keywords/metrics/warnings/dataFile）。下面两层断言是这条坑的回归网。
const SNAPSHOT_REQUIRED_KEYS = [
	"id",
	"marketId",
	"source",
	"capturedAt",
	"importedAt",
	"rowCount",
	"listings",
	"keywords",
	"metrics",
	"warnings",
] as const;
// 可选键 = emptySnapshotPayload 末尾那几行 `if (x !== undefined)`。
// 新增一个持久化字段时必须同时改 store.ts 的白名单和这里；本用例变红就是在提醒别漏前者。
const SNAPSHOT_OPTIONAL_KEYS = ["fileName", "archivedFile", "fileHash", "dataFile"] as const;
const SNAPSHOT_WHITELIST_KEYS = new Set<string>([...SNAPSHOT_REQUIRED_KEYS, ...SNAPSHOT_OPTIONAL_KEYS]);

// JSON 落盘不保留 undefined（importParsedMarket 会显式写 fileName: undefined，
// metrics 里的 evidence() 会写 note: undefined），逐层剔掉，免得和真正的字段丢失混为一谈。
function withoutUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutUndefined);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, item]) => item !== undefined)
				.map(([key, item]) => [key, withoutUndefined(item)]),
		);
	}
	return value;
}

// listings/keywords 在 load 后被 installLazySnapshotData 换成**不可枚举**的 getter，
// dataFile 又是 save 现场生成的，三者直接进 deepEqual 必然误红；而且读 listings/keywords
// 会触发 sidecar 懒加载，本用例不该有这个副作用（Object.entries 只看可枚举键，不碰 getter）。
function comparableSnapshot(snapshot: MarketSnapshot): Record<string, unknown> {
	const lazyKeys = new Set(["listings", "keywords", "dataFile"]);
	const shallow = Object.fromEntries(Object.entries(snapshot).filter(([key]) => !lazyKeys.has(key)));
	return withoutUndefined(shallow) as Record<string, unknown>;
}

function assertSnapshotKeyShape(persistedSnapshot: Record<string, unknown>): void {
	const keys = new Set(Object.keys(persistedSnapshot));
	// 下界：必备键一个都不能少
	for (const key of SNAPSHOT_REQUIRED_KEYS) {
		assert.ok(keys.has(key), `store.json 快照缺少必备键 ${key}`);
	}
	// 上界：不允许出现白名单之外的键
	for (const key of keys) {
		assert.ok(
			SNAPSHOT_WHITELIST_KEYS.has(key),
			`store.json 快照出现未登记的键 ${key}：请同步 store.ts 的 emptySnapshotPayload 与本用例白名单`,
		);
	}
	// 明细只进 sidecar，store.json 里恒为空数组
	assert.deepEqual(persistedSnapshot.listings, []);
	assert.deepEqual(persistedSnapshot.keywords, []);
	assert.equal(typeof persistedSnapshot.dataFile, "string");
}

test("快照 save/load 保住每个已登记字段，落盘键集合钉在 emptySnapshotPayload 白名单内", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-snapshot-payload-"));
	try {
		const repo = new CompassRepository(root);
		const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
		const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
		const store = createEmptyStore("2026-08-01T00:00:00.000Z");
		ensureDefaults(store, "tester");
		// 第一条：三个可选字段全给值，把 emptySnapshotPayload 的 if 分支都走到
		const full = importParsedMarket(store, {
			marketName: "snapshot payload market",
			parsed,
			capturedAt: "2026-08-22T00:00:00.000Z",
			fileName: "demo-market.csv",
			archivedFile: ".pi/compass/raw/2026-08-22-demo-market.csv",
			fileHash: "hash-round-trip",
			actor: "tester",
		});
		// 第二条：一个可选字段都不给（手工/MCP 导入的常见形态），验证键集合断言不会误红
		const bare = importParsedMarket(store, {
			marketName: "snapshot payload bare market",
			parsed,
			capturedAt: "2026-08-23T00:00:00.000Z",
			actor: "tester",
		});
		const expected = new Map([
			[full.snapshot.id, comparableSnapshot(structuredClone(full.snapshot))],
			[bare.snapshot.id, comparableSnapshot(structuredClone(bare.snapshot))],
		]);

		await repo.save(store);
		const loaded = await repo.load();
		assert.equal(loaded.snapshots.length, 2);

		// ① 值层面：导入时挂在快照上的字段，load 回来必须一个不少。
		//    漏登记进白名单的字段会在这里消失 → 红。
		for (const snapshot of loaded.snapshots) {
			assert.deepEqual(comparableSnapshot(snapshot), expected.get(snapshot.id));
		}
		// metrics 是整体透传，MetricEvidence 上的可选字段（如 targetMonthlyUnits）不受白名单约束
		const roundTripped = loaded.snapshots.find((snapshot) => snapshot.id === full.snapshot.id);
		assert.equal(roundTripped?.metrics.qualify_rank_depth.targetMonthlyUnits, 300);
		assert.equal(roundTripped?.metrics.low_rating_high_sales_count.targetMonthlyUnits, 300);

		// ② 键集合层面：落盘形状 ⊇ 必备键 且 ⊆ 白名单键。
		//    下界抓「必备字段被拿掉」，上界抓「白名单被悄悄放宽 / 新字段没同步过来」；
		//    中间留给可选字段——所以 bare 快照没有 fileName 也不会红。
		const persisted = JSON.parse(await readFile(repo.storePath, "utf8")) as { snapshots: Record<string, unknown>[] };
		assert.equal(persisted.snapshots.length, 2);
		for (const persistedSnapshot of persisted.snapshots) assertSnapshotKeyShape(persistedSnapshot);
		const bareKeys = new Set(Object.keys(persisted.snapshots.find((item) => item.id === bare.snapshot.id) ?? {}));
		for (const key of ["fileName", "archivedFile", "fileHash"]) assert.equal(bareKeys.has(key), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// 这条守的是 ESRCH 分支：mtime 只有 60 秒，早于 STALE_LOCK_MAX_AGE_MS（5 分钟），
// 所以它**只能**靠「pid 确定已死 → 立即回收」通过。删掉 store.ts 里那句
// `if (…code === "ESRCH") stale = true;` 本用例会空转满 10 秒抢锁兜底后失败。
// 将来若再调 STALE_LOCK_MAX_AGE_MS，注意别把这条的 mtime 一起改大而让它退化成 mtime 判据。
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


// —— 审计 M21 回归 ——
test("存量快照 main_cpc 为 0 时不再被当作默认主词 CPC", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "test");
	const lead = createLead(store, { marketName: "zero cpc market", keywords: ["zero cpc"], actor: "tester" });
	const at = "2026-08-22T00:00:00.000Z";
	store.snapshots.push({
		id: "snap_zero_cpc",
		marketId: lead.market.id,
		source: "sorftime",
		capturedAt: at,
		importedAt: at,
		rowCount: 1,
		listings: [],
		keywords: [],
		metrics: { main_cpc: { value: 0, source: "sorftime", capturedAt: at, confidence: 0.82, sampleSize: 3 } },
		warnings: [],
	});
	assert.equal(mainCpcForMarket(store, lead.market.id), undefined);
	store.snapshots[0].metrics.main_cpc = { value: 0.85, source: "sorftime", capturedAt: at, confidence: 0.82, sampleSize: 3 };
	assert.equal(mainCpcForMarket(store, lead.market.id), 0.85);
});

// —— 审计 M21 后续：运营填 cpc=0 与不填同义 ——
test("利润测算的主词 CPC 回填：填 0 与不填走同一条路径", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "test");
	const parsed = parseMarketCsv(
		[
			"ASIN,商品标题,排名,价格,月销量,关键词,月搜索量,建议CPC",
			"B0DEMO0001,Demo A,1,19.99,1250,cpc backfill,30000,0.85",
		].join("\n"),
		{ source: "generic_csv", capturedAt: "2026-09-01T00:00:00.000Z" },
	);
	const imported = importParsedMarket(store, {
		marketName: "CPC 回填市场",
		parsed,
		capturedAt: "2026-09-01T00:00:00.000Z",
		actor: "tester",
	});
	const marketId = imported.market.id;
	assert.equal(mainCpcForMarket(store, marketId), 0.85);

	// 不填与填 0 都回落到市场主词 CPC；填了正数则以运营的输入为准。
	assert.equal(resolveProfitCpc(store, marketId, undefined), 0.85);
	assert.equal(resolveProfitCpc(store, marketId, 0), 0.85);
	assert.equal(resolveProfitCpc(store, marketId, 1.2), 1.2);

	// 市场没有可用主词 CPC 时保留运营原样填的 0，让利润测算给出「CPC 为 0，按缺数据处理」那条更具体的警告。
	const bare = createEmptyStore();
	ensureDefaults(bare, "test");
	const bareLead = createLead(bare, { marketName: "无快照市场", keywords: ["none"], actor: "tester" });
	assert.equal(resolveProfitCpc(bare, bareLead.market.id, 0), 0);
	assert.equal(resolveProfitCpc(bare, bareLead.market.id, undefined), undefined);
});


// —— 审计 M105 回归：单市场 scan 保留有界基准分 ——
// 不变式：percentile 归一化只在**同批 scan 的比较组内**做。比较组只有一行时没有可比对象，
// 必须原样保留策略引擎算出的有界基准分（0–100 的绝对刻度），否则孤市场会被归一化成
// NaN 或恒定分位，Gate 分数失去跨批可比性。
const M105_BOUNDED_SCORES = { demand: 77, competition: 80.5, unit_economics: 50, product: 80, risk: 50 };
const M105_BOUNDED_SCORE = 67.5;

// —— 审计 M105 回归 ——
test("单市场 scan 不做分位数归一化，保留策略引擎的有界基准分", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "test");
	const imported = importParsedMarket(store, { marketName: "solo market", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	// 默认策略 scoring.normalize === "percentile"，所以这条用例走的确实是归一化分支的入口。
	assert.equal(latestStrategy(store).definition.scoring.normalize, "percentile");

	const bounded = evaluateMarketWithoutPersisting(store, imported.market.id, "jingpu-daily10", "screen");
	const results = scanMarkets(store, { limit: 10 });
	assert.equal(results.length, 1);
	// 与引擎直算结果逐维一致：任何把单行也拿去归一化的改动（NaN、恒 50、恒 100）都会在这里红。
	assert.deepEqual(results[0].evaluation.dimensionScores, M105_BOUNDED_SCORES);
	assert.deepEqual(results[0].evaluation.dimensionScores, bounded.dimensionScores);
	assert.equal(results[0].evaluation.score, M105_BOUNDED_SCORE);
	assert.equal(results[0].evaluation.score, bounded.score);
});


// —— 审计 M105 回归 ——
test("percentile 归一化只在同批比较组内做：query 过滤到单行时不归一化", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const weaker = structuredClone(parsed);
	for (const listing of weaker.listings) {
		if (listing.monthlySales !== undefined) listing.monthlySales *= 0.25;
		listing.monthsOnline = (listing.monthsOnline ?? 0) + 24;
	}
	const store = createEmptyStore();
	ensureDefaults(store, "test");
	importParsedMarket(store, { marketName: "solo market", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	importParsedMarket(store, { marketName: "weak other", parsed: weaker, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });

	// 库里有两个市场，但 query 把比较组收窄到一行 → 依旧是有界基准分，不受另一个市场影响。
	const filtered = scanMarkets(store, { query: "solo", limit: 10 });
	assert.equal(filtered.length, 1);
	assert.equal(filtered[0].market.name, "solo market");
	assert.deepEqual(filtered[0].evaluation.dimensionScores, M105_BOUNDED_SCORES);
	assert.equal(filtered[0].evaluation.score, M105_BOUNDED_SCORE);

	// 同一个 store 全量 scan（比较组 2 行）才转成同批分位：同一市场的分数因此不同。
	const batch = scanMarkets(store, { limit: 10 });
	assert.deepEqual(batch.map((row) => row.market.name), ["solo market", "weak other"]);
	assert.deepEqual(batch[0].evaluation.dimensionScores, { demand: 100, competition: 100, unit_economics: 50, product: 100, risk: 50 });
	assert.deepEqual(batch[1].evaluation.dimensionScores, { demand: 0, competition: 0, unit_economics: 50, product: 0, risk: 50 });
	assert.equal(batch[0].evaluation.score, 80);
	assert.equal(batch[1].evaluation.score, 20);
});


// —— 审计 M105 回归 ——
test("runStrategy 落库的 dimensionScores 是有界基准分，且缺失指标照实登记", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "test");
	const imported = importParsedMarket(store, { marketName: "solo market", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });

	const screen = runStrategy(store, { marketRef: imported.market.id, mode: "screen", actor: "tester" });
	assert.equal(screen.result.outcome, "pass");
	assert.deepEqual(screen.result.dimensionScores, M105_BOUNDED_SCORES);
	assert.equal(screen.result.score, M105_BOUNDED_SCORE);
	assert.deepEqual(screen.result.missingMetrics, []);

	// full 模式只多跑规则，不改评分口径：维度分与 screen 完全一致，缺的硬指标全部登记。
	const full = runStrategy(store, { marketRef: imported.market.id, mode: "full", actor: "tester" });
	assert.equal(full.result.outcome, "review");
	assert.deepEqual(full.result.dimensionScores, M105_BOUNDED_SCORES);
	assert.equal(full.result.score, M105_BOUNDED_SCORE);
	assert.deepEqual(full.result.missingMetrics, [
		"capital_share",
		"cert_status",
		"cpc_ratio",
		"est_rating_gap",
		"gross_margin",
		"ip_risk_level",
		"logistics_risk",
		"policy_flag",
		"risk_overall",
		"season_flag",
	]);
	// 落到候选卡上的也是有界分，不是 scan 的同批分位。
	assert.equal(store.candidates.find((candidate) => candidate.marketId === imported.market.id)?.score, M105_BOUNDED_SCORE);
});

// —— 审计 M3/M16/M8 回归 ——
// —— 审计 M3 / M16 回归（服务层） ——
test("saveStrategyVersion 拒绝非法的月销口径，落盘口径与展示口径不再分叉", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	for (const bad of ["monthly_units_q: 3OO", "monthly_units_q: 300个", 'monthly_units_q: "500"', "monthly_units_q: -5", "monthly_units_q: 0"]) {
		assert.throws(
			() => saveStrategyVersion(store, { yaml: DEFAULT_STRATEGY_YAML.replace("monthly_units_q: 300", bad), actor: "tester" }),
			/策略 meta\.monthly_units_q 必须是有限正数/,
			`${bad} 不该被保存`,
		);
	}
	assert.equal(store.strategies.length, 1, "非法版本一条都不该落盘");
	saveStrategyVersion(store, { yaml: DEFAULT_STRATEGY_YAML.replace("monthly_units_q: 300", "monthly_units_q: 500"), actor: "tester" });
	assert.equal(targetMonthlyUnits(store), 500);
});


// —— 审计 M3/M16/M8 回归 ——
test("存量脏 definition 的月销口径回落 300，导入指标与报告标签一致", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	// 绕过 saveStrategyVersion，模拟修复前已经落盘的脏 definition
	store.strategies[0].definition.meta.monthly_units_q = "300个" as unknown as number;
	assert.equal(targetMonthlyUnits(store), 300);
	const imported = importParsedMarket(store, { marketName: "legacy dirty q", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	assert.equal(imported.snapshot.metrics.qualify_rank_depth.value, 22);
	assert.equal(imported.snapshot.metrics.qualify_rank_depth.note, "月销≥300 的 listing 数");
	const report = generateMarketReport(store, imported.market.id);
	assert.match(report.markdown, /QRD\(300\) \| 22 \|/);
});

// —— 审计 M15 回归 ——
test("target monthly units change keeps report label, metric value and rule evidence on one basis", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const imported = importParsedMarket(store, { marketName: "qrd basis market", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	assert.equal(imported.snapshot.metrics.qualify_rank_depth.value, 22);
	assert.equal(imported.snapshot.metrics.qualify_rank_depth.targetMonthlyUnits, 300);
	assert.equal(imported.snapshot.metrics.low_rating_high_sales_count.value, 8);

	// 运营把目标月销从 300 调到 800（meta 与规则表达式一起改）
	saveStrategyVersion(store, {
		yaml: DEFAULT_STRATEGY_YAML
			.replace("monthly_units_q: 300", "monthly_units_q: 800")
			.replace("qualify_rank_depth(300) >= 20", "qualify_rank_depth(800) >= 20"),
		actor: "tester",
	});

	// 读侧按当前 q 重算；store 里的冻结值原样保留作历史留档
	const { context } = buildStrategyContext(store, imported.market.id);
	assert.equal(context.metrics.qualify_rank_depth.value, 4);
	assert.equal(context.metrics.qualify_rank_depth.targetMonthlyUnits, 800);
	assert.equal(context.metrics.low_rating_high_sales_count.value, 2);
	assert.equal(imported.snapshot.metrics.qualify_rank_depth.value, 22);

	// 规则 evidence 与表达式求值同口径，不再是「evidence 22 / 表达式 4」
	const run = runStrategy(store, { marketRef: imported.market.id, mode: "screen", actor: "tester" });
	const rule = run.result.rules.find((item) => item.id === "volume_feasibility");
	assert.equal(rule?.status, "fail");
	assert.equal(rule?.evidence.qualify_rank_depth?.value, 4);
	assert.equal(rule?.evidence.qualify_rank_depth?.targetMonthlyUnits, 800);

	// 报告里标签与值同口径
	const report = generateMarketReport(store, imported.market.id);
	assert.match(report.markdown, /\| QRD\(800\) \| 4 \|/);
	assert.doesNotMatch(report.markdown, /\| QRD\(800\) \| 22 \|/);
});


// —— 审计 M15 回归 ——
// 需在 ../service.ts import 列表里补 listWorkbenchTodos、metricDivergences
test("a target-units change alone does not fabricate a multi-source divergence", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const first = importParsedMarket(store, {
		marketName: "qrd divergence market",
		parsed: parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" }),
		capturedAt: "2026-08-22T00:00:00.000Z",
		actor: "tester",
	});
	saveStrategyVersion(store, { yaml: DEFAULT_STRATEGY_YAML.replace("monthly_units_q: 300", "monthly_units_q: 800"), actor: "tester" });
	const second = importParsedMarket(store, {
		marketName: "qrd divergence market",
		parsed: parseMarketCsv(csv, { source: "keepa", capturedAt: "2026-08-25T00:00:00.000Z" }),
		capturedAt: "2026-08-25T00:00:00.000Z",
		actor: "tester",
	});
	// 两份快照的冻结值口径不同（22 @q=300 / 4 @q=800），但底层是同一份数据，不该判成来源打架
	assert.equal(first.snapshot.metrics.qualify_rank_depth.value, 22);
	assert.equal(second.snapshot.metrics.qualify_rank_depth.value, 4);
	assert.deepEqual(metricDivergences(store, first.market.id), []);
	assert.deepEqual(
		listWorkbenchTodos(store, "2026-08-26T00:00:00.000Z").filter((todo) => todo.kind === "metric_divergence"),
		[],
	);
});


// —— 审计 M15 回归 ——
test("market scan filters on the QRD recomputed at the current target units", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	importParsedMarket(store, { marketName: "qrd scan market", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	assert.equal(scanMarkets(store, {})[0].qrd, 22);
	assert.equal(scanMarkets(store, { minQrd: 20 }).length, 1);

	saveStrategyVersion(store, {
		yaml: DEFAULT_STRATEGY_YAML
			.replace("monthly_units_q: 300", "monthly_units_q: 800")
			.replace("qualify_rank_depth(300) >= 20", "qualify_rank_depth(800) >= 20"),
		actor: "tester",
	});
	// 调 q 之后筛选与展示都用重算值，不再拿冻结的 22 误放行
	assert.equal(scanMarkets(store, {})[0].qrd, 4);
	assert.deepEqual(scanMarkets(store, { minQrd: 20 }), []);
});


// —— 审计 M15 回归 ——
test("a missing snapshot payload degrades target-dependent metrics to missing instead of a stale basis", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const imported = importParsedMarket(store, { marketName: "qrd orphan market", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	saveStrategyVersion(store, {
		yaml: DEFAULT_STRATEGY_YAML
			.replace("monthly_units_q: 300", "monthly_units_q: 800")
			.replace("qualify_rank_depth(300) >= 20", "qualify_rank_depth(800) >= 20"),
		actor: "tester",
	});
	// 模拟 sidecar 缺失后 store.ts 的降级形态：listings 为空
	imported.snapshot.listings = [];

	// 口径不同又拿不到明细：判缺失走 review，绝不沿用 q=300 的 22 伪装成 q=800 的结论
	const missing = buildStrategyContext(store, imported.market.id).context;
	assert.equal(missing.metrics.qualify_rank_depth.value, null);
	assert.equal(missing.metrics.low_rating_high_sales_count.value, null);
	const run = runStrategy(store, { marketRef: imported.market.id, mode: "screen", actor: "tester" });
	assert.equal(run.result.rules.find((item) => item.id === "volume_feasibility")?.status, "missing");
	assert.deepEqual(run.result.missingMetrics, ["qualify_rank_depth"]);
	assert.equal(run.result.outcome, "review");

	// 只有确认冻结口径与当前 q 相同，才允许沿用冻结值
	assert.equal(buildStrategyContext(store, imported.market.id, 300).context.metrics.qualify_rank_depth.value, 22);
});


// —— 审计 M15 回归 ——
test("rule evidence reports the threshold its own expression used", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const imported = importParsedMarket(store, { marketName: "qrd split basis market", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	// 只改 meta 的 q，规则表达式仍写着 qualify_rank_depth(300)：两个旋钮可以各改各的
	saveStrategyVersion(store, { yaml: DEFAULT_STRATEGY_YAML.replace("monthly_units_q: 300", "monthly_units_q: 800"), actor: "tester" });
	const run = runStrategy(store, { marketRef: imported.market.id, mode: "screen", actor: "tester" });
	const rule = run.result.rules.find((item) => item.id === "volume_feasibility");
	// evidence 必须是表达式自己那个阈值算出来的数（22 @300），不能拿五维表按 meta q 算的 4 冒充
	assert.equal(rule?.status, "pass");
	assert.equal(rule?.evidence.qualify_rank_depth?.value, 22);
	assert.equal(rule?.evidence.qualify_rank_depth?.targetMonthlyUnits, 300);
	// 五维证据表按 meta 的 q 展示，标签与值仍然同口径
	assert.match(generateMarketReport(store, imported.market.id).markdown, /\| QRD\(800\) \| 4 \|/);
});

// —— 审计 M4/M175 回归 ——

// ---- M4 / M175：策略保存归属与引用解析 ----

const FORK_YAML = (units: number, displayName = "Jingpu-Daily10") =>
	`meta:\n  name: my-fork\n  display_name: ${displayName}\n  monthly_units_q: ${units}\nstages:\n  - stage: market_screen\n    rules:\n      - id: activity\n        when: "new_listing_share_12m >= 0.15"\n        action: require\n        label: activity\nscoring:\n  weights:\n    demand: 1\n`;

test("saving a differently-named strategy that slugifies onto an existing id is refused", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const foreign = FORK_YAML(999).replace("name: my-fork", "name: Jingpu Daily10").replace("display_name: Jingpu-Daily10", "display_name: 老王的精铺口径");
	assert.throws(() => saveStrategyVersion(store, { yaml: foreign, actor: "laowang" }), /策略 id 冲突/);
	assert.equal(store.strategies.length, 1);
	assert.equal(listStrategies(store).length, 1);
	assert.equal(targetMonthlyUnits(store), 300);
	assert.equal(latestStrategy(store).version, 1);
	// 只差大小写与首尾空格仍是同一条链：改名不该被误伤
	const bumped = saveStrategyVersion(store, {
		yaml: DEFAULT_STRATEGY_YAML.replace("name: jingpu-daily10", "name: Jingpu-Daily10  ").replace("monthly_units_q: 300", "monthly_units_q: 400"),
		actor: "tester",
	});
	assert.equal(bumped.id, "jingpu-daily10");
	assert.equal(bumped.version, 2);
	assert.equal(targetMonthlyUnits(store), 400);
});



// —— 审计 M4/M175 回归 ——
test("cloneStrategy opens a new chain and refuses to append to a colliding id", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	assert.throws(() => cloneStrategy(store, { sourceRef: "jingpu-daily10", newName: "Jingpu Daily10", actor: "tester" }), /复制只会新建策略/);
	assert.equal(store.strategies.length, 1);
	const cloned = cloneStrategy(store, { sourceRef: "jingpu-daily10", newName: "老王精铺", actor: "tester" });
	assert.equal(cloned.id, "老王精铺");
	assert.equal(cloned.version, 1);
	assert.throws(() => cloneStrategy(store, { sourceRef: "jingpu-daily10", newName: "老王精铺", actor: "tester" }), /复制只会新建策略/);
	assert.equal(store.strategies.length, 2);
});



// —— 审计 M4/M175 回归 ——
test("strategy references resolve within one chain instead of taking a global max version", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	saveStrategyVersion(store, { yaml: FORK_YAML(111), actor: "laowang" });
	saveStrategyVersion(store, { yaml: FORK_YAML(222), actor: "laowang" });
	const byDefault = latestStrategy(store);
	assert.equal(byDefault.id, "jingpu-daily10");
	assert.equal(byDefault.version, 1);
	assert.equal(byDefault.definition.meta.monthly_units_q, 300);
	assert.equal(findStrategyVersion(store, "my-fork@v2").definition.meta.monthly_units_q, 222);
	assert.throws(() => findStrategyVersion(store, "jingpu-daily10@v2"), /未找到策略版本/);
	// 显示名同时命中两条链时报不唯一，而不是静默挑版本号最大的那条
	saveStrategyVersion(store, { yaml: FORK_YAML(333, "精铺 · 日均10单"), actor: "laowang" });
	assert.throws(() => latestStrategy(store, "精铺 · 日均10单"), /不唯一/);
	assert.equal(latestStrategy(store).id, "jingpu-daily10");
});



// —— 审计 M4/M175 回归 ——
test("saveStrategyVersion rejects an expectedId that disagrees with meta.name", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	assert.throws(
		() => saveStrategyVersion(store, { yaml: DEFAULT_STRATEGY_YAML.replace("name: jingpu-daily10", "name: my-fork"), actor: "tester", expectedId: "jingpu-daily10" }),
		/策略归属冲突/,
	);
	assert.equal(store.strategies.length, 1);
	const ok = saveStrategyVersion(store, { yaml: DEFAULT_STRATEGY_YAML.replace("monthly_units_q: 300", "monthly_units_q: 400"), actor: "tester", expectedId: "jingpu-daily10" });
	assert.equal(ok.id, "jingpu-daily10");
	assert.equal(ok.version, 2);
	assert.equal(targetMonthlyUnits(store), 400);
	// index.ts 的 save 分支先用 latestStrategy 确认 strategy_id 指向的链存在
	assert.throws(() => latestStrategy(store, "not-a-strategy"), /未找到策略/);
});

// —— 审计 M174 回归 ——
// —— 审计 M174 回归：strategy_id 语义统一 ——
async function seed(marketName: string) {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const imported = importParsedMarket(store, { marketName, parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	return { store, marketId: imported.market.id };
}


// —— 审计 M174 回归 ——
test("所有策略入口都接受 id@vN，不再只有 report/backtest 认版本后缀", async () => {
	const { store, marketId } = await seed("m174 市场");
	const ref = "jingpu-daily10@v1";

	const run = runStrategy(store, { marketRef: marketId, strategyRef: ref, mode: "screen", actor: "tester" });
	assert.equal(run.strategyId, "jingpu-daily10");
	assert.equal(run.strategyVersion, 1);

	assert.equal(scanMarkets(store, { strategyRef: ref }).length, 1);
	assert.equal(generateMarketReport(store, marketId, ref).outcome, "review");

	const cloned = cloneStrategy(store, { sourceRef: ref, newName: "m174 复制", actor: "tester" });
	assert.equal(cloned.changeNote, "复制自 jingpu-daily10@v1");

	// strategy_manage get 走的这条：改用 findStrategyVersion 后与其它入口同义
	assert.equal(findStrategyVersion(store, ref).version, 1);
});


// —— 审计 M174 回归 ——
test("findStrategyVersion 是 latestStrategy 的严格超集：名字自带 :N 后缀也能命中", async () => {
	const { store } = await seed("m174 后缀市场");
	const yaml = `meta:\n  name: pricewar\n  display_name: "价格战:2"\nstages:\n  - stage: market_screen\n    rules:\n      - id: activity\n        when: "new_listing_share_12m >= 0.15"\n        action: require\n        label: activity\nscoring:\n  weights:\n    demand: 1\n`;
	saveStrategyVersion(store, { yaml, actor: "tester" });
	assert.equal(latestStrategy(store, "价格战:2").id, "pricewar");
	assert.equal(findStrategyVersion(store, "价格战:2").id, "pricewar");
	assert.throws(() => findStrategyVersion(store, "pricewar@v9"), /未找到策略版本：pricewar@v9/);
	assert.throws(() => findStrategyVersion(store, "根本不存在"), /未找到策略：根本不存在/);
});


// —— 审计 M174 回归 ——
test("scan 的 id@vN 真的锁到该版本，而不是被打回最新版", async () => {
	const { store } = await seed("m174 锁版本市场");
	const v1 = `meta:\n  name: scan-pin\n  display_name: Scan Pin\nstages:\n  - stage: market_screen\n    rules:\n      - id: activity\n        when: "new_listing_share_12m >= 0.99"\n        action: require\n        label: activity\nscoring:\n  weights:\n    demand: 1\n`;
	saveStrategyVersion(store, { yaml: v1, actor: "tester" });
	saveStrategyVersion(store, { yaml: v1.replace(">= 0.99", ">= 0.0"), actor: "tester" });
	assert.equal(scanMarkets(store, { strategyRef: "scan-pin@v1" })[0].evaluation.outcome, "reject");
	assert.equal(scanMarkets(store, { strategyRef: "scan-pin@v2" })[0].evaluation.outcome, "pass");
	assert.equal(scanMarkets(store, { strategyRef: "scan-pin" })[0].evaluation.outcome, "pass");
});

// —— 审计 M5 回归 ——
// import { DEFAULT_STRATEGY_ID, DEFAULT_STRATEGY_YAML } from "../defaults.ts";
// 从 "../service.ts" 追加：evaluateMarketWithoutPersisting, findStrategyVersion,
//   gateDefaultsLine, generateRetroReport, latestStrategy, latestStrategyIfPresent,
//   listRetroDue, targetMonthlyUnits

test("默认策略的每个引用点都同源于 DEFAULT_STRATEGY_ID（改 meta.name 不会各走各的）", async () => {
	// M5 回归：ensureDefaults 注入的 id、latestStrategy/findStrategyVersion 的默认参数、
	// targetMonthlyUnits / listRetroDue / 报告与回测的 baseline 必须同源于 DEFAULT_STRATEGY_ID。
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	assert.equal(store.strategies[0].id, DEFAULT_STRATEGY_ID);
	assert.equal(latestStrategy(store).id, DEFAULT_STRATEGY_ID);
	assert.equal(findStrategyVersion(store).id, DEFAULT_STRATEGY_ID);
	assert.equal(latestStrategyIfPresent(store)?.id, DEFAULT_STRATEGY_ID);
	const imported = importParsedMarket(store, { marketName: "default strategy ref", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	assert.equal(evaluateMarketWithoutPersisting(store, imported.market.id).outcome, "pass");
	assert.equal(backtestStrategies(store, DEFAULT_STRATEGY_ID).baselineStrategy, `${DEFAULT_STRATEGY_ID}@v1`);
	assert.match(generateMarketReport(store, imported.market.id).markdown, /QRD\(300\)/);
});

// 断言值全部来自实跑：outcome 的实测值是 "pass"（我最初写 "reject" 被测试打回：
//   AssertionError: 'pass' !== 'reject' at tests/integration.test.ts:552）。
// 说明：这条用例在改 meta.name 之前不会红——真正的「改 meta.name 后仍正确」
// 无法在进程内触发（常量不可变），执行那半边靠上面的源码守卫用例。这条用例
// 钉的是「所有引用点同源」，一旦有人再引入第 2 个默认 id 来源，它就会红。


// —— 审计 M5 回归 ——
test("读侧总览在 store 尚无任何策略时回退默认口径而不是抛错", () => {
	// targetMonthlyUnits / listRetroDue / 复盘报告若改用会抛错的 latestStrategy，
	// 一个空 store 就能让 TUI 总览与 Web 首页整块崩掉。
	const bare = createEmptyStore();
	assert.equal(latestStrategyIfPresent(bare), undefined);
	assert.throws(() => latestStrategy(bare), /未找到策略：jingpu-daily10/);
	assert.equal(targetMonthlyUnits(bare), 300);
	assert.match(gateDefaultsLine(bare), /QRD\(300\)/);
	assert.deepEqual(listRetroDue(bare, "2026-02-05T00:00:00.000Z"), []);
	// 报告标题按本地日历日（G9：沪早 8 点前生成不再写成昨天并覆盖昨晚那份），
	// 所以断言必须钉死时区，否则在 UTC-x 机器上会算成 02-04。
	assert.match(generateRetroReport(bare, "2026-02-05T00:00:00.000Z", { timeZone: "UTC" }), /# 罗盘复盘报告｜2026-02-05/);
});

// 这条是本次改法最大风险（把静默回退换成抛错）的正面锁。断言值全部实跑确认。

// —— 审计 M148 回归：共用夹具 ——
// 在它下面加一行（该文件目前没有任何 import type）：

const M148_AT = "2026-01-01T00:00:00.000Z";

function m148Snapshot(id: string): MarketSnapshot {
	return {
		id,
		marketId: "m1",
		source: "sellersprite",
		capturedAt: M148_AT,
		importedAt: M148_AT,
		rowCount: 2,
		listings: [{ asin: "B0AAA" }, { asin: "B0BBB" }],
		keywords: [{ keyword: "kw" }],
		metrics: {},
		warnings: [],
	} as unknown as MarketSnapshot;
}

async function m148Repo(): Promise<{ root: string; repo: CompassRepository }> {
	const root = await mkdtemp(join(tmpdir(), "compass-store-perf-"));
	const repo = new CompassRepository(root);
	const store = createEmptyStore(M148_AT);
	store.markets.push({ id: "m1", name: "m1", keywords: [], createdAt: M148_AT, updatedAt: M148_AT });
	store.snapshots.push(m148Snapshot("s1"));
	await repo.save(store);
	return { root, repo };
}



// —— 审计 M31 回归 ——
test("pid 被复用的残留锁：持锁 pid 存活也按 mtime 年龄回收", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-reused-pid-lock-"));
	try {
		const repo = new CompassRepository(root);
		await mkdir(repo.dataDir, { recursive: true });
		// process.pid 必然存活，等价于「崩溃残留锁的 pid 被系统复用」：旧实现在这里永不判 stale
		await writeFile(repo.lockPath, `${process.pid}\nreused-pid-token\n`, "utf8");
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(repo.lockPath, old, old);
		const started = Date.now();
		await repo.update((store) => {
			store.markets.push({ id: "reclaimed", name: "reclaimed", keywords: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
		});
		assert.ok(Date.now() - started < 5_000, "回收残留锁不应耗到抢锁兜底的 10 秒");
		assert.equal((await repo.load()).markets[0].id, "reclaimed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// 时间控制方式：不注入时钟、不改生产代码，直接用 utimes 把锁文件 mtime 拨到 10 分钟前。
// 实跑：修前 10048ms 抛 StoreIoError（用例失败）；修后 58.070708ms 通过。


// —— code-review 回归：锁被回收后不得静默覆盖 ——
test("写事务进行中锁被回收：响亮失败，而不是覆盖抢锁方刚写入的内容", async () => {
	// 回收策略无论把阈值取多长都消不掉这个失败模式——笔记本休眠、SIGSTOP、NFS 卡顿
	// 都能让一个**活着**的写事务持锁超过任何静态阈值。原持有者若照常 rename，
	// 就会盖掉抢锁方刚写完的内容，且两边都不报错。这里模拟「锁在 mutator 执行期间被别人换掉」。
	const root = await mkdtemp(join(tmpdir(), "compass-lock-stolen-"));
	try {
		const repo = new CompassRepository(root);
		await mkdir(repo.dataDir, { recursive: true });
		await repo.save(createEmptyStore());

		await assert.rejects(
			repo.update(async (store) => {
				store.markets.push({ id: "mine", name: "mine", keywords: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
				// 抢锁方回收了我们的锁并换上自己的：unlinkLockIfOwned 之后另起一把
				await writeFile(repo.lockPath, "99999\nthief-token\n2026-01-01T00:00:00.000Z\n", "utf8");
			}),
			/锁已被回收/,
			"锁易主后必须中止写入并说明原因",
		);

		// 关键：我们的改动没有落盘，抢锁方的世界观完好
		assert.deepEqual((await repo.load()).markets, [], "中止的写事务不得留下任何痕迹");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// —— 审计 M31 回归 ——
test("新鲜的活锁不会被抢走：写入排队到持锁方释放为止", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-live-lock-"));
	try {
		const repo = new CompassRepository(root);
		await mkdir(repo.dataDir, { recursive: true });
		// mtime = 现在，远未到 5 分钟阈值：放宽阈值不能把正在进行的写事务误判成残留锁
		const held = `${process.pid}\nlive-token\n${new Date().toISOString()}\n`;
		await writeFile(repo.lockPath, held, "utf8");
		let settled = false;
		const pending = repo.update((store) => {
			store.markets.push({ id: "waited", name: "waited", keywords: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
		}).then(() => { settled = true; });
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(settled, false);
		assert.equal(await readFile(repo.lockPath, "utf8"), held);
		await rm(repo.lockPath, { force: true });
		await pending;
		assert.equal((await repo.load()).markets[0].id, "waited");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// 这条用例既钉住「不误杀活锁」，也顺带钉住 delay(50) 的 ref 语义：
// 若有人给自旋定时器加 unref，pending 这次写会在 event loop 空掉时静默丢失，
// 最后一条 assert 会读不到 waited。实跑 316.009625ms 通过，不触碰 10 秒 deadline。


// —— 审计 M148 回归 ——
test("写事务的版本判定只认顶层 updatedAt：嵌套 updatedAt 排在前面也不误判", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-version-order-"));
	try {
		const repo = new CompassRepository(root);
		// 手工构造键序：markets 排在 updatedAt 之前，且首个 market 自带一个不同的 updatedAt。
		// 「读前 256 字节取 updatedAt」若用裸正则会取到 markets[0].updatedAt。
		const handWritten = {
			schemaVersion: 1,
			createdAt: M148_AT,
			markets: [{ id: "m1", name: "m1", keywords: [], createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" }],
			updatedAt: "2026-08-28T06:51:23.648Z",
			snapshots: [], candidates: [], profitEstimates: [], riskRecords: [], reviewAnalyses: [],
			strategies: [], strategyRuns: [], decisionLog: [], budgetPools: [], costEvents: [],
			outcomeChecks: [], lessons: [], todoResolutions: [],
		};
		await mkdir(repo.dataDir, { recursive: true, mode: 0o700 });
		await writeFile(repo.storePath, `${JSON.stringify(handWritten)}\n`, "utf8");
		assert.match((await readFile(repo.storePath, "utf8")).slice(0, 256), /"updatedAt":"2020-01-01T00:00:00\.000Z"/);

		const loaded = await repo.load();
		assert.equal(loaded.updatedAt, "2026-08-28T06:51:23.648Z");
		await repo.save(loaded); // 顶层 updatedAt 匹配 → 放行

		const stale = { ...(JSON.parse(await readFile(repo.storePath, "utf8")) as CompassStore), updatedAt: "2020-01-01T00:00:00.000Z" };
		await assert.rejects(repo.save(stale), /已被其他进程更新/); // 拿嵌套值冒充顶层值 → 必须拒绝
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// 断言值来源：实跑。对 baseline（全量 parse）与推荐补丁均通过；若把锚定正则换成裸的
// /"updatedAt":"([^"]*)"/，第一个 repo.save(loaded) 就会误报「已被其他进程更新」。


// —— 审计 M148 回归 ——
test("首个写事务在 snapshots 目录尚不存在时仍落 sidecar", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-first-sidecar-"));
	try {
		const repo = new CompassRepository(root);
		const store = createEmptyStore(M148_AT);
		store.markets.push({ id: "m1", name: "m1", keywords: [], createdAt: M148_AT, updatedAt: M148_AT });
		store.snapshots.push(m148Snapshot("s1"));
		await repo.save(store);
		const persisted = JSON.parse(await readFile(repo.storePath, "utf8")) as { snapshots: Array<{ dataFile: string; listings: unknown[] }> };
		assert.equal(persisted.snapshots[0].dataFile, ".pi/compass/snapshots/s1.json");
		assert.equal(persisted.snapshots[0].listings.length, 0);
		assert.deepEqual(JSON.parse(await readFile(join(root, ".pi/compass/snapshots/s1.json"), "utf8")), { listings: [{ asin: "B0AAA" }, { asin: "B0BBB" }], keywords: [{ keyword: "kw" }] });
		assert.equal((await repo.load()).snapshots[0].listings.length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// 钉住 mkdir 外提的排序前提：mkdir 必须在 canonicalPath(snapshotDataDir) 之前执行。
// 断言值（dataFile 字面量、listings 长度、sidecar 内容）全部实跑取得。


// —— 审计 M148 回归 ——
test("已落盘快照的越界 dataFile 让写事务硬失败，而不是带着越界路径落盘", async () => {
	const { root, repo } = await m148Repo();
	try {
		const raw = JSON.parse(await readFile(repo.storePath, "utf8")) as { snapshots: Array<{ dataFile: string }> };
		raw.snapshots[0].dataFile = "../../../../etc/passwd";
		await writeFile(repo.storePath, `${JSON.stringify(raw)}\n`, "utf8");
		await assert.rejects(repo.update(() => undefined), /快照数据文件路径越界/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// 这是「不做 ②」的守卫用例：对 baseline 与推荐补丁通过，对做了 ② 的变体实测失败
// （Missing expected rejection. actual: undefined, expected: /快照数据文件路径越界/）。
// 将来若有人重提 ②，这条会先响。


// —— 审计 M148 回归 ——
test("已落盘快照的非规范 dataFile 在写事务里被归一回 snapshots 目录下的规范相对路径", async () => {
	const { root, repo } = await m148Repo();
	try {
		const raw = JSON.parse(await readFile(repo.storePath, "utf8")) as { snapshots: Array<{ dataFile: string }> };
		raw.snapshots[0].dataFile = ".pi/compass/snapshots/../snapshots/./s1.json";
		await writeFile(repo.storePath, `${JSON.stringify(raw)}\n`, "utf8");
		await repo.update(() => undefined);
		const after = JSON.parse(await readFile(repo.storePath, "utf8")) as { snapshots: Array<{ dataFile: string }> };
		assert.equal(after.snapshots[0].dataFile, ".pi/compass/snapshots/s1.json");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// 同为「不做 ②」的守卫用例：对做了 ② 的变体实测失败
// （actual: '.pi/compass/snapshots/../snapshots/./s1.json'，expected: '.pi/compass/snapshots/s1.json'）。

// —— 审计 M13/G15 回归 ——
test("routine re-import leaves a challenged retro todo standing (no auto screen run or inconclusive check counts as handling)", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const aged = structuredClone(parsed);
	for (const listing of aged.listings) { listing.monthsOnline = 24; listing.launchDate = undefined; }
	const improved = structuredClone(parsed);
	for (const listing of improved.listings) { listing.monthsOnline = 1; listing.launchDate = undefined; }
	const missing = structuredClone(parsed);
	for (const listing of missing.listings) { listing.monthsOnline = undefined; listing.launchDate = undefined; }
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const base = importMarketAndScreen(store, { marketName: "m13 routine", parsed: aged, capturedAt: "2026-01-01T00:00:00.000Z", actor: "ops" });
	assert.equal(base.screenRun?.result.outcome, "reject");
	decideCandidate(store, { candidateRef: base.candidate.id, status: "no_go", reason: "新品占比未达门槛", actor: "ops" });
	const challenged = importMarketAndScreen(store, { marketName: "m13 routine", parsed: improved, capturedAt: "2026-01-11T00:00:00.000Z", actor: "ops" });
	assert.equal(challenged.outcomeCheck?.verdict, "challenged");
	const surfaced = (now: string) => listWorkbenchTodos(store, now).filter((todo) => todo.kind === "retro_challenged").length;
	assert.equal(surfaced("2026-01-12T00:00:00.000Z"), 1);
	const routine = importMarketAndScreen(store, { marketName: "m13 routine", parsed: missing, capturedAt: "2026-01-21T00:00:00.000Z", actor: "ops" });
	assert.equal(routine.screenRun?.id !== undefined, true);
	assert.equal(routine.outcomeCheck?.verdict, "inconclusive");
	assert.equal(store.decisionLog.filter((log) => log.type === "strategy" && log.trigger === "manual").length, 0);
	assert.equal(surfaced("2026-01-22T00:00:00.000Z"), 1);
	runStrategy(store, { marketRef: base.market.id, mode: "screen", actor: "ops", trigger: "manual" });
	const manualLog = store.decisionLog.at(-1)!;
	assert.equal(manualLog.trigger, "manual");
	manualLog.createdAt = new Date(Date.parse(routine.outcomeCheck!.createdAt) + 1_000).toISOString();
	assert.equal(surfaced("2026-01-24T00:00:00.000Z"), 0);
});


// —— 审计 M13/G15 回归 ——
test("markets that were never decided neither manufacture OutcomeChecks nor move the validation rate", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const aged = structuredClone(parsed);
	for (const listing of aged.listings) { listing.monthsOnline = 24; listing.launchDate = undefined; }
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const first = importMarketAndScreen(store, { marketName: "g15 undecided", parsed: structuredClone(aged), capturedAt: "2026-01-01T00:00:00.000Z", actor: "ops" });
	assert.equal(first.screenRun?.result.outcome, "reject");
	assert.equal(first.candidate.decisionStatus, undefined);
	const second = importMarketAndScreen(store, { marketName: "g15 undecided", parsed: structuredClone(aged), capturedAt: "2026-01-11T00:00:00.000Z", actor: "ops" });
	assert.equal(second.outcomeCheck, undefined);
	assert.equal(store.outcomeChecks.length, 0);
	assert.equal(store.decisionLog.filter((log) => log.type === "retro").length, 0);
	assert.equal(outcomeStatistics(store).validationRate, null);
	decideCandidate(store, { candidateRef: first.candidate.id, status: "no_go", reason: "新品占比未达门槛", actor: "ops" });
	const third = importMarketAndScreen(store, { marketName: "g15 undecided", parsed: structuredClone(aged), capturedAt: "2026-01-21T00:00:00.000Z", actor: "ops" });
	assert.equal(third.outcomeCheck?.decisionStatus, "no_go");
	assert.equal(third.outcomeCheck?.verdict, "validated");
	const anchored = outcomeStatistics(store);
	assert.equal(anchored.validationRate, 1);
	assert.equal(anchored.strategyOnly, 0);
});


// —— 审计 G16 回归 ——
test("高频刷新的市场不再主导四率：复盘比率与 backtest alignment 共用同一份去重样本", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const stale = structuredClone(parsed);
	for (const listing of stale.listings) {
		listing.monthsOnline = 24;
		listing.launchDate = undefined;
	}
	const improved = structuredClone(parsed);
	for (const listing of improved.listings) {
		listing.monthsOnline = 1;
		listing.launchDate = undefined;
	}
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const seedNoGo = (name: string) => {
		const baseline = importMarketAndScreen(store, { marketName: name, parsed: structuredClone(stale), capturedAt: "2026-01-01T00:00:00.000Z", actor: "tester" });
		decideCandidate(store, { candidateRef: baseline.candidate.id, status: "no_go", reason: "新品占比未达门槛", actor: "tester" });
		return baseline;
	};
	const tracked = seedNoGo("高频跟踪市场");
	for (const day of ["2026-01-11", "2026-01-21", "2026-01-31", "2026-02-10", "2026-02-20"]) {
		const check = importMarketAndScreen(store, { marketName: tracked.market.name, parsed: structuredClone(stale), capturedAt: `${day}T00:00:00.000Z`, actor: "tester" }).outcomeCheck;
		assert.equal(check?.verdict, "validated");
	}
	const once = seedNoGo("单次复盘市场");
	assert.equal(importMarketAndScreen(store, { marketName: once.market.name, parsed: structuredClone(improved), capturedAt: "2026-01-11T00:00:00.000Z", actor: "tester" }).outcomeCheck?.verdict, "challenged");

	const stats = outcomeStatistics(store);
	assert.equal(stats.total, 6);
	assert.equal(stats.validated, 5);
	assert.equal(stats.ratedMarkets, 2);
	assert.equal(stats.noGoAccuracyRate, 0.5);
	assert.equal(stats.falseKillRate, 0.5);
	const backtest = backtestStrategies(store, DEFAULT_STRATEGY_ID);
	assert.equal(backtest.alignment.comparableChecks, stats.ratedMarkets);
});

// —— 审计 G13/G17 回归：共用夹具 ——
// —— 审计 G13 / G17 回归 ——
const BACKTEST_VETO_ALL_YAML = `meta:
  name: backtest-veto-all
  display_name: 回测·全否决
stages:
  - stage: market_screen
    rules:
      - id: always_veto
        when: "1 == 1"
        action: veto
        label: 恒真否决
scoring:
  weights:
    demand: 1
`;

const BACKTEST_PASS_ALL_YAML = `meta:
  name: backtest-pass-all
  display_name: 回测·全通过
stages:
  - stage: market_screen
    rules:
      - id: always_pass
        when: "1 == 1"
        action: require
        label: 恒真通过
scoring:
  weights:
    demand: 1
`;

const BACKTEST_ABSTAIN_YAML = `meta:
  name: backtest-abstain
  display_name: 回测·大量弃权
stages:
  - stage: market_screen
    rules:
      - id: dead_market_veto
        when: "new_listing_share_12m < 0.05"
        action: veto
        label: 市场已无新品进入
      - id: rating_gate
        when: "est_rating_gap >= -0.2"
        action: require
        label: 预估星级门槛（本 store 无评论分析，指标缺失）
scoring:
  weights:
    demand: 1
`;

async function seedBacktestFixture(): Promise<{ store: CompassStore; challengedMarketId: string; validatedMarketId: string; goMarketId: string }> {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const stale = structuredClone(parsed);
	for (const listing of stale.listings) {
		listing.monthsOnline = 24;
		listing.launchDate = undefined;
	}
	const fresh = structuredClone(parsed);
	for (const listing of fresh.listings) {
		listing.monthsOnline = 1;
		listing.launchDate = undefined;
	}
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const seedNoGo = (name: string) => {
		const baseline = importMarketAndScreen(store, { marketName: name, parsed: structuredClone(stale), capturedAt: "2026-01-01T00:00:00.000Z", actor: "tester" });
		decideCandidate(store, { candidateRef: baseline.candidate.id, status: "no_go", reason: "新品占比未达门槛", actor: "tester" });
		return baseline;
	};
	const challengedBase = seedNoGo("backtest challenged");
	importMarketAndScreen(store, { marketName: challengedBase.market.name, parsed: structuredClone(fresh), capturedAt: "2026-01-11T00:00:00.000Z", actor: "tester" });
	const validatedBase = seedNoGo("backtest validated");
	importMarketAndScreen(store, { marketName: validatedBase.market.name, parsed: structuredClone(stale), capturedAt: "2026-01-11T00:00:00.000Z", actor: "tester" });
	const go = importMarketAndScreen(store, { marketName: "backtest go", parsed: structuredClone(fresh), capturedAt: "2026-01-01T00:00:00.000Z", actor: "tester" });
	decideCandidate(store, { candidateRef: go.candidate.id, status: "go", reason: "粗筛通过并批准测试", actor: "tester" });
	recordRetroActuals(store, { candidateRef: go.candidate.id, actuals: { dailyUnits: 8, tacos: 0.15, returnRate: 0.04, netMargin: 0.08 }, actor: "tester" });
	return { store, challengedMarketId: challengedBase.market.id, validatedMarketId: validatedBase.market.id, goMarketId: go.market.id };
}


// —— 审计 G13/G17 回归 ——
test("回测：全否决与全通过两个退化策略都不得优于基线", async () => {
	const { store, challengedMarketId, validatedMarketId, goMarketId } = await seedBacktestFixture();
	assert.deepEqual(
		store.outcomeChecks.map((check) => `${check.marketId}:${check.decisionStatus}:${check.verdict}`),
		[`${challengedMarketId}:no_go:challenged`, `${validatedMarketId}:no_go:validated`, `${goMarketId}:go:validated`],
	);
	saveStrategyVersion(store, { yaml: BACKTEST_VETO_ALL_YAML, actor: "tester" });
	saveStrategyVersion(store, { yaml: BACKTEST_PASS_ALL_YAML, actor: "tester" });

	const veto = backtestStrategies(store, "backtest-veto-all", DEFAULT_STRATEGY_ID);
	assert.deepEqual(veto.alignment.baseline, { decided: 3, correct: 3, abstained: 0, rate: 1, coverage: 1 });
	assert.deepEqual(veto.alignment.strategy, { decided: 3, correct: 1, abstained: 0, rate: 1 / 3, coverage: 1 });
	assert.equal(veto.alignment.comparableChecks, 3);

	const pass = backtestStrategies(store, "backtest-pass-all", DEFAULT_STRATEGY_ID);
	assert.deepEqual(pass.alignment.baseline, { decided: 3, correct: 3, abstained: 0, rate: 1, coverage: 1 });
	assert.deepEqual(pass.alignment.strategy, { decided: 3, correct: 2, abstained: 0, rate: 2 / 3, coverage: 1 });

	assert.ok((veto.alignment.strategy.rate ?? 0) < (veto.alignment.baseline.rate ?? 0));
	assert.ok((pass.alignment.strategy.rate ?? 0) < (pass.alignment.baseline.rate ?? 0));

	const label = (result: ReturnType<typeof backtestStrategies>, marketId: string) => {
		const row = result.rows.find((item) => item.marketId === marketId && item.checkId);
		return `${row?.baselineOutcome}→${row?.strategyOutcome}`;
	};
	assert.equal(label(veto, challengedMarketId), "pass→reject");
	assert.equal(label(veto, goMarketId), "pass→reject");
	assert.equal(label(pass, validatedMarketId), "reject→pass");
});


// —— 审计 G13/G17 回归 ——
test("回测：review 计为弃权，不进对齐率分母，覆盖率单独报", async () => {
	const { store, validatedMarketId } = await seedBacktestFixture();
	saveStrategyVersion(store, { yaml: BACKTEST_ABSTAIN_YAML, actor: "tester" });
	const result = backtestStrategies(store, "backtest-abstain", DEFAULT_STRATEGY_ID);
	assert.deepEqual(result.alignment.strategy, { decided: 1, correct: 1, abstained: 2, rate: 1, coverage: 1 / 3 });
	assert.deepEqual(result.alignment.baseline, { decided: 3, correct: 3, abstained: 0, rate: 1, coverage: 1 });
	const decidedRow = result.rows.find((row) => row.checkId && row.marketId === validatedMarketId);
	assert.equal(decidedRow?.strategyOutcome, "reject");
	assert.equal(result.rows.filter((row) => row.checkId && row.strategyOutcome === "review").length, 2);
});


// —— 审计 G13/G17 回归 ——
test("回测：后续 inconclusive 导入不改变已判定复盘的对齐率", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const stale = structuredClone(parsed);
	for (const listing of stale.listings) {
		listing.monthsOnline = 24;
		listing.launchDate = undefined;
	}
	const columnless = structuredClone(parsed);
	for (const listing of columnless.listings) {
		listing.monthsOnline = undefined;
		listing.launchDate = undefined;
	}
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const baseline = importMarketAndScreen(store, { marketName: "backtest evidence drift", parsed: structuredClone(stale), capturedAt: "2026-01-01T00:00:00.000Z", actor: "tester" });
	decideCandidate(store, { candidateRef: baseline.candidate.id, status: "no_go", reason: "新品占比未达门槛", actor: "tester" });
	const evidence = importMarketAndScreen(store, { marketName: baseline.market.name, parsed: structuredClone(stale), capturedAt: "2026-01-11T00:00:00.000Z", actor: "tester" });
	assert.equal(evidence.outcomeCheck?.verdict, "validated");

	const before = backtestStrategies(store, DEFAULT_STRATEGY_ID);
	assert.deepEqual(before.alignment.strategy, { decided: 1, correct: 1, abstained: 0, rate: 1, coverage: 1 });

	const drifted = importMarketAndScreen(store, { marketName: baseline.market.name, parsed: structuredClone(columnless), capturedAt: "2026-01-21T00:00:00.000Z", actor: "tester" });
	assert.equal(drifted.outcomeCheck?.verdict, "inconclusive");

	const after = backtestStrategies(store, DEFAULT_STRATEGY_ID);
	assert.deepEqual(after.alignment.strategy, { decided: 1, correct: 1, abstained: 0, rate: 1, coverage: 1 });
	assert.equal(after.alignment.comparableChecks, 1);
	const alignmentRow = after.rows.find((row) => row.checkId === evidence.outcomeCheck?.id);
	assert.equal(alignmentRow?.snapshotId, evidence.snapshot.id);
	assert.equal(alignmentRow?.mode, "screen");
	assert.equal(alignmentRow?.baselineOutcome, "reject");
	const latestRow = after.rows.find((row) => row.snapshotId === drifted.snapshot.id);
	assert.equal(latestRow?.checkId, undefined);
	assert.equal(latestRow?.baselineOutcome, "review");
});

// —— 审计 G18 回归 ——
test("no_go decided after a run_screen=false import replays the run the decision recorded", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const stale = structuredClone(parsed);
	for (const listing of stale.listings) {
		listing.monthsOnline = 24;
		listing.launchDate = undefined;
	}
	const improved = structuredClone(parsed);
	for (const listing of improved.listings) {
		listing.monthsOnline = 1;
		listing.launchDate = undefined;
	}
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const t0 = importMarketAndScreen(store, { marketName: "g18 fallback", parsed: structuredClone(stale), capturedAt: "2026-01-01T00:00:00.000Z", actor: "tester", runScreen: true });
	assert.equal(t0.screenRun?.result.outcome, "reject");
	const t1 = importMarketAndScreen(store, { marketName: "g18 fallback", parsed: structuredClone(stale), capturedAt: "2026-01-05T00:00:00.000Z", actor: "tester", runScreen: false });
	assert.equal(t1.screenRun, undefined);
	assert.equal(store.outcomeChecks.length, 0);
	decideCandidate(store, { candidateRef: t0.candidate.id, status: "no_go", reason: "新品占比未达门槛", actor: "tester" });
	const decision = store.decisionLog.filter((item) => item.type === "decision").at(-1)!;
	assert.equal(decision.snapshotId, t1.snapshot.id);
	assert.equal(decision.strategyRunId, t0.screenRun?.id);
	const t2 = importMarketAndScreen(store, { marketName: "g18 fallback", parsed: structuredClone(improved), capturedAt: "2026-01-15T00:00:00.000Z", actor: "tester", runScreen: false });
	assert.equal(t2.outcomeCheck?.baselineRunId, t0.screenRun?.id);
	assert.equal(t2.outcomeCheck?.baselineSnapshotId, t0.snapshot.id);
	assert.equal(t2.outcomeCheck?.verdict, "challenged");
	assert.match(t2.outcomeCheck?.verdictReason ?? "", /基线取决策前最近一次/);
	assert.equal(t2.outcomeCheck?.elapsedDays, 14);
});

// —— 审计 G18 回归 ——
// —— review 回归：策略的 monthly_units_q 必须进入 Score ——
// buildStrategyContextForSnapshot 的 units 参数一度只喂给 installTargetDependentMetrics，
// 没落到 context.targetMonthlyUnits，于是 calculateDimensionScores 恒按 DEFAULT(300) 归一：
// 凡 monthly_units_q ≠ 300 的策略，dimensionScores 与 score 全是错的，还会顺着 runStrategy
// 写进 candidate.score / strategyRuns / 扫描排序 / 五维报告 / backtest。
// 内置默认策略的 q 恰好是 300，所以整套测试都照不出来——这条用例专门用非 300 的 q。
test("策略自带的 monthly_units_q 进入 dimensionScores，而不是恒按默认 300 归一", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const t0 = importMarketAndScreen(store, { marketName: "q sensitivity", parsed, capturedAt: "2026-01-01T00:00:00.000Z", actor: "tester", runScreen: false });

	// 先按 q=300 跑一次：saveStrategyVersion 存的是**同一条策略链的新版本**，存完之后
	// 不带 strategyRef 的调用会取到最新版，两次就都成 q=1200 了。
	const withDefault = runStrategy(store, { marketRef: t0.market.id, mode: "screen", actor: "tester" });
	assert.equal(withDefault.strategyVersion, 1);

	const bigQ = saveStrategyVersion(store, {
		yaml: DEFAULT_STRATEGY_YAML.replace(/monthly_units_q:\s*\d+/u, "monthly_units_q: 1200"),
		actor: "tester",
	});
	assert.equal(Number(bigQ.definition.meta.monthly_units_q), 1200, "前提：新版本的 q 是 1200");
	const withBigQ = runStrategy(store, { marketRef: t0.market.id, strategyRef: `${bigQ.id}@v${bigQ.version}`, mode: "screen", actor: "tester" });
	assert.equal(withBigQ.strategyVersion, 2);

	// 直接钉住构造点：demand 里的 qrd 项也随 q 变（installTargetDependentMetrics 会重算 QRD），
	// 所以只看端到端分数差**分不清**是哪条路径在起作用。这条断言专门盯 context 上的字段本身。
	assert.equal(
		buildStrategyContext(store, t0.market.id, 1200).context.targetMonthlyUnits,
		1200,
		"buildStrategyContextForSnapshot 必须把 units 写到 context.targetMonthlyUnits，否则 calculateDimensionScores 恒按默认 300 归一",
	);
	assert.equal(buildStrategyContext(store, t0.market.id, 300).context.targetMonthlyUnits, 300);

	// demand 维度是 waistSales / (q * 2)：q 变大分数必然变小。两者相等就说明 q 根本没进算式。
	assert.notEqual(
		withBigQ.result.dimensionScores.demand,
		withDefault.result.dimensionScores.demand,
		"q=1200 与 q=300 的 demand 分数相同，说明 context.targetMonthlyUnits 没被喂进去",
	);
	assert.ok(
		withBigQ.result.dimensionScores.demand < withDefault.result.dimensionScores.demand,
		`q 变大 demand 应变小：q=300 得 ${withDefault.result.dimensionScores.demand}，q=1200 得 ${withBigQ.result.dimensionScores.demand}`,
	);
});

// —— 同毫秒并列的回归 ——
// 上一条用例此前约 1/30 概率随机变红：t0 的粗筛 run 与 v1Run 偶尔落在同一毫秒，
// 而「最新一条」是用 sort((a,b) => b.runAt.localeCompare(a.runAt))[0] 取的——sort 稳定，
// 比较返回 0 时保持原序，[0] 于是取到并列里**最早**的那条，与语义正好相反。
// 这条用例把两次运行的 runAt 直接钉成同一个值，不靠时序运气。
test("同毫秒的两次策略运行：基线取后发生的那次，不取先插入的那次", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const stale = structuredClone(parsed);
	for (const listing of stale.listings) {
		listing.monthsOnline = 24;
		listing.launchDate = undefined;
	}
	const improved = structuredClone(parsed);
	for (const listing of improved.listings) {
		listing.monthsOnline = 1;
		listing.launchDate = undefined;
	}
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const t0 = importMarketAndScreen(store, { marketName: "tie break", parsed: structuredClone(stale), capturedAt: "2026-01-01T00:00:00.000Z", actor: "tester", runScreen: true });
	const first = t0.screenRun!;
	const second = runStrategy(store, { marketRef: t0.market.id, mode: "screen", actor: "tester" });
	assert.notEqual(first.id, second.id);
	// 关键：把两次运行的时间钉成同一毫秒。store.strategyRuns 的追加顺序是 first → second。
	const sameInstant = first.runAt;
	const secondIndex = store.strategyRuns.findIndex((run) => run.id === second.id);
	store.strategyRuns[secondIndex] = { ...second, runAt: sameInstant };
	assert.equal(store.strategyRuns.filter((run) => run.runAt === sameInstant).length, 2, "前提：两次运行同毫秒");

	importMarketAndScreen(store, { marketName: "tie break", parsed: structuredClone(stale), capturedAt: "2026-01-05T00:00:00.000Z", actor: "tester", runScreen: false });
	decideCandidate(store, { candidateRef: t0.candidate.id, status: "no_go", reason: "新品占比未达门槛", actor: "tester" });
	const decision = store.decisionLog.filter((item) => item.type === "decision").at(-1)!;
	delete decision.strategyRunId;

	const t2 = importMarketAndScreen(store, { marketName: "tie break", parsed: structuredClone(improved), capturedAt: "2026-01-15T00:00:00.000Z", actor: "tester", runScreen: false });
	assert.equal(t2.outcomeCheck?.baselineRunId, second.id, "同毫秒并列时应取后发生的那次运行");
	assert.notEqual(t2.outcomeCheck?.baselineRunId, first.id);
});

test("legacy decisions without strategyRunId fall back within the strategy version they recorded", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const stale = structuredClone(parsed);
	for (const listing of stale.listings) {
		listing.monthsOnline = 24;
		listing.launchDate = undefined;
	}
	const improved = structuredClone(parsed);
	for (const listing of improved.listings) {
		listing.monthsOnline = 1;
		listing.launchDate = undefined;
	}
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const t0 = importMarketAndScreen(store, { marketName: "g18 legacy", parsed: structuredClone(stale), capturedAt: "2026-01-01T00:00:00.000Z", actor: "tester", runScreen: true });
	const v2 = saveStrategyVersion(store, { yaml: DEFAULT_STRATEGY_YAML, actor: "tester" });
	assert.equal(v2.version, 2);
	const v2Run = runStrategy(store, { marketRef: t0.market.id, strategyRef: `${v2.id}@v2`, mode: "screen", actor: "tester" });
	const v1Run = runStrategy(store, { marketRef: t0.market.id, strategyRef: `${v2.id}@v1`, mode: "screen", actor: "tester" });
	assert.equal(v2Run.strategyVersion, 2);
	assert.equal(v1Run.strategyVersion, 1);
	const t1 = importMarketAndScreen(store, { marketName: "g18 legacy", parsed: structuredClone(stale), capturedAt: "2026-01-05T00:00:00.000Z", actor: "tester", runScreen: false });
	decideCandidate(store, { candidateRef: t0.candidate.id, status: "no_go", reason: "新品占比未达门槛", actor: "tester" });
	const decision = store.decisionLog.filter((item) => item.type === "decision").at(-1)!;
	assert.equal(decision.strategyVersion, 1);
	assert.equal(decision.snapshotId, t1.snapshot.id);
	delete decision.strategyRunId;
	const t2 = importMarketAndScreen(store, { marketName: "g18 legacy", parsed: structuredClone(improved), capturedAt: "2026-01-15T00:00:00.000Z", actor: "tester", runScreen: false });
	assert.equal(t2.outcomeCheck?.baselineRunId, v1Run.id);
	assert.notEqual(t2.outcomeCheck?.baselineRunId, v2Run.id);
	assert.equal(t2.outcomeCheck?.verdict, "challenged");
});

// —— 审计 G18 回归 ——
test("a no_go decided with no strategy run at all stays inconclusive instead of borrowing one", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const stale = structuredClone(parsed);
	for (const listing of stale.listings) {
		listing.monthsOnline = 24;
		listing.launchDate = undefined;
	}
	const improved = structuredClone(parsed);
	for (const listing of improved.listings) {
		listing.monthsOnline = 1;
		listing.launchDate = undefined;
	}
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const t0 = importMarketAndScreen(store, { marketName: "g18 no anchor", parsed: structuredClone(stale), capturedAt: "2026-01-01T00:00:00.000Z", actor: "tester", runScreen: false });
	decideCandidate(store, { candidateRef: t0.candidate.id, status: "no_go", reason: "人工判断供应链不可做", actor: "tester" });
	const decision = store.decisionLog.filter((item) => item.type === "decision").at(-1)!;
	assert.equal(decision.strategyId, undefined);
	assert.equal(decision.strategyRunId, undefined);
	const t1 = importMarketAndScreen(store, { marketName: "g18 no anchor", parsed: structuredClone(improved), capturedAt: "2026-01-15T00:00:00.000Z", actor: "tester", runScreen: true });
	assert.ok(t1.screenRun);
	assert.equal(t1.outcomeCheck?.baselineRunId, undefined);
	assert.equal(t1.outcomeCheck?.verdict, "inconclusive");
	assert.match(t1.outcomeCheck?.verdictReason ?? "", /缺少可重放的基线策略运行/);
});

// —— 审计 G18 回归 ——
test("a fallback baseline whose veto already passed at decision time cannot be replayed", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const stale = structuredClone(parsed);
	for (const listing of stale.listings) {
		listing.monthsOnline = 24;
		listing.launchDate = undefined;
	}
	const improved = structuredClone(parsed);
	for (const listing of improved.listings) {
		listing.monthsOnline = 1;
		listing.launchDate = undefined;
	}
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const t0 = importMarketAndScreen(store, { marketName: "g18 lapsed premise", parsed: structuredClone(stale), capturedAt: "2026-01-01T00:00:00.000Z", actor: "tester", runScreen: true });
	assert.equal(t0.screenRun?.result.outcome, "reject");
	const t1 = importMarketAndScreen(store, { marketName: "g18 lapsed premise", parsed: structuredClone(improved), capturedAt: "2026-01-05T00:00:00.000Z", actor: "tester", runScreen: false });
	decideCandidate(store, { candidateRef: t0.candidate.id, status: "no_go", reason: "供应链打样失败，不做", actor: "tester" });
	const decision = store.decisionLog.filter((item) => item.type === "decision").at(-1)!;
	assert.equal(decision.snapshotId, t1.snapshot.id);
	assert.equal(decision.strategyRunId, t0.screenRun?.id);
	const t2 = importMarketAndScreen(store, { marketName: "g18 lapsed premise", parsed: structuredClone(improved), capturedAt: "2026-01-15T00:00:00.000Z", actor: "tester", runScreen: false });
	assert.equal(t2.outcomeCheck?.baselineRunId, t0.screenRun?.id);
	assert.equal(t2.outcomeCheck?.verdict, "inconclusive");
	assert.match(t2.outcomeCheck?.verdictReason ?? "", /基线否决前提在决策当下已经转 pass/);
});

test("补数状态文件：不存在静默、坏内容要说出来，覆盖前先留备份", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-gapfill-state-"));
	try {
		const repo = new CompassRepository(root);

		// 第一次使用：文件不存在是常态，静默回默认
		assert.deepEqual(await repo.readGapfillState(), {});

		await repo.writeGapfillState({ version: 1, mode: "strict", mutedGaps: [{ id: "gap_demo", until: "2099-01-01T00:00:00.000Z" }] });
		const saved = await repo.readGapfillState();
		assert.equal((saved.value as { mode?: string }).mode, "strict");
		assert.equal(saved.error, undefined);
		const mode = await stat(repo.gapfillStatePath);
		assert.equal(mode.mode & 0o777, 0o600, "状态文件必须是 0600");

		// 运营手改坏了（.jsonc 就是给人看的）：必须报出来，不能静默把档位与静音清单退回默认
		await writeFile(repo.gapfillStatePath, '{ "version": 1, "mode": "strict", }\n', "utf8");
		const broken = await repo.readGapfillState();
		assert.equal(broken.value, undefined);
		assert.match(broken.error ?? "", /解析失败/u, "解析失败必须与「文件不存在」区分开");

		// 之后的第一次写会整份覆盖：先留一份 .bak，别把还认得出的旧内容永久销毁
		await repo.writeGapfillState({ version: 1, mode: "guided", mutedGaps: [] }, { backupExisting: true });
		const backup = await readFile(`${repo.gapfillStatePath}.bak`, "utf8");
		assert.match(backup, /"mode": "strict"/u, "备份里应保留运营手改前的内容");
		assert.equal((await repo.readGapfillState()).error, undefined, "覆盖后的新文件必须能正常解析");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

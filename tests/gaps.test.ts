import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_STRATEGY_YAML } from "../defaults.ts";
import {
	CSV_COLUMN_WARNINGS,
	FIELD_LABEL_EXTRA,
	GAP_ORIGINS,
	GAP_SOURCE_MATRIX,
	PROFIT_ASSUMED_DEFAULTS,
	RISK_CONTEXT_METRICS,
	deriveGaps,
	diffGaps,
	gapActionLine,
	gapLabel,
	gapRouteKey,
	gapTtlDays,
	renderGapNote,
	summarizeGaps,
	transientProfitUnpersistedGap,
	type GapBudgetPool,
	type GapOrigin,
	type GapRecord,
} from "../gaps.ts";
import { capHistoryLines } from "../history.ts";
import { METRIC_LABELS } from "../report.ts";
import { listWorkbenchTodos } from "../service.ts";
import { createEmptyStore } from "../store.ts";
import { missingDeepResearchFields } from "../todo.ts";
import type { Candidate, CandidateStage, CompassStore, MetricMap, ProfitInput, ProfitResult, ReviewTheme, RiskEvidenceItem, RiskStatus } from "../types.ts";

// 全部夹具都是虚构数据：ASIN 一律 B0DEMO 前缀，市场名用通用品类词。
// compass 是公开仓库且带公开 CI，断言失败的输出会进公网 Actions 日志。
const NOW = "2026-09-03T00:00:00.000Z";
const T0 = "2026-08-01T00:00:00.000Z";

function baseStore(): CompassStore {
	return createEmptyStore(T0);
}

function addMarket(store: CompassStore, id: string, name: string): void {
	store.markets.push({ id, name, keywords: [], createdAt: T0, updatedAt: T0 });
}

function addCandidate(store: CompassStore, id: string, marketId: string, stage: CandidateStage, extra: Partial<Candidate> = {}): Candidate {
	const candidate: Candidate = { id, marketId, stage, tags: [], createdAt: T0, updatedAt: T0, ...extra };
	store.candidates.push(candidate);
	return candidate;
}

function addSnapshot(
	store: CompassStore,
	id: string,
	marketId: string,
	capturedAt: string,
	options: { metrics?: MetricMap; warnings?: string[]; source?: string } = {},
): void {
	store.snapshots.push({
		id,
		marketId,
		source: options.source ?? "manual_csv",
		capturedAt,
		importedAt: capturedAt,
		rowCount: 0,
		listings: [],
		keywords: [],
		metrics: options.metrics ?? {},
		warnings: options.warnings ?? [],
	});
}

function metric(value: number | null): MetricMap[string] {
	return { value, source: "manual_csv", capturedAt: T0, confidence: 0.7 };
}

function addStrategyRun(store: CompassStore, id: string, marketId: string, mode: "screen" | "full", missingMetrics: string[], runAt = T0): void {
	store.strategyRuns.push({
		id,
		strategyId: "jingpu-daily10",
		strategyVersion: 1,
		marketId,
		snapshotId: "snap_demo",
		mode,
		result: { outcome: "review", score: 0, dimensionScores: {}, rules: [], missingMetrics },
		runAt,
		actor: "ops",
	});
}

function profitInput(overrides: Partial<ProfitInput> = {}): ProfitInput {
	return {
		salePrice: 19.99,
		purchaseCost: 4,
		firstMileCost: 0,
		tariffCost: 0,
		referralRate: 0.15,
		fbaFee: 4.5,
		cvr: 0.12,
		returnRate: 0.05,
		returnProcessingFee: 0,
		residualValue: 0,
		dailyUnits: 10,
		stockDays: 60,
		testAdBudget: 0,
		oneTimeCosts: 0,
		tacosScenarios: [0.1, 0.15, 0.2],
		currency: "USD",
		...overrides,
	};
}

function profitResult(warnings: string[]): ProfitResult {
	return {
		landedCost: 8.5,
		referralFee: 3,
		grossProfit: 8,
		grossMargin: 0.4,
		breakEvenCpc: 0.9,
		returnLossRate: 0.05,
		netMarginScenarios: [],
		monthlyRevenue: 6000,
		monthlyNetProfitScenarios: [],
		firstInventoryCost: 5100,
		startupCapital: 5100,
		paybackMonthsScenarios: [],
		warnings,
	};
}

function addProfit(store: CompassStore, id: string, marketId: string, warnings: string[], input: Partial<ProfitInput> = {}, createdAt = T0): void {
	store.profitEstimates.push({ id, marketId, input: profitInput({ marketId, ...input }), result: profitResult(warnings), createdAt, actor: "ops" });
}

function addRisk(
	store: CompassStore,
	id: string,
	marketId: string,
	overall: RiskStatus,
	evidence: RiskEvidenceItem[],
	notes?: string,
	createdAt = T0,
): void {
	store.riskRecords.push({
		id,
		marketId,
		certStatus: "pass",
		ipRiskLevel: "pass",
		seasonFlag: "clear",
		policyFlag: "clear",
		logisticsRisk: "pass",
		overall,
		evidence,
		notes,
		createdAt,
		actor: "ops",
	});
}

function addReview(
	store: CompassStore,
	id: string,
	marketId: string,
	options: { themes?: ReviewTheme[]; estimatedRatingGap?: number } = {},
	createdAt = T0,
): void {
	store.reviewAnalyses.push({
		id,
		marketId,
		sourceAsins: ["B0DEMO0007"],
		reviewCount: 120,
		themes: options.themes ?? [],
		estimatedRatingGap: options.estimatedRatingGap,
		createdAt,
		actor: "ops",
	});
}

const SORFTIME_CONFIGURED: GapBudgetPool = {
	source: "sorftime",
	tier: "A",
	enabled: true,
	monthlyLimitCny: 0,
	monthlyCallLimit: 200,
	state: "ok",
};

const SORFTIME_UNCONFIGURED: GapBudgetPool = { source: "sorftime", tier: "A", enabled: true, monthlyLimitCny: 0, state: "free" };

function derive(store: CompassStore, overrides: Partial<Parameters<typeof deriveGaps>[1]> = {}): GapRecord[] {
	return deriveGaps(store, { todos: listWorkbenchTodos(store, NOW), now: NOW, ...overrides });
}

function fieldsOf(gaps: readonly GapRecord[]): string[] {
	return gaps.map((gap) => gap.field).sort();
}

// ── 十二种 origin ─────────────────────────────────────────────────────────────

// 一个尽量覆盖全部来源的 store：五条缺列告警 + 两种 run + 深研待办 + 风险 + 差评 + 实绩 + 静默默认
function fullCoverageStore(): CompassStore {
	const store = baseStore();
	addMarket(store, "mkt_demo_clear_bag", "demo clear bag");
	addCandidate(store, "cand_demo_1", "mkt_demo_clear_bag", "deep_research");
	addSnapshot(store, "snap_demo_1", "mkt_demo_clear_bag", "2026-06-01T00:00:00.000Z", {
		warnings: [
			"未识别到月销量列，QRD、CR3、HHI 等销量指标会缺失或降置信度",
			"未识别到品牌列，品牌集中度指标不可计算",
			"未识别到评分列，低分高销数与腰部星级指标不可计算",
			"未识别到上架日期/月龄，新品占比不可计算",
			"未识别到卖家类型/自营列，AMZ 自营占比不可计算",
			// 同一数组里的非缺列告警：不得被当成缺口
			"CSV 有 2 个表头含乱码字符「�」，请改用 UTF-8 或 GB18030 重新导出",
			"快照明细文件缺失或损坏，listing/keyword 指标按缺数据处理：snapshots/snap_demo_1.json",
			"疑似宽表布局：关键词词族不完整",
		],
	});
	addStrategyRun(store, "run_screen_1", "mkt_demo_clear_bag", "screen", ["cr3"], "2026-08-20T00:00:00.000Z");
	addStrategyRun(store, "run_full_1", "mkt_demo_clear_bag", "full", ["gross_margin", "capital_share"], "2026-08-21T00:00:00.000Z");
	addProfit(store, "est_1", "mkt_demo_clear_bag", ["未提供主词 CPC，CPC 承受度 Gate 保持待复核"]);
	addRisk(store, "risk_1", "mkt_demo_clear_bag", "review", [{ category: "cert", checkedAt: T0 }], "各项虽填 pass/clear，但没有可点击证据链接，系统自动降级为 review");
	// 第二个市场承载 metric_divergence 与 retro_actuals：两个来源的类目月销差 >30%
	addMarket(store, "mkt_demo_yoga_strap", "demo yoga strap");
	addCandidate(store, "cand_demo_2", "mkt_demo_yoga_strap", "testing", { decisionStatus: "go", decisionAt: "2026-08-10T00:00:00.000Z" });
	addSnapshot(store, "snap_demo_2", "mkt_demo_yoga_strap", "2026-09-02T00:00:00.000Z", {
		metrics: { main_cpc: metric(0.46), category_monthly_sales: metric(10_000) },
	});
	addSnapshot(store, "snap_demo_2b", "mkt_demo_yoga_strap", "2026-09-01T00:00:00.000Z", {
		source: "sorftime",
		metrics: { category_monthly_sales: metric(4_000) },
	});
	// 第三个市场承载 todo_risk_missing：风控阶段但风险清单未做
	addMarket(store, "mkt_demo_lint_roller", "demo lint roller");
	addCandidate(store, "cand_demo_3", "mkt_demo_lint_roller", "risk");
	addSnapshot(store, "snap_demo_3", "mkt_demo_lint_roller", "2026-09-01T00:00:00.000Z");
	return store;
}

test("十二种 origin 各至少产出一条缺口", () => {
	const store = fullCoverageStore();
	const gaps = deriveGaps(store, {
		todos: listWorkbenchTodos(store, NOW),
		now: NOW,
		budgets: [SORFTIME_CONFIGURED],
	});
	const seen = new Set<GapOrigin>(gaps.map((gap) => gap.origin));
	// 瞬时缺口不进 deriveGaps（无 market_ref 的利润测算在 store 里零痕迹），单独补上
	seen.add(transientProfitUnpersistedGap({ summary: "毛利率 40%" }).origin);
	const missing = GAP_ORIGINS.filter((origin) => !seen.has(origin));
	assert.deepEqual(missing, [], `这些 origin 没有任何用例覆盖：${missing.join("、")}`);
});

test("非缺列告警不被误判成缺口（乱码、sidecar 损坏、宽表布局三条）", () => {
	const store = fullCoverageStore();
	const gaps = derive(store).filter((gap) => gap.marketId === "mkt_demo_clear_bag" && gap.origin === "csv_warning");
	assert.equal(gaps.length, 5, "五条缺列告警各一条，非缺列告警一条都不该进来");
	assert.deepEqual(fieldsOf(gaps), [
		"csv_column:brand",
		"csv_column:launchDate",
		"csv_column:monthlySales",
		"csv_column:rating",
		"csv_column:seller",
	]);
});

test("strategy_missing 取 full run 优先回落 screen run", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_bag", "demo bag");
	// 用粗筛阶段隔离 strategy_missing：深研阶段会另生一条 deep_missing_data 待办，
	// 两者在 gross_margin 上会被合并（这是期望的去重行为，另有用例专测）
	addCandidate(store, "cand_demo_bag", "mkt_demo_bag", "screen");
	addSnapshot(store, "snap_bag", "mkt_demo_bag", "2026-09-01T00:00:00.000Z");
	addStrategyRun(store, "run_screen", "mkt_demo_bag", "screen", ["cr3"], "2026-08-20T00:00:00.000Z");
	// full run 更早，但仍然必须被取到：例行导入只会刷新 screen run
	addStrategyRun(store, "run_full", "mkt_demo_bag", "full", ["gross_margin"], "2026-08-10T00:00:00.000Z");
	const strategyGaps = derive(store).filter((gap) => gap.origin === "strategy_missing");
	assert.deepEqual(fieldsOf(strategyGaps), ["cr3", "gross_margin"], "两种 mode 的 missingMetrics 必须取并集");
	assert.ok(strategyGaps.every((gap) => gap.fingerprint.includes("run_full") && gap.fingerprint.includes("run_screen")));
});

test("同一字段上 strategy_missing 与深研待办只留一条，reason 合并、todoId 挂上", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_merge", "demo merge");
	addCandidate(store, "cand_demo_merge", "mkt_demo_merge", "deep_research");
	addSnapshot(store, "snap_merge", "mkt_demo_merge", "2026-09-01T00:00:00.000Z");
	addStrategyRun(store, "run_merge", "mkt_demo_merge", "full", ["gross_margin"], "2026-08-20T00:00:00.000Z");
	const merged = derive(store).filter((gap) => gap.field === "gross_margin");
	assert.equal(merged.length, 1, "同一字段只留一条");
	assert.equal(merged[0].origin, "todo_deep_missing", "待办比策略更具体，做主键");
	assert.ok(merged[0].todoId?.startsWith("todo_deep_missing_data_"), "必须关联回 todo id");
	assert.match(merged[0].reason, /策略评估缺指标/u, "被合并掉的来源要留在 reason 里");
	assert.ok(merged[0].fingerprint.includes("run_merge"), "证据摘要要包含两边");
});

test("缺列时把受影响指标折进同一条缺口，不出两行同义提示", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_mat", "demo mat");
	addCandidate(store, "cand_demo_mat", "mkt_demo_mat", "deep_research");
	addSnapshot(store, "snap_mat", "mkt_demo_mat", "2026-09-01T00:00:00.000Z", {
		warnings: ["未识别到评分列，低分高销数与腰部星级指标不可计算"],
	});
	addStrategyRun(store, "run_mat", "mkt_demo_mat", "full", ["waist_rating_median"], "2026-08-20T00:00:00.000Z");
	const gaps = derive(store);
	assert.equal(gaps.filter((gap) => gap.field === "waist_rating_median").length, 0, "指标名应折进缺列伪字段");
	const folded = gaps.find((gap) => gap.field === "csv_column:rating");
	assert.ok(folded, "应保留一条评分列缺口");
	assert.equal(folded.origin, "csv_warning", "主键取更具体的缺列来源");
	assert.match(folded.reason, /腰部星级/u, "被折进来的策略缺口原因必须合并进 reason");
});

// ── 三分档与来源排序 ──────────────────────────────────────────────────────────

test("autoTier 三分与来源排序：C 在 A 之前，A 在人工之前", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_tier", "demo tier");
	addCandidate(store, "cand_demo_tier", "mkt_demo_tier", "deep_research");
	addSnapshot(store, "snap_tier", "mkt_demo_tier", "2026-09-01T00:00:00.000Z", {
		warnings: ["未识别到评分列，低分高销数与腰部星级指标不可计算"],
	});
	addRisk(store, "risk_tier", "mkt_demo_tier", "review", [{ category: "cert", checkedAt: T0 }]);
	const gaps = derive(store, { budgets: [SORFTIME_CONFIGURED] });

	const csvGap = gaps.find((gap) => gap.field === "csv_column:rating");
	assert.ok(csvGap);
	assert.equal(csvGap.autoTier, "C_auto", "重导 CSV 是 C 档且 auto=yes");
	assert.deepEqual(csvGap.sources.map((option) => option.tier), ["C", "A"], "来源必须按 C → A → manual 排序");

	const riskGap = gaps.find((gap) => gap.field === "risk_evidence_url");
	assert.ok(riskGap);
	assert.equal(riskGap.autoTier, "manual", "风险证据链接只能人工");

	// 有本地历史 CPC 时主词 CPC 是 C 档；没有时退回 A 档（池已配上限）
	addProfit(store, "est_tier", "mkt_demo_tier", ["未提供主词 CPC，CPC 承受度 Gate 保持待复核"]);
	const withoutHistory = derive(store, { budgets: [SORFTIME_CONFIGURED] }).find((gap) => gap.field === "main_cpc");
	assert.ok(withoutHistory);
	assert.equal(withoutHistory.autoTier, "A_confirm", "无本地历史且 sorftime 已配上限时是 A 档");

	store.snapshots[0].metrics.main_cpc = metric(0.46);
	const withHistory = derive(store, { budgets: [SORFTIME_CONFIGURED] }).find((gap) => gap.field === "main_cpc");
	assert.ok(withHistory);
	assert.equal(withHistory.autoTier, "C_auto", "有本地历史 CPC 时降为 C 档");
});

test("sorftime 池没配可生效上限时不算 A 档（熔断门会空转）", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_free", "demo free");
	addCandidate(store, "cand_demo_free", "mkt_demo_free", "deep_research");
	addSnapshot(store, "snap_free", "mkt_demo_free", "2026-09-01T00:00:00.000Z");
	addProfit(store, "est_free", "mkt_demo_free", ["未提供主词 CPC，CPC 承受度 Gate 保持待复核"]);
	const gap = derive(store, { budgets: [SORFTIME_UNCONFIGURED] }).find((item) => item.field === "main_cpc");
	assert.ok(gap);
	assert.equal(gap.autoTier, "manual", "默认 ¥0 无上限的池不能算 A_confirm");
	const sorftime = gap.sources.find((option) => option.source === "sorftime");
	assert.equal(sorftime?.limitConfigured, false);
	assert.equal(sorftime?.available, true, "未熔断仍算 available，只是上限没配");
});

test("只配金额上限而单价缺省同样不算已配上限", () => {
	const pool: GapBudgetPool = { source: "sorftime", tier: "A", enabled: true, monthlyLimitCny: 500, state: "ok" };
	const store = baseStore();
	addMarket(store, "mkt_demo_price", "demo price");
	addCandidate(store, "cand_demo_price", "mkt_demo_price", "deep_research");
	addSnapshot(store, "snap_price", "mkt_demo_price", "2026-09-01T00:00:00.000Z");
	addProfit(store, "est_price", "mkt_demo_price", ["未提供主词 CPC，CPC 承受度 Gate 保持待复核"]);
	const gap = derive(store, { budgets: [pool] }).find((item) => item.field === "main_cpc");
	assert.equal(gap?.autoTier, "manual");
});

// ── 利润 / 风险 / 差评 / 复盘各自的判据 ────────────────────────────────────────

test("profit_cpc 只认前两条文案，毛利为负那条不算补数缺口", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_margin", "demo margin");
	addCandidate(store, "cand_demo_margin", "mkt_demo_margin", "deep_research");
	addSnapshot(store, "snap_margin", "mkt_demo_margin", "2026-09-01T00:00:00.000Z");
	addProfit(store, "est_margin", "mkt_demo_margin", ["毛利不足以形成正向盈亏平衡 CPC，CPC 承受度 Gate 保持待复核"]);
	assert.equal(derive(store).filter((gap) => gap.origin === "profit_cpc").length, 0, "毛利为负的动作是提高毛利，不是补 CPC");

	store.profitEstimates[0].result.warnings = ["主词 CPC 为 0，按缺数据处理（Amazon 最低竞价约 $0.02），CPC 承受度 Gate 保持待复核"];
	assert.equal(derive(store).filter((gap) => gap.origin === "profit_cpc").length, 1);
});

test("defaults_silent 是启发式，文案必须写「为假设」而不是「未填」", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_assume", "demo assume");
	addCandidate(store, "cand_demo_assume", "mkt_demo_assume", "deep_research");
	addSnapshot(store, "snap_assume", "mkt_demo_assume", "2026-09-01T00:00:00.000Z");
	addProfit(store, "est_assume", "mkt_demo_assume", []);
	const assumed = derive(store).filter((gap) => gap.origin === "defaults_silent");
	assert.deepEqual(fieldsOf(assumed), ["cvr", "firstMileCost", "returnRate", "tariffCost"]);
	for (const gap of assumed) {
		assert.match(gap.reason, /为假设/u);
		assert.doesNotMatch(gap.reason, /未填/u, "落库值区分不了显式填写与默认，不能断言「未填」");
	}
	// 显式给了非默认值就不再报
	store.profitEstimates[0].input.firstMileCost = 1.2;
	assert.equal(derive(store).filter((gap) => gap.field === "firstMileCost").length, 0);
});

test("risk_url 判据看「无 URL」而不是只看 overall=review", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_risk", "demo risk");
	addCandidate(store, "cand_demo_risk", "mkt_demo_risk", "risk");
	addSnapshot(store, "snap_risk", "mkt_demo_risk", "2026-09-01T00:00:00.000Z");
	// 有链接但因季节性 review：不该产出 risk_url
	addRisk(store, "risk_season", "mkt_demo_risk", "review", [{ category: "season", url: "https://example.invalid/demo", checkedAt: T0 }]);
	assert.equal(derive(store).filter((gap) => gap.origin === "risk_url").length, 0);

	store.riskRecords[0].evidence = [{ category: "cert", checkedAt: T0 }];
	assert.equal(derive(store).filter((gap) => gap.origin === "risk_url").length, 1);
});

test("差评缺口分「没有记录」「缺预估星级」「主题无原句」三种", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_review", "demo review");
	addCandidate(store, "cand_demo_review", "mkt_demo_review", "deep_research");
	addSnapshot(store, "snap_review", "mkt_demo_review", "2026-09-01T00:00:00.000Z");
	const noRecord = derive(store).filter((gap) => gap.origin === "review_evidence");
	assert.deepEqual(fieldsOf(noRecord), ["review_evidence"]);
	assert.match(noRecord[0].reason, /尚无差评分析记录/u);

	addReview(store, "rev_1", "mkt_demo_review", {
		themes: [{ name: "拉链易坏", category: "quality", count: 12, fixability: "factory" }],
	});
	const withRecord = derive(store).filter((gap) => gap.origin === "review_evidence");
	assert.deepEqual(fieldsOf(withRecord), ["estimated_rating", "review_evidence"]);

	store.reviewAnalyses[0].estimatedRatingGap = -0.1;
	store.reviewAnalyses[0].themes[0].evidence = ["zipper broke after two weeks"];
	assert.equal(derive(store).filter((gap) => gap.origin === "review_evidence").length, 0);
});

test("retro_actuals 只对已决 go 的候选发起，且日销与净利率必须同时有值", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_retro", "demo retro");
	const candidate = addCandidate(store, "cand_demo_retro", "mkt_demo_retro", "testing");
	addSnapshot(store, "snap_retro", "mkt_demo_retro", "2026-09-01T00:00:00.000Z");
	assert.equal(derive(store).filter((gap) => gap.origin === "retro_actuals").length, 0, "未决候选不产实绩缺口");

	candidate.decisionStatus = "go";
	candidate.decisionAt = "2026-08-10T00:00:00.000Z";
	assert.equal(derive(store).filter((gap) => gap.origin === "retro_actuals").length, 1);

	store.outcomeChecks.push({
		id: "chk_1",
		marketId: "mkt_demo_retro",
		baselineSnapshotId: "snap_retro",
		actuals: { dailyUnits: 12 },
		deltas: [],
		verdict: "inconclusive",
		verdictReason: "日销与净利率必须同时有实绩，当前证据不足",
		elapsedDays: 20,
		createdAt: "2026-09-01T00:00:00.000Z",
		actor: "ops",
	});
	assert.equal(derive(store).filter((gap) => gap.origin === "retro_actuals").length, 1, "只有日销没有净利率仍算缺");

	store.outcomeChecks[0].actuals = { dailyUnits: 12, netMargin: 0.18 };
	assert.equal(derive(store).filter((gap) => gap.origin === "retro_actuals").length, 0);
});

// ── 与 todo.ts 的耦合 ─────────────────────────────────────────────────────────

test("深研待办的 reason 措辞仍能被折回字段名（todo.ts 改文案时先红）", () => {
	// 这条用例是与 todo.ts 的显式耦合：gaps.ts 靠解析「缺 主词CPC、毛利率」把标签折回字段名，
	// 一旦 missingDeepResearchFields 或 deep_missing_data 的 reason 改措辞，这里先红
	const labels = missingDeepResearchFields({});
	assert.deepEqual(labels, ["主词CPC", "毛利率", "CPC承受度", "腰部星级"]);

	const store = baseStore();
	addMarket(store, "mkt_demo_deep", "demo deep");
	addCandidate(store, "cand_demo_deep", "mkt_demo_deep", "deep_research");
	addSnapshot(store, "snap_deep", "mkt_demo_deep", "2026-09-01T00:00:00.000Z");
	const todos = listWorkbenchTodos(store, NOW);
	const deepTodo = todos.find((todo) => todo.kind === "deep_missing_data");
	assert.ok(deepTodo, "深研候选必然有一条 deep_missing_data 待办");
	assert.equal(deepTodo.reason, `缺 ${labels.join("、")}`);

	const gaps = deriveGaps(store, { todos, now: NOW }).filter((gap) => gap.origin === "todo_deep_missing");
	assert.deepEqual(fieldsOf(gaps), ["cpc_ratio", "gross_margin", "main_cpc", "waist_rating_median"]);
	assert.ok(gaps.every((gap) => gap.todoId === deepTodo.id), "每条都要挂回 todoId");
});

test("深研四项齐备时转成「深研确认」人工缺口而不是消失", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_ready", "demo ready");
	addCandidate(store, "cand_demo_ready", "mkt_demo_ready", "deep_research");
	addSnapshot(store, "snap_ready", "mkt_demo_ready", "2026-09-01T00:00:00.000Z", {
		metrics: Object.fromEntries(["main_cpc", "gross_margin", "cpc_ratio", "waist_rating_median"].map((name) => [name, metric(1)])),
	});
	const gap = derive(store).find((item) => item.origin === "todo_deep_missing");
	assert.ok(gap);
	assert.equal(gap.field, "deep_research_confirm");
	assert.equal(gap.autoTier, "manual");
	assert.equal(gap.sources[0].writeBack, "todo_submit");
});

test("快照过期缺口的 TTL 跟 todo 的固定 30 天，不用 stage TTL", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_stale", "demo stale");
	addCandidate(store, "cand_demo_stale", "mkt_demo_stale", "deep_research");
	addSnapshot(store, "snap_stale", "mkt_demo_stale", "2026-05-01T00:00:00.000Z");
	const gap = derive(store).find((item) => item.origin === "todo_snapshot_stale");
	assert.ok(gap, "125 天前的快照必然浮出 snapshot_stale");
	assert.equal(gap.ttlDays, 30, "与 todo.ts 的判据同口径，不能写 deep_research 的 7 天");
	assert.equal(gapTtlDays("deep_research"), 7);
	assert.equal(gapTtlDays("decision"), 7);
	assert.equal(gapTtlDays("review"), 1);
	assert.equal(gapTtlDays("archived"), null);
});

test("archived 候选不产任何缺口", () => {
	const store = fullCoverageStore();
	for (const candidate of store.candidates) candidate.stage = "archived";
	assert.deepEqual(derive(store), []);
});

// ── fingerprint / diff / 静音 / 摘要 ──────────────────────────────────────────

test("fingerprint diff：证据不变不判新增，换一次快照即判新增", () => {
	const store = fullCoverageStore();
	const first = derive(store);
	const round1 = diffGaps(new Set<string>(), first);
	assert.equal(round1.added.length, first.length, "首轮全部算新增");

	const round2 = diffGaps(round1.fingerprints, derive(store));
	assert.deepEqual(round2.added, [], "证据没变就不该再判新增");

	addSnapshot(store, "snap_demo_3", "mkt_demo_clear_bag", "2026-09-02T00:00:00.000Z", {
		warnings: ["未识别到评分列，低分高销数与腰部星级指标不可计算"],
	});
	const round3 = diffGaps(round1.fingerprints, derive(store));
	assert.ok(
		round3.added.some((gap) => gap.field === "csv_column:rating"),
		"换了最新快照，评分列缺口的指纹应变化并判为新增",
	);
});

test("静音的缺口不进尾注与状态栏计数，list 仍可见", () => {
	const store = fullCoverageStore();
	const target = derive(store).find((gap) => gap.field === "csv_column:rating");
	assert.ok(target);
	const muted = derive(store, { muted: [{ id: target.id, until: "2026-09-20T00:00:00.000Z" }] });
	const mutedGap = muted.find((gap) => gap.id === target.id);
	assert.ok(mutedGap?.mutedUntil, "list 面仍能看到这一条，只是带静音标记");
	assert.equal(summarizeGaps(muted).total, summarizeGaps(derive(store)).total - 1, "状态栏计数要把静音的排除");
	assert.deepEqual(renderGapNote([mutedGap], { marketName: "demo clear bag", stage: "deep_research", ttlDays: 7 }), [], "尾注不出静音条目");

	// 过期的静音自动失效
	const expired = derive(store, { muted: [{ id: target.id, until: "2026-08-01T00:00:00.000Z" }] });
	assert.equal(expired.find((gap) => gap.id === target.id)?.mutedUntil, undefined);
});

test("按市场静音：整个市场的缺口一次静音", () => {
	const store = fullCoverageStore();
	const muted = derive(store, { muted: [{ id: "mkt_demo_clear_bag", until: "2026-09-20T00:00:00.000Z" }] });
	const bag = muted.filter((gap) => gap.marketId === "mkt_demo_clear_bag");
	assert.ok(bag.length > 0);
	assert.ok(bag.every((gap) => gap.mutedUntil), "市场级静音要盖住该市场全部缺口");
	assert.ok(muted.filter((gap) => gap.marketId === "mkt_demo_yoga_strap").every((gap) => !gap.mutedUntil), "别的市场不受影响");
});

test("会话中途过期的 gap 级静音，不得盖掉仍然有效的市场级静音", () => {
	const store = fullCoverageStore();
	const target = derive(store).find((gap) => gap.field === "csv_column:rating");
	assert.ok(target);
	// 过期的那条排在前面：用 find 取第一个命中项就会判成「已过期」，整个市场的静音跟着失效
	const muted = derive(store, {
		muted: [
			{ id: target.id, until: "2026-08-01T00:00:00.000Z" },
			{ id: "mkt_demo_clear_bag", until: "2026-09-20T00:00:00.000Z" },
		],
	});
	assert.equal(muted.find((gap) => gap.id === target.id)?.mutedUntil, "2026-09-20T00:00:00.000Z", "应取所有命中项里最晚的 until");
	assert.ok(
		muted.filter((gap) => gap.marketId === "mkt_demo_clear_bag").every((gap) => gap.mutedUntil),
		"市场级静音仍在有效期内，该市场全部缺口都该带静音标记",
	);
});

test("marketId 入参把派生收敛到单个市场", () => {
	const store = fullCoverageStore();
	const scoped = derive(store, { marketId: "mkt_demo_yoga_strap" });
	assert.ok(scoped.length > 0);
	assert.ok(scoped.every((gap) => gap.marketId === "mkt_demo_yoga_strap"));
});

// ── 尾注渲染 ──────────────────────────────────────────────────────────────────

test("缺口行排前且合并后不超 7 行 650 字", () => {
	const store = fullCoverageStore();
	const gaps = derive(store, { marketId: "mkt_demo_clear_bag", budgets: [SORFTIME_CONFIGURED] });
	const note = renderGapNote(gaps, { marketName: "demo clear bag", stage: "deep_research", snapshotAgeDays: 94, ttlDays: 7 });
	assert.ok(note.length <= 5, `尾注最多 5 行，实际 ${note.length}`);
	assert.match(note[0], /^demo clear bag（深研/u);
	// 必须是可调用形态：plan 是 action 参数的取值，不是位置参数（这一行运营最可能直接复制）
	assert.match(note[note.length - 1], /^下一步：compass_gaps action=plan market_ref=mkt_demo_clear_bag/u);

	// 与 index.ts 的合并口径完全一致：缺口先切 5 行 400 字，剩余额度再给历史对照
	const history = ["历史对照行 A", "历史对照行 B", "历史对照行 C", "历史对照行 D", "历史对照行 E"];
	const gapPart = capHistoryLines(note, 5, 400);
	const gapChars = gapPart.reduce((sum, line) => sum + line.length + 1, 0);
	const historyPart = capHistoryLines(history, Math.max(0, 7 - gapPart.length), Math.max(0, 650 - gapChars));
	const merged = [...gapPart, ...historyPart];
	assert.ok(merged.length <= 7, `合并后最多 7 行，实际 ${merged.length}`);
	assert.ok(merged.reduce((sum, line) => sum + line.length + 1, 0) <= 650);
	assert.deepEqual(merged.slice(0, gapPart.length), gapPart, "缺口行必须排在历史对照之前");
});

test("人工模板不含未回答槽位的编造值", () => {
	const store = fullCoverageStore();
	const manual = derive(store).filter((gap) => gap.autoTier === "manual");
	assert.ok(manual.length > 0);
	for (const gap of manual) {
		const template = gap.sources.find((option) => option.tier === "manual")?.template;
		if (!template) continue;
		// 模板里只允许 {{占位符}}，不许出现具体数字（编造值）
		const stripped = template.replace(/\{\{[^}]*\}\}/gu, "");
		assert.doesNotMatch(stripped, /\d+\.\d+/u, `模板不得写死具体数值：${template}`);
		assert.match(template, /\{\{.+\}\}/u, `人工模板必须留占位符：${template}`);
	}
});

test("每一档的动作行都指向自己那档的来源，不拿 sources[0] 顶替", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_tierline", "demo tier line");
	addCandidate(store, "cand_demo_tierline", "mkt_demo_tierline", "deep_research");
	addSnapshot(store, "snap_tierline", "mkt_demo_tierline", "2026-09-01T00:00:00.000Z");
	addProfit(store, "est_tierline", "mkt_demo_tierline", ["未提供主词 CPC，CPC 承受度 Gate 保持待复核"]);
	const gap = derive(store, { budgets: [SORFTIME_CONFIGURED] }).find((item) => item.field === "main_cpc");
	assert.ok(gap);
	assert.equal(gap.autoTier, "A_confirm");
	// main_cpc 的来源排序是 [C local_history, A sorftime, manual]，sources[0] 是 C 档；
	// A 档的动作行若拿 sources[0]，就会打印出「A 档 local_history」这种自相矛盾的行
	assert.equal(gap.sources[0].tier, "C", "前提：排序仍是 C 在最前");
	const line = gapActionLine(gap);
	assert.match(line, /^A 档 sorftime/u, `A 档动作行必须点名 A 档来源，实得：${line}`);
	assert.doesNotMatch(line, /local_history/u);
});

test("A 档缺口的尾注给出可照做的 approve 命令（带 market_ref）", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_a", "demo a");
	addCandidate(store, "cand_demo_a", "mkt_demo_a", "deep_research");
	addSnapshot(store, "snap_a", "mkt_demo_a", "2026-09-01T00:00:00.000Z");
	addProfit(store, "est_a", "mkt_demo_a", ["未提供主词 CPC，CPC 承受度 Gate 保持待复核"]);
	const gaps = derive(store, { budgets: [SORFTIME_CONFIGURED] }).filter((gap) => gap.autoTier === "A_confirm");
	assert.ok(gaps.length > 0);
	const note = renderGapNote(gaps, { marketName: "demo a", stage: "deep_research", ttlDays: 7 });
	// 二期起 A 档给的是可照做的命令。钉的是「命令带上了市场」——只钉 action=approve 的话，
	// 把 market_ref 丢掉也照样绿，而没有市场的那条命令运营复制过去就报错
	assert.ok(
		note.some((line) => /compass_gaps action=approve market_ref=\S+/u.test(line)),
		`A 档尾注要给出带 market_ref 的 approve 命令：\n${note.join("\n")}`,
	);
	assert.ok(note.every((line) => !line.includes("二期上线")), "功能已上线，尾注不得再说「二期上线」");
});

// ── 路由表与公开仓库卫生 ──────────────────────────────────────────────────────

test("GAP_SOURCE_MATRIX 只用预算池已有的来源名，且不含内部 SOP 线索", () => {
	const allowed = new Set(["local_history", "manual_csv", "sorftime", "sellersprite", "keepa", "sp_api", "manual"]);
	const forbidden = /供应商名|货代公司|钉钉|飞书|微信|后台账号|密钥|token/iu;
	for (const [key, templates] of Object.entries(GAP_SOURCE_MATRIX)) {
		assert.ok(templates.length > 0, `${key} 至少要有一条来源`);
		for (const template of templates) {
			assert.ok(allowed.has(template.source), `${key} 用了不在预算池里的来源 ${template.source}`);
			assert.doesNotMatch(template.how, forbidden, `${key} 的 how 疑似含内部口径`);
			if (template.template) assert.doesNotMatch(template.template, forbidden, `${key} 的模板疑似含内部口径`);
		}
	}
});

test("每个 routeKey 都能在矩阵里找到条目，没有静默落到 generic 的字段", () => {
	const fields = [
		"csv_column:rating",
		"main_cpc",
		"cpc_ratio",
		"waist_rating_median",
		"snapshot",
		"gross_margin",
		"firstMileCost",
		"tariffCost",
		"cvr",
		"returnRate",
		"capital_share",
		"risk_evidence_url",
		"risk_check",
		"risk_overall",
		"review_evidence",
		"estimated_rating",
		"actuals",
		"metric_divergence",
		"deep_research_confirm",
		"market_ref",
	];
	for (const field of fields) {
		const key = gapRouteKey(field);
		assert.notEqual(key, "generic", `${field} 不该落到兜底路由`);
		assert.ok(GAP_SOURCE_MATRIX[key], `${key} 在矩阵里没有条目`);
	}
	assert.equal(gapRouteKey("something_unknown"), "generic");
	assert.deepEqual(
		PROFIT_ASSUMED_DEFAULTS.map((item) => item.field),
		["firstMileCost", "tariffCost", "cvr", "returnRate"],
	);
});

// ── 标签与路由的单一口径（评审 C1 / C2 的回归） ──────────────────────────────

test("六个风险指标折成一条 risk_check，指向 compass_risk_check 而不是「没有可自动补的来源」", () => {
	const store = baseStore();
	addMarket(store, "mkt_demo_riskmetrics", "demo risk metrics");
	addCandidate(store, "cand_demo_riskmetrics", "mkt_demo_riskmetrics", "risk");
	addSnapshot(store, "snap_riskmetrics", "mkt_demo_riskmetrics", "2026-09-01T00:00:00.000Z");
	// 无 RiskRecord 时 riskMetrics 返回 {}，full run 会把这六个一起登记成 missing
	addStrategyRun(store, "run_riskmetrics", "mkt_demo_riskmetrics", "full", [...RISK_CONTEXT_METRICS], "2026-08-20T00:00:00.000Z");
	const gaps = derive(store);

	// 一条，不是六条：它们同源同补法，逐个成条会把尾注的前 3 名全占掉
	const riskGaps = gaps.filter((gap) => gap.field === "risk_check");
	assert.equal(riskGaps.length, 1, `风险指标应折成一条，实得 ${riskGaps.length} 条`);
	assert.equal(riskGaps[0].sources[0].writeBack, "risk_check");
	assert.match(riskGaps[0].sources[0].how, /compass_risk_check/u, "补法必须指向那条一次写齐六项的工具");
	assert.match(riskGaps[0].reason, /认证状态/u, "被折进来的指标要在 reason 里列出来");

	// 没有任何缺口掉进 generic 的「没有可自动补的来源」
	for (const gap of gaps) {
		assert.notEqual(gapRouteKey(gap.field), "generic", `${gap.field} 落进了兜底路由，会给出「没有可自动补的来源」的错误建议`);
	}
	// 六个字段各自也不能掉进 generic（将来有人绕过折叠直接产字段时兜住）
	for (const metric of RISK_CONTEXT_METRICS) {
		assert.equal(gapRouteKey(metric), "risk_check", `${metric} 必须走风险清单路由`);
	}
});

test("指标中文名只有一处所有者：FIELD_LABEL_EXTRA 不得与 report.ts 的 METRIC_LABELS 重叠", () => {
	const overlap = Object.keys(FIELD_LABEL_EXTRA).filter((field) => field in METRIC_LABELS);
	assert.deepEqual(overlap, [], `这些字段在 METRIC_LABELS 里已有中文名，重抄一份就会出现「报告里叫 A、缺口里叫 B」：${overlap.join("、")}`);
	// 真指标走 METRIC_LABELS，不再吐英文 id
	assert.equal(gapLabel("ip_risk_level"), METRIC_LABELS.ip_risk_level);
	assert.equal(gapLabel("logistics_risk"), METRIC_LABELS.logistics_risk);
	assert.equal(gapLabel("cr3"), METRIC_LABELS.cr3);
	assert.equal(gapLabel("amz_share"), METRIC_LABELS.amz_share);
	// 深研四项仍用 todo.ts 的措辞，与待办列表逐字一致
	assert.equal(gapLabel("main_cpc"), "主词CPC");
	assert.equal(gapLabel("waist_rating_median"), "腰部星级");
});

test("默认策略引用的每个指标都有中文标签（新增指标忘配标签时先红）", () => {
	// 策略表达式里的标识符就是 missingMetrics 的取值来源。只在内置策略 YAML 里抽，
	// 不要扫整个 defaults.ts——那会把 TypeScript 的 number / string 之类一起抓进来
	const referenced = new Set(
		[...DEFAULT_STRATEGY_YAML.matchAll(/\b([a-z][a-z0-9_]{3,})\s*(?:>=|<=|==|!=|>|<)/gu)].map((match) => match[1]),
	);
	assert.ok(referenced.size >= 10, `只从内置策略里抽到 ${referenced.size} 个指标引用，抽取正则可能已失效`);
	const naked = [...referenced].filter((metric) => !metric.startsWith("qualify_rank_depth") && gapLabel(metric) === metric);
	assert.deepEqual(naked, [], `这些策略指标在缺口面会裸露英文 id：${naked.join("、")}`);
});

test("五条缺列告警字面量仍与 csv.ts 逐字一致（csv.ts 改措辞时先红）", () => {
	// 注释承诺过「csv.ts 改措辞时本表先红」。夹具是硬编码的，挡不住——这条才挡得住：
	// 改了 csv.ts 的告警文案而没同步本表，deriveGaps 的 includes 会永远为 false，缺口静默消失
	const source = readFileSync(new URL("../csv.ts", import.meta.url), "utf8");
	for (const item of CSV_COLUMN_WARNINGS) {
		assert.ok(source.includes(`"${item.warning}"`), `csv.ts 里已经没有这条告警文案，CSV_COLUMN_WARNINGS 需同步：${item.warning}`);
	}
	assert.equal(CSV_COLUMN_WARNINGS.length, 5, "缺列告警恰好五条；csv.ts 新增一条时要一起登记");
});

test("瞬时缺口不属于任何市场，也不进 deriveGaps", () => {
	const gap = transientProfitUnpersistedGap({ summary: "毛利率 40%" });
	assert.equal(gap.marketId, "-");
	assert.equal(gap.origin, "profit_unpersisted");
	assert.equal(gap.autoTier, "manual");
	assert.equal(gap.ttlDays, null);
	assert.match(gap.reason, /未关联市场/u);

	const store = fullCoverageStore();
	assert.equal(derive(store).filter((item) => item.origin === "profit_unpersisted").length, 0);
});

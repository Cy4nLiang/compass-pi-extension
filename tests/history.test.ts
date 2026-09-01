import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	actualsOutcomeVerdict,
	buildTimeline,
	calculateMetricDeltas,
	dueRetroItems,
	historyKeywordSet,
	jaccard,
	renderHistoryBrief,
	outcomeStatistics,
	renderHistoryNote,
	renderRetroReport,
	renderSessionLedger,
	replayOutcomeVerdict,
	retroDueConfig,
	retroReportFileName,
	similarMarkets,
} from "../history.ts";
import { createEmptyStore } from "../store.ts";
import type { CompassStore, DecisionStatus, Lesson, Market, MetricEvidence, OutcomeCheck, OutcomeVerdict, RuleEvaluation, StrategyEvaluation, StrategyRun } from "../types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const at = "2026-01-01T00:00:00.000Z";
const evidence = (value: number | null): MetricEvidence => ({ value, source: "test", capturedAt: at, confidence: 1 });

function market(id: string, name: string, keywords: string[], category?: string): Market {
	return { id, name, keywords, category, createdAt: at, updatedAt: at };
}

function rule(status: RuleEvaluation["status"]): RuleEvaluation {
	return {
		id: "entry",
		stage: "market_screen",
		action: "require",
		label: "新品占比",
		when: "new_listing_share_12m >= 0.15",
		condition: status === "pass",
		status,
		references: ["new_listing_share_12m"],
		evidence: {},
		message: status,
	};
}

function evaluation(status: RuleEvaluation["status"]): StrategyEvaluation {
	return {
		outcome: status === "pass" ? "pass" : status === "missing" ? "review" : "reject",
		score: 50,
		dimensionScores: {},
		rules: [rule(status)],
		missingMetrics: status === "missing" ? ["new_listing_share_12m"] : [],
	};
}

function baselineRun(): StrategyRun {
	return {
		id: "run_base",
		strategyId: "strategy",
		strategyVersion: 1,
		marketId: "target",
		snapshotId: "snap_base",
		mode: "screen",
		result: evaluation("fail"),
		runAt: at,
		actor: "tester",
	};
}

test("similarity is deterministic for English and Chinese keyword sets", () => {
	const store = createEmptyStore(at);
	store.markets.push(
		market("target", "Yoga Mat Strap", ["yoga mat strap", "mat carrier"], "Sports & Outdoors"),
		market("similar", "Yoga Strap Carrier", ["yoga mat strap", "strap carrier"], "Sports & Outdoors"),
		market("other", "Silicone Spatula", ["kitchen spatula"], "Kitchen"),
		market("cn-a", "折叠露营灯", ["折叠露营灯", "帐篷灯"], "户外"),
		market("cn-b", "便携露营灯", ["折叠露营灯", "便携灯"], "户外"),
	);
	const english = similarMarkets(store, { marketId: "target" });
	assert.equal(english[0]?.market.id, "similar");
	assert.ok((english[0]?.score ?? 0) >= 0.35);
	assert.equal(english.some((item) => item.market.id === "other"), false);
	const chinese = similarMarkets(store, { marketId: "cn-a" });
	assert.equal(chinese[0]?.market.id, "cn-b");
	assert.equal(jaccard(historyKeywordSet(["折叠露营灯"]), historyKeywordSet(["折叠露营灯"])), 1);
});

test("metric deltas apply direction semantics without inventing direction for price", () => {
	const deltas = calculateMetricDeltas(
		{ new_listing_share_12m: evidence(0.1), cr3: evidence(0.7), price_p50: evidence(20) },
		{ new_listing_share_12m: evidence(0.2), cr3: evidence(0.6), price_p50: evidence(22) },
		["new_listing_share_12m", "cr3", "price_p50"],
	);
	assert.equal(deltas.find((item) => item.metric === "new_listing_share_12m")?.direction, "improved");
	assert.equal(deltas.find((item) => item.metric === "cr3")?.direction, "improved");
	assert.equal(deltas.find((item) => item.metric === "price_p50")?.direction, "unknown");
});

test("no_go replay has validated, challenged, and inconclusive branches", () => {
	const run = baselineRun();
	assert.equal(replayOutcomeVerdict(run, evaluation("fail"), []).verdict, "validated");
	assert.equal(replayOutcomeVerdict(run, evaluation("pass"), [{ metric: "new_listing_share_12m", baseline: 0.1, current: 0.2, direction: "improved" }]).verdict, "challenged");
	assert.equal(replayOutcomeVerdict(run, evaluation("missing"), []).verdict, "inconclusive");
});

test("actuals verdict requires both daily units and margin and respects thresholds", () => {
	assert.equal(actualsOutcomeVerdict({ dailyUnits: 8, netMargin: 0.05 }, 10).verdict, "validated");
	assert.equal(actualsOutcomeVerdict({ dailyUnits: 3.9, netMargin: 0.05 }, 10).verdict, "challenged");
	assert.equal(actualsOutcomeVerdict({ dailyUnits: 8 }, 10).verdict, "inconclusive");
});

test("due rules and injected brief stay within hard line/character budgets", () => {
	const store = createEmptyStore(at);
	store.markets.push(market("m", "yoga mat strap", ["yoga mat strap"], "Sports"));
	store.candidates.push({
		id: "cand",
		marketId: "m",
		stage: "testing",
		tags: [],
		decisionStatus: "go",
		decisionReason: "完整 Gate 通过",
		decisionAt: "2026-01-01T00:00:00.000Z",
		createdAt: "2025-12-20T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});
	store.decisionLog.push({ id: "dec", candidateId: "cand", marketId: "m", type: "decision", conclusion: "Go", decisionStatus: "go", reason: "完整 Gate 通过", actor: "tester", createdAt: "2026-01-01T00:00:00.000Z" });
	const due = dueRetroItems(store, "2026-02-05T00:00:00.000Z");
	assert.equal(due[0]?.group, "go");
	assert.equal(due[0]?.overdueDays, 5);
	const brief = renderHistoryBrief(store, { marketId: "m", dueCount: due.length });
	assert.ok(brief.split("\n").length <= 12);
	assert.ok(brief.length <= 1_200);
	assert.match(brief, /compass_history/);
	const note = renderHistoryNote(Array.from({ length: 20 }, (_, index) => `${index} ${"很长的历史".repeat(100)}`));
	assert.ok(note.length <= 8);
	assert.ok(note.join("\n").length <= 1_600);
	const ledger = renderSessionLedger(Array.from({ length: 30 }, (_, index) => ({ at: `2026-02-05T00:00:${String(index).padStart(2, "0")}.000Z`, marketId: "m", action: "strategy", conclusion: "结论".repeat(100), ids: [`run_${index}`] })));
	assert.ok(ledger.split("\n").length <= 20);
	assert.match(ledger, /compass_history timeline/);
});

test("due list covers waitlist, no_go sampling, and review without checks", () => {
	const store = createEmptyStore(at);
	for (const [id, status, stage, date] of [
		["wait", "waitlist", "decision", "2026-01-01T00:00:00.000Z"],
		["no", "no_go", "archived", "2026-01-01T00:00:00.000Z"],
		["review", undefined, "review", "2026-03-01T00:00:00.000Z"],
	] as const) {
		store.markets.push(market(`m-${id}`, id, []));
		store.candidates.push({ id: `c-${id}`, marketId: `m-${id}`, stage, tags: [], decisionStatus: status, decisionAt: status ? date : undefined, createdAt: date, updatedAt: date });
	}
	const due = dueRetroItems(store, "2026-04-15T00:00:00.000Z");
	assert.deepEqual(new Set(due.map((item) => item.group)), new Set(["waitlist", "no_go", "review"]));
});

test("timeline merges snapshots, strategy runs, decisions, and outcome checks", () => {
	const store = createEmptyStore(at);
	store.markets.push(market("m", "market", []));
	store.snapshots.push({ id: "snap", marketId: "m", source: "test", capturedAt: at, importedAt: at, rowCount: 0, listings: [], keywords: [], metrics: {}, warnings: [] });
	store.strategyRuns.push({ ...baselineRun(), marketId: "m", snapshotId: "snap" });
	store.decisionLog.push({ id: "dec", marketId: "m", type: "decision", conclusion: "No Go", decisionStatus: "no_go", reason: "test", actor: "tester", createdAt: "2026-01-02T00:00:00.000Z" });
	store.outcomeChecks.push({ id: "chk", marketId: "m", decisionLogId: "dec", decisionStatus: "no_go", baselineSnapshotId: "snap", actuals: { dailyUnits: 0, netMargin: -0.1 }, deltas: [], verdict: "challenged", verdictReason: "test", elapsedDays: 30, createdAt: "2026-02-01T00:00:00.000Z", actor: "tester" });
	const timeline = buildTimeline(store, "m");
	assert.deepEqual(new Set(timeline.map((item) => item.kind)), new Set(["snapshot", "strategy_run", "decision", "outcome_check"]));
	assert.equal(timeline[0].id, "chk");
});

test("timeline merges todo resolution events with actor, reason, and stable ordering", () => {
	const store = createEmptyStore(at);
	store.markets.push(market("m", "market", []));
	store.markets.push(market("other", "other market", []));
	store.snapshots.push({ id: "snap", marketId: "m", source: "test", capturedAt: at, importedAt: at, rowCount: 0, listings: [], keywords: [], metrics: {}, warnings: [] });
	store.todoResolutions = [
		{
			id: "tdr_1",
			todoId: "todo_metric_divergence_m",
			kind: "metric_divergence",
			marketId: "m",
			candidateId: "c1",
			titleSnapshot: "多源指标偏差 >30%",
			status: "reopened",
			attempts: [
				{ submittedAt: "2026-03-01T00:00:00.000Z", submittedBy: "compass-web", note: "第一轮说明\n第二行", evidence: [], verdict: "reject", verdictReason: "未说明以哪个来源为准", verifiedAt: "2026-03-02T00:00:00.000Z", verifiedBy: "compass-agent" },
				{ submittedAt: "2026-03-03T00:00:00.000Z", submittedBy: "compass-web", note: "第二轮说明", evidence: [], verdict: "pass", verdictReason: "口径与理由明确", verifiedAt: "2026-03-04T00:00:00.000Z", verifiedBy: "compass-agent" },
			],
			reopens: [{ reopenedAt: "2026-03-06T00:00:00.000Z", reopenedBy: "ops", reason: "勾错了，拉回重新处理" }],
			resolvedAt: "2026-03-05T00:00:00.000Z",
			resolvedBy: "compass-web",
			basis: { snapshotWatermark: "sellersprite@2026-02-01T00:00:00.000Z" },
			createdAt: "2026-03-01T00:00:00.000Z",
			updatedAt: "2026-03-06T00:00:00.000Z",
		},
		// 其他市场的记录不得混入
		{
			id: "tdr_2",
			todoId: "todo_metric_divergence_other",
			kind: "metric_divergence",
			marketId: "other",
			titleSnapshot: "多源指标偏差 >30%",
			status: "submitted",
			attempts: [{ submittedAt: "2026-03-07T00:00:00.000Z", submittedBy: "ops", note: "别的市场", evidence: [] }],
			reopens: [],
			createdAt: "2026-03-07T00:00:00.000Z",
			updatedAt: "2026-03-07T00:00:00.000Z",
		},
		// 预算类无市场归属：不进任何市场时间线，但记录本身保留
		{
			id: "tdr_3",
			todoId: "todo_budget_warning_keepa",
			kind: "budget_warning",
			source: "keepa",
			titleSnapshot: "预算 80% 告警：keepa",
			status: "submitted",
			attempts: [{ submittedAt: "2026-03-08T00:00:00.000Z", submittedBy: "ops", note: "已核对用量", evidence: [] }],
			reopens: [],
			createdAt: "2026-03-08T00:00:00.000Z",
			updatedAt: "2026-03-08T00:00:00.000Z",
		},
	];
	const timeline = buildTimeline(store, "m");
	const events = timeline.filter((item) => item.kind === "todo_resolution");
	assert.equal(events.length, 6, "两轮提交 + 两次验证 + 一次勾选 + 一次重开");
	// 时间倒序稳定排序
	assert.deepEqual(events.map((item) => item.at), [
		"2026-03-06T00:00:00.000Z",
		"2026-03-05T00:00:00.000Z",
		"2026-03-04T00:00:00.000Z",
		"2026-03-03T00:00:00.000Z",
		"2026-03-02T00:00:00.000Z",
		"2026-03-01T00:00:00.000Z",
	]);
	assert.deepEqual(events.map((item) => item.action), ["reopen", "complete", "verify", "submit", "verify", "submit"]);
	// 每个动作带 actor 与说明/理由，且自由文本被压平到单行
	assert.equal(events[0].actor, "ops");
	assert.equal(events[0].reason, "勾错了，拉回重新处理");
	assert.equal(events[1].actor, "compass-web");
	assert.match(events[2].summary, /验证通过/);
	assert.equal(events[2].actor, "compass-agent");
	// 操作者必须落进 summary：时间线的渲染面只输出 at/kind/id/summary/reason，字段不进正文就答不出「谁验证」
	assert.match(events[2].summary, /compass-agent/);
	assert.match(events[1].summary, /compass-web/);
	assert.match(events[0].summary, /ops/);
	assert.equal(events[2].reason, "口径与理由明确");
	assert.match(events[4].summary, /驳回/);
	assert.equal(events[5].reason, "第一轮说明 第二行");
	assert.equal(events[5].candidateId, "c1");
	assert.ok(events.every((item) => item.marketId === "m"));
	// 既有条目类型不受影响
	assert.ok(timeline.some((item) => item.kind === "snapshot"));
	// 其他市场与无市场归属的记录都不混入
	assert.equal(timeline.filter((item) => item.summary.includes("别的市场") || item.summary.includes("keepa")).length, 0);
	// 候选过滤：指定其他候选时该市场的处理事件不出现
	assert.equal(buildTimeline(store, "m", "c9").filter((item) => item.kind === "todo_resolution").length, 0);
	assert.equal(buildTimeline(store, "m", "c1").filter((item) => item.kind === "todo_resolution").length, 6);
});

test("timeline tolerates stores without any todo resolutions", () => {
	const store = createEmptyStore(at);
	store.markets.push(market("m", "market", []));
	store.snapshots.push({ id: "snap", marketId: "m", source: "test", capturedAt: at, importedAt: at, rowCount: 0, listings: [], keywords: [], metrics: {}, warnings: [] });
	delete store.todoResolutions;
	assert.equal(buildTimeline(store, "m").length, 1);
});

// —— 审计 M5 回归 ——

test("renderRetroReport 的到期节奏来自调用方注入的 config，而不是自己去找默认策略", () => {
	const store = createEmptyStore(at);
	store.markets.push(market("m", "yoga mat strap", ["yoga mat strap"], "Sports"));
	store.candidates.push({
		id: "cand",
		marketId: "m",
		stage: "testing",
		tags: [],
		decisionStatus: "go",
		decisionReason: "完整 Gate 通过",
		decisionAt: "2026-01-01T00:00:00.000Z",
		createdAt: "2025-12-20T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});
	const now = "2026-02-05T00:00:00.000Z";
	assert.match(renderRetroReport(store, now), /逾期 5 天/);
	const fast = renderRetroReport(store, now, { goDays: 7, testingStaleDays: 60, waitlistDays: 45, noGoDays: 90, reviewDays: 30 });
	assert.match(fast, /逾期 28 天/);
	const slow = renderRetroReport(store, now, { goDays: 90, testingStaleDays: 120, waitlistDays: 45, noGoDays: 90, reviewDays: 30 });
	assert.match(slow, /- \[x\] 当前没有到期复盘对象。/);
});

// 逾期天数 5 / 28 与「当前没有到期复盘对象。」三个断言值均来自实跑，
// 与既有用例 tests/history.test.ts:122 的 overdueDays=5 对得上。
// market() / createEmptyStore / at 在该文件里已是现成 helper。

// —— 审计 G9 回归：共用夹具 ——
const SHANGHAI = "Asia/Shanghai";

function lessonAt(id: string, createdAt: string, sourceRetro?: string): Lesson {
	return { id, title: `经验 ${id}`, detail: "detail", scope: {}, evidence: ["chk_x"], status: "active", sourceRetro, createdAt, updatedAt: createdAt, actor: "tester" };
}

// —— 审计 G9 回归 ——
test("复盘报告的日与文件名按本地日历日切，沪时早 8 点前生成不再写成昨天、也不再覆盖昨晚同名文件", () => {
	const store = createEmptyStore(at);
	const lastNight = "2026-08-31T12:00:00.000Z";    // 沪 08-31 20:00
	const earlyMorning = "2026-08-31T23:00:00.000Z"; // 沪 09-01 07:00，UTC 仍是 08-31
	const forenoon = "2026-09-01T01:00:00.000Z";     // 沪 09-01 09:00
	assert.match(renderRetroReport(store, lastNight, undefined, { timeZone: SHANGHAI }), /# 罗盘复盘报告｜2026-08-31/);
	assert.match(renderRetroReport(store, earlyMorning, undefined, { timeZone: SHANGHAI }), /# 罗盘复盘报告｜2026-09-01/);
	assert.equal(retroReportFileName(lastNight, SHANGHAI), "retro-2026-08-31-2000.md");
	assert.equal(retroReportFileName(earlyMorning, SHANGHAI), "retro-2026-09-01-0700.md");
	// 同一天多次生成各留一份，文件名按字典序即时间序
	assert.equal(retroReportFileName(forenoon, SHANGHAI), "retro-2026-09-01-0900.md");
	assert.ok(retroReportFileName(earlyMorning, SHANGHAI) < retroReportFileName(forenoon, SHANGHAI));
	// 时区显式注入，UTC 机器上同一时刻仍切在 UTC 日
	assert.equal(retroReportFileName(earlyMorning, "UTC"), "retro-2026-08-31-2300.md");
});

// 这是「月界 + 日界」那一例：08-31/09-01 既跨月又跨日。断言值全部实跑得到
// （TZ=Asia/Shanghai / UTC / America/New_York / Pacific/Kiritimati 四个时区跑过，
//  因为 timeZone 显式注入，四处结果一致）。
// 未改前这条会红在第一处：earlyMorning 的标题实测是「# 罗盘复盘报告｜2026-08-31」。


// —— 审计 G9 回归 ——
test("「本次沉淀经验」优先按 sourceRetro 配对、次选上一份报告之后的时间窗，不再按 UTC 日一含一漏", () => {
	const store = createEmptyStore(at);
	const output = ".pi/compass/reports/retro-2026-09-01-0900.md";
	store.lessons.push(
		lessonAt("les_lastnight", "2026-08-31T12:00:00.000Z"),             // 沪 08-31 20:00
		lessonAt("les_morning", "2026-08-31T23:30:00.000Z"),               // 沪 09-01 07:30，UTC 仍是 08-31
		lessonAt("les_linked", "2026-09-01T00:10:00.000Z", output),        // 沪 09-01 08:10，挂了本次报告
	);
	const forenoon = "2026-09-01T01:00:00.000Z";                          // 沪 09-01 09:00
	// 兜底窗口 = 本地日历日：今晨 07:30 那张不再被漏掉，昨晚那张也不会被误收
	const dayWindow = renderRetroReport(store, forenoon, undefined, { timeZone: SHANGHAI, outputPath: output });
	assert.match(dayWindow, /les_morning/);
	assert.match(dayWindow, /les_linked/);
	assert.doesNotMatch(dayWindow, /les_lastnight/);
	// 已有上一份报告（沪 07:45）时收窄到「上一份之后」，但挂了 sourceRetro 的仍然进
	const narrowed = renderRetroReport(store, forenoon, undefined, { timeZone: SHANGHAI, outputPath: output, previousRetroAt: "2026-08-31T23:45:00.000Z" });
	assert.doesNotMatch(narrowed, /les_morning/);
	assert.match(narrowed, /les_linked/);
	// 月界另一侧：沪 08-31 晚上那份不得把次日早上才产生的经验算进来
	const lastNight = renderRetroReport(store, "2026-08-31T12:00:00.000Z", undefined, { timeZone: SHANGHAI });
	assert.doesNotMatch(lastNight, /les_morning/);
	assert.match(lastNight, /les_lastnight/);
	// 没有任何经验落在窗口内时仍走空文案
	assert.match(renderRetroReport(store, "2026-09-02T01:00:00.000Z", undefined, { timeZone: SHANGHAI }), /- 本次尚未沉淀 Lesson。/);
});

// 「一含一漏」两侧都钉住了：未改前 dayWindow 里 les_morning 缺席（§5 输出
// 「- 本次尚未沉淀 Lesson。」），而 lastNight 里 les_morning 反而在场。
// 空文案断言 /- 本次尚未沉淀 Lesson。/ 的原文来自实跑输出。

// —— 审计 M13/G15 回归 ——
test("validation rate counts only checks anchored to a human decision", () => {
	const store = createEmptyStore();
	store.outcomeChecks.push(
		{ id: "chk1", marketId: "m1", decisionStatus: "no_go", baselineSnapshotId: "s0", evidenceSnapshotId: "s1", deltas: [], verdict: "challenged", verdictReason: "前提翻转", elapsedDays: 10, createdAt: "2026-02-01T00:00:00.000Z", actor: "ops" },
		{ id: "chk2", marketId: "m2", baselineSnapshotId: "s0", evidenceSnapshotId: "s1", deltas: [], verdict: "validated", verdictReason: "规则仍不通过", elapsedDays: 10, createdAt: "2026-02-02T00:00:00.000Z", actor: "compass-auto" },
		{ id: "chk3", marketId: "m3", baselineSnapshotId: "s0", evidenceSnapshotId: "s1", deltas: [], verdict: "validated", verdictReason: "规则仍不通过", elapsedDays: 10, createdAt: "2026-02-03T00:00:00.000Z", actor: "compass-auto" },
	);
	const stats = outcomeStatistics(store);
	assert.equal(stats.total, 3);
	assert.equal(stats.validated, 2);
	assert.equal(stats.challenged, 1);
	assert.equal(stats.strategyOnly, 2);
	// conclusive 与 byStrategy 保留「对照次数」语义（不过滤、不去重），比率的分母是 ratedMarkets
	assert.equal(stats.conclusive, 3);
	assert.equal(stats.ratedMarkets, 1);
	// 只有 chk1 挂到人工决策锚点，它是 challenged → 验证率 0；两条无锚点的 validated 不再拉高它
	assert.equal(stats.validationRate, 0);
	assert.deepEqual(stats.byStrategy, [{ strategy: "无策略锚点", validated: 2, challenged: 1, inconclusive: 0, accuracy: 2 / 3 }]);
});


// —— 审计 G16 回归 ——
function outcomeCheck(id: string, marketId: string, decisionStatus: DecisionStatus | undefined, verdict: OutcomeVerdict, createdAt: string): OutcomeCheck {
	return {
		id,
		marketId,
		candidateId: `cand_${marketId}`,
		decisionStatus,
		baselineSnapshotId: `snap_${marketId}_base`,
		evidenceSnapshotId: `snap_${id}`,
		deltas: [],
		verdict,
		verdictReason: verdict,
		elapsedDays: 10,
		createdAt,
		actor: "tester",
	};
}

test("四率按市场去重：同一市场刷 N 条 validated 只算一票，无决策锚点的 check 不进比率", () => {
	const store = createEmptyStore(at);
	store.markets.push(market("a", "market a", ["a"]), market("b", "market b", ["b"]), market("c", "market c", ["c"]));
	store.outcomeChecks.push(
		outcomeCheck("chk_a1", "a", "no_go", "validated", "2026-01-11T00:00:00.000Z"),
		outcomeCheck("chk_a2", "a", "no_go", "validated", "2026-01-21T00:00:00.000Z"),
		outcomeCheck("chk_a3", "a", "no_go", "validated", "2026-01-31T00:00:00.000Z"),
		outcomeCheck("chk_a4", "a", "no_go", "validated", "2026-02-10T00:00:00.000Z"),
		outcomeCheck("chk_a5", "a", "no_go", "validated", "2026-02-20T00:00:00.000Z"),
		outcomeCheck("chk_b1", "b", "no_go", "challenged", "2026-01-11T00:00:00.000Z"),
		outcomeCheck("chk_c1", "c", undefined, "validated", "2026-01-11T00:00:00.000Z"),
	);
	const stats = outcomeStatistics(store);
	assert.equal(stats.total, 7);
	assert.equal(stats.validated, 6);
	assert.equal(stats.challenged, 1);
	assert.equal(stats.ratedMarkets, 2);
	assert.equal(stats.noGoAccuracyRate, 0.5);
	assert.equal(stats.falseKillRate, 0.5);
	assert.equal(stats.validationRate, 0.5);
	assert.equal(stats.goAttainmentRate, null);
});


// —— 审计 G16 回归 ——
test("去重取的是最新一条可判对照，且不受调用方预排序影响", () => {
	const store = createEmptyStore(at);
	store.markets.push(market("a", "market a", ["a"]));
	store.outcomeChecks.push(
		outcomeCheck("chk_old", "a", "no_go", "validated", "2026-01-11T00:00:00.000Z"),
		outcomeCheck("chk_new", "a", "no_go", "challenged", "2026-02-20T00:00:00.000Z"),
		outcomeCheck("chk_last", "a", "no_go", "inconclusive", "2026-03-01T00:00:00.000Z"),
	);
	const ascending = outcomeStatistics(store);
	const descending = outcomeStatistics(store, [...store.outcomeChecks].sort((x, y) => y.createdAt.localeCompare(x.createdAt)));
	assert.equal(ascending.ratedMarkets, 1);
	assert.equal(ascending.noGoAccuracyRate, 0);
	assert.equal(ascending.falseKillRate, 1);
	assert.deepEqual(descending.noGoAccuracyRate, ascending.noGoAccuracyRate);
	assert.deepEqual(descending.falseKillRate, ascending.falseKillRate);
	assert.deepEqual(descending.ratedMarkets, ascending.ratedMarkets);
});


// —— 审计 G16 回归 ——
test("复盘报告 §1 与 header 标明按市场去重，比率不再被对照次数带偏", () => {
	const store = createEmptyStore(at);
	store.markets.push(market("a", "market a", ["a"]), market("b", "market b", ["b"]));
	store.outcomeChecks.push(
		outcomeCheck("chk_a1", "a", "no_go", "validated", "2026-01-11T00:00:00.000Z"),
		outcomeCheck("chk_a2", "a", "no_go", "validated", "2026-01-21T00:00:00.000Z"),
		outcomeCheck("chk_a3", "a", "no_go", "validated", "2026-01-31T00:00:00.000Z"),
		outcomeCheck("chk_a4", "a", "no_go", "validated", "2026-02-10T00:00:00.000Z"),
		outcomeCheck("chk_a5", "a", "no_go", "validated", "2026-02-20T00:00:00.000Z"),
		outcomeCheck("chk_b1", "b", "no_go", "challenged", "2026-01-11T00:00:00.000Z"),
	);
	const markdown = renderRetroReport(store, "2026-03-01T00:00:00.000Z", undefined, { timeZone: "UTC" });
	assert.match(markdown, /对照次数 6 次 · 比率样本 2 个市场（按市场去重：同一市场只取最新一条可判对照）/);
	assert.match(markdown, /- 验证率：50\.0%；go 达成率：—；no_go 正确率：50\.0%；错杀率：50\.0%（四率按市场去重，样本 2 个市场；无决策锚点与 inconclusive 不计入）。/);
	assert.match(markdown, /- 结论分布（按对照次数 6 次）：validated 5 \/ challenged 1 \/ inconclusive 0。/);
});

// 复盘报告黄金文件：六章结构 + 表格转义 + 「本次沉淀」的并集口径一次性钉死。
// 时区必须显式传 UTC——标题、文件名与第 5 章时间窗都按本地日历日算，不钉死会在
// UTC+13/+14 的机器上生成另一份内容（下面 timeZone 那条用例就是这个反证）。
const RETRO_GENERATED_AT = "2026-03-01T12:00:00.000Z";
const RETRO_OUTPUT_PATH = ".pi/compass/reports/retro-2026-03-01-1200.md";

function retroGoldenStore(): CompassStore {
	const store = createEmptyStore("2025-11-01T00:00:00.000Z");
	// 市场名故意带竖线、换行与落单的 **：三者分别能把表格错列、把一行拆成两行、把加粗提前闭合
	store.markets.push(
		{ id: "m_pipe", name: "瑜伽垫 | Yoga Mat\nStrap", keywords: ["yoga mat strap"], category: "Sports", createdAt: "2025-11-01T00:00:00.000Z", updatedAt: "2025-11-01T00:00:00.000Z" },
		{ id: "m_bold", name: "**折叠露营灯", keywords: ["camping lantern"], category: "Outdoors", createdAt: "2025-12-25T00:00:00.000Z", updatedAt: "2025-12-25T00:00:00.000Z" },
		{ id: "m_wait", name: "硅胶铲", keywords: ["silicone spatula"], category: "Kitchen", createdAt: "2025-11-15T00:00:00.000Z", updatedAt: "2025-11-15T00:00:00.000Z" },
	);
	store.candidates.push(
		{ id: "c_pipe", marketId: "m_pipe", stage: "archived", tags: [], decisionStatus: "no_go", decisionReason: "IP 风险", decisionAt: "2025-11-20T00:00:00.000Z", createdAt: "2025-11-01T00:00:00.000Z", updatedAt: "2025-11-20T00:00:00.000Z" },
		{ id: "c_bold", marketId: "m_bold", stage: "testing", tags: [], decisionStatus: "go", decisionReason: "完整 Gate 通过", decisionAt: "2026-01-10T00:00:00.000Z", createdAt: "2025-12-25T00:00:00.000Z", updatedAt: "2025-12-20T00:00:00.000Z" },
		{ id: "c_wait", marketId: "m_wait", stage: "decision", tags: [], decisionStatus: "waitlist", decisionReason: "等价格回落", decisionAt: "2025-12-01T00:00:00.000Z", createdAt: "2025-11-15T00:00:00.000Z", updatedAt: "2025-12-01T00:00:00.000Z" },
	);
	store.decisionLog.push(
		{ id: "dec_pipe", candidateId: "c_pipe", marketId: "m_pipe", type: "decision", conclusion: "No Go", decisionStatus: "no_go", reason: "IP 风险", actor: "tester", createdAt: "2025-11-20T00:00:00.000Z" },
		{ id: "dec_bold", candidateId: "c_bold", marketId: "m_bold", type: "decision", conclusion: "Go", decisionStatus: "go", reason: "完整 Gate 通过", actor: "tester", createdAt: "2026-01-10T00:00:00.000Z" },
		{ id: "dec_wait", candidateId: "c_wait", marketId: "m_wait", type: "decision", conclusion: "Waitlist", decisionStatus: "waitlist", reason: "等价格回落", actor: "tester", createdAt: "2025-12-01T00:00:00.000Z" },
	);
	store.strategyRuns.push({
		id: "run_v2",
		strategyId: "gse-default",
		strategyVersion: 2,
		marketId: "m_pipe",
		snapshotId: "snap_pipe_base",
		mode: "full",
		result: {
			outcome: "reject",
			score: 42,
			dimensionScores: {},
			rules: [
				{ id: "veto_ip", stage: "market_screen", action: "veto", label: "IP 风险", when: "ip_risk == true", condition: true, status: "veto", references: ["ip_risk"], evidence: {}, message: "veto" },
				{ id: "gate_new_share", stage: "market_screen", action: "require", label: "新品占比", when: "new_listing_share_12m >= 0.15", condition: false, status: "fail", references: ["new_listing_share_12m"], evidence: {}, message: "fail" },
			],
			missingMetrics: [],
		},
		runAt: "2025-11-20T00:00:00.000Z",
		actor: "tester",
	});
	// 四条对照：同一市场两条（四率去重只认最新一条）、一条 go 实绩、一条无决策锚点的策略自我对照
	store.outcomeChecks.push(
		{ id: "chk_bold", marketId: "m_bold", candidateId: "c_bold", decisionLogId: "dec_bold", decisionStatus: "go", baselineSnapshotId: "snap_bold_base", actuals: { dailyUnits: 2, netMargin: -0.031 }, deltas: [], verdict: "challenged", verdictReason: "日销与净利均未达标", elapsedDays: 36, createdAt: "2026-02-15T00:00:00.000Z", actor: "tester" },
		{ id: "chk_pipe", marketId: "m_pipe", candidateId: "c_pipe", decisionLogId: "dec_pipe", decisionStatus: "no_go", baselineSnapshotId: "snap_pipe_base", baselineRunId: "run_v2", evidenceSnapshotId: "snap_pipe_t1", deltas: [{ metric: "new_listing_share_12m", baseline: 0.08, current: 0.22, direction: "improved" }, { metric: "price_p50", baseline: 19.9, current: 19.9, direction: "flat" }], verdict: "challenged", verdictReason: "新品占比回升 | 疑似错杀\n建议重新入池", elapsedDays: 82, createdAt: "2026-02-10T00:00:00.000Z", actor: "tester" },
		{ id: "chk_wait", marketId: "m_wait", baselineSnapshotId: "snap_wait_base", deltas: [], verdict: "inconclusive", verdictReason: "缺关键指标", elapsedDays: 35, createdAt: "2026-01-05T00:00:00.000Z", actor: "tester" },
		{ id: "chk_pipe_old", marketId: "m_pipe", candidateId: "c_pipe", decisionLogId: "dec_pipe", decisionStatus: "no_go", baselineSnapshotId: "snap_pipe_base", baselineRunId: "run_v2", evidenceSnapshotId: "snap_pipe_t0", deltas: [], verdict: "validated", verdictReason: "否决规则重放仍成立", elapsedDays: 25, createdAt: "2025-12-15T00:00:00.000Z", actor: "tester" },
	);
	// 第 5 章「本次沉淀」= 结构化归属 ∪ 时间窗：les_same_day 靠本地日历日命中、
	// les_source 靠 sourceRetro 命中；les_other_day（跨日且无 sourceRetro）与 les_retired 都必须落选
	store.lessons.push(
		{ id: "les_same_day", title: "低价段 | 慎入", detail: "毛利低于 25% 时\n直接放弃", scope: { keywords: ["yoga mat strap"] }, evidence: ["chk_pipe"], status: "active", createdAt: "2026-03-01T09:00:00.000Z", updatedAt: "2026-03-01T09:00:00.000Z", actor: "tester" },
		{ id: "les_source", title: "**实绩未达标要先归因", detail: "先看 TACOS 再看退货率", scope: {}, evidence: ["chk_bold"], status: "active", sourceRetro: "reports/retro-2026-03-01-1200.md", createdAt: "2026-02-20T00:00:00.000Z", updatedAt: "2026-02-20T00:00:00.000Z", actor: "tester" },
		{ id: "les_other_day", title: "不该出现在本次沉淀", detail: "跨日且无 sourceRetro", scope: {}, evidence: ["chk_wait"], status: "active", createdAt: "2026-02-25T00:00:00.000Z", updatedAt: "2026-02-25T00:00:00.000Z", actor: "tester" },
		{ id: "les_retired", title: "已退休的经验", detail: "retired 不进报告", scope: {}, evidence: ["chk_pipe_old"], status: "retired", retiredReason: "口径过时", createdAt: "2026-03-01T10:00:00.000Z", updatedAt: "2026-03-01T10:00:00.000Z", actor: "tester" },
	);
	return store;
}

function goldenRetroReport(): string {
	return renderRetroReport(retroGoldenStore(), RETRO_GENERATED_AT, retroDueConfig(), { outputPath: RETRO_OUTPUT_PATH, timeZone: "UTC" });
}

/** 取某个 `## x. 标题` 到下一个 `## ` 之间的正文行 */
function retroSection(report: string, heading: string): string[] {
	const lines = report.split("\n");
	const start = lines.indexOf(heading);
	assert.notEqual(start, -1, `报告缺少章节：${heading}`);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => line.startsWith("## "));
	return end === -1 ? rest : rest.slice(0, end);
}

/** 表格数据行（去掉表头与分隔行） */
function tableRows(section: string[]): string[] {
	return section.filter((line) => line.startsWith("|") && !line.startsWith("|---")).slice(1);
}

/** 单元格切分：先把转义过的 \| 换成占位符，剩下的 | 才是真列分隔 */
function cells(row: string): string[] {
	return row.replaceAll("\\|", "␟").split("|").slice(1, -1).map((cell) => cell.trim());
}



test("复盘报告黄金文件：整篇逐字比对（M102）", async () => {
	// 逐条 assert.match 只钉住了「我想到要断言的那几行」——批次三把报告日历从 UTC 改成本地日
	// 时，正是那些没被断言到的段落悄悄变了。整篇比对让任何一处措辞/顺序/数字变化都必须先
	// 更新黄金文件，改动因此变成显式动作。
	const golden = await readFile(join(here, "fixtures/retro-report.golden.md"), "utf8");
	assert.equal(goldenRetroReport(), golden);
});

test("复盘报告与运行机器的时区无关（M102）", () => {
	// 报告里既有「生成时间」也有「平均决策周期」这类跨日计算，日历口径必须由 timeZone 参数
	// 决定，而不是由跑测试的机器决定——否则同一份 store 在上海和 UTC 机器上出两份不同报告。
	const utc = goldenRetroReport();
	for (const timeZone of ["UTC", "Asia/Shanghai", "America/New_York", "Pacific/Kiritimati"]) {
		const report = renderRetroReport(retroGoldenStore(), RETRO_GENERATED_AT, retroDueConfig(), {
			outputPath: RETRO_OUTPUT_PATH,
			timeZone,
		});
		if (timeZone === "UTC") {
			assert.equal(report, utc);
			continue;
		}
		// 非 UTC 时区允许标题日期与生成时间的本地呈现不同，但正文的统计口径必须一致：
		// 四率与结论分布来自 store 里的绝对时刻，不该随时区漂移。
		assert.equal(
			retroSection(report, "## 1. 台账概览").join("\n"),
			retroSection(utc, "## 1. 台账概览").join("\n"),
			`${timeZone} 下台账概览与 UTC 不一致`,
		);
	}
});

test("逐项对照表：每行列数一致且理由里的竖线被转义（M102）", () => {
	const rows = tableRows(retroSection(goldenRetroReport(), "## 2. 逐项对照"));
	assert.ok(rows.length > 0, "逐项对照没有数据行");
	const width = cells(rows[0] ?? "").length;
	for (const row of rows) {
		assert.equal(cells(row).length, width, `列数不齐：${row}`);
		// 未转义的 | 会把一列劈成两列，表格在渲染器里错位
		assert.doesNotMatch(row.replaceAll("\\|", ""), /\|\s*\|/, `出现空单元格，疑似未转义的竖线：${row}`);
	}
});

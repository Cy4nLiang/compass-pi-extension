import assert from "node:assert/strict";
import test from "node:test";
import {
	actualsOutcomeVerdict,
	buildTimeline,
	calculateMetricDeltas,
	dueRetroItems,
	historyKeywordSet,
	jaccard,
	renderHistoryBrief,
	renderHistoryNote,
	renderSessionLedger,
	replayOutcomeVerdict,
	similarMarkets,
} from "../history.ts";
import { createEmptyStore } from "../store.ts";
import type { Market, MetricEvidence, RuleEvaluation, StrategyEvaluation, StrategyRun } from "../types.ts";

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

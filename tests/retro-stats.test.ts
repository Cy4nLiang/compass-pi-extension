import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RETRO_DUE_RULES, latestComparableChecks, matchingLessonsForMarket, outcomeStatistics, renderHistoryBrief, retroDueConfig, similarMarkets } from "../history.ts";
import { backtestStrategies, decisionHistoryNote, importHistoryNote, leadHistoryNote, saveStrategyVersion, strategyHistoryNote } from "../service.ts";
import { createEmptyStore } from "../store.ts";
import type { Candidate, DecisionStatus, Lesson, Market, MarketSnapshot, MetricEvidence, OutcomeCheck, OutcomeVerdict, StrategyRun } from "../types.ts";
import { compactDashboardSummary } from "../ui.ts";
import { overviewData, retroData } from "../web/data.ts";

const at = "2026-01-01T00:00:00.000Z";

const evidence = (value: number | null): MetricEvidence => ({ value, source: "test", capturedAt: at, confidence: 1 });

function market(id: string, name: string, keywords: string[] = [name], category?: string): Market {
	return { id, name, keywords, category, createdAt: at, updatedAt: at };
}

function snapshot(id: string, marketId: string, capturedAt: string, metrics: Record<string, MetricEvidence> = {}): MarketSnapshot {
	return { id, marketId, source: "test", capturedAt, importedAt: capturedAt, rowCount: 1, listings: [], keywords: [], metrics, warnings: [] };
}

function check(id: string, marketId: string, decisionStatus: DecisionStatus | undefined, verdict: OutcomeVerdict, extra: Partial<OutcomeCheck> = {}): OutcomeCheck {
	return { id, marketId, decisionStatus, baselineSnapshotId: "snap_base", deltas: [], verdict, verdictReason: "理由", elapsedDays: 30, createdAt: at, actor: "tester", ...extra };
}

function strategyRun(id: string, strategyId: string, strategyVersion: number): StrategyRun {
	return { id, strategyId, strategyVersion, marketId: "m", snapshotId: "snap", mode: "screen", result: { outcome: "reject", score: 10, dimensionScores: {}, rules: [], missingMetrics: [] }, runAt: at, actor: "tester" };
}

function lesson(id: string, updatedAt: string, scope: Lesson["scope"], status: Lesson["status"] = "active"): Lesson {
	return { id, title: `经验 ${id}`, detail: "说明", scope, evidence: ["chk_x"], status, createdAt: at, updatedAt, actor: "tester" };
}

test("四率的分子分母：只认 go/no_go 决策锚点、剔除 inconclusive，且按市场去重每市场一票", () => {
	const store = createEmptyStore(at);
	store.outcomeChecks.push(
		check("chk_go_v", "m1", "go", "validated"),
		check("chk_go_c", "m2", "go", "challenged"),
		check("chk_go_i", "m3", "go", "inconclusive"),
		check("chk_no_v", "m4", "no_go", "validated"),
		check("chk_no_c", "m5", "no_go", "challenged"),
		check("chk_no_i", "m6", "no_go", "inconclusive"),
		check("chk_wait_v", "m7", "waitlist", "validated"),
	);
	const stats = outcomeStatistics(store);
	assert.equal(stats.total, 7);
	assert.equal(stats.validated, 3);
	assert.equal(stats.challenged, 2);
	assert.equal(stats.inconclusive, 2);
	assert.equal(stats.conclusive, 5);
	// G15/G16：waitlist 与 inconclusive 都不是可判样本，四率分母 = 4 个市场各一票
	assert.equal(stats.ratedMarkets, 4);
	assert.equal(stats.strategyOnly, 0);
	assert.equal(stats.validationRate, 0.5);
	assert.equal(stats.goAttainmentRate, 0.5);
	assert.equal(stats.noGoAccuracyRate, 0.5);
	assert.equal(stats.falseKillRate, 0.5);
	const withoutWaitlist = outcomeStatistics(store, store.outcomeChecks.filter((item) => item.decisionStatus !== "waitlist"));
	assert.equal(withoutWaitlist.validationRate, 0.5);
	assert.equal(withoutWaitlist.goAttainmentRate, 0.5);
	assert.equal(withoutWaitlist.noGoAccuracyRate, 0.5);
	assert.equal(withoutWaitlist.falseKillRate, 0.5);
	const empty = outcomeStatistics(createEmptyStore(at));
	assert.deepEqual(
		[empty.total, empty.conclusive, empty.validationRate, empty.goAttainmentRate, empty.noGoAccuracyRate, empty.falseKillRate],
		[0, 0, null, null, null, null],
	);
	assert.deepEqual(empty.byStrategy, []);
	const onlyInconclusive = outcomeStatistics(store, [check("chk_only_i", "m8", "no_go", "inconclusive")]);
	assert.deepEqual(
		[onlyInconclusive.validationRate, onlyInconclusive.goAttainmentRate, onlyInconclusive.noGoAccuracyRate, onlyInconclusive.falseKillRate],
		[null, null, null, null],
	);
});

test("decisionStatus 为空的 check 不再推高 validationRate：策略自我对照只留档、不进任何比率", () => {
	const store = createEmptyStore(at);
	store.outcomeChecks.push(check("chk_go_v", "m1", "go", "validated"), check("chk_no_c", "m2", "no_go", "challenged"));
	const before = outcomeStatistics(store);
	assert.equal(before.validationRate, 0.5);
	assert.equal(before.goAttainmentRate, 1);
	assert.equal(before.noGoAccuracyRate, 0);
	assert.equal(before.falseKillRate, 1);
	store.outcomeChecks.push(
		check("chk_bare_v1", "m3", undefined, "validated"),
		check("chk_bare_v2", "m4", undefined, "validated"),
		check("chk_bare_c", "m5", undefined, "challenged"),
	);
	const after = outcomeStatistics(store);
	assert.equal(after.total, 5);
	assert.equal(after.conclusive, 5);
	// G15：三条无决策锚点的 check 单列 strategyOnly，比率一动不动
	assert.equal(after.strategyOnly, 3);
	assert.equal(after.ratedMarkets, 2);
	assert.equal(after.validationRate, 0.5);
	assert.equal(after.goAttainmentRate, 1);
	assert.equal(after.noGoAccuracyRate, 0);
	assert.equal(after.falseKillRate, 1);
	assert.deepEqual(after.byStrategy, [{ strategy: "无策略锚点", validated: 3, challenged: 2, inconclusive: 0, accuracy: 0.6 }]);
});

test("四率按市场去重：同一市场刷 5 条 validated 也只算一票，不再主导 no_go 正确率与错杀率", () => {
	const store = createEmptyStore(at);
	for (let index = 0; index < 5; index++) {
		store.outcomeChecks.push(check(`chk_a_${index}`, "mA", "no_go", "validated", { createdAt: `2026-0${index + 1}-01T00:00:00.000Z` }));
	}
	store.outcomeChecks.push(check("chk_b", "mB", "no_go", "challenged"));
	const stats = outcomeStatistics(store);
	assert.equal(stats.total, 6);
	assert.equal(stats.validated, 5);
	assert.equal(stats.challenged, 1);
	// G16：mA 只取最新一条（2026-05-01），与 mB 各一票 → 与同一份 store 的 backtest alignment 同口径
	assert.equal(stats.ratedMarkets, 2);
	assert.equal(stats.noGoAccuracyRate, 0.5);
	assert.equal(stats.falseKillRate, 0.5);
	assert.equal(stats.validationRate, 0.5);
	assert.equal(stats.goAttainmentRate, null);
});

test("byStrategy 按 baselineRunId 指向的 run 归成 id@vN，缺锚点与悬空锚点并入「无策略锚点」", () => {
	const store = createEmptyStore(at);
	store.strategyRuns.push(strategyRun("run_a1", "alpha", 1), strategyRun("run_a2", "alpha", 2), strategyRun("run_b1", "beta", 1));
	store.outcomeChecks.push(
		check("chk_1", "m1", "no_go", "validated", { baselineRunId: "run_a1" }),
		check("chk_2", "m2", "no_go", "challenged", { baselineRunId: "run_a1" }),
		check("chk_3", "m3", "go", "validated", { baselineRunId: "run_a2" }),
		check("chk_4", "m4", "go", "inconclusive", { baselineRunId: "run_b1" }),
		check("chk_5", "m5", "no_go", "validated", { baselineRunId: "run_gone" }),
		check("chk_6", "m6", "no_go", "inconclusive"),
	);
	const byStrategy = outcomeStatistics(store).byStrategy;
	assert.deepEqual(byStrategy, [
		{ strategy: "alpha@v1", validated: 1, challenged: 1, inconclusive: 0, accuracy: 0.5 },
		{ strategy: "alpha@v2", validated: 1, challenged: 0, inconclusive: 0, accuracy: 1 },
		{ strategy: "无策略锚点", validated: 1, challenged: 0, inconclusive: 1, accuracy: 1 },
		{ strategy: "beta@v1", validated: 0, challenged: 0, inconclusive: 1, accuracy: null },
	]);
	assert.equal(byStrategy.map((row) => row.validated + row.challenged).join(","), "2,1,1,0");
});

test("backtest 在每条可判 check 自己的证据快照上重跑，弃权与错判分开计", () => {
	const store = createEmptyStore(at);
	const strict = `meta:\n  name: bt-strict\n  display_name: BT Strict\nstages:\n  - stage: market_screen\n    rules:\n      - id: activity\n        when: "new_listing_share_12m >= 0.15"\n        action: require\n        label: 新品占比\nscoring:\n  weights:\n    demand: 1\n`;
	const loose = strict.replace("name: bt-strict", "name: bt-loose").replace("display_name: BT Strict", "display_name: BT Loose").replace(">= 0.15", ">= 0.0");
	saveStrategyVersion(store, { yaml: strict, actor: "tester" });
	saveStrategyVersion(store, { yaml: loose, actor: "tester" });
	store.markets.push(market("mA", "market a"), market("mB", "market b"), market("mC", "market c"), market("mE", "market e"));
	store.snapshots.push(
		snapshot("snap_a", "mA", "2026-02-01T00:00:00.000Z", { new_listing_share_12m: evidence(0.3) }),
		snapshot("snap_b", "mB", "2026-02-01T00:00:00.000Z", { new_listing_share_12m: evidence(0.05) }),
		snapshot("snap_c1", "mC", "2026-02-01T00:00:00.000Z", { new_listing_share_12m: evidence(0.3) }),
		snapshot("snap_c2", "mC", "2026-03-01T00:00:00.000Z"),
		snapshot("snap_e", "mE", "2026-02-01T00:00:00.000Z", { new_listing_share_12m: evidence(0.3) }),
	);
	store.outcomeChecks.push(
		check("chk_a", "mA", "go", "validated", { createdAt: "2026-02-10T00:00:00.000Z", baselineSnapshotId: "snap_a", evidenceSnapshotId: "snap_a" }),
		check("chk_a_later", "mA", undefined, "inconclusive", { createdAt: "2026-03-10T00:00:00.000Z", baselineSnapshotId: "snap_a", evidenceSnapshotId: "snap_a" }),
		check("chk_b", "mB", "no_go", "validated", { createdAt: "2026-02-10T00:00:00.000Z", baselineSnapshotId: "snap_b", evidenceSnapshotId: "snap_b" }),
		check("chk_c", "mC", "go", "validated", { createdAt: "2026-02-10T00:00:00.000Z", baselineSnapshotId: "snap_c1", evidenceSnapshotId: "snap_c1" }),
		check("chk_e", "mE", "waitlist", "validated", { createdAt: "2026-02-10T00:00:00.000Z", baselineSnapshotId: "snap_e", evidenceSnapshotId: "snap_e" }),
	);
	const result = backtestStrategies(store, "bt-loose@v1", "bt-strict@v1");
	assert.equal(result.strategy, "bt-loose@v1");
	assert.equal(result.baselineStrategy, "bt-strict@v1");
	assert.equal(result.alignment.comparableChecks, 3);
	// G13：alignment 分两侧、各自区分「已判定 / 一致 / 弃权」，分母只算 decided
	// G17：mC 的对照在它自己的证据快照 snap_c1 上重跑（能判 pass），不再被过时的 snap_c2 拖成 review
	assert.deepEqual(result.alignment.baseline, { decided: 3, correct: 3, abstained: 0, rate: 1, coverage: 1 });
	assert.deepEqual(result.alignment.strategy, { decided: 3, correct: 2, abstained: 0, rate: 2 / 3, coverage: 1 });
	// 每市场先有一行「最新快照」的翻转行；证据快照与最新快照相同时（mA/mB）直接原地标上 checkId，
	// 不同时（mC：证据在 snap_c1、最新是缺列的 snap_c2）另追加一行落在证据快照上的对齐行。
	assert.deepEqual(result.rows.map((row) => [row.marketId, row.snapshotId, row.checkId ?? null, row.baselineOutcome, row.strategyOutcome]), [
		["mA", "snap_a", "chk_a", "pass", "pass"],
		["mB", "snap_b", "chk_b", "reject", "pass"],
		["mC", "snap_c2", null, "review", "review"],
		["mE", "snap_e", null, "pass", "pass"],
		["mC", "snap_c1", "chk_c", "pass", "pass"],
	]);
	assert.deepEqual(result.flips.map((row) => row.marketId), ["mB"]);
	assert.equal(Object.keys(result.matrix).length, 9);
	// 翻转矩阵按市场统计（每市场一格），而 rows 现在混装翻转行与对齐行，两者不再相等
	assert.equal(result.markets, 4);
	assert.equal(Object.values(result.matrix).reduce((sum, value) => sum + value, 0), result.markets);
	assert.deepEqual(Object.entries(result.matrix).filter(([, value]) => value > 0), [["pass→pass", 2], ["review→review", 1], ["reject→pass", 1]]);
});

test("后续缺数据的导入不再改变 alignment：对照始终在 check 自己的证据快照上重跑", () => {
	const store = createEmptyStore(at);
	const strict = `meta:\n  name: bt-strict\n  display_name: BT Strict\nstages:\n  - stage: market_screen\n    rules:\n      - id: activity\n        when: "new_listing_share_12m >= 0.15"\n        action: require\n        label: 新品占比\nscoring:\n  weights:\n    demand: 1\n`;
	saveStrategyVersion(store, { yaml: strict, actor: "tester" });
	store.markets.push(market("mC", "market c"));
	store.snapshots.push(
		snapshot("snap_c1", "mC", "2026-02-01T00:00:00.000Z", { new_listing_share_12m: evidence(0.3) }),
		snapshot("snap_c2", "mC", "2026-03-01T00:00:00.000Z"),
	);
	store.outcomeChecks.push(check("chk_c", "mC", "go", "validated", { createdAt: "2026-02-10T00:00:00.000Z", baselineSnapshotId: "snap_c1", evidenceSnapshotId: "snap_c1" }));
	const stale = backtestStrategies(store, "bt-strict@v1", "bt-strict@v1");
	// 翻转行仍看最新快照（缺列 → review），但对齐**不再**取这一行
	assert.equal(stale.rows[0]?.snapshotId, "snap_c2");
	assert.equal(stale.rows[0]?.baselineOutcome, "review");
	const staleAlignmentRow = stale.rows.find((row) => row.checkId === "chk_c");
	assert.equal(staleAlignmentRow?.snapshotId, "snap_c1");
	assert.equal(staleAlignmentRow?.baselineOutcome, "pass");
	assert.deepEqual(stale.alignment.baseline, { decided: 1, correct: 1, abstained: 0, rate: 1, coverage: 1 });
	// 把那次缺数据的导入撤掉，alignment 一个数都不变——这正是 G17 要的「后续导入不改变对齐率」
	store.snapshots = store.snapshots.filter((item) => item.id !== "snap_c2");
	const onEvidence = backtestStrategies(store, "bt-strict@v1", "bt-strict@v1");
	assert.equal(onEvidence.rows[0]?.snapshotId, "snap_c1");
	assert.equal(onEvidence.rows[0]?.baselineOutcome, "pass");
	assert.deepEqual(onEvidence.alignment, stale.alignment);
});

test("leadHistoryNote 给出相似市场的相似度、历史结论与复盘 verdict，无相似市场时返回空", () => {
	const store = createEmptyStore(at);
	store.markets.push(
		market("target", "Yoga Mat Strap", ["yoga mat strap", "mat carrier"], "Sports & Outdoors"),
		market("similar", "Yoga Strap Carrier", ["yoga mat strap", "strap carrier"], "Sports & Outdoors"),
	);
	store.decisionLog.push({ id: "dec_sim", marketId: "similar", type: "decision", conclusion: "No Go", decisionStatus: "no_go", reason: "红海", actor: "tester", createdAt: "2026-01-05T00:00:00.000Z" });
	store.outcomeChecks.push(check("chk_sim", "similar", "no_go", "challenged", { createdAt: "2026-02-01T00:00:00.000Z" }));
	assert.deepEqual(leadHistoryNote(store, "target"), [
		"与 similar「Yoga Strap Carrier」相似度 73%（关键词重合 5）；历史结论 no_go / 复盘 challenged。",
		"先用 compass_history action=timeline market_ref=similar 查看证据，再决定是否重复立项。",
	]);
	const lonely = createEmptyStore(at);
	lonely.markets.push(market("only", "Yoga Mat Strap", ["yoga mat strap"]));
	assert.deepEqual(leadHistoryNote(lonely, "only"), []);
});

test("importHistoryNote 依次给出快照对照、既往决策与本次自动 OutcomeCheck", () => {
	const store = createEmptyStore(at);
	store.markets.push(market("m", "market m"));
	store.snapshots.push(
		snapshot("snap_old", "m", "2026-01-01T00:00:00.000Z", { new_listing_share_12m: evidence(0.1), cr3: evidence(0.7), price_p50: evidence(20) }),
		snapshot("snap_new", "m", "2026-02-01T00:00:00.000Z", { new_listing_share_12m: evidence(0.2), cr3: evidence(0.6), price_p50: evidence(22) }),
	);
	store.decisionLog.push({ id: "dec", marketId: "m", type: "decision", conclusion: "No Go", decisionStatus: "no_go", reason: "新品占比不足", actor: "tester", createdAt: "2026-01-10T00:00:00.000Z" });
	const outcome = check("chk_1", "m", "no_go", "challenged", {
		createdAt: "2026-02-01T00:00:00.000Z",
		baselineSnapshotId: "snap_old",
		evidenceSnapshotId: "snap_new",
		verdictReason: "新品占比回升",
	});
	assert.deepEqual(importHistoryNote(store, "m", "snap_new", outcome), [
		"快照对照 snap_old→snap_new：价格中位数 20→22 (unknown)；CR3 70.0%→60.0% (improved)；新品占比 10.0%→20.0% (improved)",
		"既往决策：no_go · 新品占比不足",
		"已生成 chk_1：challenged · 新品占比回升；建议重跑 compass_strategy_run",
	]);
	assert.deepEqual(importHistoryNote(store, "m", "snap_old"), ["既往决策：no_go · 新品占比不足"]);
	const fresh = createEmptyStore(at);
	fresh.markets.push(market("m", "market m"));
	fresh.snapshots.push(snapshot("snap_only", "m", "2026-01-01T00:00:00.000Z", { cr3: evidence(0.7) }));
	assert.deepEqual(importHistoryNote(fresh, "m", "snap_only"), []);
});

test("decisionHistoryNote 汇总决策链、相似市场 go 达成率与命中经验", () => {
	const store = createEmptyStore(at);
	store.markets.push(
		market("target", "Yoga Mat Strap", ["yoga mat strap", "mat carrier"], "Sports & Outdoors"),
		market("peer", "Yoga Strap Carrier", ["yoga mat strap", "strap carrier"], "Sports & Outdoors"),
		// 第二个 peer 只有一条 check：两个 peer 的 check 条数不等，按条数与按市场加权
		// 才会算出不同的数，用例因此能真正区分两种口径（见下面的断言注释）。
		market("peer2", "Yoga Mat Strap Belt", ["yoga mat strap", "strap belt"], "Sports & Outdoors"),
	);
	const candidate: Candidate = { id: "cand", marketId: "target", stage: "deep_research", tags: [], decisionStatus: "waitlist", decisionReason: "等竞品数据", decisionAt: "2026-02-01T00:00:00.000Z", createdAt: at, updatedAt: at };
	store.candidates.push(candidate);
	store.decisionLog.push(
		{ id: "d1", candidateId: "cand", marketId: "target", type: "stage_move", conclusion: "lead → deep_research", reason: "值得深研", actor: "tester", createdAt: "2026-01-05T00:00:00.000Z" },
		{ id: "d2", candidateId: "cand", marketId: "target", type: "decision", conclusion: "Waitlist", decisionStatus: "waitlist", reason: "等竞品数据", actor: "tester", createdAt: "2026-02-01T00:00:00.000Z" },
	);
	store.outcomeChecks.push(
		check("chk_p1", "peer", "go", "validated", { createdAt: "2026-02-01T00:00:00.000Z" }),
		check("chk_p2", "peer", "go", "challenged", { createdAt: "2026-02-02T00:00:00.000Z" }),
		check("chk_p3", "peer", "go", "inconclusive", { createdAt: "2026-02-03T00:00:00.000Z" }),
		check("chk_q1", "peer2", "go", "validated", { createdAt: "2026-02-01T00:00:00.000Z" }),
	);
	store.lessons.push(
		{ ...lesson("les_category", "2026-01-01T00:00:00.000Z", { categories: ["Sports & Outdoors"] }), evidence: ["chk_p1", "chk_p2"] },
		{ ...lesson("les_single", "2026-03-01T00:00:00.000Z", { keywords: ["carrier"] }), evidence: ["chk_p1", "chk_p2"] },
		{ ...lesson("les_global", "2026-05-01T00:00:00.000Z", {}), evidence: ["chk_p1", "chk_p2"] },
	);
	assert.deepEqual(decisionHistoryNote(store, candidate), [
		"决策链：2 条留痕；当前 waitlist，stage=deep_research。",
		// 按市场去重：peer 的最新可判 check 是 chk_p2（challenged，chk_p3 是 inconclusive 不可判），
		// peer2 是 chk_q1（validated）→ 2 个市场 1 个 validated = 50%。
		// 若退回按条数加权会是 chk_p1+chk_p2+chk_q1 里 2 个 validated = 67%，两者可区分。
		"相似市场 go 品实绩达成率 50%（2 个市场，按市场去重：同一市场只取最新一条可判对照）。",
		"命中经验 les_category：经验 les_category（evidence: chk_p1、chk_p2）",
		// G19：limit 2 的第二席给了单关键词命中的专属经验，不再被最新的通用条挤占
		"命中经验 les_single：经验 les_single（evidence: chk_p1、chk_p2）",
	]);
});

test("strategyHistoryNote 的历史准确率直接引用 byStrategy 的该版本分组", () => {
	const store = createEmptyStore(at);
	store.markets.push(market("m", "market m"));
	const makeRun = (id: string, runAt: string, outcome: "pass" | "reject", score: number, status: "pass" | "veto"): StrategyRun => ({
		id,
		strategyId: "alpha",
		strategyVersion: 1,
		marketId: "m",
		snapshotId: "snap",
		mode: "screen",
		result: {
			outcome,
			score,
			dimensionScores: {},
			rules: [{ id: "entry", stage: "market_screen", action: "require", label: "新品占比", when: "new_listing_share_12m >= 0.15", condition: status === "pass", status, references: ["new_listing_share_12m"], evidence: {}, message: status }],
			missingMetrics: [],
		},
		runAt,
		actor: "tester",
	});
	const previous = makeRun("run_prev", "2026-01-01T00:00:00.000Z", "reject", 40, "veto");
	const current = makeRun("run_now", "2026-02-01T00:00:00.000Z", "pass", 60, "pass");
	store.strategyRuns.push(previous, current);
	store.outcomeChecks.push(
		check("chk_1", "m", "no_go", "validated", { baselineRunId: "run_prev" }),
		check("chk_2", "m2", "no_go", "challenged", { baselineRunId: "run_prev" }),
	);
	assert.deepEqual(strategyHistoryNote(store, current), [
		"上次 run_prev→本次 run_now：outcome reject→pass，Score 40→60，veto 1→0。",
		"规则变化：entry:veto→pass",
		"该策略版本历史准确率 50%（validated 1 / challenged 1 / inconclusive 0）。",
	]);
});

test("验证率有三处独立实现：history 的 outcomeStatistics、web 的 overview/retro、TUI 状态行必须同口径", () => {
	const store = createEmptyStore(at);
	store.outcomeChecks.push(
		check("chk_go_v", "m1", "go", "validated"),
		check("chk_no_c", "m2", "no_go", "challenged"),
		check("chk_bare_v1", "m3", undefined, "validated"),
		check("chk_bare_v2", "m4", undefined, "validated"),
		check("chk_bare_c", "m5", undefined, "challenged"),
		check("chk_go_i", "m6", "go", "inconclusive"),
	);
	const now = "2026-03-01T00:00:00.000Z";
	// 三个面必须给出同一个数；G15/G16 之后这个数是 0.5（m3/m4/m5 无决策锚点、m6 inconclusive 全被剔除）
	assert.equal(outcomeStatistics(store).validationRate, 0.5);
	assert.equal(overviewData(store, now).summary.validationRate, 0.5);
	assert.equal(retroData(store, now).stats.validationRate, 0.5);
	assert.deepEqual(
		[retroData(store, now).stats.checks, retroData(store, now).stats.validated, retroData(store, now).stats.challenged, retroData(store, now).stats.inconclusive],
		[6, 3, 2, 1],
	);
	assert.match(compactDashboardSummary(store), /验证率 50%/);
});

// —— 审计 G19 回归（替换原「平分 1 分」那条 B 组断言）——
function scopedLesson(id: string, scope: Lesson["scope"], updatedAt: string): Lesson {
	return { id, title: `经验 ${id}`, detail: "detail", scope, evidence: ["chk_x"], status: "active", createdAt: at, updatedAt, actor: "tester" };
}

// —— 审计 G19 回归 ——
test("经验召回按 scope 命中分档：单关键词命中排在无 scope 的通用经验之前，通用经验仍保底可召回", () => {
	const store = createEmptyStore(at);
	store.markets.push(
		market("mkt_target", "硅胶铲", ["硅胶铲", "耐高温", "烘焙工具"], "厨房用品"),
		market("mkt_probe", "硅胶刮刀", ["硅胶铲", "耐高温", "烘焙工具"], "厨房用品"),
		market("mkt_other", "宠物饮水机", ["饮水机", "宠物"], "宠物用品"),
	);
	const candidate: Candidate = { id: "cand_g19", marketId: "mkt_target", stage: "screen", tags: [], createdAt: at, updatedAt: at };
	store.candidates.push(candidate);
	store.lessons.push(
		scopedLesson("les_global", {}, "2026-08-30T00:00:00.000Z"),
		scopedLesson("les_metrics", { metrics: ["price_band"] }, "2026-08-29T00:00:00.000Z"),
		scopedLesson("les_keyword", { keywords: ["耐高温"] }, "2026-01-10T00:00:00.000Z"),
		scopedLesson("les_category", { categories: ["厨房用品"] }, "2026-01-01T00:00:00.000Z"),
	);
	// 类目命中 > 单关键词命中 > 无 scope / 仅 metrics scope；只有同档内才按 updatedAt 决胜
	assert.deepEqual(
		matchingLessonsForMarket(store, "mkt_target").map((lesson) => lesson.id),
		["les_category", "les_keyword", "les_global", "les_metrics"],
	);
	// 三个注入面：历史速览 limit 1
	assert.match(renderHistoryBrief(store, { marketId: "mkt_target" }), /· 相关经验 les_category：/);
	// decisionHistoryNote limit 2
	assert.deepEqual(
		decisionHistoryNote(store, candidate).filter((line) => line.startsWith("命中经验")),
		[
			"命中经验 les_category：经验 les_category（evidence: chk_x）",
			"命中经验 les_keyword：经验 les_keyword（evidence: chk_x）",
		],
	);
	// similarMarkets 携带的 lessons limit 3
	assert.deepEqual(
		similarMarkets(store, { marketId: "mkt_probe", limit: 3 })[0].lessons.map((lesson) => lesson.id),
		["les_category", "les_keyword", "les_global"],
	);
	// 「无 scope 全局适用」不变：没有专属经验时通用条照样注入，无关市场也只剩通用条
	store.lessons = store.lessons.filter((lesson) => lesson.id === "les_global" || lesson.id === "les_metrics");
	assert.match(renderHistoryBrief(store, { marketId: "mkt_target" }), /· 相关经验 les_global：/);
	assert.deepEqual(matchingLessonsForMarket(store, "mkt_other").map((lesson) => lesson.id), ["les_global", "les_metrics"]);
});

// —— 审计 G16 回归（verifier 复核后补）：两个面的去重样本必须逐条相同 ——
// backtest 曾就地重写一遍去重逻辑但漏掉 id 兜底，同毫秒并列时与四率选中相反的 check，
// 「复盘比率与 backtest 一致率同口径」这句话就不成立。同毫秒 OutcomeCheck 在真实导入链路上
// 会自然发生（一次导入里连写多条），所以这不是理论边界。
test("同毫秒并列的可判对照：四率与 backtest 必须选中同一条，不能各排各的序", () => {
	const store = createEmptyStore(at);
	const strict = `meta:\n  name: bt-tie\n  display_name: BT Tie\nstages:\n  - stage: market_screen\n    rules:\n      - id: activity\n        when: "new_listing_share_12m >= 0.15"\n        action: require\n        label: 新品占比\nscoring:\n  weights:\n    demand: 1\n`;
	saveStrategyVersion(store, { yaml: strict, actor: "tester" });
	store.markets.push(market("mT", "market tie"));
	store.snapshots.push(snapshot("snap_t", "mT", "2026-02-01T00:00:00.000Z", { new_listing_share_12m: evidence(0.3) }));
	// 两条 createdAt 完全相同、verdict 相反；数组序与 id 序刻意相反，逼出「靠数组序」与「靠 id 兜底」的分歧
	const tie = "2026-02-10T00:00:00.000Z";
	store.outcomeChecks.push(
		check("chk_aaa", "mT", "no_go", "validated", { createdAt: tie, baselineSnapshotId: "snap_t", evidenceSnapshotId: "snap_t" }),
		check("chk_zzz", "mT", "no_go", "challenged", { createdAt: tie, baselineSnapshotId: "snap_t", evidenceSnapshotId: "snap_t" }),
	);
	const picked = latestComparableChecks(store.outcomeChecks);
	assert.equal(picked.length, 1);
	const backtest = backtestStrategies(store, "bt-tie@v1", "bt-tie@v1");
	const backtestPicked = backtest.rows.find((row) => row.checkId)?.checkId;
	assert.equal(backtestPicked, picked[0].id, "backtest 与四率必须取同一条并列对照");
	// 两边同源之后，「no_go 正确率」与 alignment 才可能互相印证
	const stats = outcomeStatistics(store);
	assert.equal(stats.ratedMarkets, 1);
	assert.equal(backtest.alignment.comparableChecks, 1);
});

// —— review R16 回归（读取侧兜底）——
test("retroDueConfig：小数天数回落缺省，不被 Math.floor 压成 0 天", () => {
	// 保存侧（strategy.ts 的 POSITIVE_INTEGER_META_FIELDS）已经拒了小数，这条守的是**存量 store**：
	// 从前 0.5 会变成 0 天，retro_due 恒为到期、录了实绩也清不掉，全程没有任何报错。
	const decimal = retroDueConfig({ retro_go_days: 0.5, retro_waitlist_days: 7.5 });
	assert.equal(decimal.goDays, DEFAULT_RETRO_DUE_RULES.goDays, "0.5 应回落缺省而不是变成 0");
	assert.equal(decimal.waitlistDays, DEFAULT_RETRO_DUE_RULES.waitlistDays);
	assert.notEqual(decimal.goDays, 0);

	// 正整数照常生效；非正数与非数字同样回落
	assert.equal(retroDueConfig({ retro_go_days: 14 }).goDays, 14);
	assert.equal(retroDueConfig({ retro_go_days: 0 }).goDays, DEFAULT_RETRO_DUE_RULES.goDays);
	assert.equal(retroDueConfig({ retro_go_days: -3 }).goDays, DEFAULT_RETRO_DUE_RULES.goDays);
	assert.equal(retroDueConfig({ retro_go_days: "30" }).goDays, DEFAULT_RETRO_DUE_RULES.goDays);
	assert.equal(retroDueConfig(undefined).goDays, DEFAULT_RETRO_DUE_RULES.goDays);
});


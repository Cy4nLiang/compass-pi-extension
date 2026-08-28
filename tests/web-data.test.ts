import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarketCsv } from "../csv.ts";
import { estimateProfit, normalizeProfitInput } from "../economics.ts";
import { createLead, ensureDefaults, importMarketAndScreen, recordProfitEstimate, recordRisk } from "../service.ts";
import { createEmptyStore } from "../store.ts";
import type { CompassStore } from "../types.ts";
import {
	budgetData,
	marketDossierData,
	marketsData,
	overviewData,
	poolCandidateData,
	poolData,
	retroData,
	todosData,
} from "../web/data.ts";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-08-26T00:00:00.000Z";

async function seededStore(): Promise<CompassStore> {
	const store = createEmptyStore("2026-08-01T00:00:00.000Z");
	ensureDefaults(store, "test");
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const fresh = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-24T00:00:00.000Z" });
	importMarketAndScreen(store, { marketName: "fresh market", parsed: fresh, capturedAt: "2026-08-24T00:00:00.000Z", actor: "tester", runScreen: true });
	const stale = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-07-01T00:00:00.000Z" });
	importMarketAndScreen(store, { marketName: "stale market", parsed: stale, capturedAt: "2026-07-01T00:00:00.000Z", actor: "tester", runScreen: true });
	return store;
}

test("all store-wide DTO functions survive an empty store with complete shapes", () => {
	const store = createEmptyStore("2026-08-01T00:00:00.000Z");
	const overview = overviewData(store, NOW);
	assert.equal(overview.summary.markets, 0);
	assert.equal(overview.summary.validationRate, null);
	assert.equal(overview.stages.length, 8);
	assert.equal(overview.todoCounts.length, 5);
	assert.deepEqual(overview.radar, []);
	assert.match(overview.gateDefaultsLine, /QRD\(300\)/);

	const todos = todosData(store, NOW);
	assert.equal(todos.total, 0);
	assert.equal(todos.groups.length, 5);

	const markets = marketsData(store, NOW);
	assert.equal(markets.total, 0);
	assert.deepEqual(markets.rows, []);

	const pool = poolData(store, NOW);
	assert.equal(pool.total, 0);
	assert.equal(pool.lanes.length, 8);
	assert.ok(pool.lanes.every((lane) => lane.count === 0 && lane.items.length === 0));

	const budget = budgetData(store, "2026-08");
	assert.deepEqual(budget.pools, []);
	assert.equal(budget.totals.attributionRate, 1);

	const retro = retroData(store, NOW);
	assert.deepEqual(retro.due, []);
	assert.equal(retro.stats.checks, 0);
	assert.deepEqual(retro.lessons, []);
});

test("reference-based DTO functions throw on unknown references", () => {
	const store = createEmptyStore("2026-08-01T00:00:00.000Z");
	assert.throws(() => marketDossierData(store, "no-such-market", NOW), /未找到市场/);
	assert.throws(() => poolCandidateData(store, "no-such-candidate"), /未找到候选/);
});

test("overview counts reflect imported markets and screen runs", async () => {
	const store = await seededStore();
	const overview = overviewData(store, NOW);
	assert.equal(overview.summary.markets, 2);
	assert.equal(overview.summary.activeCandidates, 2);
	const gateTotal = overview.kpi.gate.pass + overview.kpi.gate.review + overview.kpi.gate.reject;
	assert.equal(gateTotal, 2, "两张候选卡都应有粗筛 Gate 结论");
	assert.equal(overview.kpi.staleMarkets30d, 1);
	assert.equal(overview.radar.length, 2);
	assert.equal(overview.stages.reduce((sum, stage) => sum + stage.count, 0), 2);
	assert.ok(overview.budget.length >= 5, "ensureDefaults 应播种默认预算池");
});

test("markets rows expose freshness tiers and snapshot metrics", async () => {
	const store = await seededStore();
	const markets = marketsData(store, NOW);
	assert.equal(markets.total, 2);
	const fresh = markets.rows.find((row) => row.name === "fresh market");
	const stale = markets.rows.find((row) => row.name === "stale market");
	assert.ok(fresh && stale);
	assert.equal(fresh.freshness, "deep_fresh");
	assert.equal(fresh.snapshotAgeDays, 2);
	assert.equal(stale.freshness, "stale");
	assert.equal(markets.freshnessCounts.deep_fresh, 1);
	assert.equal(markets.freshnessCounts.stale, 1);
	assert.equal(typeof fresh.qrd, "number");
	assert.equal(typeof fresh.mainCpc, "number");
	assert.ok(fresh.gateOutcome, "导入自动粗筛后 Gate 结论应存在");
});

test("market dossier carries evidence rows with source and confidence", async () => {
	const store = await seededStore();
	const dossier = marketDossierData(store, "fresh market", NOW);
	assert.equal(dossier.snapshot?.freshness, "deep_fresh");
	assert.equal(dossier.metricSections.length, 5, "五维各一节");
	const d1 = dossier.metricSections[0];
	const sales = d1.rows.find((row) => row.key === "category_monthly_sales");
	assert.ok(sales);
	assert.equal(sales.source, "sellersprite");
	assert.equal(typeof sales.confidence, "number");
	assert.ok(["高", "中", "低"].includes(sales.confidenceTier));
	assert.match(d1.rows.find((row) => row.key === "qualify_rank_depth")?.label ?? "", /^QRD\(\d+\)$/);
	assert.ok(dossier.evaluation, "已有 screen run 时 evaluation 不应为空");
	assert.equal(dossier.evaluation.source, "run");
	assert.ok(dossier.evaluation.rules.length > 0);
	assert.equal(dossier.evaluation.dimensionScores.length, 5);
	assert.ok(dossier.decisionLog.length > 0, "导入应产生决策日志");
});

test("pool lanes group by stage and drawer detail carries latest run rules", async () => {
	const store = await seededStore();
	const pool = poolData(store, NOW);
	assert.equal(pool.total, 2);
	assert.equal(pool.lanes.reduce((sum, lane) => sum + lane.count, 0), 2);
	const laneWithItems = pool.lanes.find((lane) => lane.count > 0);
	assert.ok(laneWithItems);
	assert.ok(laneWithItems.items[0].marketName);

	const detail = poolCandidateData(store, "fresh market");
	assert.equal(detail.candidate.marketName, "fresh market");
	assert.ok(detail.latestRun, "粗筛 run 应作为规则摘要来源");
	assert.ok(detail.latestRun.rules.length > 0);
	assert.ok(detail.decisions.length > 0);
	const times = detail.decisions.map((decision) => decision.createdAt);
	assert.deepEqual(times, [...times].sort((a, b) => b.localeCompare(a)), "决策日志应按时间降序");
});

test("serialized DTOs never leak lazy snapshot detail arrays", async () => {
	const store = await seededStore();
	const payloads = [
		JSON.stringify(overviewData(store, NOW)),
		JSON.stringify(marketsData(store, NOW)),
		JSON.stringify(marketDossierData(store, "fresh market", NOW)),
		JSON.stringify(poolData(store, NOW)),
		JSON.stringify(poolCandidateData(store, "fresh market")),
		JSON.stringify(todosData(store, NOW)),
	];
	for (const payload of payloads) {
		assert.ok(!payload.includes('"listings"'), "DTO 序列化结果不得包含快照明细 listings");
	}
	// 红线豁免面本身必须有界：单品详情的链接区最多 5 条 listing 摘要
	const detail = poolCandidateData(store, "fresh market");
	assert.ok(detail.links.topListings.length <= 5, "topListings 必须 ≤5（有界读取）");
});

test("lead-only market (no snapshot, no run) stays safe across all DTO functions", async () => {
	const store = await seededStore();
	createLead(store, { marketName: "lead only market", actor: "tester" });

	const markets = marketsData(store, NOW);
	const leadRow = markets.rows.find((row) => row.name === "lead only market");
	assert.ok(leadRow);
	assert.equal(leadRow.freshness, "missing");
	assert.equal(leadRow.snapshotAgeDays, null);
	assert.equal(markets.freshnessCounts.missing, 1);

	const dossier = marketDossierData(store, "lead only market", NOW);
	assert.equal(dossier.snapshot, null);
	assert.equal(dossier.evaluation, null);
	assert.deepEqual(dossier.metricSections, []);

	const overview = overviewData(store, NOW);
	assert.equal(overview.summary.markets, 3);

	// 导入不会自动流转阶段（移动强制 reason），三张候选卡都还在 lead 泳道
	const pool = poolData(store, NOW);
	const leadLane = pool.lanes.find((lane) => lane.stage === "lead");
	assert.ok(leadLane?.items.some((item) => item.marketName === "lead only market"));
	assert.ok(leadLane?.items.every((item) => typeof item.snapshotAgeDays === "number" || item.snapshotAgeDays === null));

	const detail = poolCandidateData(store, "lead only market");
	assert.equal(detail.latestRun, null);
	assert.deepEqual(detail.links.topListings, []);
	assert.equal(detail.profitSummary, null);
	assert.equal(detail.riskSummary, null);
	assert.ok(detail.keyMetrics.every((row) => row.display === "缺"), "无快照时核心指标全部按缺失展示");
});

test("all clock-derived data follows the injected now, and invalid now falls back to the real clock", async () => {
	const store = await seededStore();
	store.costEvents.push({ id: "ce-aug", source: "sellersprite", amountCny: 50, createdAt: "2026-08-20T00:00:00.000Z", actor: "tester" });
	const january = overviewData(store, "2026-01-15T00:00:00.000Z");
	assert.equal(january.summary.monthSpentCny, 0, "预算月份必须跟随注入的 now，而非真实时钟");
	const august = overviewData(store, NOW);
	assert.equal(august.summary.monthSpentCny, 50);
	// 非法 now 回退真实时钟：与不传 now 的结果一致，绝不把好数据误报成过期
	assert.deepEqual(marketsData(store, "not-a-date").rows, marketsData(store).rows);
});

test("budget data aggregates month events and totals", async () => {
	const store = await seededStore();
	store.costEvents.push({ id: "ce1", source: "sellersprite", marketId: store.markets[0].id, amountCny: 12.5, createdAt: "2026-08-20T00:00:00.000Z", actor: "tester" });
	store.costEvents.push({ id: "ce2", source: "keepa", amountCny: 3, createdAt: "2026-07-15T00:00:00.000Z", actor: "tester" });
	const budget = budgetData(store, "2026-08");
	assert.equal(budget.events.length, 1, "只聚合当月事件");
	assert.equal(budget.events[0].marketName, store.markets[0].name);
	assert.equal(budget.totals.totalCostCny, 15.5);
	assert.equal(budget.totals.attributedCny, 12.5);
	const sellersprite = budget.pools.find((pool) => pool.source === "sellersprite");
	assert.equal(sellersprite?.spentCny, 12.5);
});

test("pool candidate detail carries decision evidence: links, key metrics, profit and risk summaries", async () => {
	const store = await seededStore();
	const input = normalizeProfitInput({
		marketId: "fresh market",
		salePrice: 25.99,
		purchaseCost: 3.5,
		firstMileCost: 0.9,
		referralRate: 0.15,
		fbaFee: 5.2,
		cvr: 0.12,
		cpc: 0.85,
	});
	recordProfitEstimate(store, input, estimateProfit(input), "tester");
	const risk = recordRisk(store, {
		marketRef: "fresh market",
		certStatus: "pass",
		ipRiskLevel: "pass",
		seasonFlag: "clear",
		policyFlag: "clear",
		logisticsRisk: "pass",
		evidence: [{ category: "cert", url: "https://example.gov/doc" }],
		actor: "tester",
	});
	const detail = poolCandidateData(store, "fresh market");
	// 链接区：Top 竞品按 rank 升序、URL 出自白名单 helper；搜索链接全部指向 amazon 搜索
	assert.ok(detail.links.topListings.length > 0 && detail.links.topListings.length <= 5);
	assert.equal(detail.links.topListings[0].rank, 1);
	assert.match(detail.links.topListings[0].url ?? "", /^https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}$/);
	assert.ok(detail.links.searches.every((item) => item.url.startsWith("https://www.amazon.com/s?k=")));
	// 核心指标卡：五个决策锚点，顺序稳定，含格式化展示
	assert.deepEqual(detail.keyMetrics.map((row) => row.key), ["qualify_rank_depth", "cr3", "new_listing_share_12m", "gross_margin", "cpc_ratio"]);
	assert.ok(detail.keyMetrics.every((row) => typeof row.display === "string" && row.display.length > 0));
	// 利润/风险摘要
	assert.ok(detail.profitSummary && detail.profitSummary.grossMargin > 0.4);
	assert.equal(detail.riskSummary?.overall, risk.overall);
	// 五维分随 latestRun 序列化（决策页唯一来源）
	assert.equal(detail.latestRun?.dimensionScores.length, 5);
	assert.ok(detail.latestRun?.dimensionScores.every((row) => typeof row.key === "string" && typeof row.label === "string"));
	// 旧字段保留（增量兼容）
	assert.ok(detail.candidate.id && Array.isArray(detail.decisions) && detail.latestRun);
});

test("pool candidate detail normalizes optional listing fields to null at the DTO boundary", async () => {
	const store = await seededStore();
	const marketId = store.markets.find((market) => market.name === "fresh market")?.id;
	const snapshot = store.snapshots.find((item) => item.marketId === marketId);
	assert.ok(snapshot);
	// 制造设计内常态：排名第一的 listing 无合法 ASIN（spec §4.2.5：行保留但不带链接）
	snapshot.listings[0].asin = "bad asin!!";
	const raw = JSON.parse(JSON.stringify(poolCandidateData(store, "fresh market")));
	const first = raw.links.topListings[0];
	assert.ok("url" in first, "可选字段必须以 null 出现而非丢键（前端严格 !== null 判空惯例）");
	assert.equal(first.url, null);
	assert.equal(first.asin, "bad asin!!");
});

test("todos DTO carries resolution summaries, status badges, and the resolved partition", () => {
	const store = createEmptyStore("2026-08-01T00:00:00.000Z");
	ensureDefaults(store, "test");
	store.markets.push({ id: "m1", name: "偏差市场", keywords: [], createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" });
	store.candidates.push({ id: "c1", marketId: "m1", stage: "screen", tags: [], gateOutcome: "review", gateReason: "缺 cr3", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" });
	for (const [id, source, capturedAt, cr3] of [["s1", "sellersprite", "2026-08-20T00:00:00.000Z", 0.9], ["s2", "sorftime", "2026-08-19T00:00:00.000Z", 0.5]] as const) {
		store.snapshots.push({ id, marketId: "m1", source, capturedAt, importedAt: capturedAt, rowCount: 0, listings: [], keywords: [], metrics: { cr3: { value: cr3, source, capturedAt, confidence: 0.8 } }, warnings: [] });
	}
	// 预算：一条当月已勾选（抑制）、一条上月水位失效（浮出）
	store.costEvents.push({ id: "ce1", source: "keepa", amountCny: 350, createdAt: "2026-08-20T00:00:00.000Z", actor: "ops" });
	store.budgetPools.push({ source: "web_demo", tier: "B", monthlyLimitCny: 100, enabled: true });
	store.costEvents.push({ id: "ce2", source: "web_demo", amountCny: 90, createdAt: "2026-08-20T00:00:00.000Z", actor: "ops" });
	const passed = {
		submittedAt: "2026-08-21T00:00:00.000Z", submittedBy: "compass-web", note: "已核对用量并决定收紧补数",
		evidence: [{ ref: "compass-imports/usage.md", note: "用量明细" }],
		verdict: "pass" as const, verdictReason: "结论与后续动作明确", verifiedAt: "2026-08-22T00:00:00.000Z", verifiedBy: "compass-agent",
	};
	store.todoResolutions = [
		{
			id: "tdr_sub", todoId: "todo_metric_divergence_m1", kind: "metric_divergence", marketId: "m1",
			titleSnapshot: "多源指标偏差 >30%", status: "rejected",
			attempts: [{ ...passed, verdict: "reject", verdictReason: "未说明以哪个来源为准" }],
			reopens: [], createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
		},
		{
			id: "tdr_done", todoId: "todo_budget_warning_keepa", kind: "budget_warning", source: "keepa",
			titleSnapshot: "预算 80% 告警：keepa", status: "resolved", attempts: [passed], reopens: [],
			resolvedAt: "2026-08-23T00:00:00.000Z", resolvedBy: "compass-web", basis: { month: "2026-08" },
			createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z",
		},
		{
			id: "tdr_lapsed", todoId: "todo_budget_warning_web_demo", kind: "budget_warning", source: "web_demo",
			titleSnapshot: "预算 80% 告警：web_demo", status: "resolved", attempts: [passed],
			reopens: [{ reopenedAt: "2026-07-20T00:00:00.000Z", reopenedBy: "ops", reason: "上月曾拉回" }],
			resolvedAt: "2026-07-23T00:00:00.000Z", resolvedBy: "compass-web", basis: { month: "2026-07" },
			createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z",
		},
	];

	const data = todosData(store, NOW);
	const active = data.groups.flatMap((group) => group.todos);
	// 非闭环类：resolvable=false、无状态徽标（null 归一，不留 undefined）
	const gate = active.find((todo) => todo.kind === "gate_review");
	assert.equal(gate?.resolvable, false);
	assert.equal(gate?.resolution, null);
	assert.equal(gate?.statusBadge, null);
	// 闭环类已驳回：徽标与驳回理由都进 DTO
	const divergence = active.find((todo) => todo.id === "todo_metric_divergence_m1");
	assert.equal(divergence?.resolvable, true);
	assert.equal(divergence?.statusBadge, "已驳回");
	assert.equal(divergence?.resolution?.verdict, "reject");
	assert.equal(divergence?.resolution?.verdictReason, "未说明以哪个来源为准");
	assert.equal(divergence?.resolution?.lapsed, false);
	// 已勾选且水位有效：不在活跃清单
	assert.equal(active.some((todo) => todo.id === "todo_budget_warning_keepa"), false);
	// 水位失效：浮出并标注
	const lapsed = active.find((todo) => todo.id === "todo_budget_warning_web_demo");
	assert.equal(lapsed?.statusBadge, "已处理·失效浮出");
	assert.equal(lapsed?.resolution?.lapsed, true);

	// 已处理分区：两条 resolved 记录，含末轮说明、结论、三动作时间与 actor
	assert.equal(data.resolved.length, 2);
	const done = data.resolved.find((row) => row.todoId === "todo_budget_warning_keepa");
	assert.equal(done?.titleSnapshot, "预算 80% 告警：keepa");
	assert.equal(done?.note, "已核对用量并决定收紧补数");
	assert.equal(done?.verdict, "pass");
	assert.equal(done?.verdictReason, "结论与后续动作明确");
	assert.equal(done?.submittedBy, "compass-web");
	assert.equal(done?.verifiedBy, "compass-agent");
	assert.equal(done?.resolvedBy, "compass-web");
	assert.equal(done?.resolvedAt, "2026-08-23T00:00:00.000Z");
	assert.equal(done?.lapsed, false);
	assert.equal(done?.marketId, null, "预算类无市场归属，null 归一");
	assert.equal(done?.evidence.length, 1);
	assert.equal(done?.reopenCount, 0);
	const lapsedRow = data.resolved.find((row) => row.todoId === "todo_budget_warning_web_demo");
	assert.equal(lapsedRow?.lapsed, true, "失效浮出的记录在已处理分区应标注");
	assert.equal(lapsedRow?.reopenCount, 1);
	// 按勾选时间倒序
	assert.deepEqual(data.resolved.map((row) => row.todoId), ["todo_budget_warning_keepa", "todo_budget_warning_web_demo"]);
	// 懒加载红线：DTO 不得序列化快照明细
	assert.ok(!JSON.stringify(data).includes('"listings"'));
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarketCsv } from "../csv.ts";
import { createLead, ensureDefaults, importMarketAndScreen } from "../service.ts";
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
	];
	for (const payload of payloads) {
		assert.ok(!payload.includes('"listings"'), "DTO 序列化结果不得包含快照明细 listings");
	}
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

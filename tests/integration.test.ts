import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarketCsv } from "../csv.ts";
import { estimateProfit, normalizeProfitInput } from "../economics.ts";
import { generateMarketReport } from "../report.ts";
import {
	createLead,
	ensureDefaults,
	importParsedMarket,
	moveCandidate,
	recordProfitEstimate,
	recordReviewAnalysis,
	recordRisk,
	runStrategy,
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
		assert.equal(loaded.strategyRuns.length, 2);
		assert.ok(loaded.decisionLog.length >= 7);
		assert.equal(loaded.candidates[0].stage, "deep_research");
		assert.equal(result.full.result.outcome, "pass");
		assert.equal(result.report.snapshotId, result.imported.snapshot.id);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

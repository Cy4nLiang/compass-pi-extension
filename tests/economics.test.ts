import assert from "node:assert/strict";
import test from "node:test";
import { estimateProfit, normalizeProfitInput } from "../economics.ts";

test("profit calculator reproduces the documented pricing example and capital model", () => {
	const input = normalizeProfitInput({
		salePrice: 25.99,
		purchaseCost: 3.5,
		firstMileCost: 0.9,
		fbaFee: 5.2,
		referralRate: 0.15,
		cvr: 0.12,
		cpc: 0.85,
		returnRate: 0.05,
		dailyUnits: 10,
		stockDays: 60,
		testAdBudget: 500,
		oneTimeCosts: 100,
		portfolioCapital: 20_000,
	});
	const result = estimateProfit(input);
	assert.equal(result.landedCost, 4.4);
	assert.ok(Math.abs(result.grossMargin - 0.4805) < 0.001);
	assert.equal(result.breakEvenCpc, 1.5);
	assert.ok(result.cpcRatio !== undefined && Math.abs(result.cpcRatio - 0.567) < 0.002);
	assert.equal(result.firstInventoryCost, 2640);
	assert.equal(result.startupCapital, 3240);
	assert.equal(result.netMarginScenarios.length, 3);
	assert.ok(result.netMarginScenarios[0].netMargin > result.netMarginScenarios[2].netMargin);
});

test("percentage inputs above one are rejected", () => {
	assert.throws(
		() => normalizeProfitInput({ salePrice: 20, purchaseCost: 4, fbaFee: 5, referralRate: 15 }),
		/0–1/,
	);
});

test("negative CPC is rejected before it can pass the Gate", () => {
	assert.throws(
		() => normalizeProfitInput({ salePrice: 20, purchaseCost: 4, fbaFee: 5, cpc: -1 }),
		/cpc.*非负/,
	);
});

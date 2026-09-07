import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_GATE_THRESHOLDS } from "../defaults.ts";
import { estimateProfit, normalizeProfitInput, profitMetrics } from "../economics.ts";

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


// —— 审计 M21 回归 ——
test("CPC 为 0 按缺数据处理：cpcRatio 缺失、有警告、cpc_ratio 指标为 null", () => {
	const input = normalizeProfitInput({
		salePrice: 25.99,
		purchaseCost: 3.5,
		firstMileCost: 0.9,
		fbaFee: 5.2,
		referralRate: 0.15,
		cvr: 0.12,
		cpc: 0,
	});
	const result = estimateProfit(input);
	assert.equal(result.breakEvenCpc, 1.5);
	assert.equal(result.cpcRatio, undefined);
	assert.ok(result.warnings.some((warning) => warning.includes("主词 CPC 为 0")));
	const metrics = profitMetrics(input, result, "2026-08-22T00:00:00.000Z");
	assert.equal(metrics.cpc_ratio.value, null);
});


// —— D-1 缺陷组 ②：毛利 Gate 阈值单一事实来源（2026-09-05）——
// 策略规则 gross_margin_gate 改阈值后，利润测算的警告仍按写死的 0.4 判：策略说通过、
// 利润测算说未达标（或反向：利润面全绿、策略已否决）。阈值必须由调用方传入，文案回显阈值。
test("毛利 Gate 警告按传入阈值判定，文案回显阈值而不是写死 40%（D-1 缺陷组 ②）", () => {
	const at37 = normalizeProfitInput({ salePrice: 20, purchaseCost: 4.6, fbaFee: 5, referralRate: 0.15, cvr: 0.12, cpc: 0.5 });
	const at42 = normalizeProfitInput({ salePrice: 20, purchaseCost: 3.6, fbaFee: 5, referralRate: 0.15, cvr: 0.12, cpc: 0.5 });
	assert.ok(Math.abs(estimateProfit(at37).grossMargin - 0.37) < 0.001);
	assert.ok(Math.abs(estimateProfit(at42).grossMargin - 0.42) < 0.001);
	// 策略把毛利 Gate 放宽到 35%：0.37 不该再有「低于」警告
	assert.equal(estimateProfit(at37, { grossMargin: 0.35 }).warnings.some((warning) => warning.includes("毛利率低于")), false);
	// 策略收紧到 45%：0.42 必须有且只有一条警告，文案回显 45%
	const tight = estimateProfit(at42, { grossMargin: 0.45 }).warnings.filter((warning) => warning.includes("毛利率低于"));
	assert.equal(tight.length, 1);
	assert.match(tight[0], /45%/);
	// 不传第二参 = 内置默认：0.37 有警告且文案回显 40%
	const byDefault = estimateProfit(at37).warnings.filter((warning) => warning.includes("毛利率低于"));
	assert.equal(byDefault.length, 1);
	assert.match(byDefault[0], /40%/);
	assert.equal(DEFAULT_GATE_THRESHOLDS.grossMargin, 0.4);
});


// —— 1688 参考成本（compass-1688-cost-reference）：采购价出处随利润输入落库 ——
// normalizeProfitInput 逐字段重建对象，新字段不显式列出就会被静默丢掉；
// 出处只在传了的时候才落键——deepEqual 会把 { x: undefined } 与 {} 判成不同，存量路径不能多出键。
test("采购价出处：normalizeProfitInput 透传 purchaseCostSource 与 costReferenceId，没传就不落键", () => {
	const sourced = normalizeProfitInput({ salePrice: 20, purchaseCost: 4, fbaFee: 5, purchaseCostSource: "ali1688_reference", costReferenceId: "cref_demo1" });
	assert.equal(sourced.purchaseCostSource, "ali1688_reference");
	assert.equal(sourced.costReferenceId, "cref_demo1");
	const plain = normalizeProfitInput({ salePrice: 20, purchaseCost: 4, fbaFee: 5 });
	assert.equal(Object.hasOwn(plain, "purchaseCostSource"), false);
	assert.equal(Object.hasOwn(plain, "costReferenceId"), false);
});

test("采购价出处：profitMetrics 的 gross_margin note 在出处为 1688 参考成本时标注口径", () => {
	const sourced = normalizeProfitInput({ salePrice: 20, purchaseCost: 4, fbaFee: 5, purchaseCostSource: "ali1688_reference", costReferenceId: "cref_demo1" });
	const note = profitMetrics(sourced, estimateProfit(sourced), "2026-09-07T00:00:00.000Z").gross_margin.note ?? "";
	assert.ok(note.includes("1688 参考成本"), note);
	const quoted = normalizeProfitInput({ salePrice: 20, purchaseCost: 4, fbaFee: 5, purchaseCostSource: "supplier_quote" });
	const quotedNote = profitMetrics(quoted, estimateProfit(quoted), "2026-09-07T00:00:00.000Z").gross_margin.note ?? "";
	assert.equal(quotedNote.includes("1688 参考成本"), false);
	assert.ok(quotedNote.includes("输入成本口径决定精度"), "既有 note 原文保留");
});

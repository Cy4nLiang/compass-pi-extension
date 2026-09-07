import assert from "node:assert/strict";
import test from "node:test";
import { COST_REFERENCE_COEFFICIENT } from "../defaults.ts";
import { computeCostReference, normalizeRows, orderCandidates, resolveUnitPrice, type CandidateRow, type CostReferenceFieldMap } from "../cost-reference.ts";

// 夹具形状逐字照搬 1688 参考成本链冻结的字段结构（头价是 JSON 数字、阶梯价是数字字符串、
// 30 天销量是 JSON 数字），但**取值全部虚构**：product_id 一律 1688DEMO 前缀、标题是 Demo 词——
// compass 是公开仓库且带公开 CI，断言失败的输出会进公网 Actions 日志。
const FIELDS: CostReferenceFieldMap = {
	product_id: "product_id",
	title: "title",
	url: "url",
	photo: "photo",
	price: "price",
	sales: "sales_of_30d",
	tiers: "wholesale_price_range",
	tier_price: "price",
	tier_quantity: "purchase_quantity",
	moq: "min_order_quantity",
};

interface RawRowOptions {
	price?: number;
	sales?: number;
	tiers?: string[];
	moq?: number;
}

function rawRow(index: number, options: RawRowOptions = {}): Record<string, unknown> {
	const id = `1688DEMO${String(index).padStart(4, "0")}`;
	const tiers = options.tiers ?? ["12.00"];
	return {
		product_id: id,
		title: `Demo Magnetic Basket ${index}`,
		url: `https://detail.1688.com/offer/${id}.html`,
		photo: `https://img.example.invalid/${id}.jpg`,
		price: options.price ?? 12,
		sales_of_30d: options.sales ?? 100,
		wholesale_price_range: tiers.map((price, tier) => ({ price, purchase_quantity: tier === 0 ? "≥2件" : `${(tier + 1) * 100}~${(tier + 2) * 100 - 1}件` })),
		min_order_quantity: options.moq ?? 2,
	};
}

/** 一条已归一、可取价的候选行：priceCny 直接给定，模拟运营纳入后的样本。 */
function candidate(index: number, priceCny: number, sales = 100): CandidateRow {
	const [row] = normalizeRows([rawRow(index, { price: priceCny, sales, tiers: [priceCny.toFixed(2)] })], FIELDS);
	return row;
}

const FX = { fxRate: 0.14, fxAsOf: "2026-09-01", currency: "USD" };

// ── 单品取价（拍板补充 2） ────────────────────────────────────────────────────

test("参考成本·单品取价：3 档阶梯取中间档", () => {
	const [row] = normalizeRows([rawRow(1, { price: 0, tiers: ["10.00", "9.00", "8.00"] })], FIELDS);
	assert.deepEqual(resolveUnitPrice(row), { priceCny: 9, priceField: "tier_median", tierCount: 3 });
});

test("参考成本·单品取价：2 档阶梯取两档均值", () => {
	const [row] = normalizeRows([rawRow(2, { price: 10, tiers: ["10.00", "8.00"] })], FIELDS);
	assert.deepEqual(resolveUnitPrice(row), { priceCny: 9, priceField: "tier_median", tierCount: 2 });
});

test("参考成本·单品取价：1 档阶梯即该档，头价不参与", () => {
	const [row] = normalizeRows([rawRow(3, { price: 99, tiers: ["7.50"] })], FIELDS);
	assert.deepEqual(resolveUnitPrice(row), { priceCny: 7.5, priceField: "tier_median", tierCount: 1 });
});

test("参考成本·单品取价：阶梯为空时头价 ≥ 1 元才可取，否则该行不可取价", () => {
	const [headline, zero, tiny, junkTier] = normalizeRows(
		[
			rawRow(4, { price: 6, tiers: [] }),
			rawRow(5, { price: 0, tiers: [] }),
			rawRow(6, { price: 0.6, tiers: [] }),
			// 阶梯里只有解析不出的档位：等于没有阶梯
			rawRow(7, { price: 0, tiers: ["面议"] }),
		],
		FIELDS,
	);
	assert.deepEqual(resolveUnitPrice(headline), { priceCny: 6, priceField: "headline", tierCount: 0 });
	assert.equal(resolveUnitPrice(zero), null);
	assert.equal(resolveUnitPrice(tiny), null);
	assert.equal(resolveUnitPrice(junkTier), null);
	assert.equal(headline.unit?.priceField, "headline", "normalizeRows 已把取价结果挂在行上");
	assert.equal(zero.unit, null);
});

// ── 候选顺序（拍板补充 3） ────────────────────────────────────────────────────

test("参考成本·候选顺序：有销量的行按返回顺序在前、零销量行在后，不可取价的行不进候选", () => {
	const rows = normalizeRows(
		[
			rawRow(1, { sales: 100 }),
			rawRow(2, { sales: 0 }),
			rawRow(3, { sales: 50 }),
			rawRow(4, { sales: 0, price: 0, tiers: [] }),
			rawRow(5, { sales: 20 }),
			rawRow(6, { sales: 0 }),
		],
		FIELDS,
	);
	const ordered = orderCandidates(rows);
	assert.deepEqual(
		ordered.map((row) => row.productId),
		["1688DEMO0001", "1688DEMO0003", "1688DEMO0005", "1688DEMO0002", "1688DEMO0006"],
		"有销量三条保持返回顺序（不按销量重排），零销量两条按返回顺序补在后面，无价的第 4 条被剔除",
	);
});

test("参考成本·零销量补位：纳入的零销量行计数进警告并在样本上标记", () => {
	const accepted = [candidate(1, 10, 500), candidate(2, 9, 300), candidate(3, 11, 200), candidate(4, 8, 0), candidate(5, 12, 0)];
	const result = computeCostReference(accepted, FX);
	assert.ok(result);
	assert.equal(result.zeroSalesCount, 2);
	assert.ok(result.warnings.some((warning) => warning.includes("零销量补位 2 条")), result.warnings.join(" | "));
	assert.deepEqual(result.samples.map((sample) => sample.zeroSales), [false, false, false, true, true]);
});

// ── 样本量分支（拍板补充 1） ──────────────────────────────────────────────────

test("参考成本·样本量 5：升序第 3 小；超过 5 条只取纳入顺序的前 5", () => {
	const accepted = [candidate(1, 5), candidate(2, 9), candidate(3, 7), candidate(4, 3), candidate(5, 11), candidate(6, 1), candidate(7, 2)];
	const result = computeCostReference(accepted, FX);
	assert.ok(result);
	assert.equal(result.sampleSize, 5);
	assert.deepEqual(result.samples.map((sample) => sample.productId), ["1688DEMO0001", "1688DEMO0002", "1688DEMO0003", "1688DEMO0004", "1688DEMO0005"]);
	assert.equal(result.method, "median");
	assert.equal(result.medianCny, 7);
});

test("参考成本·样本量 4：第 2、3 小的均值", () => {
	const result = computeCostReference([candidate(1, 5), candidate(2, 9), candidate(3, 7), candidate(4, 3)], FX);
	assert.ok(result);
	assert.equal(result.method, "median");
	assert.equal(result.medianCny, 6);
});

test("参考成本·样本量 3：第 2 小", () => {
	const result = computeCostReference([candidate(1, 9), candidate(2, 3), candidate(3, 7)], FX);
	assert.ok(result);
	assert.equal(result.method, "median");
	assert.equal(result.medianCny, 7);
});

test("参考成本·样本量 2：取最小值并告警", () => {
	const result = computeCostReference([candidate(1, 9), candidate(2, 3)], FX);
	assert.ok(result);
	assert.equal(result.method, "min");
	assert.equal(result.referenceCostCny, Math.round(3 * COST_REFERENCE_COEFFICIENT * 10_000) / 10_000);
	assert.ok(result.warnings.some((warning) => warning.includes("样本不足 3 条")), result.warnings.join(" | "));
});

test("参考成本·样本量 1：取最小值并告警", () => {
	const result = computeCostReference([candidate(1, 4)], FX);
	assert.ok(result);
	assert.equal(result.method, "min");
	assert.equal(result.medianCny, 4);
	assert.ok(result.warnings.some((warning) => warning.includes("样本不足 3 条")));
});

test("参考成本·样本量 0：不出数", () => {
	assert.equal(computeCostReference([], FX), null);
});

// ── 极小值防线 ───────────────────────────────────────────────────────────────

test("参考成本·极小值：最小价低于中位价一半时告警，正常分布不告警", () => {
	const bait = computeCostReference([candidate(1, 1), candidate(2, 8), candidate(3, 9), candidate(4, 10), candidate(5, 11)], FX);
	assert.ok(bait);
	assert.equal(bait.medianCny, 9);
	assert.ok(bait.warnings.some((warning) => warning.includes("疑似占位价")), bait.warnings.join(" | "));
	const normal = computeCostReference([candidate(1, 5), candidate(2, 8), candidate(3, 9), candidate(4, 10), candidate(5, 11)], FX);
	assert.ok(normal);
	assert.equal(normal.warnings.some((warning) => warning.includes("疑似占位价")), false);
});

// ── 系数与汇率 ───────────────────────────────────────────────────────────────

test("参考成本·系数与汇率：缺省系数 0.9，结果带系数、汇率、口径日期与币种", () => {
	const result = computeCostReference([candidate(1, 10), candidate(2, 10), candidate(3, 10)], FX);
	assert.ok(result);
	assert.equal(COST_REFERENCE_COEFFICIENT, 0.9);
	assert.equal(result.coefficient, 0.9);
	assert.equal(result.referenceCostCny, 9);
	assert.equal(result.referenceCost, 1.26);
	assert.equal(result.fxRate, 0.14);
	assert.equal(result.fxAsOf, "2026-09-01");
	assert.equal(result.currency, "USD");
});

test("参考成本·系数与汇率：显式系数生效，换算结果四舍五入到 4 位", () => {
	const result = computeCostReference([candidate(1, 7), candidate(2, 9), candidate(3, 11)], { ...FX, coefficient: 0.8, fxRate: 0.1398 });
	assert.ok(result);
	assert.equal(result.coefficient, 0.8);
	assert.equal(result.referenceCostCny, 7.2);
	assert.equal(result.referenceCost, 1.0066);
});

// ── 确定性 ───────────────────────────────────────────────────────────────────

test("参考成本·确定性：同一份输入两次计算逐字段相同", () => {
	const accepted = [candidate(1, 5, 500), candidate(2, 9, 0), candidate(3, 7, 30), candidate(4, 3, 0), candidate(5, 11, 12)];
	const first = computeCostReference(accepted, FX);
	const second = computeCostReference(accepted, FX);
	assert.deepEqual(first, second);
	assert.equal(JSON.stringify(first), JSON.stringify(second));
});

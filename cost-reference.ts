import { COST_REFERENCE_BAIT_RATIO, COST_REFERENCE_COEFFICIENT, COST_REFERENCE_MIN_HEADLINE_CNY, COST_REFERENCE_SAMPLE_SIZE } from "./defaults.ts";
import { ValidationError } from "./errors.ts";
import type { CostReferenceSample } from "./types.ts";

// 1688 参考成本：把一页按关键词检索到的 1688 商品行，按运营纳入的顺序算出一个参考采购价。
//
// 本模块是**纯函数层**：零 I/O、零写事务，只 import defaults / errors / types；不得 import
// gapfill-convert / service / index（它们是编排层，方向只能反过来）。数字不经模型：取价、排序、
// 中位数、系数、汇率全部在这里算，调用方只负责把运营在 TUI 里逐条确认过的行按顺序传进来。
//
// 规则来源（2026-09-07）：owner 四条原话——同款按销量取前 5、升序取中位、×系数、< 3 条取最小值并告警；
// 三条拍板补充——样本不足 5 条时先排序再取中位数（偶数取均值）、每个商品取阶梯价的中位数、
// 零销量行可按返回顺序补位但必须写出警告。

/** 映射表 cost_reference.fields：键是本模块认的字段名，值是载荷行里的字段名（或点路径）。 */
export interface CostReferenceFieldMap {
	product_id: string;
	title: string;
	url?: string;
	photo?: string;
	price: string;
	sales: string;
	tiers: string;
	tier_price: string;
	tier_quantity?: string;
	moq?: string;
}

export interface CandidateTier {
	price: number;
	quantity?: string;
}

export interface CandidateUnitPrice {
	priceCny: number;
	priceField: "tier_median" | "headline";
	tierCount: number;
}

/** 归一后的候选行。unit 为 null 表示这一行取不到价（头价 < 1 元且没有可解析的阶梯），不进候选。 */
export interface CandidateRow {
	productId: string;
	title: string;
	url?: string;
	photo?: string;
	salesOf30d: number;
	headlinePrice: number | null;
	tiers: CandidateTier[];
	moq?: number;
	unit: CandidateUnitPrice | null;
}

export interface CostReferenceOptions {
	/** 缺省 COST_REFERENCE_COEFFICIENT（0.9）；approve 参数可覆盖，范围 (0, 1] */
	coefficient?: number;
	/** 1 CNY 折合多少目标币种 */
	fxRate: number;
	/** 汇率口径日期（纯日期） */
	fxAsOf: string;
	currency: string;
	baitRatio?: number;
	sampleSize?: number;
}

export interface CostReferenceComputation {
	method: "median" | "min";
	/** 纳入样本价格升序后的中位数（偶数取均值），只作展示与极小值判据 */
	medianCny: number;
	referenceCostCny: number;
	referenceCost: number;
	coefficient: number;
	fxRate: number;
	fxAsOf: string;
	currency: string;
	sampleSize: number;
	zeroSalesCount: number;
	samples: CostReferenceSample[];
	warnings: string[];
}

/** 警告文案的字面量表。工作区 follower 逐字钉这三个前缀，改措辞先改那边的 needles。 */
export const COST_REFERENCE_TEXT = {
	zeroFill: "零销量补位",
	smallSample: "样本不足 3 条，按最小值计",
	bait: "疑似占位价",
} as const;

function round4(value: number): number {
	return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

/** 与 gapfill-convert.ts 的 pickPath 同语义（只看自有属性、缺任一层即 undefined），本层不能 import 编排层，所以自带一份。 */
function readField(root: unknown, path: string | undefined): unknown {
	if (!path) return undefined;
	let node: unknown = root;
	for (const key of path.split(".")) {
		if (node === null || typeof node !== "object") return undefined;
		if (!Object.hasOwn(node as object, key)) return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return node;
}

/** JSON 数字或纯数字字符串 → 有限数；其它形态（"面议"、空串、区间）一律 null。 */
function toFiniteNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const text = value.trim();
		if (!/^[0-9]+(?:\.[0-9]+)?$/u.test(text)) return null;
		const parsed = Number(text);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function textOf(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}

/** 升序数组的中位数：奇数取中间项，偶数取两个中间项的均值（owner 2026-09-07 确认）。 */
export function medianOf(sortedAsc: readonly number[]): number {
	if (!sortedAsc.length) throw new ValidationError("中位数需要至少一个数");
	const middle = Math.floor(sortedAsc.length / 2);
	return sortedAsc.length % 2 === 1 ? sortedAsc[middle] : (sortedAsc[middle - 1] + sortedAsc[middle]) / 2;
}

/**
 * 单品取价（拍板补充 2）：有可解析的阶梯就取阶梯价的中位数（3 档中间档、2 档均值、1 档即该档）；
 * 阶梯为空时头价须 ≥ 1 元才可取（抽样里 61% 的头价恰好为 0，是占位不是价）；两者皆无 → null。
 */
export function resolveUnitPrice(row: Pick<CandidateRow, "headlinePrice" | "tiers">): CandidateUnitPrice | null {
	const prices = row.tiers.map((tier) => tier.price).filter((price) => price > 0).sort((a, b) => a - b);
	if (prices.length) return { priceCny: round4(medianOf(prices)), priceField: "tier_median", tierCount: prices.length };
	if (row.headlinePrice !== null && row.headlinePrice >= COST_REFERENCE_MIN_HEADLINE_CNY) {
		return { priceCny: round4(row.headlinePrice), priceField: "headline", tierCount: 0 };
	}
	return null;
}

/** 按映射表把载荷行归一成候选行；非对象、无 product_id 的行不可取价。顺序保持载荷原序。 */
export function normalizeRows(rows: readonly unknown[], fields: CostReferenceFieldMap): CandidateRow[] {
	const normalized: CandidateRow[] = [];
	for (const raw of rows) {
		if (raw === null || typeof raw !== "object") continue;
		const productId = textOf(readField(raw, fields.product_id)) ?? "";
		const tiersRaw = readField(raw, fields.tiers);
		const tiers: CandidateTier[] = [];
		if (Array.isArray(tiersRaw)) {
			for (const tier of tiersRaw) {
				const price = toFiniteNumber(readField(tier, fields.tier_price));
				if (price === null) continue;
				const quantity = textOf(readField(tier, fields.tier_quantity));
				tiers.push(quantity === undefined ? { price } : { price, quantity });
			}
		}
		const moq = toFiniteNumber(readField(raw, fields.moq));
		const row: CandidateRow = {
			productId,
			title: textOf(readField(raw, fields.title)) ?? "",
			url: textOf(readField(raw, fields.url)),
			photo: textOf(readField(raw, fields.photo)),
			salesOf30d: Math.max(0, toFiniteNumber(readField(raw, fields.sales)) ?? 0),
			headlinePrice: toFiniteNumber(readField(raw, fields.price)),
			tiers,
			moq: moq === null ? undefined : moq,
			unit: null,
		};
		row.unit = productId ? resolveUnitPrice(row) : null;
		normalized.push(row);
	}
	return normalized;
}

/**
 * 候选顺序（拍板补充 3）：可取价的行里，30 天销量 > 0 的按载荷原序在前（载荷已按销量降序，
 * 这里**不重排**，只过滤），零销量的按原序补在后面。不可取价的行不进候选、不弹确认。
 */
export function orderCandidates(rows: readonly CandidateRow[]): CandidateRow[] {
	const eligible = rows.filter((row) => row.unit !== null);
	return [...eligible.filter((row) => row.salesOf30d > 0), ...eligible.filter((row) => row.salesOf30d <= 0)];
}

/**
 * 参考成本：`accepted` 是运营按纳入顺序确认过的候选行，只取前 sampleSize（5）条。
 * 样本 ≥ 3：升序取中位数；样本 1–2：取最小值并告警；样本 0：null（调用方不写库）。
 * 结果里没有任何时间戳或随机量——同一份输入两次调用逐字段相同。
 */
export function computeCostReference(accepted: readonly CandidateRow[], options: CostReferenceOptions): CostReferenceComputation | null {
	const coefficient = options.coefficient ?? COST_REFERENCE_COEFFICIENT;
	const baitRatio = options.baitRatio ?? COST_REFERENCE_BAIT_RATIO;
	const sampleSize = options.sampleSize ?? COST_REFERENCE_SAMPLE_SIZE;
	if (!Number.isFinite(coefficient) || coefficient <= 0 || coefficient > 1) throw new ValidationError("参考成本系数必须在 (0, 1] 之间");
	if (!Number.isFinite(options.fxRate) || options.fxRate <= 0) throw new ValidationError("汇率必须是正数");
	if (!Number.isFinite(sampleSize) || sampleSize < 1) throw new ValidationError("样本上限必须 ≥ 1");

	const chosen = accepted.filter((row): row is CandidateRow & { unit: CandidateUnitPrice } => row.unit !== null).slice(0, sampleSize);
	if (!chosen.length) return null;

	const prices = chosen.map((row) => row.unit.priceCny).sort((a, b) => a - b);
	const pivot = medianOf(prices);
	const method: CostReferenceComputation["method"] = chosen.length <= 2 ? "min" : "median";
	const base = method === "min" ? prices[0] : pivot;
	const zeroSalesCount = chosen.filter((row) => row.salesOf30d <= 0).length;

	const warnings: string[] = [];
	if (zeroSalesCount > 0) warnings.push(`${COST_REFERENCE_TEXT.zeroFill} ${zeroSalesCount} 条：这几条 30 天销量为 0，只是按返回顺序凑满样本`);
	if (method === "min") warnings.push(`${COST_REFERENCE_TEXT.smallSample}（只有 ${chosen.length} 条可用样本）`);
	if (prices[0] < pivot * baitRatio) {
		warnings.push(`${COST_REFERENCE_TEXT.bait}：最小价 ¥${prices[0].toFixed(2)} 不到中位价 ¥${round4(pivot).toFixed(2)} 的 ${Math.round(baitRatio * 100)}%`);
	}

	const referenceCostCny = round4(base * coefficient);
	return {
		method,
		medianCny: round4(pivot),
		referenceCostCny,
		referenceCost: round4(referenceCostCny * options.fxRate),
		coefficient,
		fxRate: options.fxRate,
		fxAsOf: options.fxAsOf,
		currency: options.currency,
		sampleSize: chosen.length,
		zeroSalesCount,
		samples: chosen.map((row) => {
			const sample: CostReferenceSample = {
				productId: row.productId,
				title: row.title,
				salesOf30d: row.salesOf30d,
				zeroSales: row.salesOf30d <= 0,
				priceCny: row.unit.priceCny,
				priceField: row.unit.priceField,
				tierCount: row.unit.tierCount,
			};
			if (row.url !== undefined) sample.url = row.url;
			if (row.moq !== undefined) sample.moq = row.moq;
			return sample;
		}),
		warnings,
	};
}

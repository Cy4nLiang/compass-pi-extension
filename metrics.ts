import { AMZ_MISSING_PREFIX, type AmazonSampleCounts, amazonSampleCounts, amazonSampleDiagnosis, dedupeKeywordRecords, rankedTop100 } from "./csv.ts";
import { DEFAULT_TARGET_MONTHLY_UNITS, SOURCE_BASE_CONFIDENCE } from "./defaults.ts";
import type { KeywordRecord, ListingRecord, MetricEvidence, MetricMap } from "./types.ts";

function finite(values: Array<number | undefined>): number[] {
	return values.filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0);
}

export function quantile(values: number[], q: number): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const position = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return sorted[lower];
	const fraction = position - lower;
	return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function round(value: number | undefined, digits = 4): number | null {
	if (value === undefined || !Number.isFinite(value)) return null;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function clamp(value: number, min = 0, max = 1): number {
	return Math.max(min, Math.min(max, value));
}

function confidence(base: number, known: number, total: number): number {
	if (known === 0 || total === 0) return 0;
	return round(clamp(base * Math.sqrt(known / total)), 2) ?? 0;
}

function evidence(
	value: number | string | boolean | null,
	source: string,
	capturedAt: string,
	metricConfidence: number,
	sampleSize?: number,
	note?: string,
): MetricEvidence {
	return { value, source, capturedAt, confidence: metricConfidence, sampleSize, note };
}

export function qualifyRankDepth(listings: ListingRecord[], monthlyUnits: number): number {
	return listings.filter((listing) => (listing.monthlySales ?? -Infinity) >= monthlyUnits).length;
}

// 取值随策略 meta.monthly_units_q（q）变化的指标：导入时冻结一份进快照，
// 读侧还要按「当时那个策略的 q」重算一份（service.buildStrategyContextForSnapshot）。
// 两条路径必须共用下面这一份算法，否则口径会静默分叉。
export const TARGET_DEPENDENT_METRIC_NAMES = ["qualify_rank_depth", "low_rating_high_sales_count"] as const;

export function targetDependentMetrics(input: {
	listings: ListingRecord[];
	source: string;
	capturedAt: string;
	targetMonthlyUnits: number;
}): MetricMap {
	const q = input.targetMonthlyUnits;
	const base = SOURCE_BASE_CONFIDENCE[input.source] ?? SOURCE_BASE_CONFIDENCE.generic_csv;
	const top = rankedTop100(input.listings);
	const total = top.length;
	const knownSales = finite(top.map((listing) => listing.monthlySales));
	const knownRatings = finite(top.map((listing) => listing.rating));
	const lowRatingHighSalesRows = top.filter(
		(listing) => listing.rating !== undefined && Number.isFinite(listing.rating) && listing.monthlySales !== undefined &&
			Number.isFinite(listing.monthlySales),
	);
	const lowRatingHighSalesCount = knownRatings.length > 0 && knownSales.length > 0
		? lowRatingHighSalesRows.filter(
			(listing) => (listing.rating as number) <= 4.2 && (listing.monthlySales as number) >= q,
		).length
		: undefined;
	return {
		qualify_rank_depth: {
			...evidence(
				knownSales.length ? qualifyRankDepth(top, q) : null,
				input.source,
				input.capturedAt,
				confidence(base, knownSales.length, total),
				knownSales.length,
				`月销≥${q} 的 listing 数`,
			),
			targetMonthlyUnits: q,
		},
		low_rating_high_sales_count: {
			...evidence(
				round(lowRatingHighSalesCount, 0),
				input.source,
				input.capturedAt,
				confidence(base, lowRatingHighSalesRows.length, total),
				lowRatingHighSalesRows.length,
				`星级≤4.2 且月销≥${q}`,
			),
			targetMonthlyUnits: q,
		},
	};
}

function waist(listings: ListingRecord[]): ListingRecord[] {
	if (listings.length === 0) return [];
	const start = Math.floor(listings.length * 0.4);
	const end = Math.max(start + 1, Math.ceil(listings.length * 0.6));
	return listings.slice(start, end);
}

function brandConcentration(listings: ListingRecord[]): {
	cr3?: number;
	cr5?: number;
	cr10?: number;
	hhi?: number;
	known: number;
} {
	const rows = listings.filter(
		(listing): listing is ListingRecord & { brand: string; monthlySales: number } =>
			Boolean(listing.brand) && listing.monthlySales !== undefined && listing.monthlySales >= 0,
	);
	const total = rows.reduce((sum, listing) => sum + listing.monthlySales, 0);
	if (rows.length === 0 || total <= 0) return { known: 0 };

	const groups = new Map<string, number>();
	for (const listing of rows) {
		const key = listing.brand.trim().toLocaleLowerCase();
		groups.set(key, (groups.get(key) ?? 0) + listing.monthlySales);
	}
	const shares = [...groups.values()].map((sales) => sales / total).sort((a, b) => b - a);
	const cr = (count: number) => shares.slice(0, count).reduce((sum, share) => sum + share, 0);
	return {
		cr3: cr(3),
		cr5: cr(5),
		cr10: cr(10),
		hhi: shares.reduce((sum, share) => sum + share ** 2, 0) * 10_000,
		known: rows.length,
	};
}

// 卖家类型已知率不足半数时，AMZ 占比不足以支撑「红海 veto」这条硬门槛，两个方向都会造出假确定性：
// 已知样本全自营会伪造出 1.0 直接满足 AMZ>30%，全非自营会伪造出 0.0 直接放过红海市场。
// 一律按缺失处理，交给策略引擎走 review（领域不变式：缺数据不得伪装成结论）。
// known 是「卖家类型 ∩ 月销量」都有值的行数（份额按月销加权，缺任一列的行对分子分母都不贡献），
// sellerKnown 只数卖家类型——两者不同时，告警必须点名真正缺的那一列，否则会把运营指向无效操作。
// 计数与判据都用 csv.ts 的共享件；diagnosis 存在即视为稀疏（不再单独返回 sparse 布尔，
// 那会让分类器跑两遍、且 note 侧出现永远到不了的 else 分支）。
// 恰好 50% 仍然计算，证据强度交由 confidence 表达。
function amazonShare(listings: ListingRecord[]): { value?: number; counts: AmazonSampleCounts; diagnosis?: string } {
	const counts = amazonSampleCounts(listings);
	const diagnosis = amazonSampleDiagnosis(counts);
	if (diagnosis !== undefined) return { counts, diagnosis };
	const amazonSales = listings
		.filter((listing) => listing.isAmazon === true && listing.monthlySales !== undefined && listing.monthlySales >= 0)
		.reduce((sum, listing) => sum + (listing.monthlySales ?? 0), 0);
	return { value: amazonSales / counts.salesTotal, counts };
}

// 稀疏告警必须点名**所有**不足的列：只报第一个不足的列会让运营补完那一列、重导、结论不变。
// 有效样本 known = 两列都有值的行数（份额按月销加权，缺任一列的行对分子分母都不贡献）。
// 三种形态：两列都不足半数 / 只有一列不足 / 两列各自都过半但缺口互补导致交集不足。
// 指标侧的 note 与 csv.ts 的导入告警共用 amazonSampleDiagnosis 的判断，只是各自换个说法。
// 注意：note 目前在报告与 Web 上都没有渲染点（report.ts / ui.ts 零引用，app.js 也没取
// MetricRowDto.note），运营真正看得到的是导入告警——所以那边必须同样准确，不能只修这里。
function sparseAmazonNote(counts: AmazonSampleCounts, diagnosis: string): string {
	return `${AMZ_MISSING_PREFIX}：有效样本 ${counts.usable}/${counts.total} 行（需卖家类型与月销量同时有值），份额按月销加权；${diagnosis}`;
}

function keywordMetrics(keywords: KeywordRecord[]): {
	totalSearchVolume?: number;
	mainCpc?: number;
	trafficConcentration?: number;
	volumeKnown: number;
	cpcKnown: number;
	total: number;
} {
	// 第二道防线：csv.ts 已在导入口折叠重复词行，这里再折叠一次，
	// 让直接喂历史快照 keywords 或手工构造数组的调用方同样拿不到被放大的合计。
	const unique = dedupeKeywordRecords(keywords).keywords;
	const withVolume = unique.filter(
		(keyword): keyword is KeywordRecord & { searchVolume: number } =>
			keyword.searchVolume !== undefined && Number.isFinite(keyword.searchVolume) && keyword.searchVolume >= 0,
	);
	const volumes = withVolume.map((keyword) => keyword.searchVolume).sort((a, b) => b - a);
	const totalSearchVolume = volumes.length ? volumes.reduce((sum, value) => sum + value, 0) : undefined;
	const trafficConcentration =
		totalSearchVolume && totalSearchVolume > 0
			? volumes.slice(0, 3).reduce((sum, value) => sum + value, 0) / totalSearchVolume
			: undefined;
	// CPC=0 视为缺失而非「零成本流量」：Amazon Sponsored Products 最低竞价约 $0.02，
	// 数据源导出时普遍用 0 表示「无竞价数据」。计入加权会把主词 CPC 稀释成假低值，
	// 进而让 cpc_ratio 拿满分、两条 CPC Gate 无警告通过，违反「缺数据一律转 review」。
	const withCpc = unique.filter(
		(keyword): keyword is KeywordRecord & { cpc: number } =>
			keyword.cpc !== undefined && Number.isFinite(keyword.cpc) && keyword.cpc > 0,
	);
	let mainCpc: number | undefined;
	if (withCpc.length) {
		const weighted = withCpc.filter((keyword) => keyword.searchVolume !== undefined && keyword.searchVolume > 0);
		if (weighted.length) {
			const weight = weighted.reduce((sum, keyword) => sum + (keyword.searchVolume ?? 0), 0);
			mainCpc = weighted.reduce((sum, keyword) => sum + (keyword.cpc ?? 0) * (keyword.searchVolume ?? 0), 0) / weight;
		} else {
			mainCpc = quantile(withCpc.map((keyword) => keyword.cpc as number), 0.5);
		}
	}
	return {
		totalSearchVolume,
		mainCpc,
		trafficConcentration,
		volumeKnown: withVolume.length,
		cpcKnown: withCpc.length,
		total: unique.length,
	};
}

export function calculateMarketMetrics(input: {
	listings: ListingRecord[];
	keywords: KeywordRecord[];
	source: string;
	capturedAt: string;
	targetMonthlyUnits?: number;
}): MetricMap {
	const targetMonthlyUnits = input.targetMonthlyUnits ?? DEFAULT_TARGET_MONTHLY_UNITS;
	const source = input.source;
	const capturedAt = input.capturedAt;
	const base = SOURCE_BASE_CONFIDENCE[source] ?? SOURCE_BASE_CONFIDENCE.generic_csv;
	const top = rankedTop100(input.listings);
	const middle = waist(top);
	const total = top.length;
	const sales = finite(top.map((listing) => listing.monthlySales));
	const revenues = finite(top.map((listing) => listing.monthlyRevenue));
	const prices = finite(top.map((listing) => listing.price));
	const waistSales = finite(middle.map((listing) => listing.monthlySales));
	const waistReviews = finite(middle.map((listing) => listing.reviewCount));
	const waistRatings = finite(middle.map((listing) => listing.rating));
	const ages = finite(top.map((listing) => listing.monthsOnline));
	const top20Ages = finite(top.slice(0, 20).map((listing) => listing.monthsOnline));
	const concentration = brandConcentration(top);
	const amazon = amazonShare(top);
	const kw = keywordMetrics(input.keywords);

	const categoryMonthlySales = sales.length === total && total > 0 ? sales.reduce((sum, value) => sum + value, 0) : undefined;
	const categoryMonthlyRevenue =
		revenues.length === total && total > 0 ? revenues.reduce((sum, value) => sum + value, 0) : undefined;
	const newListingShare = ages.length ? ages.filter((months) => months <= 12).length / ages.length : undefined;

	const metrics: MetricMap = {
		listing_count: evidence(total, source, capturedAt, total ? base : 0, total),
		category_monthly_sales: evidence(
			round(categoryMonthlySales, 0),
			source,
			capturedAt,
			confidence(base, sales.length, total),
			sales.length,
			"Top100（或导入范围）月销估算合计；仅在每行均有月销时给出",
		),
		category_monthly_revenue: evidence(
			round(categoryMonthlyRevenue, 2),
			source,
			capturedAt,
			confidence(base, revenues.length, total),
			revenues.length,
		),
		waist_monthly_sales: evidence(
			round(quantile(waistSales, 0.5), 0),
			source,
			capturedAt,
			confidence(base, waistSales.length, middle.length),
			waistSales.length,
			"按导入排名 P40–P60 listing 的月销中位数",
		),
		// q 相关的两项（qualify_rank_depth / low_rating_high_sales_count）统一由
		// targetDependentMetrics 产出：读侧会用同一份算法按当时的策略 q 重算，口径必须同源
		...targetDependentMetrics({ listings: input.listings, source, capturedAt, targetMonthlyUnits }),
		price_p25: evidence(round(quantile(prices, 0.25), 2), source, capturedAt, confidence(base, prices.length, total), prices.length),
		price_p50: evidence(round(quantile(prices, 0.5), 2), source, capturedAt, confidence(base, prices.length, total), prices.length),
		price_p75: evidence(round(quantile(prices, 0.75), 2), source, capturedAt, confidence(base, prices.length, total), prices.length),
		cr3: evidence(round(concentration.cr3), source, capturedAt, confidence(base, concentration.known, total), concentration.known, "按品牌月销份额"),
		cr5: evidence(round(concentration.cr5), source, capturedAt, confidence(base, concentration.known, total), concentration.known, "按品牌月销份额"),
		cr10: evidence(round(concentration.cr10), source, capturedAt, confidence(base, concentration.known, total), concentration.known, "按品牌月销份额"),
		hhi: evidence(round(concentration.hhi, 0), source, capturedAt, confidence(base, concentration.known, total), concentration.known, "Σ品牌份额²×10000"),
		amz_share: evidence(
			round(amazon.value),
			source,
			capturedAt,
			amazon.diagnosis ? 0 : confidence(base, amazon.counts.usable, total),
			amazon.counts.usable,
			amazon.diagnosis ? sparseAmazonNote(amazon.counts, amazon.diagnosis) : "Amazon 自营在卖家类型已知样本中的月销份额",
		),
		new_listing_share_12m: evidence(
			round(newListingShare),
			source,
			capturedAt,
			confidence(base, ages.length, total),
			ages.length,
			"已知上架时间样本中，上架≤12个月的坑位占比",
		),
		waist_review_median: evidence(
			round(quantile(waistReviews, 0.5), 0),
			source,
			capturedAt,
			confidence(base, waistReviews.length, middle.length),
			waistReviews.length,
		),
		waist_rating_median: evidence(
			round(quantile(waistRatings, 0.5), 2),
			source,
			capturedAt,
			confidence(base, waistRatings.length, middle.length),
			waistRatings.length,
		),
		top20_age_months_median: evidence(
			round(quantile(top20Ages, 0.5), 0),
			source,
			capturedAt,
			confidence(base, top20Ages.length, Math.min(20, total)),
			top20Ages.length,
		),
		keyword_search_volume: evidence(
			round(kw.totalSearchVolume, 0),
			source,
			capturedAt,
			confidence(base, kw.volumeKnown, kw.total),
			kw.volumeKnown,
			"导入词族搜索量合计",
		),
		main_cpc: evidence(
			round(kw.mainCpc, 2),
			source,
			capturedAt,
			confidence(base, kw.cpcKnown, kw.total),
			kw.cpcKnown,
			"有搜索量时按搜索量加权，否则取 CPC 中位数",
		),
		traffic_concentration: evidence(
			round(kw.trafficConcentration),
			source,
			capturedAt,
			confidence(base, kw.volumeKnown, kw.total),
			kw.volumeKnown,
			"Top3 关键词搜索量÷词族总搜索量",
		),
	};

	return metrics;
}

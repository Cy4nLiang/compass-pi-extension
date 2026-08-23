import { SOURCE_BASE_CONFIDENCE } from "./defaults.ts";
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

function rankedTop100(listings: ListingRecord[]): ListingRecord[] {
	return [...listings].sort((a, b) => a.rank - b.rank).slice(0, 100);
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

function amazonShare(listings: ListingRecord[]): { value?: number; known: number } {
	const rows = listings.filter(
		(listing): listing is ListingRecord & { isAmazon: boolean; monthlySales: number } =>
			listing.isAmazon !== undefined && listing.monthlySales !== undefined && listing.monthlySales >= 0,
	);
	const total = rows.reduce((sum, listing) => sum + listing.monthlySales, 0);
	if (rows.length === 0 || total <= 0) return { known: 0 };
	return {
		value: rows.filter((listing) => listing.isAmazon).reduce((sum, listing) => sum + listing.monthlySales, 0) / total,
		known: rows.length,
	};
}

function keywordMetrics(keywords: KeywordRecord[]): {
	totalSearchVolume?: number;
	mainCpc?: number;
	trafficConcentration?: number;
	volumeKnown: number;
	cpcKnown: number;
} {
	const withVolume = keywords.filter(
		(keyword): keyword is KeywordRecord & { searchVolume: number } =>
			keyword.searchVolume !== undefined && Number.isFinite(keyword.searchVolume) && keyword.searchVolume >= 0,
	);
	const volumes = withVolume.map((keyword) => keyword.searchVolume).sort((a, b) => b - a);
	const totalSearchVolume = volumes.length ? volumes.reduce((sum, value) => sum + value, 0) : undefined;
	const trafficConcentration =
		totalSearchVolume && totalSearchVolume > 0
			? volumes.slice(0, 3).reduce((sum, value) => sum + value, 0) / totalSearchVolume
			: undefined;
	const withCpc = keywords.filter(
		(keyword): keyword is KeywordRecord & { cpc: number } =>
			keyword.cpc !== undefined && Number.isFinite(keyword.cpc) && keyword.cpc >= 0,
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
	};
}

export function calculateMarketMetrics(input: {
	listings: ListingRecord[];
	keywords: KeywordRecord[];
	source: string;
	capturedAt: string;
	targetMonthlyUnits?: number;
}): MetricMap {
	const targetMonthlyUnits = input.targetMonthlyUnits ?? 300;
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
	const knownRatings = finite(top.map((listing) => listing.rating));
	const knownSales = finite(top.map((listing) => listing.monthlySales));
	const lowRatingHighSalesRows = top.filter(
		(listing) => listing.rating !== undefined && Number.isFinite(listing.rating) && listing.monthlySales !== undefined &&
			Number.isFinite(listing.monthlySales),
	);
	const lowRatingHighSalesCount = knownRatings.length > 0 && knownSales.length > 0
		? lowRatingHighSalesRows.filter(
			(listing) => (listing.rating as number) <= 4.2 && (listing.monthlySales as number) >= targetMonthlyUnits,
		).length
		: undefined;

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
		qualify_rank_depth: evidence(
			sales.length ? qualifyRankDepth(top, targetMonthlyUnits) : null,
			source,
			capturedAt,
			confidence(base, sales.length, total),
			sales.length,
			`月销≥${targetMonthlyUnits} 的 listing 数`,
		),
		price_p25: evidence(round(quantile(prices, 0.25), 2), source, capturedAt, confidence(base, prices.length, total), prices.length),
		price_p50: evidence(round(quantile(prices, 0.5), 2), source, capturedAt, confidence(base, prices.length, total), prices.length),
		price_p75: evidence(round(quantile(prices, 0.75), 2), source, capturedAt, confidence(base, prices.length, total), prices.length),
		cr3: evidence(round(concentration.cr3), source, capturedAt, confidence(base, concentration.known, total), concentration.known, "按品牌月销份额"),
		cr5: evidence(round(concentration.cr5), source, capturedAt, confidence(base, concentration.known, total), concentration.known, "按品牌月销份额"),
		cr10: evidence(round(concentration.cr10), source, capturedAt, confidence(base, concentration.known, total), concentration.known, "按品牌月销份额"),
		hhi: evidence(round(concentration.hhi, 0), source, capturedAt, confidence(base, concentration.known, total), concentration.known, "Σ品牌份额²×10000"),
		amz_share: evidence(round(amazon.value), source, capturedAt, confidence(base, amazon.known, total), amazon.known, "Amazon 自营在卖家类型已知样本中的月销份额"),
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
		low_rating_high_sales_count: evidence(
			round(lowRatingHighSalesCount, 0),
			source,
			capturedAt,
			confidence(base, lowRatingHighSalesRows.length, total),
			lowRatingHighSalesRows.length,
			`星级≤4.2 且月销≥${targetMonthlyUnits}`,
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
			confidence(base, kw.volumeKnown, input.keywords.length),
			kw.volumeKnown,
			"导入词族搜索量合计",
		),
		main_cpc: evidence(
			round(kw.mainCpc, 2),
			source,
			capturedAt,
			confidence(base, kw.cpcKnown, input.keywords.length),
			kw.cpcKnown,
			"有搜索量时按搜索量加权，否则取 CPC 中位数",
		),
		traffic_concentration: evidence(
			round(kw.trafficConcentration),
			source,
			capturedAt,
			confidence(base, kw.volumeKnown, input.keywords.length),
			kw.volumeKnown,
			"Top3 关键词搜索量÷词族总搜索量",
		),
	};

	return metrics;
}

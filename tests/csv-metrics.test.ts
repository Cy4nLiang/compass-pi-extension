import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarketCsv, parseNumeric } from "../csv.ts";
import { calculateMarketMetrics } from "../metrics.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("demo CSV maps SellerSprite-style fields and computes screen metrics", async () => {
	const text = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(text, {
		source: "sellersprite",
		capturedAt: "2026-08-22T00:00:00.000Z",
	});
	assert.equal(parsed.listings.length, 25);
	assert.equal(parsed.keywords.length, 5);
	assert.equal(parsed.listings[0].asin, "B0DEMO0001");
	assert.equal(parsed.listings[0].monthlyRevenue, 19.99 * 1250);
	assert.equal(parsed.listings[3].monthsOnline, 7);

	const metrics = calculateMarketMetrics({
		listings: parsed.listings,
		keywords: parsed.keywords,
		source: parsed.source,
		capturedAt: "2026-08-22T00:00:00.000Z",
		targetMonthlyUnits: 300,
	});
	assert.equal(metrics.qualify_rank_depth.value, 22);
	assert.equal(metrics.new_listing_share_12m.value, 0.28);
	assert.ok(typeof metrics.amz_share.value === "number" && metrics.amz_share.value > 0.02 && metrics.amz_share.value < 0.03);
	assert.ok(typeof metrics.cr3.value === "number" && metrics.cr3.value < 0.6);
	assert.ok(typeof metrics.keyword_search_volume.value === "number" && metrics.keyword_search_volume.value > 40_000);
	assert.ok(typeof metrics.main_cpc.value === "number" && metrics.main_cpc.value > 0.7);
});

test("CSV parser supports quotes, escaped quotes, tabs, and Chinese number suffixes", () => {
	const text = 'ASIN\t标题\t月销量\t价格\nB0X\t"A ""quoted"" title"\t1.2万\t$19.99\n';
	const parsed = parseMarketCsv(text, { source: "generic_csv" });
	assert.equal(parsed.delimiter, "tab");
	assert.equal(parsed.listings[0].title, 'A "quoted" title');
	assert.equal(parsed.listings[0].monthlySales, 12_000);
	assert.equal(parsed.listings[0].price, 19.99);
});

test("CSV numeric parsing handles Chinese large units, percentages, and negatives", () => {
	assert.equal(parseNumeric("1.2亿"), 120_000_000);
	assert.equal(parseNumeric("5千万"), 50_000_000);
	assert.equal(parseNumeric("30%"), 0.3);
	assert.equal(parseNumeric("-1.2"), undefined);
});

test("CSV parser warns about malformed quotes and missing ratings", () => {
	const parsed = parseMarketCsv("ASIN,标题,月销量\nB0X,\"broken title,300\n", { source: "generic_csv" });
	assert.ok(parsed.warnings.some((warning) => warning.includes("未闭合")));
	assert.ok(parsed.warnings.some((warning) => warning.includes("评分列")));
});

test("formal rank column takes precedence over 序号", () => {
	const parsed = parseMarketCsv("序号,排名,ASIN,月销量\n1,88,B0X,300\n", { source: "generic_csv" });
	assert.equal(parsed.listings[0].rank, 88);
	assert.ok(parsed.warnings.some((warning) => warning.includes("序号")));
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type AmazonSampleCounts, amazonSampleDiagnosis, decodeCsvBuffer, detectDelimiter, parseMarketCsv, parseNumeric } from "../csv.ts";
import { calculateMarketMetrics, targetDependentMetrics } from "../metrics.ts";

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


// —— 审计 M10 回归 ——
function placeholderAgeCsv(realAgeRows = 10): string {
	const placeholders = ["暂无", "未知", "待定", "?", "NaN", "无数据", "不详", "缺失"];
	const lines = ["ASIN,标题,排名,价格,评分,评论数,月销量,品牌,卖家,上架月数"];
	for (let index = 1; index <= 50; index++) {
		const age = index > 50 - realAgeRows ? "36" : placeholders[index % placeholders.length];
		lines.push(
			`B0DEMO${String(index).padStart(4, "0")},商品${index},${index},19.99,4.4,${100 + index},${400 + index},品牌${index % 7},第三方卖家,${age}`,
		);
	}
	return `${lines.join("\n")}\n`;
}


// —— 审计 M10 回归 ——
test("parseNumeric treats placeholder text as missing while keeping real zeros", () => {
	const placeholders = [
		"暂无", "未知", "待定", "不详", "缺失", "无数据", "未提供", "空",
		"TBD", "tbd", "None", "none", "NaN", "N/A", "n/a", "NA", "null",
		"-", "--", "—", "――", "?", "？", "$", "¥", "￥", "%", "USD", "RMB",
		"#N/A", "#DIV/0!", "#VALUE!", "万", "k",
	];
	for (const placeholder of placeholders) {
		assert.equal(parseNumeric(placeholder), undefined, `占位文本「${placeholder}」必须判成缺失`);
	}
	assert.equal(parseNumeric("0"), 0);
	assert.equal(parseNumeric("0.00"), 0);
	assert.equal(parseNumeric("0%"), 0);
	assert.equal(parseNumeric("$0.00"), 0);
	assert.equal(parseNumeric("0万"), 0);
	assert.equal(parseNumeric("1,234"), 1234);
	assert.equal(parseNumeric("45123"), 45_123);
});


// —— 审计 M10 回归 ——
test("placeholder listing-age cells drop out of the sample instead of counting as brand-new", () => {
	const capturedAt = "2026-08-22T00:00:00.000Z";
	const parsed = parseMarketCsv(placeholderAgeCsv(), { source: "generic_csv", capturedAt });
	assert.equal(parsed.listings.length, 50);
	assert.equal(parsed.listings[0].monthsOnline, undefined);
	assert.equal(parsed.listings[49].monthsOnline, 36);
	assert.ok(parsed.warnings.some((warning) => warning.includes("按缺失处理") && warning.includes("上架月数 40")));

	const metrics = calculateMarketMetrics({
		listings: parsed.listings,
		keywords: parsed.keywords,
		source: parsed.source,
		capturedAt,
		targetMonthlyUnits: 300,
	});
	assert.equal(metrics.new_listing_share_12m.value, 0);
	assert.equal(metrics.new_listing_share_12m.sampleSize, 10);
	assert.equal(metrics.new_listing_share_12m.confidence, 0.28);
});


// —— 审计 M10 回归 ——
test("unparsable numeric cells are summarised in one warning and counted once per cell", () => {
	const text = [
		"ASIN,排名,价格,评分,评论数,月销量,上架月数,关键词,月搜索量,建议CPC",
		"B0A,1,暂无,4.5,120,300,12,yoga mat,10000,0.8",
		"B0B,未知,19.99,N/A,?,300,--,yoga strap,暂无,-0.5",
		"B0C,3,$,4.2,80,TBD,24,,,",
	].join("\n") + "\n";
	const parsed = parseMarketCsv(text, { source: "generic_csv", capturedAt: "2026-08-22T00:00:00.000Z" });
	const warning = parsed.warnings.find((entry) => entry.includes("按缺失处理"));
	assert.ok(warning, "应汇总出一条「按缺失处理」warning");
	assert.match(warning, /^9 个数值单元格无法解析为数字/);
	assert.match(warning, /价格 2/);
	assert.match(warning, /排名 1/);
	assert.equal(parsed.listings[1].rank, 2);
	assert.equal(parsed.keywords[1].searchVolume, undefined);
});


// —— 审计 M10 回归 ——
test("real zeros and Excel serial dates survive the stricter numeric parser", () => {
	const parsed = parseMarketCsv("ASIN,月销量,评论数,评分,上架时间\nB0A,300,0,0,45123\nB0B,300,0,0,暂无\n", {
		source: "generic_csv",
		capturedAt: "2026-08-22T00:00:00.000Z",
	});
	assert.equal(parsed.listings[0].reviewCount, 0);
	assert.equal(parsed.listings[0].rating, 0);
	assert.equal(parsed.listings[0].launchDate, "2023-07-16T00:00:00.000Z");
	assert.equal(parsed.listings[0].monthsOnline, 37);
	assert.equal(parsed.listings[1].launchDate, undefined);
	assert.equal(parsed.warnings.some((warning) => warning.includes("按缺失处理")), false);
});


// —— 审计 M20 回归 ——
test("parseNumeric 只取第一个数字 token，不跨 token 拼接", () => {
	assert.equal(parseNumeric("4.5 out of 5 stars"), 4.5);
	assert.equal(parseNumeric("5 out of 5"), 5);
	assert.equal(parseNumeric("4.5/5"), 4.5);
	assert.equal(parseNumeric("4.5 颗星，最多 5 颗星"), 4.5);
	assert.equal(parseNumeric("4.5 (1,234)"), undefined);
	assert.equal(parseNumeric("5 x 3 x 2"), undefined);
	assert.equal(parseNumeric("19.99 - 29.99"), undefined);
});


// —— 审计 M20 回归 ——
test("parseNumeric 的量词后缀只在紧跟数字的位置生效", () => {
	assert.equal(parseNumeric("5cm"), undefined);
	assert.equal(parseNumeric("5mm"), undefined);
	assert.equal(parseNumeric("100 km"), 100);
	assert.equal(parseNumeric("5 mAh"), 5);
	assert.equal(parseNumeric("3.5m"), 3_500_000);
	assert.equal(parseNumeric("5 M"), 5_000_000);
	assert.equal(parseNumeric("2.5k"), 2_500);
	assert.equal(parseNumeric("1.5k pcs"), 1_500);
	assert.equal(parseNumeric("1.2万件"), 12_000);
	assert.equal(parseNumeric("1,234 万"), 12_340_000);
	assert.equal(parseNumeric("19.99 USD"), 19.99);
	assert.equal(parseNumeric("19.99USD"), 19.99);
});


// —— 审计 M20 回归 ——
test("parseNumeric 保留 Excel 序列号与科学计数法，parseDate 不受影响", () => {
	assert.equal(parseNumeric("45000"), 45_000);
	assert.equal(parseNumeric("45000.5"), 45_000.5);
	assert.equal(parseNumeric("1.23E+08"), 123_000_000);
	assert.equal(parseNumeric("2024-01-05"), undefined);
	const serial = parseMarketCsv("ASIN,上架时间,月销量\nB0X,45000,300\n", {
		source: "generic_csv",
		capturedAt: "2026-08-22T00:00:00.000Z",
	});
	assert.equal(serial.listings[0].launchDate, "2023-03-15T00:00:00.000Z");
	const iso = parseMarketCsv("ASIN,上架时间,月销量\nB0X,2024-01-05,300\n", {
		source: "generic_csv",
		capturedAt: "2026-08-22T00:00:00.000Z",
	});
	assert.equal(iso.listings[0].launchDate, "2024-01-05T00:00:00.000Z");
});


// —— 审计 M20 回归 ——
test("评分列拒收百分制与越界值，并给出行号告警", () => {
	const parsed = parseMarketCsv(
		"ASIN,评分,月销量\nB0A,4.5 out of 5 stars,1000\nB0B,90%,900\nB0C,88,800\nB0D,4.5/5,700\n",
		{ source: "generic_csv", capturedAt: "2026-08-22T00:00:00.000Z" },
	);
	assert.deepEqual(parsed.listings.map((listing) => listing.rating), [4.5, undefined, undefined, 4.5]);
	// 评分解析失败与其他数值列共用 M10 的汇总告警，不再单独推一条行号告警（两条会重复报同一批单元格）。
	assert.ok(parsed.warnings.some((warning) => warning.includes("2 个数值单元格无法解析") && warning.includes("评分 2")));
});


// —— 审计 M18 回归 ——
test("narrow TSV with comma-heavy fields is not misread as a comma CSV", () => {
	const text = "ASIN\t标题\t月销量\n" +
		"B0DEMO0001\tYoga Mat Strap, Blue, Large\t1,250\n" +
		"B0DEMO0002\tCotton Sling, Grey, Medium\t1,100\n" +
		"B0DEMO0003\tNylon Carrier, Black, Small\t1,050\n" +
		"B0DEMO0004\tCork Holder, Natural, XL\t1,010\n";
	assert.equal(detectDelimiter(text), "\t");
	const parsed = parseMarketCsv(text, { source: "generic_csv" });
	assert.equal(parsed.delimiter, "tab");
	assert.deepEqual(parsed.headers, ["ASIN", "标题", "月销量"]);
	assert.equal(parsed.listings.length, 4);
	assert.equal(parsed.listings[0].title, "Yoga Mat Strap, Blue, Large");
	assert.equal(parsed.listings[0].monthlySales, 1250);
	assert.equal(parsed.listings[3].monthlySales, 1010);
});


// —— 审计 M18 回归 ——
test("delimiter detection survives CRLF, blank lines, quoted newlines and single-column files", () => {
	const tsv = "ASIN\t标题\t月销量\nB0X\tStrap, Blue, L\t1,250\nB0Y\tSling, Grey, M\t1,100\n";
	assert.equal(detectDelimiter(tsv), "\t");
	assert.equal(detectDelimiter(tsv.replace(/\n/g, "\r\n")), "\t");
	assert.equal(detectDelimiter(tsv.trimEnd()), "\t");
	assert.equal(detectDelimiter(`\n\n${tsv}`), "\t");
	assert.equal(detectDelimiter('ASIN\t标题\t月销量\nB0X\t"多行, 红\n第二行, 大"\t1,250\nB0Y\t"再一, 蓝\n第二, 小"\t1,100\n'), "\t");
	assert.equal(detectDelimiter("ASIN\nB0X\nB0Y\n"), ",");
	assert.equal(detectDelimiter(""), ",");
	assert.equal(detectDelimiter("名称;价格;库存\n垫子;1,5;100\n绳子;2,5;80\n"), ";");
	assert.equal(detectDelimiter("ASIN|标题|月销量\nB0X|Strap, Blue|1,250\nB0Y|Sling, Grey|1,100\n"), "|");
});


// —— 审计 M18 回归 ——
test("unmappable headers report the detected delimiter and column split", () => {
	assert.throws(
		() => parseMarketCsv("名称;价格;库存\n垫子;1,5;100\n", { source: "generic_csv" }),
		/分隔符=“;”，切出 3 列/,
	);
	assert.throws(
		() => parseMarketCsv("ASIN§标题§月销量\nB0X§Strap§300\n", { source: "generic_csv" }),
		/只切出 1 列/,
	);
});


// —— 审计 M19 回归 ——
// GBK 字节样本：不落二进制夹具文件，把字节写死在测试里，评审能逐字节核对。
// 明文等价（虚构数据）：ASIN,月销量,价格\nB0GBKDEMO1,1250,19.99\n
const GBK_SAMPLE = Buffer.from([
	0x41, 0x53, 0x49, 0x4e, 0x2c, 0xd4, 0xc2, 0xcf, 0xfa, 0xc1, 0xbf, 0x2c, 0xbc, 0xdb, 0xb8, 0xf1,
	0x0a, 0x42, 0x30, 0x47, 0x42, 0x4b, 0x44, 0x45, 0x4d, 0x4f, 0x31, 0x2c, 0x31, 0x32, 0x35, 0x30,
	0x2c, 0x31, 0x39, 0x2e, 0x39, 0x39, 0x0a,
]);

test("GBK CSV decodes through gb18030 instead of silently losing every Chinese column", () => {
	const decoded = decodeCsvBuffer(GBK_SAMPLE);
	assert.equal(decoded.encoding, "gb18030");
	assert.ok(decoded.warnings.some((warning) => warning.includes("GB18030")));
	assert.equal(decoded.text.split("\n")[0], "ASIN,月销量,价格");
	const parsed = parseMarketCsv(decoded.text, { source: "generic_csv" });
	assert.deepEqual(parsed.headers, ["ASIN", "月销量", "价格"]);
	assert.deepEqual(parsed.mappedFields, ["asin", "price", "monthlySales"]);
	assert.equal(parsed.listings[0].monthlySales, 1250);
	assert.equal(parsed.listings[0].price, 19.99);
});


// —— 审计 M19 回归 ——
test("valid UTF-8 CSV still decodes as UTF-8 with no encoding warning", () => {
	const decoded = decodeCsvBuffer(Buffer.from("﻿ASIN,月销量,价格\nB0UTF8DEMO,1250,19.99\n", "utf8"));
	assert.equal(decoded.encoding, "utf-8");
	assert.deepEqual(decoded.warnings, []);
	assert.equal(decoded.text.split("\n")[0], "ASIN,月销量,价格");
});


// —— 审计 M19 回归 ——
test("a stray invalid byte in an otherwise UTF-8 file is not mistaken for GBK", () => {
	const dirty = Buffer.concat([
		Buffer.from("ASIN,月销量,价格\nB0X,1250,19.99", "utf8"),
		Buffer.from([0xe9]),
		Buffer.from("\n", "utf8"),
	]);
	const decoded = decodeCsvBuffer(dirty);
	assert.equal(decoded.encoding, "utf-8");
	assert.ok(decoded.warnings.some((warning) => warning.includes("非法 UTF-8 字节")));
	assert.equal(decoded.text.split("\n")[0], "ASIN,月销量,价格");
});


// —— 审计 M19 回归 ——
test("UTF-16 BOM files keep their existing decode path", () => {
	const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("ASIN,月销量\nB0X,1250\n", "utf16le")]);
	const decoded = decodeCsvBuffer(le);
	assert.equal(decoded.encoding, "utf-16le");
	assert.deepEqual(decoded.warnings, []);
	assert.equal(decoded.text.split("\n")[0], "ASIN,月销量");
});


// —— 审计 M19 回归 ——
test("garbled headers with almost nothing mapped are refused instead of imported empty", () => {
	assert.throws(
		() => parseMarketCsv("ASIN,���,��\nB0X,1250,19.99\n", { source: "generic_csv" }),
		/表头疑似编码错误/,
	);
});


// —— 审计 M19 回归 ——
test("garbled headers only warn when the rest of the mapping survived", () => {
	const parsed = parseMarketCsv("ASIN,价格,月销量,��\nB0X,19.99,1250,x\n", { source: "generic_csv" });
	assert.deepEqual(parsed.mappedFields, ["asin", "price", "monthlySales"]);
	assert.ok(parsed.warnings.some((warning) => warning.includes("乱码字符")));
});


// —— 审计 M22 回归 ——
function launchDateCsv(values: string[]): string {
	const lines = ["ASIN,标题,月销量,评分,品牌,上架时间"];
	values.forEach((value, index) => lines.push(`B0LD${String(index).padStart(4, "0")},T${index},100,4.2,BrandX,"${value}"`));
	return `${lines.join("\n")}\n`;
}


// —— 审计 M22 回归 ——
test("上架日期解析覆盖带毫秒/带时区的 ISO 时间与 Excel 序列号", () => {
	const parsed = parseMarketCsv(
		launchDateCsv([
			"2024-01-05T00:00:00.000Z",
			"2024-01-05T00:00:00Z",
			"2024-01-05T08:30:00.123+08:00",
			"2024-01-05T00:00:00.5Z",
			"2024-01-05",
			"2024.10.05",
			"2024/10/05",
			"45000",
			"45000.5",
		]),
		{ source: "generic_csv", capturedAt: "2026-08-22T00:00:00.000Z" },
	);
	assert.deepEqual(parsed.listings.map((listing) => listing.launchDate), [
		"2024-01-05T00:00:00.000Z",
		"2024-01-05T00:00:00.000Z",
		"2024-01-05T00:30:00.123Z",
		"2024-01-05T00:00:00.500Z",
		"2024-01-05T00:00:00.000Z",
		"2024-10-05T00:00:00.000Z",
		"2024-10-05T00:00:00.000Z",
		"2023-03-15T00:00:00.000Z",
		"2023-03-15T12:00:00.000Z",
	]);
	assert.deepEqual(parsed.listings.map((listing) => listing.monthsOnline), [31, 31, 31, 31, 31, 22, 22, 41, 41]);
	// 该样本无卖家/自营列，会命中 M196 的缺列告警；此处只断言日期与数值解析本身没有告警。
	assert.ok(!parsed.warnings.some((warning) => warning.includes("上架日期列") || warning.includes("数值单元格")));
});


// —— 审计 M22 回归 ——
test("无法识别的上架日期一律按缺失处理，不伪造月龄", () => {
	const parsed = parseMarketCsv(
		launchDateCsv(["暂无", "TBD", "--", "N/A", "2024.13.05", "19999", "123456"]),
		{ source: "generic_csv", capturedAt: "2026-08-22T00:00:00.000Z" },
	);
	assert.deepEqual(parsed.listings.map((listing) => listing.launchDate), [
		undefined, undefined, undefined, undefined, undefined, undefined, undefined,
	]);
	assert.deepEqual(parsed.listings.map((listing) => listing.monthsOnline), [
		undefined, undefined, undefined, undefined, undefined, undefined, undefined,
	]);
});


// —— 审计 M22 回归 ——
test("上架日期列解析成功率低于 50% 时推 warning，分母只算非空单元格", () => {
	const low = parseMarketCsv(launchDateCsv(["2024-01-05", "", "暂无", "TBD"]), {
		source: "generic_csv",
		capturedAt: "2026-08-22T00:00:00.000Z",
	});
	assert.ok(low.warnings.some((warning) => warning.includes("上架日期列有 2/3 个值无法识别")));

	const half = parseMarketCsv(launchDateCsv(["2024-01-05", "2024-02-05", "暂无", "TBD"]), {
		source: "generic_csv",
		capturedAt: "2026-08-22T00:00:00.000Z",
	});
	assert.equal(half.warnings.some((warning) => warning.includes("上架日期列")), false);

	const empty = parseMarketCsv(launchDateCsv(["", "", "", ""]), {
		source: "generic_csv",
		capturedAt: "2026-08-22T00:00:00.000Z",
	});
	assert.equal(empty.warnings.some((warning) => warning.includes("上架日期列")), false);
});


// —— 审计 M14 回归 ——
const WIDE_HEADER = "asin,title,rank,price,rating,review_count,monthly_sales,monthly_revenue,brand,seller,is_amazon,launch_date,category,keyword,search_volume,cpc";

function wideLayoutCsv(rowCount: number, keyword = "flat paint brush", searchVolume = "253", cpc = "0.61"): string {
	const rows = Array.from(
		{ length: rowCount },
		(_, index) =>
			`B0WIDE${String(index).padStart(4, "0")},Craft Brush ${index + 1},${index + 1},9.99,4.5,120,${
				500 - index
			},${(500 - index) * 9.99},BrandX,BrandX Store,false,2024-01-15,Paintbrush Sets,${keyword},${searchVolume},${cpc}`,
	);
	return `${WIDE_HEADER}\n${rows.join("\n")}\n`;
}


// —— 审计 M14 回归 ——
test("宽表布局里每行重复的同一关键词只计一次，并给出去重与布局警告", () => {
	const parsed = parseMarketCsv(wideLayoutCsv(25), { source: "sorftime", capturedAt: "2026-08-26T00:00:00.000Z" });
	assert.equal(parsed.listings.length, 25);
	assert.equal(parsed.rowCount, 25);
	assert.deepEqual(parsed.keywords, [
		{ keyword: "flat paint brush", searchVolume: 253, cpc: 0.61, rank: undefined, sourceRow: 2 },
	]);
	assert.ok(parsed.warnings.some((warning) => warning.includes("关键词行去重：25 行折叠为 1 个词（重复 24 行）")));
	assert.ok(parsed.warnings.some((warning) => warning.includes("疑似宽表布局")));

	const metrics = calculateMarketMetrics({
		listings: parsed.listings,
		keywords: parsed.keywords,
		source: parsed.source,
		capturedAt: "2026-08-26T00:00:00.000Z",
		targetMonthlyUnits: 300,
	});
	assert.equal(metrics.keyword_search_volume.value, 253);
	assert.equal(metrics.keyword_search_volume.sampleSize, 1);
	assert.equal(metrics.keyword_search_volume.confidence, 0.82);
	assert.equal(metrics.traffic_concentration.value, 1);
	assert.equal(metrics.main_cpc.value, 0.61);
});


// —— 审计 M14 回归 ——
test("重复关键词行的搜索量/CPC 冲突时保留首行并逐条警告", () => {
	const text = `${WIDE_HEADER}
B0CONF0001,Tech Pouch A,1,19.99,4.6,300,500,9995,BrandY,BrandY Store,false,2024-02-01,Travel,tech pouch,73487,0.60
B0CONF0002,Tech Pouch B,2,18.99,4.4,200,400,7596,BrandY,BrandY Store,false,2024-02-01,Travel,Tech Pouch,71000,0.62
B0CONF0003,Tech Pouch C,3,17.99,4.3,100,300,5397,BrandZ,BrandZ Store,false,2024-02-01,Travel,ＴＥＣＨ ＰＯＵＣＨ,,0.60
`;
	const parsed = parseMarketCsv(text, { source: "sorftime", capturedAt: "2026-08-26T00:00:00.000Z" });
	assert.deepEqual(parsed.keywords, [
		{ keyword: "tech pouch", searchVolume: 73487, cpc: 0.6, rank: undefined, sourceRow: 2 },
	]);
	assert.ok(parsed.warnings.some((warning) => warning.includes("不一致的搜索量：保留第 2 行的 73487，忽略 71000")));
	assert.ok(parsed.warnings.some((warning) => warning.includes("不一致的CPC：保留第 2 行的 0.6，忽略 0.62")));
});

// —— review R10 回归 ——
test("冲突告警的行号指向真正被保留的那个值所在的行，而不是组内首行", () => {
	// 组内首行没有搜索量（宽表里同一关键词的多行常常只有一行填了这一列），
	// 保留的是第一个出现的**非空**值 71000，它在第 3 行。报「第 2 行」会把人带到
	// 一个根本看不到这个数的位置——告警文案是「保留第 N 行的 X」，直接给运营看。
	const text = `${WIDE_HEADER}
B0ROW00001,Tech Pouch A,1,19.99,4.6,300,500,9995,BrandY,BrandY Store,false,2024-02-01,Travel,tech pouch,,0.60
B0ROW00002,Tech Pouch B,2,18.99,4.4,200,400,7596,BrandY,BrandY Store,false,2024-02-01,Travel,Tech Pouch,71000,0.62
B0ROW00003,Tech Pouch C,3,17.99,4.3,100,300,5397,BrandZ,BrandZ Store,false,2024-02-01,Travel,TECH POUCH,80000,0.60
`;
	const parsed = parseMarketCsv(text, { source: "sorftime", capturedAt: "2026-08-26T00:00:00.000Z" });
	assert.equal(parsed.keywords[0]?.searchVolume, 71000, "保留第一个非空值");
	const volumeWarning = parsed.warnings.find((warning) => warning.includes("不一致的搜索量"));
	assert.ok(volumeWarning, `没有产生搜索量冲突告警：${parsed.warnings.join(" / ")}`);
	assert.match(volumeWarning ?? "", /保留第 3 行的 71000/);
	assert.doesNotMatch(volumeWarning ?? "", /保留第 2 行/);
});


// —— 审计 M14 回归 ——
test("尾块关键词与真窄表都不触发去重或宽表警告", () => {
	const tailBlock = `${WIDE_HEADER}
B0TAIL0001,Rod Holder A,1,15.74,4.8,6026,4497,70783,BrandR,BrandR Store,false,2023-03-18,Rod Holders,,,
B0TAIL0002,Rod Holder B,2,15.99,4.5,2351,3323,53135,BrandR,BrandR Store,false,2023-04-10,Rod Holders,,,
,,,,,,,,,,,,,fishing rod holder for boat,6838,0.85
`;
	const tail = parseMarketCsv(tailBlock, { source: "sorftime", capturedAt: "2026-08-26T00:00:00.000Z" });
	assert.equal(tail.listings.length, 2);
	assert.deepEqual(tail.keywords, [
		{ keyword: "fishing rod holder for boat", searchVolume: 6838, cpc: 0.85, rank: undefined, sourceRow: 4 },
	]);
	assert.equal(tail.warnings.filter((warning) => warning.includes("去重") || warning.includes("宽表")).length, 0);

	const narrow = parseMarketCsv(
		`${WIDE_HEADER}\nB0NARROW01,Solo Item,1,9.99,4.5,10,100,999,BrandN,BrandN Store,false,2024-01-15,Misc,solo keyword,900,0.50\n`,
		{ source: "sorftime", capturedAt: "2026-08-26T00:00:00.000Z" },
	);
	assert.equal(narrow.keywords.length, 1);
	assert.equal(narrow.warnings.filter((warning) => warning.includes("去重") || warning.includes("宽表")).length, 0);
});


// —— 审计 M14 回归 ——
test("calculateMarketMetrics 自身对重复词行有第二道防线", () => {
	const duplicated = Array.from({ length: 25 }, (_, index) => ({
		keyword: index % 2 === 0 ? "flat paint brush" : "FLAT PAINT BRUSH",
		searchVolume: 253,
		cpc: 0.61,
		rank: index + 1,
		sourceRow: index + 2,
	}));
	const metrics = calculateMarketMetrics({
		listings: [],
		keywords: duplicated,
		source: "sorftime",
		capturedAt: "2026-08-26T00:00:00.000Z",
		targetMonthlyUnits: 300,
	});
	assert.equal(metrics.keyword_search_volume.value, 253);
	assert.equal(metrics.keyword_search_volume.sampleSize, 1);
	// 分母同样用去重后的词数，去重不得把好数据误判成低置信
	assert.equal(metrics.keyword_search_volume.confidence, 0.82);
	assert.equal(metrics.traffic_concentration.value, 1);
	assert.equal(metrics.main_cpc.value, 0.61);
});


// —— 审计 M196 回归 ——
// 放在文件顶部 `const here = dirname(fileURLToPath(import.meta.url));` 之后。
// 数据保持虚构（B0DEMO 前缀 ASIN、虚构品牌），与 examples/ 的卫生要求一致。
// salesRows：只有前 N 行填月销量（默认全填）。用来构造「卖家列完整、月销稀疏」——
// amz_share 按月销加权，那种文件的有效样本其实很少，但告警从前只数卖家类型、说反了话。
// salesFrom/salesRows 一起圈定月销量所在的行区间 [salesFrom, salesRows]（默认全填）。
// 用区间而不是「前 N 行」，才能构造「两列缺口落在不同行上」这种交集不足的输入。
function sparseAmazonCsv(options: { rows: number; marked: number; mark?: string; withSeller?: boolean; salesFrom?: number; salesRows?: number }): string {
	const mark = options.mark ?? "是";
	const header = ["排名", "ASIN", "品牌", "月销量", "上架月数", "亚马逊自营"];
	if (options.withSeller) header.push("卖家");
	const lines = [header.join(",")];
	for (let rank = 1; rank <= options.rows; rank++) {
		const flagged = rank <= options.marked;
		const row = [
			String(rank),
			`B0DEMO${String(rank).padStart(4, "0")}`,
			`Brand${(rank % 3) + 1}`,
			(options.salesRows !== undefined && rank > options.salesRows) || (options.salesFrom !== undefined && rank < options.salesFrom)
				? ""
				: String(1000 - rank * 10),
			rank <= Math.ceil(options.rows * 0.3) ? "6" : "30",
			flagged ? mark : "",
		];
		if (options.withSeller) row.push(flagged ? "Amazon.com" : `Seller ${rank}`);
		lines.push(row.join(","));
	}
	return lines.join("\n") + "\n";
}

function sparseAmazonMetrics(csv: string) {
	const parsed = parseMarketCsv(csv, { source: "generic_csv", capturedAt: "2026-09-01T00:00:00.000Z" });
	const metrics = calculateMarketMetrics({
		listings: parsed.listings,
		keywords: parsed.keywords,
		source: parsed.source,
		capturedAt: "2026-09-01T00:00:00.000Z",
		targetMonthlyUnits: 300,
	});
	return { parsed, metrics };
}


// —— 审计 M196 回归 ——
test("稀疏自营列不得伪造 AMZ 占比：已知率不足半数时按缺失处理", () => {
	const { parsed, metrics } = sparseAmazonMetrics(sparseAmazonCsv({ rows: 20, marked: 3 }));
	assert.equal(parsed.listings.filter((listing) => listing.isAmazon !== undefined).length, 3);
	assert.equal(metrics.amz_share.value, null);
	assert.equal(metrics.amz_share.confidence, 0);
	assert.equal(metrics.amz_share.sampleSize, 3);
	assert.match(String(metrics.amz_share.note), /卖家类型仅 3\/20 行有值/);
	// 导入告警与指标 note 现在同源（csv.ts 的 amazonSampleDiagnosis），措辞一致
	assert.ok(
		parsed.warnings.some((warning) => warning.includes("AMZ 自营占比按缺失处理并转人工复核：卖家类型仅 3/20 行有值")),
		`实际告警：${parsed.warnings.join(" / ")}`,
	);
});


// —— 审计 M196 回归 ——
test("稀疏“否”标记同样按缺失处理，不得伪造出 0 而放过红海市场", () => {
	const { metrics } = sparseAmazonMetrics(sparseAmazonCsv({ rows: 20, marked: 3, mark: "否" }));
	assert.equal(metrics.amz_share.value, null);
	assert.equal(metrics.amz_share.confidence, 0);
});


// —— 审计 M196 回归 ——
// 护栏：证明修法只命中「稀疏自营列 且 无卖家列」，csv.ts 的卖家名回退路径逐字不受影响。
// 该用例在修前修后都必须绿。0.1642 = 前 3 行月销(990+980+970) ÷ 20 行月销合计。
test("带卖家列时逐行回退匹配已填满自营标记，AMZ 占比照常计算且不告警", () => {
	const { parsed, metrics } = sparseAmazonMetrics(sparseAmazonCsv({ rows: 20, marked: 3, withSeller: true }));
	assert.equal(parsed.listings.filter((listing) => listing.isAmazon !== undefined).length, 20);
	assert.equal(metrics.amz_share.value, 0.1642);
	assert.equal(metrics.amz_share.sampleSize, 20);
	assert.ok(!parsed.warnings.some((warning) => warning.includes("卖家类型仅")));
});


// —— 审计 M196 回归 ——
test("自营列已知率恰好 50% 仍然计算，只降置信度", () => {
	const { parsed, metrics } = sparseAmazonMetrics(sparseAmazonCsv({ rows: 20, marked: 10 }));
	assert.equal(metrics.amz_share.value, 1);
	assert.equal(metrics.amz_share.confidence, 0.44);
	// 文案已改成点名「有效样本」（卖家类型 ∩ 月销量）：该 CSV 每行都有月销量，所以有效样本就是 10/20。
	assert.ok(
		parsed.warnings.some((warning) => warning.includes("有效样本 10/20 行") && !warning.includes("不足半数")),
		`实际告警：${parsed.warnings.join(" / ")}`,
	);
});


// —— review R11 回归 ——
test("卖家列完整但月销稀疏：告警点名月销量列，不谎报卖家类型缺失", () => {
	// 卖家类型 10/10 全有值，月销量只有 4 行。amz_share 按月销加权，有效样本只有 4/10，
	// 值确实该按缺失处理——但从前的 note 写的是「卖家类型仅 4/10 行有值」，与事实相反，
	// 而手册把这句的处置写成「补全自营列」，运营照做重导，结论不会有任何变化。
	const { parsed, metrics } = sparseAmazonMetrics(sparseAmazonCsv({ rows: 10, marked: 10, salesRows: 4 }));
	assert.equal(metrics.amz_share.value, null, "有效样本不足半数，值仍按缺失处理（闸门不放宽）");

	const note = metrics.amz_share.note ?? "";
	assert.doesNotMatch(note, /卖家类型仅 4\/10/, "反事实：卖家类型其实是 10/10");
	assert.match(note, /卖家类型有 10\/10 行/);
	assert.match(note, /同时有月销量的仅 4\/10 行/);
	assert.match(note, /缺的是月销量列，请补全它/, "处置要指向真正缺的那一列");

	// csv 侧的告警必须与 metrics 同口径，不能一边说「按已知样本计算」一边把值丢成 null
	const warning = parsed.warnings.find((item) => item.includes("AMZ 自营占比"));
	assert.ok(warning, `没有 AMZ 相关告警：${parsed.warnings.join(" / ")}`);
	assert.match(warning ?? "", /按缺失处理/);
	assert.doesNotMatch(warning ?? "", /按已知样本计算/, "与 metrics 打架的空头承诺");
	assert.match(warning ?? "", /月销量列/);
});

// —— code-review 回归：稀疏告警必须点名**所有**不足的列 ——
test("两列都稀疏时明说「只补一列不会改变结论」，不再单点自营列", () => {
	// 从前只报第一个不足的列：卖家 3/10、月销 3/10 时说「请补全自营列」，
	// 运营补完卖家列重导——月销仍是瓶颈，结论一字不变，正是要消灭的「照做无效」。
	const { metrics } = sparseAmazonMetrics(sparseAmazonCsv({ rows: 10, marked: 3, salesRows: 3 }));
	assert.equal(metrics.amz_share.value, null);
	const note = String(metrics.amz_share.note);
	assert.match(note, /卖家类型 3\/10、月销量 3\/10/);
	assert.match(note, /两列都不足半数，只补一列不会改变结论/);
	assert.doesNotMatch(note, /请补全自营列，或补一列卖家名称/, "两列都缺时不该只指向自营列");
});

test("两列各自过半但缺口落在不同行：说清是交集不足，让人把两列补到同一批行上", () => {
	// 卖家在 1–6 行、月销在 5–10 行：各自 6/10 都过半，交集只有 2/10。
	// 前两个分支都覆盖不到这种输入，从前会落到「缺的是月销量」这种同样不准的话上。
	// 卖家在 1–6 行，月销在 5–10 行：各自 6/10，交集只有第 5、6 行共 2/10。
	const { metrics } = sparseAmazonMetrics(sparseAmazonCsv({ rows: 10, marked: 6, salesFrom: 5 }));
	assert.equal(metrics.amz_share.value, null);
	const note = String(metrics.amz_share.note);
	assert.match(note, /各自都不算少，但两列的缺口落在不同行上/);
	assert.match(note, /请把两列补到同一批行上/);
});

test("完全没有有效行时也给诊断，不再挂着「已算出份额」的口径描述", () => {
	// 从前 rows.length===0 走 sparse:false 分支，value 为 null 却写着
	// 「Amazon 自营在卖家类型已知样本中的月销份额」，运营看到「—」加一句口径描述，
	// 完全不知道缺的是哪一列。
	// 卖家在 1–5 行，月销在 6–10 行：交集为空。
	const { metrics } = sparseAmazonMetrics(sparseAmazonCsv({ rows: 10, marked: 5, salesFrom: 6 }));
	assert.equal(metrics.amz_share.value, null);
	const note = String(metrics.amz_share.note);
	assert.doesNotMatch(note, /^Amazon 自营在卖家类型已知样本中的月销份额$/, "不能挂着断言已算出结果的口径描述");
	assert.match(note, /有效样本 0\/10 行/);
	assert.match(note, /没有任何一行两列同时有值/);
});


// —— code-review 第三轮：分类器八个分支逐个钉死 ——
// 直接测函数：它现在是导入告警与指标 note 的**唯一**来源，一个未测分支就是一对未测的
// 运营可见信号。绕 CSV 构造覆盖不到 total===0 与 salesTotal<=0 这两格。
test("amazonSampleDiagnosis 的八个分支与边界", () => {
	const c = (over: Partial<AmazonSampleCounts>): AmazonSampleCounts => ({
		total: 10, sellerKnown: 10, salesKnown: 10, usable: 10, salesTotal: 1000, ...over,
	});

	// 样本充足 → 不告警
	assert.equal(amazonSampleDiagnosis(c({})), undefined);
	// 恰好半数不算短缺（证据强度交给 confidence）
	assert.equal(amazonSampleDiagnosis(c({ sellerKnown: 5, salesKnown: 5, usable: 5 })), undefined);

	// 没有任何 listing：返回 undefined 会让调用方按「算出来了」走，0/0=NaN
	assert.match(String(amazonSampleDiagnosis(c({ total: 0, sellerKnown: 0, salesKnown: 0, usable: 0, salesTotal: 0 }))), /没有任何 listing 行/);

	// usable===0 的四种成因各自点名
	assert.match(String(amazonSampleDiagnosis(c({ sellerKnown: 0, salesKnown: 0, usable: 0, salesTotal: 0 }))), /两列都没有任何值/);
	assert.match(String(amazonSampleDiagnosis(c({ sellerKnown: 0, usable: 0, salesTotal: 0 }))), /一行都没有卖家类型/);
	assert.match(String(amazonSampleDiagnosis(c({ salesKnown: 0, usable: 0, salesTotal: 0 }))), /一行都没有月销量/);
	assert.match(String(amazonSampleDiagnosis(c({ sellerKnown: 6, salesKnown: 6, usable: 0, salesTotal: 0 }))), /没有任何一行两列同时有值/);

	// 样本不足的三种成因
	assert.match(String(amazonSampleDiagnosis(c({ sellerKnown: 3, salesKnown: 3, usable: 3, salesTotal: 30 }))), /两列都不足半数，只补一列不会改变结论/);
	assert.match(String(amazonSampleDiagnosis(c({ sellerKnown: 3, usable: 3, salesTotal: 30 }))), /卖家类型仅 3\/10 行有值/);
	assert.match(String(amazonSampleDiagnosis(c({ salesKnown: 4, usable: 4, salesTotal: 40 }))), /缺的是月销量列/);
	assert.match(String(amazonSampleDiagnosis(c({ sellerKnown: 6, salesKnown: 6, usable: 2, salesTotal: 20 }))), /缺口落在不同行上/);

	// 月销合计为 0：样本够时单独报；样本不够时**附在主要矛盾后面**，
	// 免得运营改完那一格重导、再撞上另一条诊断。
	assert.match(String(amazonSampleDiagnosis(c({ salesTotal: 0 }))), /月销量合计为 0/);
	const both = String(amazonSampleDiagnosis(c({ salesKnown: 1, usable: 1, salesTotal: 0 })));
	assert.match(both, /缺的是月销量列/, "主要矛盾是样本量，要排在前面");
	assert.match(both, /另外有值的那 1\/10 行月销量合计为 0/);
});

test("导入告警与指标用同一个行集：200 行文件上两条信号不再相反", () => {
	// 从前导入告警按全部 listing 计数、指标按 rankedTop100，于是月销只落在 101–200 行时
	// 告警说「按已知样本计算，置信度已相应下调」而指标是 null——两条运营可见信号相反。
	const header = ["排名", "ASIN", "品牌", "月销量", "上架月数", "亚马逊自营"].join(",");
	const rows = Array.from({ length: 200 }, (_, index) => {
		const rank = index + 1;
		return [String(rank), `B0DEMO${String(rank).padStart(4, "0")}`, "BrandA", rank > 100 ? "1000" : "", "30", "是"].join(",");
	});
	const parsed = parseMarketCsv([header, ...rows].join("\n") + "\n", { source: "sellersprite", capturedAt: "2026-01-01T00:00:00.000Z" });
	const metrics = calculateMarketMetrics({
		listings: parsed.listings,
		keywords: parsed.keywords,
		source: parsed.source,
		capturedAt: "2026-01-01T00:00:00.000Z",
	});
	assert.equal(metrics.amz_share.value, null);
	const warning = parsed.warnings.find((item) => item.includes("AMZ"));
	assert.ok(warning, `没有 AMZ 告警：${parsed.warnings.join(" / ")}`);
	assert.match(warning ?? "", /一行都没有月销量/, "告警要与指标 note 说同一件事");
	assert.match(warning ?? "", /按排名前 100 行判定/, "行数与文件不同时要说明判定范围");
	assert.doesNotMatch(warning ?? "", /按已知样本计算/, "不能一边说算出来了一边把值丢成 null");
});

test("空 listing 的市场：amz_share 不产出 NaN，也不挂「已算出份额」的口径描述", () => {
	// 纯关键词 CSV 走得到这里（parseMarketCsv 只在 listings 与 keywords 都空时才抛）。
	const metrics = calculateMarketMetrics({
		listings: [],
		keywords: [],
		source: "sellersprite",
		capturedAt: "2026-01-01T00:00:00.000Z",
	});
	assert.equal(metrics.amz_share.value, null);
	assert.equal(Number.isNaN(metrics.amz_share.value), false, "0/0 不能漏成 NaN");
	assert.match(String(metrics.amz_share.note), /没有任何 listing 行/);
	assert.notEqual(metrics.amz_share.note, "Amazon 自营在卖家类型已知样本中的月销份额");
});

// —— 审计 M196 回归 ——
test("既无自营列也无卖家列时给出明确的缺列警告", () => {
	const parsed = parseMarketCsv(
		"排名,ASIN,品牌,月销量,评分,上架月数\n1,B0DEMO0001,Alpha,900,4.3,6\n2,B0DEMO0002,Beta,800,4.4,30\n",
		{ source: "generic_csv" },
	);
	assert.ok(parsed.warnings.some((warning) => warning.includes("未识别到卖家类型/自营列")));
});


// —— 审计 M21 回归 ——
test("CPC 列全为 0 时 main_cpc 判缺失，而不是零成本流量", () => {
	const text = [
		"ASIN,商品标题,排名,价格,月销量,关键词,月搜索量,建议CPC",
		"B0DEMO0001,Demo A,1,19.99,1250,demo widget,30000,0",
		"B0DEMO0002,Demo B,2,21.99,900,demo widget large,12000,0",
		"B0DEMO0003,Demo C,3,17.99,600,widget for demo,5000,0",
	].join("\n");
	const parsed = parseMarketCsv(text, { source: "sorftime", capturedAt: "2026-08-22T00:00:00.000Z" });
	assert.deepEqual(parsed.keywords.map((keyword) => keyword.cpc), [0, 0, 0]);
	const metrics = calculateMarketMetrics({
		listings: parsed.listings,
		keywords: parsed.keywords,
		source: parsed.source,
		capturedAt: "2026-08-22T00:00:00.000Z",
	});
	assert.equal(metrics.main_cpc.value, null);
	assert.equal(metrics.main_cpc.confidence, 0);
	assert.equal(metrics.main_cpc.sampleSize, 0);
});


// —— 审计 M21 回归 ——
test("混合 CPC：0 被剔出加权，置信度按可用样本下调", () => {
	const keywords = [
		{ keyword: "a", searchVolume: 30_000, cpc: 0, sourceRow: 2 },
		{ keyword: "b", searchVolume: 12_000, cpc: 1.2, sourceRow: 3 },
		{ keyword: "c", searchVolume: 5_000, cpc: 0.9, sourceRow: 4 },
		{ keyword: "d", searchVolume: 3_000, cpc: 0, sourceRow: 5 },
	];
	const metrics = calculateMarketMetrics({
		listings: [],
		keywords,
		source: "sorftime",
		capturedAt: "2026-08-22T00:00:00.000Z",
	});
	// (1.2×12000 + 0.9×5000) ÷ 17000 = 1.1118；把 0 计入加权会稀释成 0.38
	assert.equal(metrics.main_cpc.value, 1.11);
	assert.equal(metrics.main_cpc.sampleSize, 2);
	assert.equal(metrics.main_cpc.confidence, 0.58);
});

// —— 审计 M10 × M20 合流回归 ——
// M10（占位文本判缺失）与 M20（只取第一个数字 token）改的是同一个 parseNumeric。
// 两条各自的用例都只覆盖自己那一半，这里钉住合并后的交叉行为：
// 占位判定不得误伤真 0，token 判定不得放过占位，负号的两种写法都要拦住。
test("parseNumeric 合流后：真 0 保留、占位判缺失、负号两种写法都拦住", () => {
	for (const zero of ["0", "00", "0.0", "0.00", "0%", "$0.00", "0万"]) {
		assert.equal(parseNumeric(zero), 0, `真实的 0 被误判成缺失：${zero}`);
	}
	assert.equal(parseNumeric("0.02"), 0.02);
	for (const placeholder of ["暂无", "TBD", "?", "？", "--", "None", "NaN", "#DIV/0!", "$", "%", "USD"]) {
		assert.equal(parseNumeric(placeholder), undefined, `占位文本没有判成缺失：${placeholder}`);
	}
	// ASCII 连字符走 parsed < 0，U+2212 数学减号（Excel 与部分中文工具的默认负号）走 token 首字符判定；
	// 老实现会把 U+2212 当普通字符剥掉，凭空造出一个正数 1.2。
	assert.equal(parseNumeric("-1.2"), undefined);
	assert.equal(parseNumeric("−1.2"), undefined);
	// 科学计数法与 Excel 序列号是 parseDate 的依赖，不能被更严的解析误伤。
	assert.equal(parseNumeric("1.23E+08"), 123_000_000);
	assert.equal(parseNumeric("45123"), 45_123);
});

// —— 审计 M15 回归 ——
// 需把 ../metrics.ts 的 import 改为 { calculateMarketMetrics, targetDependentMetrics }
test("target-dependent metrics recompute from listings and stay identical to the import-time algorithm", async () => {
	const text = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const at = "2026-08-22T00:00:00.000Z";
	const parsed = parseMarketCsv(text, { source: "sellersprite", capturedAt: at });
	for (const [units, qrd, lowRating] of [[300, 22, 8], [500, 13, 5], [800, 4, 2]] as const) {
		const derived = targetDependentMetrics({ listings: parsed.listings, source: "sellersprite", capturedAt: at, targetMonthlyUnits: units });
		assert.equal(derived.qualify_rank_depth.value, qrd);
		assert.equal(derived.low_rating_high_sales_count.value, lowRating);
		assert.equal(derived.qualify_rank_depth.targetMonthlyUnits, units);
		assert.equal(derived.qualify_rank_depth.note, `月销≥${units} 的 listing 数`);
		// 导入侧与读侧必须是同一段算法，逐字段相同
		const full = calculateMarketMetrics({ listings: parsed.listings, keywords: parsed.keywords, source: "sellersprite", capturedAt: at, targetMonthlyUnits: units });
		assert.deepEqual(full.qualify_rank_depth, derived.qualify_rank_depth);
		assert.deepEqual(full.low_rating_high_sales_count, derived.low_rating_high_sales_count);
	}
	// 没有明细就判缺失，不是 0
	const empty = targetDependentMetrics({ listings: [], source: "sellersprite", capturedAt: at, targetMonthlyUnits: 300 });
	assert.equal(empty.qualify_rank_depth.value, null);
	assert.equal(empty.low_rating_high_sales_count.value, null);
	assert.equal(empty.qualify_rank_depth.confidence, 0);
});


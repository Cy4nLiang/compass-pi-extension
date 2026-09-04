import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CSV_ALIAS_HEADERS, parseMarketCsv } from "../csv.ts";
import { convertSorftimePayloads, pickPath, slugForFileName, type CachedPayload, type SorftimeFieldMap } from "../gapfill-convert.ts";
import { calculateMarketMetrics } from "../metrics.ts";
import { CompassRepository, IMPORTS_DIR_NAME } from "../store.ts";

// 夹具形状逐字照搬 E0 实测的 Sorftime 返回（字段名与取值形态：月销/销售额是纯数字字符串、
// 评分/评论数/价格是 JSON 数字、上架日是 yyyy-MM-dd），但**取值全部虚构**：
// ASIN 一律 B0DEMO 前缀、品牌与卖家是编造词——compass 是公开仓库且带公开 CI，
// 断言失败的输出会进公网 Actions 日志。
const MAP: SorftimeFieldMap = {
	rows: { listing: "data.top100_products", keyword: "data" },
	listing: {
		asin: "asin",
		title: "title",
		price: "price",
		rating: "star_rating",
		reviewCount: "review_count",
		monthlySales: "monthly_sales_volume",
		monthlyRevenue: "monthly_sales_amount",
		brand: "brand",
		seller: "seller",
		launchDate: "online_date",
		category: "product_category",
	},
	keyword: { keyword: "keyword", searchVolume: "monthly_search_volume", cpc: "cpc_exact_bid" },
};

function listingPayload(count = 12): { data: { top100_products: Array<Record<string, unknown>> } } {
	const rows = Array.from({ length: count }, (_, index) => ({
		asin: `B0DEMO${String(index + 1).padStart(4, "0")}`,
		title: `Demo Under-Sink Organizer ${index + 1}`,
		sub_title: null,
		price: 19.99 + index,
		star_rating: 4.1 + (index % 5) * 0.1,
		review_count: 500 + index * 7,
		monthly_sales_volume: String(2000 - index * 40),
		monthly_sales_amount: String((2000 - index * 40) * (19.99 + index)),
		brand: `DemoBrand${index % 6}`,
		seller: index === 0 ? "Amazon.com" : `DemoSeller${index % 5}`,
		category_rank: `#${index + 1} in Demo Category (See Top 100 in Demo)`,
		delivery_type: index % 3 === 0 ? "FBA" : "FBM",
		days_listed: 0,
		online_date: `2024-0${(index % 9) + 1}-15`,
		product_category: "Demo Category",
		gross_profit: 3.2,
		gross_profit_margin: 0.21,
	}));
	return { data: { top100_products: rows } };
}

function keywordPayload(count = 5): { data: Array<Record<string, unknown>> } {
	return {
		data: Array.from({ length: count }, (_, index) => ({
			keyword: `demo organizer keyword ${index + 1}`,
			weekly_search_rank: String(1000 + index),
			monthly_search_volume: String(400_000 - index * 30_000),
			cpc_exact_bid: String((0.4 + index * 0.1).toFixed(2)),
			search_volume_peak_season: "--",
		})),
	};
}

async function withRepo<T>(run: (repo: CompassRepository, root: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "compass-convert-"));
	try {
		return await run(new CompassRepository(root), root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const inline = (value: unknown, tool: string): CachedPayload => ({ server: "sorftime", tool, value });

test("点路径取值只按属性名逐层走，缺一层即 undefined，不 eval", () => {
	const root = { a: { b: { c: 1 } }, list: [{ x: 1 }] };
	assert.equal(pickPath(root, "a.b.c"), 1);
	assert.equal(pickPath(root, "a.b.missing"), undefined);
	assert.equal(pickPath(root, "a.missing.c"), undefined);
	assert.deepEqual(pickPath(root, "list"), [{ x: 1 }]);
	// 数组下标是「顺带能用」而非设计目标：JS 里数组也是对象，list["0"] 天然成立。
	// 映射文件不该依赖它——按行号取值是逻辑不是结构，Sorftime 换个排序就错位
	assert.equal(pickPath(root, "list.0.x"), 1);
	// 原型链不参与：拿不到 constructor / __proto__ 这类继承属性
	assert.equal(pickPath(root, "a.constructor"), undefined);
	assert.equal(pickPath(root, "a.__proto__"), undefined);
});

test("表头取自 csv.ts 的首别名表，映射里出现未知字段名即报错", async () => {
	// 键是 compass 字段名（FIELD_ALIASES 的键），值才是写进 CSV 的表头（每组首个别名）
	assert.equal(CSV_ALIAS_HEADERS.monthlySales, "monthlysales");
	assert.equal(CSV_ALIAS_HEADERS.reviewCount, "reviewcount");
	assert.equal(CSV_ALIAS_HEADERS.launchDate, "launchdate");
	await withRepo(async (repo) => {
		const bad: SorftimeFieldMap = { ...MAP, listing: { ...MAP.listing, not_a_column: "asin" } };
		await assert.rejects(
			() => convertSorftimePayloads({ repo }, { payloads: [inline(listingPayload(), "category_report"), inline(keywordPayload(), "category_keywords")], map: bad, marketName: "demo market", capturedDate: "2026-09-04" }),
			/不在 csv\.ts 的别名表里/u,
		);
	});
});

test("转出的 CSV 被 compass 自己的解析器读出两类行，且五维指标全部算得出来", async () => {
	await withRepo(async (repo, root) => {
		const result = await convertSorftimePayloads(
			{ repo },
			{
				payloads: [inline(listingPayload(), "category_report"), inline(keywordPayload(), "category_keywords")],
				map: MAP,
				marketName: "demo under sink organizer",
				capturedDate: "2026-09-04",
			},
		);
		assert.equal(result.listingRows, 12);
		assert.equal(result.keywordRows, 5);
		assert.match(result.csvPath, /^compass-imports\/mcp-2026-09-04-demo-under-sink-organizer-sorftime\.csv$/u);

		const csv = await readFile(join(root, result.csvPath), "utf8");
		// 表头逐字钉死：必须是 csv.ts 每组别名的**首个**，不是映射表的键。
		// 光看「能不能解析」挡不住这条——normalizeHeader 会转小写，把 reviewCount 当表头照样命中，
		// 但那样表头就与别名表脱钩了：将来把某组首别名改成中文，CSV 不会跟着变
		assert.equal(
			csv.split("\n")[0],
			"asin,title,price,rating,reviewcount,monthlysales,monthlyrevenue,brand,seller,launchdate,category,keyword,searchvolume,cpc",
		);
		const parsed = parseMarketCsv(csv);
		assert.equal(parsed.listings.length, 12, "listing 行必须被识别");
		assert.equal(parsed.keywords.length, 5, "关键词行必须被识别");
		assert.deepEqual(parsed.warnings, [], `不该有任何告警，实得：${parsed.warnings.join(" / ")}`);

		// csv.ts 的三个自动回退都要真的生效（E0 §4）
		assert.deepEqual(parsed.listings.map((item) => item.rank), Array.from({ length: 12 }, (_, index) => index + 1), "rank 缺失时按行序回退");
		assert.equal(parsed.listings[0]?.isAmazon, true, "卖家名含 Amazon 时 isAmazon 由 seller 推断");
		assert.equal(parsed.listings[1]?.isAmazon, false);
		assert.ok((parsed.listings[0]?.monthsOnline ?? 0) > 0, "monthsOnline 由 launchDate 自动算");

		const metrics = calculateMarketMetrics({ listings: parsed.listings, keywords: parsed.keywords, source: "sorftime", capturedAt: "2026-09-04T00:00:00.000Z" });
		const missing = Object.keys(metrics).filter((name) => metrics[name]?.value === undefined || metrics[name]?.value === null);
		assert.deepEqual(missing, [], `这些指标没算出来：${missing.join("、")}`);
		assert.ok(metrics.main_cpc?.value !== undefined, "main_cpc 必须有值——它是 profit_cpc 缺口的判据");
	});
});

test("映射外的字段不出现在 CSV 里，但会被列进 unmappedFields", async () => {
	await withRepo(async (repo, root) => {
		const result = await convertSorftimePayloads(
			{ repo },
			{ payloads: [inline(listingPayload(3), "category_report"), inline(keywordPayload(2), "category_keywords")], map: MAP, marketName: "demo market", capturedDate: "2026-09-04" },
		);
		const csv = await readFile(join(root, result.csvPath), "utf8");
		const header = csv.split("\n")[0];
		for (const dropped of ["gross_profit", "gross_profit_margin", "delivery_type", "days_listed", "category_rank", "sub_title"]) {
			assert.ok(!header.includes(dropped), `${dropped} 不在映射里，不该出现在表头`);
		}
		// 值也不能混进去：gross_profit 的 3.2 若被误写会污染某一列
		assert.ok(!csv.includes("weekly_search_rank"), "关键词侧未映射字段同理");
		for (const expected of ["gross_profit", "delivery_type", "days_listed", "category_rank", "weekly_search_rank"]) {
			assert.ok(result.unmappedFields.includes(expected), `unmappedFields 应提示 ${expected}`);
		}
	});
});

test("缺字段留空、数值原样，不猜不补", async () => {
	await withRepo(async (repo, root) => {
		const payload = listingPayload(3);
		delete payload.data.top100_products[1].brand;
		payload.data.top100_products[2].online_date = "--";
		const result = await convertSorftimePayloads(
			{ repo },
			{ payloads: [inline(payload, "category_report"), inline(keywordPayload(2), "category_keywords")], map: MAP, marketName: "demo market", capturedDate: "2026-09-04" },
		);
		const csv = await readFile(join(root, result.csvPath), "utf8");
		const rows = csv.trimEnd().split("\n");
		const header = rows[0].split(",");
		const brandAt = header.indexOf("brand");
		assert.equal(rows[2].split(",")[brandAt], "", "缺失的品牌必须留空，不能补占位符");
		// 月销原样：不改格式、不加千分位
		const salesAt = header.indexOf("monthlysales");
		assert.equal(rows[1].split(",")[salesAt], "2000");
		const brandCoverage = result.coverage.find((item) => item.column === "brand");
		assert.deepEqual(brandCoverage, { column: "brand", filled: 2, total: 3 });
	});
});

test("只有关键词行的载荷被拒绝写文件——残缺快照会静默抹掉指标", async () => {
	await withRepo(async (repo, root) => {
		await assert.rejects(
			() => convertSorftimePayloads({ repo }, { payloads: [inline(keywordPayload(), "category_keywords")], map: MAP, marketName: "demo market", capturedDate: "2026-09-04" }),
			/没有 listing 行/u,
		);
		// 拒绝就是拒绝：目录里不能留半份产物
		await assert.rejects(() => stat(join(root, IMPORTS_DIR_NAME)), /ENOENT/u);
	});
});

test("只有 listing 行的载荷同样被拒绝", async () => {
	await withRepo(async (repo) => {
		await assert.rejects(
			() => convertSorftimePayloads({ repo }, { payloads: [inline(listingPayload(), "category_report")], map: MAP, marketName: "demo market", capturedDate: "2026-09-04" }),
			/没有关键词行/u,
		);
	});
});

test("溢写文件：正文链直接 parse，结果链要二次取 content 里的 text；两条都清理", async () => {
	await withRepo(async (repo, root) => {
		const spillRoot = await mkdtemp(join(tmpdir(), "compass-spill-"));
		const dirA = join(spillRoot, "a");
		const dirB = join(spillRoot, "b");
		await mkdir(dirA, { recursive: true });
		await mkdir(dirB, { recursive: true });
		const fileA = join(dirA, "output-1.txt");
		const fileB = join(dirB, "result-1.txt");
		// 链一：outputGuard.fullOutputPath —— 文件里就是正文
		await writeFile(fileA, JSON.stringify(listingPayload(4)), "utf8");
		// 链二：mcpResult.fullResultPath —— 文件里是整个 CallToolResult，正文在 content[].text
		await writeFile(fileB, JSON.stringify({ content: [{ type: "text", text: JSON.stringify(keywordPayload(3)) }] }), "utf8");
		try {
			const result = await convertSorftimePayloads(
				{ repo },
				{
					payloads: [
						{ server: "sorftime", tool: "category_report", filePath: fileA, cleanupPaths: [fileA] },
						{ server: "sorftime", tool: "category_keywords", filePath: fileB, fileHoldsToolResult: true, cleanupPaths: [fileB] },
					],
					map: MAP,
					marketName: "demo market",
					capturedDate: "2026-09-04",
				},
			);
			assert.equal(result.listingRows, 4);
			assert.equal(result.keywordRows, 3, "结果链必须二次 parse 才拿得到业务载荷");
			assert.deepEqual(result.cleaned.sort(), [fileA, fileB].sort(), "两条链的溢写文件都要删");
			await assert.rejects(() => stat(fileA), /ENOENT/u);
			await assert.rejects(() => stat(fileB), /ENOENT/u);
			// 目录也要带走：两条链各自 mkdtemp 过一个目录，经营数据不留在临时目录里
			await assert.rejects(() => stat(dirA), /ENOENT/u);
			await assert.rejects(() => stat(dirB), /ENOENT/u);
			// CSV 照常写出且能被解析
			const parsed = parseMarketCsv(await readFile(join(root, result.csvPath), "utf8"));
			assert.equal(parsed.listings.length, 4);
			assert.equal(parsed.keywords.length, 3);
		} finally {
			await rm(spillRoot, { recursive: true, force: true });
		}
	});
});

test("原始载荷归档进 raw/，CSV 出问题时能回到载荷核对", async () => {
	await withRepo(async (repo, root) => {
		const result = await convertSorftimePayloads(
			{ repo },
			{ payloads: [inline(listingPayload(3), "category_report"), inline(keywordPayload(2), "category_keywords")], map: MAP, marketName: "demo market", capturedDate: "2026-09-04" },
		);
		assert.equal(result.archivedRaw.length, 2, "两份载荷各归档一份");
		for (const path of result.archivedRaw) {
			const info = await stat(join(root, path));
			assert.equal(info.mode & 0o777, 0o600, "归档件必须 0600");
		}
	});
});

test("文件名 slug 只影响文件名，不参与任何匹配语义", () => {
	assert.equal(slugForFileName("Demo Under-Sink Organizer"), "demo-under-sink-organizer");
	assert.equal(slugForFileName("  "), "market");
	assert.equal(slugForFileName("清洁/收纳 篮"), "清洁-收纳-篮");
	// 路径分隔符不能穿透进文件名
	assert.ok(!slugForFileName("../../etc/passwd").includes("/"));
});

test("写出的 CSV 权限 0600 且落在导入目录内", async () => {
	await withRepo(async (repo, root) => {
		const result = await convertSorftimePayloads(
			{ repo },
			{ payloads: [inline(listingPayload(2), "category_report"), inline(keywordPayload(2), "category_keywords")], map: MAP, marketName: "demo market", capturedDate: "2026-09-04" },
		);
		assert.ok(result.csvPath.startsWith(`${IMPORTS_DIR_NAME}/`), `CSV 必须写在导入目录内，实得 ${result.csvPath}`);
		const info = await stat(join(root, result.csvPath));
		assert.equal(info.mode & 0o777, 0o600);
	});
});

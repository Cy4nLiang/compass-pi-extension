import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CSV_ALIAS_HEADERS, parseMarketCsv } from "../csv.ts";
import { capturedAtForBatch, convertSorftimePayloads, createMcpPayloadCache, extractMcpPayload, isAdapterSpillPath, parseSorftimeFieldMap, pickPath, slugForFileName, type CachedPayload, type SorftimeFieldMap } from "../gapfill-convert.ts";
import { calculateMarketMetrics } from "../metrics.ts";
import { CompassRepository, IMPORTS_DIR_NAME } from "../store.ts";


// adapter 的溢写路径形状：mkdtemp(join(tmpdir(), "pi-mcp-output-")) / `${kind}-<8 位 hex>.txt`。
// 夹具必须照这个形状造——extractMcpPayload 现在只认这个形状（服务端能在返回体里伪造
// fullResultPath，认下来就等于把 unlink 的目标交给对端），随手写个 /tmp/xxx 会被判成伪造
const spill = (kind: "output" | "mcp-result", seed: string) =>
	join(tmpdir(), `pi-mcp-output-${seed}`, `${kind}-${seed.repeat(8).slice(0, 8).replace(/[^0-9a-f]/gu, "a")}.txt`);
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

// ── 载荷抽取（H1）：五级链的顺序是这一节的全部重点 ──────────────────────────

const textBlocks = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }];

test("① mcpResult 未被摘要时直接用它", () => {
	const body = listingPayload(2);
	const got = extractMcpPayload({ mode: "call", server: "sorftime", tool: "category_report", mcpResult: body }, textBlocks(body));
	assert.equal(got?.payload.value, body, "应当是同一份对象引用，不拷贝");
	assert.equal(got?.payload.text, undefined);
});

test("② 16–50 KiB 那一带：mcpResult 是摘要而正文完整——必须取正文，这是 PRD 的实锤缺陷", () => {
	const body = keywordPayload(4);
	// adapter 在整个 CallToolResult 超 16 KiB 时把 mcpResult 换成摘要，但正文没超 50 KiB 也没超
	// 2000 行，所以 content 是完整的。照 PRD「优先 mcpResult」写会取到摘要 → 转出空 CSV
	const summary = { omitted: true, reason: "result too large", rawResultBytes: 20_000, fullResultPath: spill("mcp-result", "x") };
	const got = extractMcpPayload({ mode: "call", server: "sorftime", tool: "category_keywords", mcpResult: summary }, textBlocks(body));
	assert.equal(got?.payload.value, undefined, "摘要不能被当成载荷");
	assert.ok(got?.payload.text, "必须回退到完整正文");
	assert.deepEqual(JSON.parse(got.payload.text), body);
	// 摘要里的溢写路径仍要记下来清理
	assert.deepEqual(got.payload.cleanupPaths, [spill("mcp-result", "x")]);
});

test("③ 正文被截断且有结果溢写：记 fullResultPath，并标明文件里是整个 CallToolResult", () => {
	const got = extractMcpPayload(
		{
			mode: "call",
			server: "sorftime",
			tool: "category_report",
			mcpResult: { omitted: true, fullResultPath: spill("mcp-result", "a") },
			outputGuard: { truncated: true, fullOutputPath: spill("output", "b") },
		},
		[{ type: "text", text: "[MCP text output truncated: …]" }],
	);
	assert.equal(got?.payload.filePath, spill("mcp-result", "a"), "结果链优先于正文链");
	assert.equal(got?.payload.fileHoldsToolResult, true);
	assert.equal(got?.payload.text, undefined, "截断的正文不能当载荷");
	// 两条链各自 mkdtemp 过一个目录，两个文件都要清
	assert.deepEqual(got.payload.cleanupPaths?.sort(), [spill("mcp-result", "a"), spill("output", "b")]);
	assert.equal(got.approxBytes, 0, "只记路径不占内存账");
});

test("④ 只有正文溢写时用 fullOutputPath，文件里就是正文", () => {
	const got = extractMcpPayload(
		{ mode: "call", server: "sorftime", tool: "category_report", outputGuard: { truncated: true, fullOutputPath: spill("output", "c") } },
		[{ type: "text", text: "[MCP text output truncated: …]" }],
	);
	assert.equal(got?.payload.filePath, spill("output", "c"));
	assert.notEqual(got?.payload.fileHoldsToolResult, true, "这条链的文件不需要二次取 content");
});

test("⑤ 溢写也失败时记成「不可恢复」，不是当作没这次调用（那会诱导运营再花钱）", () => {
	// 这一档 2026-09-05 在线上真撞到了：运营烧掉 8 次配额，因为 convert 只说「没见到这一步
	// 的返回」，读起来就是「再调一次」。而这一步**已经调过、已经扣过钱**，重试同样会失败。
	// 原设计「宁可不缓存」是错的——「没缓存」与「没调用」在下游无法区分，而两者对运营的
	// 意义完全相反：一个该重试，一个该去修磁盘。
	const lost = extractMcpPayload({ mode: "call", server: "sorftime", tool: "t", mcpResult: { omitted: true, resultWriteError: "ENOSPC" }, outputGuard: { truncated: true, writeError: "ENOSPC" } }, [
		{ type: "text", text: "[MCP text output truncated: …]" },
	]);
	assert.equal(lost?.payload.unavailable, "ENOSPC", "要带上 adapter 给的 writeError，那是唯一的直接证据");
	assert.equal(lost?.payload.value, undefined);
	assert.equal(lost?.payload.filePath, undefined);

	// 截断了但 adapter 没给 writeError：仍要记，给一句通用说明
	const noReason = extractMcpPayload({ server: "sorftime", tool: "t", outputGuard: { truncated: true } }, [{ type: "text", text: "[truncated…]" }]);
	assert.match(noReason?.payload.unavailable ?? "", /溢写文件未写成/u);

	// 认证失败之类**根本没发出请求**的分支照旧不缓存：那是真的「没这次调用」
	assert.equal(extractMcpPayload({ mode: "call", error: "auth_required", server: "sorftime", tool: "t" }, []), undefined);
	assert.equal(extractMcpPayload(undefined, []), undefined);
});

test("缓存按批次取：只给本 server、本 ticket 窗口内的载荷", () => {
	const cache = createMcpPayloadCache();
	const at = (iso: string, id: string, server = "sorftime") =>
		cache.remember({ server, tool: "category_report" }, { toolCallId: id, details: { mode: "call", server, tool: "t", mcpResult: { a: id } }, content: [], receivedAt: iso });
	at("2026-09-04T10:00:00.000Z", "before");
	at("2026-09-04T10:05:00.000Z", "inside");
	at("2026-09-04T10:06:00.000Z", "other", "keepa");
	const batch = cache.since("sorftime", "2026-09-04T10:01:00.000Z");
	assert.deepEqual(batch.map((entry) => entry.toolCallId), ["inside"], "窗口之前的与别的 server 都不能进批次");
	cache.forget(["inside"]);
	assert.deepEqual(cache.since("sorftime", "2026-09-04T10:01:00.000Z"), [], "消费掉就丢弃——溢写文件已被删，留着会读到不存在的路径");
});

test("缓存按条数与字节双限逐出最旧的", () => {
	const cache = createMcpPayloadCache({ maxEntries: 3, maxBytes: 10_000_000 });
	for (let index = 0; index < 5; index += 1) {
		cache.remember(
			{ server: "sorftime", tool: "t" },
			{ toolCallId: `id-${index}`, details: { mode: "call", server: "sorftime", tool: "t", mcpResult: { index } }, content: [], receivedAt: `2026-09-04T10:0${index}:00.000Z` },
		);
	}
	assert.equal(cache.size, 3);
	assert.deepEqual(cache.since("sorftime", "2026-09-04T00:00:00.000Z").map((entry) => entry.toolCallId), ["id-2", "id-3", "id-4"]);

	// 字节限：单条就超限时至少留一条，别把刚收到的也逐掉
	const tiny = createMcpPayloadCache({ maxEntries: 10, maxBytes: 10 });
	tiny.remember({ server: "sorftime", tool: "t" }, { toolCallId: "big", details: { mode: "call", server: "sorftime", tool: "t" }, content: textBlocks(listingPayload(3)), receivedAt: "2026-09-04T10:00:00.000Z" });
	assert.equal(tiny.size, 1);
});

test("同一个 toolCallId 重来时挪到队尾，不占着旧的逐出位置", () => {
	const cache = createMcpPayloadCache({ maxEntries: 2 });
	const put = (id: string, iso: string) =>
		cache.remember({ server: "sorftime", tool: "t" }, { toolCallId: id, details: { mode: "call", server: "sorftime", tool: "t", mcpResult: { id } }, content: [], receivedAt: iso });
	put("a", "2026-09-04T10:00:00.000Z");
	put("b", "2026-09-04T10:01:00.000Z");
	put("a", "2026-09-04T10:02:00.000Z");
	put("c", "2026-09-04T10:03:00.000Z");
	assert.deepEqual(cache.since("sorftime", "2026-09-04T00:00:00.000Z").map((entry) => entry.toolCallId).sort(), ["a", "c"], "被逐出的应是 b 而不是重来过的 a");
});

test("缓存下来的文本载荷能直接喂给转换，无需先 parse", async () => {
	await withRepo(async (repo) => {
		const cache = createMcpPayloadCache();
		cache.remember({ server: "sorftime", tool: "category_report" }, { toolCallId: "l", details: { mode: "call", server: "sorftime", tool: "category_report" }, content: textBlocks(listingPayload(3)), receivedAt: "2026-09-04T10:00:00.000Z" });
		cache.remember({ server: "sorftime", tool: "category_keywords" }, { toolCallId: "k", details: { mode: "call", server: "sorftime", tool: "category_keywords" }, content: textBlocks(keywordPayload(2)), receivedAt: "2026-09-04T10:01:00.000Z" });
		const result = await convertSorftimePayloads({ repo }, { payloads: cache.since("sorftime", "2026-09-04T09:00:00.000Z"), map: MAP, marketName: "demo market", capturedDate: "2026-09-04" });
		assert.equal(result.listingRows, 3);
		assert.equal(result.keywordRows, 2);
	});
});

test("映射表校验：结构不全一律抛错，不降级——降级会转出静默缺列的 CSV", () => {
	const good = {
		rows: { listing: "data.top100_products", keyword: "data" },
		listing: { asin: "asin", title: "title" },
		keyword: { keyword: "keyword" },
		chain: [
			{ step: 1, tool: "step_one", required: ["category_name"] },
			{ step: 2, tool: "step_two" },
		],
		// 映射表里还有 _readme / version / dead_fields 这些说明性字段，校验必须无视它们
		_readme: ["随便写点什么"],
		version: 1,
	};
	const parsed = parseSorftimeFieldMap(good);
	assert.deepEqual(parsed.rows, { listing: "data.top100_products", keyword: "data" });
	assert.deepEqual(parsed.chain?.map((step) => step.tool), ["step_one", "step_two"]);
	assert.deepEqual(parsed.chain?.[0].required, ["category_name"]);
	assert.equal(parsed.chain?.[1].required, undefined);
	// 说明性字段不进结果：approve / convert 只认这四个键
	assert.deepEqual(Object.keys(parsed).sort(), ["chain", "keyword", "listing", "rows"]);

	assert.throws(() => parseSorftimeFieldMap(null), /映射表 必须是对象/u);
	assert.throws(() => parseSorftimeFieldMap({ ...good, rows: { keyword: "data" } }), /rows\.listing/u);
	assert.throws(() => parseSorftimeFieldMap({ ...good, rows: { listing: "", keyword: "data" } }), /rows\.listing/u);
	assert.throws(() => parseSorftimeFieldMap({ ...good, listing: {} }), /listing 一列都没有/u);
	assert.throws(() => parseSorftimeFieldMap({ ...good, keyword: { keyword: 42 } }), /keyword\.keyword 必须是非空字符串/u);
	assert.throws(() => parseSorftimeFieldMap({ ...good, chain: [] }), /chain 必须是非空数组/u);
	assert.throws(() => parseSorftimeFieldMap({ ...good, chain: [{ step: 1 }] }), /chain\[0\]\.tool/u);

	// 列名必须在 csv.ts 的别名表里，而且要在**这里**就抛——approve 会先跑一遍校验，
	// 拖到写文件那一步才发现的话，3 次真实调用的点数已经花掉了
	assert.throws(() => parseSorftimeFieldMap({ ...good, listing: { asin: "asin", 根本没有这一列: "x" } }), /不在 csv\.ts 的别名表里/u);

	// chain 可以没有：映射表只用来转换、不用来 approve 时是合法的
	const { chain, ...withoutChain } = good;
	assert.equal(parseSorftimeFieldMap(withoutChain).chain, undefined);
	assert.equal(chain.length, 2);
});

// 链路第 1 步（类目检索）的返回体：根就是 data[]，与 MAP.rows.keyword 的点路径完全撞形。
// 它必然进缓存（tool_result 对该 server 的任何结果都收），也必然落进确认单窗口
function categorySearchPayload(): { data: Array<Record<string, unknown>> } {
	return {
		data: [
			{ node_id: "3744231", category_name: "Demo Under-Sink Organizers", parent_node_id: "1063498" },
			{ node_id: "3744232", category_name: "Demo Sink Caddies", parent_node_id: "1063498" },
		],
	};
}

test("类目检索那一步的 data[] 不是关键词行：守卫不被它喂饱，行数与覆盖率也不虚高", async () => {
	await withRepo(async (repo) => {
		// ① 第 3 步超时（B3：计费但零载荷）时，只剩 step-1 + step-2。若把 step-1 的 data[]
		// 当关键词行，守卫会放行并写出一份 0 条真关键词的残缺快照——main_cpc 等三个指标
		// 会静默消失且导入链零告警，这正是这道守卫存在的全部理由
		await assert.rejects(
			convertSorftimePayloads(
				{ repo },
				{
					payloads: [inline(categorySearchPayload(), "category_name_search"), inline(listingPayload(3), "category_report")],
					map: MAP,
					marketName: "demo market",
					capturedDate: "2026-09-04",
				},
			),
			/关键词行/u,
			"缺真关键词时必须拒绝，不能被类目检索的 data[] 顶替",
		);

		// ② 三步都成功时，行数只算真关键词行；覆盖率的分母也不能被撑大
		const result = await convertSorftimePayloads(
			{ repo },
			{
				payloads: [inline(categorySearchPayload(), "category_name_search"), inline(listingPayload(3), "category_report"), inline(keywordPayload(4), "category_keywords")],
				map: MAP,
				marketName: "demo market",
				capturedDate: "2026-09-04",
			},
		);
		assert.equal(result.listingRows, 3);
		assert.equal(result.keywordRows, 4, "2 条候选类目不该被算进关键词行");
		const keywordCoverage = result.coverage.find((item) => item.column === "keyword");
		assert.deepEqual([keywordCoverage?.filled, keywordCoverage?.total], [4, 4], "分母被撑大会让运营看到一片假的「未填满」");
	});
});

test("溢写路径只认 adapter 自己写的那个形状：服务端伪造的 fullResultPath 既不读也不删", async () => {
	// MCP 的 ResultSchema 是 loose object，服务端能在 ≤16 KiB 的返回体里塞任意顶层字段。
	// 链① 下 details.mcpResult 就是那个原始对象——无条件收下它的 fullResultPath，
	// 等于让对端决定我们转换成功后 unlink 哪个文件
	const forged = extractMcpPayload(
		{ mode: "call", server: "sorftime", tool: "category_report", mcpResult: { data: { top100_products: [] }, fullResultPath: "/Users/someone/.pi/compass/store.json" } },
		undefined,
	);
	assert.ok(forged, "载荷本身照常取用，只是不认它自带的路径");
	assert.deepEqual(forged.payload.cleanupPaths, [], "伪造路径不得进清理列表");

	// 目录名对、文件名不对；文件名对、目录不在临时目录下——两种都不认
	for (const path of [join(tmpdir(), "pi-mcp-output-x", "store.json"), join("/Users/someone/pi-mcp-output-x", "mcp-result-0a1b2c3d.txt"), join(tmpdir(), "other", "mcp-result-0a1b2c3d.txt")]) {
		assert.equal(isAdapterSpillPath(path), false, `${path} 不该被当成 adapter 的溢写文件`);
	}
	assert.equal(isAdapterSpillPath(join(tmpdir(), "pi-mcp-output-Ab3", "mcp-result-0a1b2c3d.txt")), true);
	assert.equal(isAdapterSpillPath(join(tmpdir(), "pi-mcp-output-Ab3", "output-deadbeef.txt")), true);
});

// 直连工具（sorftime_category_report 这种）的 details 形状与网关**不同**：
// direct-tools.ts:570 是 `{ server, tool, ...guardedMcpDetails(guarded) }`，而
// guardedMcpDetails 只在有值时才放字段，guardMcpOutput 又**不产生 mcpResult**
// （那是网关侧 boundMcpResult 才有的）。所以直连成功只有两种形状：
//   小返回 → { server, tool }，正文完整在 content 里
//   大返回 → { server, tool, outputGuard: { truncated, fullOutputPath } }，正文被截断溢写
// 这是本工作区**生产实际用的形状**（87 个直连工具），先前三档夹具全是网关形式，一条都没覆盖。
test("直连工具的两种成功形状都能取到载荷（生产实际用的就是直连）", () => {
	const body = JSON.stringify({ data: { top100_products: [{ asin: "B0DEMO0001" }] } });

	// ① 小返回：没有 mcpResult 也没有 outputGuard，正文完整——必须走链②拿 text
	const small = extractMcpPayload({ server: "sorftime", tool: "category_keywords" }, [{ type: "text", text: body }]);
	assert.equal(small?.payload.text, body, "直连小返回要从 content 拿正文");
	assert.equal(small?.payload.value, undefined);
	assert.deepEqual(small?.payload.cleanupPaths, []);

	// ② 大返回：正文被截断并溢写，只剩 outputGuard 这一条链可用。
	// 这一档是 category_report（实测 ~79KB）的真实形状——它要是取不到，
	// convert 会说「本批载荷里没有 listing 行」，而运营完全看不出是载荷被丢了
	const spillPath = join(tmpdir(), "pi-mcp-output-Zz9", "output-0a1b2c3d.txt");
	const large = extractMcpPayload(
		{ server: "sorftime", tool: "category_report", outputGuard: { truncated: true, fullOutputPath: spillPath } },
		[{ type: "text", text: "[truncated…]" }],
	);
	assert.equal(large?.payload.filePath, spillPath, "直连大返回要走 outputGuard 溢写链");
	assert.equal(large?.payload.fileHoldsToolResult, undefined, "outputGuard 那条链文件里就是正文，不是整个 CallToolResult");
	assert.deepEqual(large?.payload.cleanupPaths, [spillPath], "溢写文件要进清理列表");

	// ③ 截断了却没给溢写路径（写文件也失败）：记成不可恢复，convert 会明说重试无用
	assert.match(extractMcpPayload({ server: "sorftime", tool: "category_report", outputGuard: { truncated: true } }, [{ type: "text", text: "[truncated…]" }])?.payload.unavailable ?? "", /溢写文件未写成/u, "拿不回来也要记一笔，别当作没调用过");
});

test("载荷不可恢复时，拒绝理由必须说「重试不会变好」而不是「请先补齐这一步的调用」", async () => {
	// 2026-09-05 线上真实事故：运营照着「请先补齐这一步的调用再转换」重试，
	// 每次都真扣钱、每次都同样失败，烧掉 8 次配额才发现是溢写写盘失败。
	// 这条钉的是**措辞的方向**——错误信息在这里直接等于钱。
	await withRepo(async (repo, root) => {
		const before = await readdir(join(root, IMPORTS_DIR_NAME)).catch(() => [] as string[]);
		await assert.rejects(
			convertSorftimePayloads(
				{ repo },
				{
					payloads: [
						{ server: "sorftime", tool: "category_report", unavailable: "ENOSPC: no space left on device" },
						inline(keywordPayload(2), "category_keywords"),
					],
					map: MAP,
					marketName: "demo market",
					capturedDate: "2026-09-05",
				},
			),
			(error: Error) => {
				assert.match(error.message, /已经拿不回来了/u, "要点明载荷丢了，不是没调用");
				assert.match(error.message, /ENOSPC: no space left on device/u, "要带上 adapter 给的原因");
				assert.match(error.message, /重试同一步不会变好/u, "这句是防止运营继续烧配额的那句");
				assert.doesNotMatch(error.message, /请先补齐这一步的调用/u, "旧措辞会被读成「再调一次」，正是这次事故的成因");
				return true;
			},
		);
		const after = await readdir(join(root, IMPORTS_DIR_NAME)).catch(() => [] as string[]);
		assert.deepEqual(after, before, "拒绝时不得写出任何 CSV");
	});
});

// —— 2026-09-05 真实冒烟回归：convert 给的 captured_at 必须是完整时间戳 ——
test("capturedAtForBatch：取这批载荷最后一次收到返回的完整时间戳，不是纯日期", () => {
	const at = capturedAtForBatch([
		{ receivedAt: "2026-01-02T03:04:05.000Z" },
		{ receivedAt: "2026-01-02T03:09:59.123Z" },
		{ receivedAt: "2026-01-02T03:04:30.000Z" },
	]);
	assert.equal(at, "2026-01-02T03:09:59.123Z");
	assert.match(at, /T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, "必须是完整 ISO：纯日期会被导入侧归一到 UTC 零点，压不过同一天早些时候的手工快照");
});

test("capturedAtForBatch：没有可用的 receivedAt 时退回给定的 now", () => {
	const now = new Date("2026-09-05T01:02:03.004Z");
	assert.equal(capturedAtForBatch([], now), "2026-09-05T01:02:03.004Z");
	assert.equal(capturedAtForBatch([{ receivedAt: "not-a-date" }, {}], now), "2026-09-05T01:02:03.004Z");
});

// —— 2026-09-05 评审核出的两处既有缺陷：链① 的包装体、失败调用的报错文本 ——
test("链① 的 mcpResult 是整个 CallToolResult：convert 要从 content[].text 里二次 parse 才拿得到行", async () => {
	await withRepo(async (repo) => {
		const cache = createMcpPayloadCache();
		// adapter 的 rawMcpResult 就是 CallToolResult（{ content: [{ type: "text", text }], isError }），
		// 不是业务对象——真实冒烟归档的 payload-1.json 顶层键就是 content / isError
		const wrap = (value: unknown) => ({ content: textBlocks(value), isError: false });
		cache.remember({ server: "sorftime", tool: "category_report" }, { toolCallId: "l", details: { mode: "call", server: "sorftime", tool: "category_report", mcpResult: wrap(listingPayload(3)) }, content: textBlocks(listingPayload(3)), receivedAt: "2026-01-02T03:00:00.000Z" });
		cache.remember({ server: "sorftime", tool: "category_keywords" }, { toolCallId: "k", details: { mode: "call", server: "sorftime", tool: "category_keywords", mcpResult: wrap(keywordPayload(2)) }, content: textBlocks(keywordPayload(2)), receivedAt: "2026-01-02T03:00:01.000Z" });
		const entries = cache.since("sorftime", "2026-01-02T00:00:00.000Z");
		assert.equal(entries.filter((entry) => entry.value !== undefined).length, 2, "两条都该走链①（value 形态）");
		const result = await convertSorftimePayloads({ repo }, { payloads: entries, map: MAP, marketName: "demo market", capturedDate: "2026-01-02" });
		assert.equal(result.listingRows, 3, "包装体里的 listing 行必须被取出，不能静默丢掉");
		assert.equal(result.keywordRows, 2);
		// 归档的是业务载荷，不是包装体
		const archived = JSON.parse(await readFile(join(repo.projectRoot, result.archivedRaw[0] ?? ""), "utf8")) as Record<string, unknown>;
		assert.ok("data" in archived && !("content" in archived), `归档应是业务对象，实得键：${Object.keys(archived).join("、")}`);
	});
});

test("直接给业务对象的 mcpResult（旧夹具形态）仍然能转", async () => {
	await withRepo(async (repo) => {
		const result = await convertSorftimePayloads(
			{ repo },
			{ payloads: [inline(listingPayload(2), "category_report"), inline(keywordPayload(2), "category_keywords")], map: MAP, marketName: "demo market", capturedDate: "2026-01-02" },
		);
		assert.equal(result.listingRows, 2);
		assert.equal(result.keywordRows, 2);
	});
});

test("缓存里混进失败调用的报错文本：不崩、能转；缺行时拒绝理由点名被跳过的那一步", async () => {
	const failedText = (tool: string): CachedPayload => ({ server: "sorftime", tool, text: "Failed to call tool: request timed out after 30000 ms\n\nExpected parameters:\n  node_id (string) *required*" });
	await withRepo(async (repo) => {
		// 第 2 步先超时再重调成功：两类行齐了，报错文本只是噪声
		const ok = await convertSorftimePayloads(
			{ repo },
			{ payloads: [failedText("category_report"), inline(listingPayload(3), "category_report"), inline(keywordPayload(2), "category_keywords")], map: MAP, marketName: "demo market", capturedDate: "2026-01-02" },
		);
		assert.equal(ok.listingRows, 3);
		assert.equal(ok.keywordRows, 2);
	});
	await withRepo(async (repo) => {
		// 第 2 步只超时没重调：拒绝，且说清是 category_report 那条不是 JSON——「这一批没见到 X 的返回」
		// 那个提示按工具名算会把失败的那次也当成「见到了」，所以这里必须自己点名
		await assert.rejects(
			() => convertSorftimePayloads({ repo }, { payloads: [failedText("category_report"), inline(keywordPayload(2), "category_keywords")], map: MAP, marketName: "demo market", capturedDate: "2026-01-02" }),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				assert.match(message, /没有 listing 行/u);
				assert.match(message, /已跳过/u);
				assert.match(message, /category_report（返回体不是 JSON/u);
				assert.doesNotMatch(message, /Unexpected token/u, "不能把 SyntaxError 原样抛给运营");
				return true;
			},
		);
	});
});

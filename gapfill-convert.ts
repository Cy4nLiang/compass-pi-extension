import { readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { CostReferenceFieldMap } from "./cost-reference.ts";
import { CSV_ALIAS_HEADERS } from "./csv.ts";
import type { CompassRepository } from "./store.ts";

// 补数转换：把缓存下来的 MCP 载荷按点路径映射成一份 compass 能直接导入的市场 CSV。
//
// 分层：这是**编排层**，与 importer.ts 平级——它做文件 I/O（读溢写文件、写 CSV、归档原始
// JSON、清理临时文件），所以不能放进 csv.ts / metrics.ts / gaps.ts 那一层的纯函数模块里。
// 依赖方向单向：只 import csv.ts（拿表头）、store.ts 的类型与 cost-reference.ts 的类型；绝不 import
// index.ts / importer.ts / service.ts / ui.ts / web/*——convert 只产出 CSV / 材料 / 参考成本候选行，
// 回写走现有的 compass_import_csv 或调用方的写事务，不另开第二条导入链路。反向也不许：纯函数层不得 import 本模块。
//
// 数字不经 LLM：取值一律按映射文件里的点路径直取，不 eval、不推断、缺字段留空。

export interface SorftimeFieldMap {
	/** 两类行各自所在的数组的点路径，如 data.top100_products */
	rows: { listing: string; keyword: string };
	/** compass 列名（= FIELD_ALIASES 每组首别名） → 载荷里的字段名或点路径 */
	listing: Record<string, string>;
	keyword: Record<string, string>;
	/** 调用链：approve 用它算这批要几次调用、以及 ticket 的工具白名单。缺省表示映射表没声明链路 */
	chain?: SorftimeChainStep[];
	/** 差评材料链。缺省表示映射表没声明它，material 单一律拒绝而不是降级 */
	reviews?: SorftimeReviewsMap;
	/** 1688 参考成本链。缺省表示映射表没声明它，cost_reference 单一律拒绝而不是降级 */
	costReference?: SorftimeCostReferenceMap;
}

/**
 * 1688 参考成本链：第三种产物——既不是 CSV 也不是材料，convert 算出一条参考成本记录写回 store。
 * `rows` 是商品行数组的点路径；`fields` 的键是 cost-reference.ts 认的字段名（product_id / price / sales /
 * tiers / tier_price …），不是 CSV 列名，同样不能并进 headerFor 那个循环。
 */
export interface SorftimeCostReferenceMap {
	chain: SorftimeChainStep[];
	rows: string;
	fields: CostReferenceFieldMap;
	/** 服务端「无结果」时返回的纯文本哨兵（不是 JSON）。命中即判空结果，不当成非 JSON 报错 */
	emptySentinel?: string;
	pageSize?: number;
}

/** 映射表 `chain` 数组里的一步。工具名只在映射表里出现，compass 源码不硬编码第三方工具名。 */
export interface SorftimeChainStep {
	step: number;
	tool: string;
	required?: string[];
	/** "asin" 表示这一步按 ASIN 逐个调用，approve 据此把次数算成 asins.length */
	per?: "batch" | "asin";
	/** 必须固定传的参数（如评论类型）。approve 把它存进确认单，strict 档据此复核实际调用 */
	fixed?: Record<string, string>;
}

/**
 * 差评材料链：与 CSV 那条路子并列的第二种产物。
 *
 * 形状与 CSV 段刻意不同，别照抄校验分支：`rows` 是**一个字符串**（评论行数组的点路径），
 * 不是 `{ listing, keyword }` 对象；`fields` 的键是材料文件里的字段名，不是 CSV 列名——
 * 所以它们绝不能并进 parseSorftimeFieldMap 末尾那个 headerFor 循环，body / variant 不在
 * csv.ts 的别名表里，并进去会把整张已冻结的映射表判死。
 */
export interface SorftimeReviewsMap {
	chain: SorftimeChainStep[];
	rows: string;
	fields: Record<string, string>;
	sampleCap?: number;
	asinsPerTicketMax?: number;
}

/**
 * `fields.asin` 的哨兵值：评论行里没有 ASIN，只能取自当次调用的请求参数。
 * 它不是点路径——`pickPath(row, "$request.asin")` 恒返回 undefined，会让所有行的 asin 静默变空。
 */
export const REQUEST_ASIN_SENTINEL = "$request.asin";

/**
 * 校验映射表并归一成 SorftimeFieldMap。缺字段一律抛错、**不降级**：
 * 映射表不全时转出来的 CSV 会静默缺列，而 parseMarketCsv 对缺列零告警（E0 负向对照实测），
 * 事后没人能从结果反推出「是映射表坏了」。
 *
 * 列名合法性也在这里查（headerFor 会抛）——approve 在花掉 3 次真实调用**之前**先跑一遍，
 * 免得钱花完了才在写文件那一步发现映射表里有个列名 csv.ts 不认识。
 */
export function parseSorftimeFieldMap(raw: unknown): SorftimeFieldMap {
	const asRecord = (value: unknown, what: string): Record<string, unknown> => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} 必须是对象`);
		return value as Record<string, unknown>;
	};
	const asPathMap = (value: unknown, what: string): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const [key, item] of Object.entries(asRecord(value, what))) {
			if (typeof item !== "string" || !item) throw new Error(`${what}.${key} 必须是非空字符串（点路径）`);
			out[key] = item;
		}
		if (!Object.keys(out).length) throw new Error(`${what} 一列都没有`);
		return out;
	};

	// 两条链共用的一步解析。per / fixed 是差评链引入的，快照链没有这两个键、解析后仍是 undefined
	const chainStep = (step: Record<string, unknown>, index: number): SorftimeChainStep => {
		if (typeof step.tool !== "string" || !step.tool) throw new Error(`chain[${index}].tool 必须是非空字符串`);
		const fixed: Record<string, string> = {};
		for (const [key, value] of Object.entries(step.fixed && typeof step.fixed === "object" && !Array.isArray(step.fixed) ? (step.fixed as Record<string, unknown>) : {})) {
			if (typeof value === "string" && value) fixed[key] = value;
		}
		return {
			step: typeof step.step === "number" ? step.step : index + 1,
			tool: step.tool,
			required: Array.isArray(step.required) ? step.required.filter((value): value is string => typeof value === "string") : undefined,
			per: step.per === "asin" || step.per === "batch" ? step.per : undefined,
			fixed: Object.keys(fixed).length ? fixed : undefined,
		};
	};

	const root = asRecord(raw, "映射表");
	const rows = asRecord(root.rows, "rows");
	if (typeof rows.listing !== "string" || !rows.listing) throw new Error("rows.listing 必须是非空点路径");
	if (typeof rows.keyword !== "string" || !rows.keyword) throw new Error("rows.keyword 必须是非空点路径");

	const map: SorftimeFieldMap = {
		rows: { listing: rows.listing, keyword: rows.keyword },
		listing: asPathMap(root.listing, "listing"),
		keyword: asPathMap(root.keyword, "keyword"),
	};

	if (root.chain !== undefined) {
		if (!Array.isArray(root.chain) || !root.chain.length) throw new Error("chain 必须是非空数组");
		map.chain = root.chain.map((item, index) => chainStep(asRecord(item, `chain[${index}]`), index));
	}

	// reviews 段缺省时**不能带这个键**：调用方按键集判「映射表声明了哪几条链路」，
	// 带一个值为 undefined 的键会让「没声明」看起来像「声明了但是空的」
	if (root.reviews !== undefined) {
		const reviews = asRecord(root.reviews, "reviews");
		if (!Array.isArray(reviews.chain) || !reviews.chain.length) throw new Error("reviews.chain 必须是非空数组");
		if (typeof reviews.rows !== "string" || !reviews.rows) throw new Error("reviews.rows 必须是非空点路径");
		const fields = asPathMap(reviews.fields, "reviews.fields");
		// 身份列与正文列缺一不可：没有 asin 就归不了组（评论行里没有 ASIN，只能取请求参数），
		// 没有 body 就没有可聚类的内容，两种情况写出来的材料都是废的
		if (!fields.asin) throw new Error("reviews.fields 必须映射 asin：评论行里没有 ASIN，只能取自请求参数");
		if (!fields.body) throw new Error("reviews.fields 必须映射 body：没有正文就没有可聚类的内容");
		map.reviews = {
			chain: reviews.chain.map((item, index) => chainStep(asRecord(item, `reviews.chain[${index}]`), index)),
			rows: reviews.rows,
			fields,
			sampleCap: typeof reviews.sample_cap === "number" && reviews.sample_cap > 0 ? Math.floor(reviews.sample_cap) : undefined,
			asinsPerTicketMax:
				typeof reviews.asins_per_ticket_max === "number" && Number.isInteger(reviews.asins_per_ticket_max) && reviews.asins_per_ticket_max > 0
					? reviews.asins_per_ticket_max
					: undefined,
		};
		if (map.reviews.asinsPerTicketMax === undefined) throw new Error("reviews.asins_per_ticket_max 必须是正整数：approve 靠它复核一张单最多批几个 ASIN");
	}

	// cost_reference 段同样是「缺省不带键」：调用方按键集判映射表声明了哪几条链
	if (root.cost_reference !== undefined) {
		const section = asRecord(root.cost_reference, "cost_reference");
		if (!Array.isArray(section.chain) || !section.chain.length) throw new Error("cost_reference.chain 必须是非空数组");
		if (typeof section.rows !== "string" || !section.rows) throw new Error("cost_reference.rows 必须是非空点路径");
		const fields = asPathMap(section.fields, "cost_reference.fields");
		// 取价要靠阶梯与头价，排序要靠销量，复核要靠商品 id：缺任一项算出来的参考成本都不可信
		for (const required of ["product_id", "price", "sales", "tiers", "tier_price"] as const) {
			if (!fields[required]) throw new Error(`cost_reference.fields 必须映射 ${required}：缺了它参考成本要么取不到价、要么排不了序、要么无法复核`);
		}
		map.costReference = {
			chain: section.chain.map((item, index) => chainStep(asRecord(item, `cost_reference.chain[${index}]`), index)),
			rows: section.rows,
			fields: {
				product_id: fields.product_id,
				title: fields.title ?? "title",
				url: fields.url,
				photo: fields.photo,
				price: fields.price,
				sales: fields.sales,
				tiers: fields.tiers,
				tier_price: fields.tier_price,
				tier_quantity: fields.tier_quantity,
				moq: fields.moq,
			},
			emptySentinel: typeof section.empty_sentinel === "string" && section.empty_sentinel.trim() ? section.empty_sentinel.trim() : undefined,
			pageSize: typeof section.page_size === "number" && Number.isInteger(section.page_size) && section.page_size > 0 ? section.page_size : undefined,
		};
	}

	// 身份列必须映射：convert 靠 asin / keyword 判断一行到底属于哪一类（与 csv.ts 同口径）。
	// 少了它们，同一 server 其它步骤的返回体就会混进行里，「两类行必须齐」的守卫随之失效
	if (!map.listing.asin) throw new Error("listing 必须映射 asin：convert 靠它判定 listing 行，缺了会把别的返回体当成 listing");
	if (!map.keyword.keyword) throw new Error("keyword 必须映射 keyword：convert 靠它判定关键词行，缺了会把类目检索的返回当成关键词");
	for (const column of [...Object.keys(map.listing), ...Object.keys(map.keyword)]) headerFor(column);
	return map;
}

/**
 * 一份缓存下来的 MCP 载荷。三种取值形态互斥，按可靠性排序：
 * `value`（已是对象）→ `text`（原始 JSON 正文，延后 parse）→ `filePath`（只有溢写文件）。
 */
export interface CachedPayload {
	server: string;
	tool: string;
	/** 内联对象载荷：details.mcpResult 未被摘要时就是它 */
	value?: unknown;
	/** 内联文本载荷：正文未被截断时的 content 拼接结果。热路径不 parse，留给 convert */
	text?: string;
	/** 溢写文件路径。两条链的字段名不同，这里统一成一个路径 + 是否要二次取 result */
	filePath?: string;
	/** filePath 指向的是完整 CallToolResult 而不是正文时为真（mcpResult.fullResultPath 那条链） */
	fileHoldsToolResult?: boolean;
	/**
	 * 载荷**不可恢复**：正文被截断，而溢写文件又没写成（磁盘满 / 临时目录不可写）。
	 * 值是 adapter 给的 writeError，拿不到就给一句通用说明。
	 *
	 * 记下来而不是当作「没这次调用」——这两者对运营的意义完全相反：后者会让 convert 说
	 * 「请先补齐这一步的调用」，而这一步**已经调过、已经扣过钱了**，再调一次同样会失败。
	 * 把它冒出来，运营才知道要去解决溢写而不是继续烧配额。
	 */
	unavailable?: string;
	/** 读完要删的临时文件；其所在目录随之一并清理 */
	cleanupPaths?: string[];
}

/** pi-mcp-adapter 的 outputGuard（正文截断链）。字段名以 mcp-output-guard.ts 的类型定义为准。 */
interface OutputGuardDetails {
	truncated?: boolean;
	fullOutputPath?: string;
	writeError?: string;
}

/** pi-mcp-adapter 的 mcpResult 摘要（结果溢写链）。`omitted: true` 是「这不是真载荷」的判据。 */
interface McpResultSummaryShape {
	omitted?: boolean;
	fullResultPath?: string;
	resultWriteError?: string;
}

/** details.mcpResult ≤16 KiB 时是原对象引用，取不到精确字节数就按这个上界记账。 */
const DETAILS_MAX_BYTES = 16 * 1024;

/**
 * 溢写文件名的形状（pi-mcp-adapter 的 mcp-output-guard）：目录是
 * `mkdtemp(join(tmpdir(), "pi-mcp-output-"))`，文件是 `${"output"|"mcp-result"}-<8 位 hex>.txt`。
 * **只删长这样的路径。**
 *
 * 这不是洁癖：取值链①下 `details.mcpResult` 是**服务端返回的原始对象**（MCP 的 ResultSchema
 * 是 loose object，任意顶层字段原样透传），服务端只要塞一个 `fullResultPath` 进来，就能指使
 * 我们在转换成功后 unlink 任意文件。下面的 `extractMcpPayload` 已经在源头挡了一道（只认
 * `omitted === true` 时的 fullResultPath），这里是第二道：删除侧不判断「像不像」，只判断
 * 「是不是我们自己写出来的那个」。
 *
 * 判据对不上时**跳过删除**而不是抛错——最坏结果是一个临时文件留在系统临时目录里，
 * 比误删一个真文件轻得多。
 */
const SPILL_FILE_NAME = /^(?:output|mcp-result)-[0-9a-f]{8}\.txt$/u;
export function isAdapterSpillPath(path: string): boolean {
	if (!path) return false;
	const resolved = resolve(path);
	const dir = dirname(resolved);
	return SPILL_FILE_NAME.test(basename(resolved)) && basename(dir).startsWith("pi-mcp-output-") && dirname(dir) === resolve(tmpdir());
}

/**
 * 从一次 MCP 工具结果里抽出可用载荷。**纯函数、零 I/O**：溢写文件只记路径不读，
 * 文本只存不 parse——它跑在 `tool_result` 热路径上。
 *
 * 五级链，顺序不能换：
 *   ① `mcpResult` 且 `omitted !== true` —— 完整对象，最可靠
 *   ② 正文未被截断 —— content 的 text 块拼接（此时哪怕 mcpResult 是摘要，正文也是全的）
 *   ③ `mcpResult.fullResultPath` —— 结果溢写，文件里是整个 CallToolResult
 *   ④ `outputGuard.fullOutputPath` —— 正文溢写，文件里就是正文
 *   ⑤ 都没有 —— 不缓存
 *
 * ②必须排在③④前面：16–50 KiB 那一带 `mcpResult` 是摘要而 content 是**完整的**，
 * 若照「优先 mcpResult」写，convert 会从摘要里取到 undefined，转出空 CSV 或半张表。
 */
export function extractMcpPayload(
	details: unknown,
	content: ReadonlyArray<{ type?: string; text?: string }> | undefined,
): { payload: Omit<CachedPayload, "server" | "tool">; approxBytes: number } | undefined {
	if (!details || typeof details !== "object") return undefined;
	const record = details as { mcpResult?: unknown; outputGuard?: OutputGuardDetails };
	const guard = record.outputGuard;
	const summary = record.mcpResult as McpResultSummaryShape | undefined;
	// 只把 **adapter 自己写出来的**溢写路径记进清理列表。链①下 mcpResult 是服务端原始对象，
	// 它自带的 fullResultPath 是伪造的（真正的溢写只发生在 omitted === true 那一档），
	// 无条件收下等于把 unlink 的目标交给对端决定
	const spilled = [guard?.fullOutputPath, summary?.omitted === true ? summary.fullResultPath : undefined];
	const cleanupPaths = spilled.filter((path): path is string => typeof path === "string" && isAdapterSpillPath(path));

	if (record.mcpResult !== undefined && summary?.omitted !== true) {
		return { payload: { value: record.mcpResult, cleanupPaths }, approxBytes: DETAILS_MAX_BYTES };
	}
	const text = (content ?? [])
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
	if (text && guard?.truncated !== true) {
		return { payload: { text, cleanupPaths }, approxBytes: text.length };
	}
	// ③④ 读溢写文件同样只认 adapter 写出来的路径。这两条链的前提本来就排除了服务端伪造
	// （③ 要求 omitted === true，④ 的 outputGuard 由 adapter 生成），多这一道是为了让
	// 「文件路径必须是我们自己写的」在读与删两侧是同一条判据，将来谁动了链的顺序也不会破
	if (typeof summary?.fullResultPath === "string" && isAdapterSpillPath(summary.fullResultPath)) {
		return { payload: { filePath: summary.fullResultPath, fileHoldsToolResult: true, cleanupPaths }, approxBytes: 0 };
	}
	if (typeof guard?.fullOutputPath === "string" && isAdapterSpillPath(guard.fullOutputPath)) {
		return { payload: { filePath: guard.fullOutputPath, cleanupPaths }, approxBytes: 0 };
	}
	// ⑤ 正文被截断，而两条溢写链都没给出可用路径——载荷**不可恢复**。
	// 这里绝不能返回 undefined 了事：那等于「这次调用没发生过」，而它已经发生、已经扣过钱。
	// convert 会照着「没见到这一步的返回」劝运营再调一次，同样会失败，钱照扣。
	if (guard?.truncated === true || summary?.omitted === true) {
		const why = guard?.writeError ?? summary?.resultWriteError ?? "正文被截断，溢写文件未写成";
		return { payload: { unavailable: why, cleanupPaths }, approxBytes: 0 };
	}
	return undefined;
}

export interface McpPayloadEntry extends CachedPayload {
	toolCallId: string;
	receivedAt: string;
	approxBytes: number;
	/**
	 * 这次调用请求参数里的 ASIN。差评链唯一的归组依据——评论行里既没有 ASIN 也没有评论 id，
	 * 一张单 2–5 个 ASIN 的返回体形状完全相同、并行到达顺序也不定，不记下来就没法把行分回去。
	 *
	 * 只存这一个字符串，不存整个 input：热路径要保持零 I/O、O(1)，而原始参数已经随 details
	 * 落进会话文件了，这里再持一份只是白占内存。
	 */
	requestAsin?: string;
	/**
	 * 这次调用请求参数里的检索关键词（1688 参考成本链）。convert 按它只收本关键词的返回——
	 * 窗口内同一工具换个词再调，返回体形状完全相同，不记下来就分不出哪份是确认单批的那次。
	 * 与 requestAsin 同理只存一个字符串。
	 */
	requestSearchName?: string;
}

export interface McpPayloadCache {
	/** 收下一次 MCP 结果里的载荷；抽不出可用载荷时什么都不做 */
	remember(sample: { server: string; tool: string }, event: { toolCallId: string; details?: unknown; content?: ReadonlyArray<{ type?: string; text?: string }>; receivedAt?: string; input?: Record<string, unknown> }): void;
	/** 某 server 在给定时刻之后收到的载荷，按到达顺序——ticket 用它界定一个批次 */
	since(server: string, sinceIso: string): McpPayloadEntry[];
	/** 转换消费掉之后丢弃：它已把溢写文件删了，留着只会让下次读到不存在的路径 */
	forget(toolCallIds: readonly string[]): void;
	readonly size: number;
}

/**
 * MCP 载荷的会话内缓存。纯内存、零 I/O——它跑在 `tool_result` 热路径上。
 *
 * 生命周期只到 `/reload`：载荷引用本来就随 details 落进了会话文件，这里持同一份不额外增内存，
 * 但文本副本与溢写路径会真占地方，所以按条数与近似字节双限，逐出最旧的。
 *
 * 方法名一律避开 `update`——compass 的 static-invariants 用纯文本正则 `/\.update\s*\(/` 判
 * 「热路径出现写事务」，缓存里出现 `xxx.update(` 会被误判。
 */
/**
 * 从调用参数里取「含某个键」的参数对象。两种形态：直连是 `input[key]`，网关把参数套在 `input.args` 里。
 * 缺省键是 asin（差评链）；1688 参考成本链传 "search_name"。
 *
 * 门禁与缓存里的字段必须从**同一个对象**读——门禁那边还要在同一个对象里读 review_type / page，跨对象拼会在
 * 网关形态下把合规调用误拦。这里只认字符串、不 parse、不递归，热路径经得起。
 */
export function requestParamsOf(input: Record<string, unknown> | undefined, key = "asin"): Record<string, unknown> | undefined {
	if (!input) return undefined;
	if (typeof input[key] === "string") return input;
	const args = input.args;
	if (args && typeof args === "object" && !Array.isArray(args) && typeof (args as Record<string, unknown>)[key] === "string") return args as Record<string, unknown>;
	return undefined;
}

function requestAsinOf(input: Record<string, unknown> | undefined): string | undefined {
	const asin = requestParamsOf(input)?.asin;
	return typeof asin === "string" && asin ? asin : undefined;
}

function requestSearchNameOf(input: Record<string, unknown> | undefined): string | undefined {
	const searchName = requestParamsOf(input, "search_name")?.search_name;
	const trimmed = typeof searchName === "string" ? searchName.trim() : "";
	return trimmed ? trimmed : undefined;
}

export function createMcpPayloadCache(options: { maxEntries?: number; maxBytes?: number } = {}): McpPayloadCache {
	const maxEntries = options.maxEntries ?? 20;
	const maxBytes = options.maxBytes ?? 2 * 1_048_576;
	const entries = new Map<string, McpPayloadEntry>();

	const evict = () => {
		let bytes = 0;
		for (const entry of entries.values()) bytes += entry.approxBytes;
		while (entries.size > maxEntries || (bytes > maxBytes && entries.size > 1)) {
			const oldest = entries.keys().next();
			if (oldest.done) break;
			bytes -= entries.get(oldest.value)?.approxBytes ?? 0;
			entries.delete(oldest.value);
		}
	};

	return {
		remember(sample, event) {
			const extracted = extractMcpPayload(event.details, event.content);
			if (!extracted) return;
			// 先删再设：同一个 toolCallId 重来时要挪到队尾，否则逐出顺序会认旧位置
			entries.delete(event.toolCallId);
			entries.set(event.toolCallId, {
				...extracted.payload,
				toolCallId: event.toolCallId,
				server: sample.server,
				tool: sample.tool,
				receivedAt: event.receivedAt ?? new Date().toISOString(),
				approxBytes: extracted.approxBytes,
				requestAsin: requestAsinOf(event.input),
				requestSearchName: requestSearchNameOf(event.input),
			});
			evict();
		},
		since(server, sinceIso) {
			const since = Date.parse(sinceIso);
			return [...entries.values()].filter((entry) => entry.server === server && Date.parse(entry.receivedAt) >= since);
		},
		forget(toolCallIds) {
			for (const id of toolCallIds) entries.delete(id);
		},
		get size() {
			return entries.size;
		},
	};
}

export interface ConvertDeps {
	repo: CompassRepository;
}

export interface ConvertInput {
	payloads: CachedPayload[];
	map: SorftimeFieldMap;
	marketName: string;
	/** YYYY-MM-DD；由调用方按 D8 口径决定（载荷统计期优先，取不到用当天） */
	capturedDate: string;
	source?: string;
}

/**
 * 这一批载荷的采集时刻：取最后一次收到 sorftime 返回的时间（完整 ISO），一个都取不到才用 now。
 *
 * 必须是完整时间戳而不是 YYYY-MM-DD：导入侧把纯日期归一到 UTC 零点，而「最新快照」按
 * (capturedAt, importedAt) 比较——同一 UTC 日早些时候手工导入的快照会因此排在这批花钱补来的
 * 数据之前，看板 / 市场档案 / 五维报告 / 粗筛继续用旧的，CPC 缺口只从 A 档降成 C 档
 * （2026-09-05 真实冒烟实测：17:05Z 的手工快照压过了 22:13Z 补来的 sorftime 快照）。
 */
export function capturedAtForBatch(payloads: ReadonlyArray<{ receivedAt?: string }>, now = new Date()): string {
	let latest = Number.NEGATIVE_INFINITY;
	for (const payload of payloads) {
		const time = typeof payload.receivedAt === "string" ? Date.parse(payload.receivedAt) : Number.NaN;
		if (Number.isFinite(time) && time > latest) latest = time;
	}
	return new Date(Number.isFinite(latest) ? latest : now.getTime()).toISOString();
}

export interface ColumnCoverage {
	column: string;
	filled: number;
	total: number;
}

export interface ConvertResult {
	/** 相对项目根的路径，可直接交给 compass_import_csv */
	csvPath: string;
	listingRows: number;
	keywordRows: number;
	coverage: ColumnCoverage[];
	/** 载荷里有、但映射表没登记的字段（提示运营映射还能补什么） */
	unmappedFields: string[];
	archivedRaw: string[];
	cleaned: string[];
}

/**
 * 按点路径逐层取属性。不 eval、不解析表达式，缺任何一层即 undefined。
 * 只看自有属性：原型链上的 constructor / __proto__ 之类拿不到，映射文件里写错也不会摸到别的东西。
 * 数组下标（`list.0.x`）是「顺带能用」——JS 里数组也是对象——但映射文件不该依赖它：
 * 按行号取值是逻辑不是结构，Sorftime 换个排序就错位。
 */
export function pickPath(root: unknown, path: string): unknown {
	let node: unknown = root;
	for (const key of path.split(".")) {
		if (node === null || typeof node !== "object") return undefined;
		if (!Object.hasOwn(node as object, key)) return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return node;
}

function csvCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	const text = String(value);
	return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** 市场名 → 文件名里的 slug。只影响文件名，不参与任何匹配语义。 */
export function slugForFileName(marketName: string): string {
	const slug = marketName
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9一-鿿]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 40);
	return slug || "market";
}

interface ResolvedPayload {
	body: unknown;
	/** 这条不是 JSON（call_failed / aborted 之后 adapter 给的报错文本之类），跳过但要在拒绝理由里点名 */
	skipped?: string;
	/** 命中映射表声明的「无结果」纯文本哨兵：是正常空值，不是失败，不进 skipped */
	empty?: true;
}

/**
 * adapter 的 details.mcpResult（链①）与 fullResultPath 文件（链③）存的都是**整个 CallToolResult**：
 * `{ content: [{ type: "text", text: "<业务 JSON>" }], isError }`，业务载荷在 content[].text 里要二次 parse。
 * 2026-09-05 真实冒烟归档的 payload-1.json 顶层键就是 content / isError——此前链①把包装体原样当载荷，
 * pickPath(body, "data…") 取到 undefined，返回体 ≤16 KiB 的那一步（关键词很少的类目）会静默丢行。
 * 不是包装体（没有 content 数组）就原样返回，兼容直接给业务对象的调用方与夹具。
 */
function unwrapToolResult(value: unknown, parse: (text: string) => ResolvedPayload): ResolvedPayload {
	const content = (value as { content?: unknown } | null | undefined)?.content;
	if (!Array.isArray(content)) return { body: value };
	const text = content
		.filter((item): item is { type: string; text: string } => item?.type === "text" && typeof item?.text === "string")
		.map((item) => item.text)
		.join("\n");
	return text ? parse(text) : { body: undefined };
}

async function resolvePayload(payload: CachedPayload, emptySentinel?: string): Promise<ResolvedPayload> {
	// 解析失败不抛：失败调用的报错文本若混进这一批，convert 直接崩会让这张确认单永远转不出去
	// （catch 分支按设计不清单不清缓存），运营只能重新 approve 再把已经花钱拿到的两步重付一遍
	const parse = (text: string): ResolvedPayload => {
		// 哨兵要在 JSON.parse **之前**比对：服务端「无结果」给的是纯文本，走到 catch 就成了
		// 「返回体不是 JSON、那一步要重调」——那是在诱导运营再花一次钱去搜一个本来就没结果的词
		if (emptySentinel !== undefined && text.trim() === emptySentinel) return { body: undefined, empty: true };
		try {
			return { body: JSON.parse(text) as unknown };
		} catch {
			return { body: undefined, skipped: `${payload.tool}（返回体不是 JSON：${text.replace(/\s+/gu, " ").slice(0, 60)}…）` };
		}
	};
	if (payload.value !== undefined) return unwrapToolResult(payload.value, parse);
	// 文本形态在热路径上只存不 parse，到这里才解析
	if (payload.text !== undefined) return parse(payload.text);
	if (!payload.filePath) return { body: undefined };
	const parsed = parse(await readFile(payload.filePath, "utf8"));
	if (parsed.skipped !== undefined || !payload.fileHoldsToolResult) return parsed;
	return unwrapToolResult(parsed.body, parse);
}

function headerFor(column: string): string {
	const header = CSV_ALIAS_HEADERS[column];
	if (!header) throw new Error(`映射表里的列名 ${column} 不在 csv.ts 的别名表里；请核对 sorftime.map.json`);
	return header;
}

/**
 * 完整快照原则（E0 负向对照实证）：只有关键词行时 21 个指标只剩 4 个，只有 listing 行时
 * 丢掉 main_cpc 等 3 个，而**三种情况 parseMarketCsv 的告警数都是 0**——残缺快照会静默
 * 抹掉指标。所以两类行必须同时拿到才写文件，拿不齐就拒绝并说清缺哪一边。
 */
export async function convertSorftimePayloads(deps: ConvertDeps, input: ConvertInput): Promise<ConvertResult> {
	const resolved: Array<{ payload: CachedPayload } & ResolvedPayload> = [];
	for (const payload of input.payloads) {
		resolved.push({ payload, ...(await resolvePayload(payload)) });
	}

	// 身份列过滤：确认单窗口内**同一个 server 的所有载荷**都会进来，而链路第 1 步
	// （类目检索）的返回体根就是 `data[]`，与 rows.keyword 的点路径撞形——不过滤的话
	// 那几行候选类目会被当成关键词行，把「两类行必须齐」那道守卫喂饱，残缺快照照样写出去。
	// 判据用 csv.ts 自己判定行类型的那两列：listing 认 asin，关键词认 keyword。
	const listingIdPath = input.map.listing.asin;
	const keywordIdPath = input.map.keyword.keyword;
	const hasValue = (value: unknown) => value !== null && value !== undefined && String(value) !== "";

	const listingRows: Array<Record<string, unknown>> = [];
	const keywordRows: Array<Record<string, unknown>> = [];
	for (const { body } of resolved) {
		const listings = pickPath(body, input.map.rows.listing);
		if (Array.isArray(listings)) {
			listingRows.push(...(listings as Array<Record<string, unknown>>).filter((row) => hasValue(pickPath(row, listingIdPath))));
		}
		const keywords = pickPath(body, input.map.rows.keyword);
		if (Array.isArray(keywords)) {
			keywordRows.push(...(keywords as Array<Record<string, unknown>>).filter((row) => hasValue(pickPath(row, keywordIdPath))));
		}
	}
	if (!listingRows.length || !keywordRows.length) {
		const missing = !listingRows.length ? " listing 行" : "关键词行";
		// 载荷不可恢复的那几次要**单独说**。它们已经调过、已经扣过钱，重试同一步同样会失败——
		// 只说「没有 listing 行」会被读成「再调一次就好」，那是在诱导运营继续烧配额。
		const lost = input.payloads.filter((payload) => payload.unavailable);
		if (lost.length) {
			const reasons = [...new Set(lost.map((payload) => payload.unavailable as string))].join("；");
			throw new Error(
				`补数转换被拒绝：这一批有 ${lost.length} 次调用的返回体**已经拿不回来了**（${reasons}）。` +
					`这几次的钱已经花了，但正文被截断且溢写文件没写成，**重试同一步不会变好**——` +
					`先解决溢写失败（多半是磁盘满或临时目录不可写），再重新 approve。` +
					`当前这一批缺${missing}，不会写出残缺快照。`,
			);
		}
		// 被跳过的非 JSON 条目要点名：调用方按工具名算「这一批没见到谁的返回」时，失败的那次
		// 也算「见到了」，不点名运营就不知道该重调哪一步
		const skipped = resolved.filter((item) => item.skipped !== undefined).map((item) => item.skipped as string);
		const skippedNote = skipped.length
			? `另有 ${skipped.length} 条返回体不是 JSON、已跳过——多半是超时 / 中断后 adapter 给的报错文本，那一步要重调：${skipped.join("、")}。`
			: "";
		throw new Error(
			`补数转换被拒绝：本批载荷里没有${missing}，只能合成残缺快照。` +
				`残缺快照会让策略指标静默消失（只有关键词行时 21 个指标只剩 4 个），且导入链对此零告警。` +
				`请先补齐这一步的调用再转换。${skippedNote}`,
		);
	}

	const listingColumns = Object.entries(input.map.listing);
	const keywordColumns = Object.entries(input.map.keyword);
	const headers = [...listingColumns.map(([column]) => headerFor(column)), ...keywordColumns.map(([column]) => headerFor(column))];

	const lines = [headers.join(",")];
	const filled = new Map<string, number>();
	const bump = (column: string, value: unknown) => {
		if (value !== null && value !== undefined && String(value) !== "") filled.set(column, (filled.get(column) ?? 0) + 1);
	};

	// listing 行：关键词列留空
	for (const row of listingRows) {
		const cells = listingColumns.map(([column, path]) => {
			const value = pickPath(row, path);
			bump(column, value);
			return csvCell(value);
		});
		lines.push([...cells, ...keywordColumns.map(() => "")].join(","));
	}
	// 关键词行：listing 列留空——没有 asin / title 就不会被 csv.ts 当成 listing
	for (const row of keywordRows) {
		const cells = keywordColumns.map(([column, path]) => {
			const value = pickPath(row, path);
			bump(column, value);
			return csvCell(value);
		});
		lines.push([...listingColumns.map(() => ""), ...cells].join(","));
	}

	const coverage: ColumnCoverage[] = [
		...listingColumns.map(([column]) => ({ column, filled: filled.get(column) ?? 0, total: listingRows.length })),
		...keywordColumns.map(([column]) => ({ column, filled: filled.get(column) ?? 0, total: keywordRows.length })),
	];

	// 载荷里有、映射没登记的字段：告诉运营映射还能补什么，而不是默默丢掉
	const mappedListing = new Set(listingColumns.map(([, path]) => path));
	const mappedKeyword = new Set(keywordColumns.map(([, path]) => path));
	const unmapped = new Set<string>();
	for (const key of Object.keys(listingRows[0] ?? {})) if (!mappedListing.has(key)) unmapped.add(key);
	for (const key of Object.keys(keywordRows[0] ?? {})) if (!mappedKeyword.has(key)) unmapped.add(key);

	const source = input.source ?? "sorftime";
	const fileName = `mcp-${input.capturedDate}-${slugForFileName(input.marketName)}-${source}.csv`;
	const csvPath = await deps.repo.writeImportCsv(fileName, `${lines.join("\n")}\n`);

	const { archivedRaw, cleaned } = await archiveAndClean(deps, resolved, fileName.replace(/\.csv$/u, ""));

	return { csvPath, listingRows: listingRows.length, keywordRows: keywordRows.length, coverage, unmappedFields: [...unmapped].sort(), archivedRaw, cleaned };
}

/**
 * 原始 JSON 归档 + 溢写清理。CSV 与差评材料两条产物路径共用。
 *
 * `baseName` 必须是**去掉扩展名**的前缀：CSV 那边传 `xxx`（不是 `xxx.csv`），材料那边传
 * `yyy`（不是 `yyy.json`）。把带扩展名的传进来会得到 `yyy.json-payload-1.json` 这种名字。
 * 入参收 resolved 而不是 payloads：归档要的是解析后的 body，清理要的是原 payload 的 cleanupPaths。
 *
 * `defer=true` 时只归档、不清理，把清理动作作为 `cleanup` 交回调用方——给「解析完还要等人操作、
 * 中途可能中断重跑」的链路用（参考成本链的逐条同款确认，最长 12 分钟）。清理一旦提前做掉，
 * 中断后重跑就会在 readFile 上抛裸 ENOENT，那次已计费的调用再也转不出来。
 */
async function archiveAndClean(
	deps: ConvertDeps,
	resolved: ReadonlyArray<{ payload: CachedPayload; body: unknown }>,
	baseName: string,
	defer = false,
): Promise<{ archivedRaw: string[]; cleaned: string[]; cleanup?: () => Promise<string[]> }> {
	// 原始 JSON 归档：产物是派生物，出了问题要能回到载荷本身核对
	const archivedRaw: string[] = [];
	for (const [index, { body }] of resolved.entries()) {
		if (body === undefined) continue;
		archivedRaw.push(await deps.repo.archiveRaw(`${baseName}-payload-${index + 1}.json`, Buffer.from(JSON.stringify(body), "utf8"), new Date().toISOString()));
	}

	if (defer) return { archivedRaw, cleaned: [], cleanup: () => cleanSpills(resolved) };
	return { archivedRaw, cleaned: await cleanSpills(resolved) };
}

/**
 * 溢写文件与其目录都要删——经营数据不留在 /tmp。两条链各自 mkdtemp 过一个目录，
 * 所以文件和目录都要清，且失败不能影响已经写好的产物。可重复调用：删过的路径再删只是无声跳过。
 */
async function cleanSpills(resolved: ReadonlyArray<{ payload: CachedPayload }>): Promise<string[]> {
	const cleaned: string[] = [];
	for (const { payload } of resolved) {
		for (const path of payload.cleanupPaths ?? []) {
			try {
				await unlink(path);
				cleaned.push(path);
			} catch {
				// 已被别人删掉 / 不可达：不影响转换结果
			}
			try {
				// rmdir 而不是 rm：只删空目录。rm(dir, { recursive: false }) 对目录会直接抛 EISDIR，
				// 被下面的 catch 一吞，目录就永远留在临时区里（写这条时真踩了一次）
				await rmdir(dirname(path));
			} catch {
				// 目录非空（同批还有别的载荷没转完）或已不存在：留着，系统清临时目录时会带走
			}
		}
	}
	return cleaned;
}

export interface ReviewMaterialInput {
	/** 必须是带 requestAsin 的缓存条目，不是裸 CachedPayload：归组全靠那个字段 */
	payloads: McpPayloadEntry[];
	map: SorftimeFieldMap;
	marketName: string;
	/** 确认单批准的 ASIN；只收这几个，多出来的载荷丢弃 */
	asins: readonly string[];
	/** 完整 ISO 时间戳，与 CSV 路径同口径 */
	capturedAt: string;
	source?: string;
}

export interface ReviewMaterialResult {
	materialPath: string;
	reviewsTotal: number;
	perAsin: Array<{ asin: string; rows: number }>;
	missingAsins: string[];
	droppedAsins: string[];
	archivedRaw: string[];
	cleaned: string[];
}

/**
 * 把 product_reviews 的返回体转成一份差评材料文件。
 *
 * 与 CSV 路径的三条关键差异：
 *  1. **完整快照原则不适用**。材料的「完整」= 每个批准的 ASIN 都有载荷；缺的点名进 missing_asins
 *     而不是整批拒绝——差评是逐 ASIN 独立的证据，少一个 ASIN 不会让另一个的聚类失真。
 *  2. **归组只能靠 requestAsin**。评论行里没有 ASIN、没有评论 id，且 rows 路径 `data` 与快照链
 *     关键词行的点路径撞形，身份列那套过滤在这里完全用不上。
 *  3. **产物不是 CSV、不进导入入口**。材料只给 compass_dispatch 读，落在数据目录的 materials 子目录。
 */
export async function materializeReviewPayloads(deps: ConvertDeps, input: ReviewMaterialInput): Promise<ReviewMaterialResult> {
	const reviews = input.map.reviews;
	if (!reviews) throw new Error("补数映射表没有声明 reviews 链：差评补数需要它才能把返回体映射成材料，请先在工作区补上再试。");

	const resolved: Array<{ payload: McpPayloadEntry } & ResolvedPayload> = [];
	for (const payload of input.payloads) {
		resolved.push({ payload, ...(await resolvePayload(payload)) });
	}

	const allowed = new Set(input.asins);
	const seenAsins = new Set<string>();
	const droppedAsins = new Set<string>();
	const fingerprints = new Set<string>();
	const rows: Array<Record<string, unknown>> = [];
	const perAsinCount = new Map<string, number>();
	for (const { payload, body } of resolved) {
		const asin = payload.requestAsin;
		// 解析不出 ASIN 的载荷不进材料：宁可让那个 ASIN 落进 missing_asins 让运营重调，
		// 也不能把来路不明的评论安到某个 ASIN 头上
		if (!asin) continue;
		if (!allowed.has(asin)) {
			droppedAsins.add(asin);
			continue;
		}
		const list = pickPath(body, reviews.rows);
		if (!Array.isArray(list)) continue;
		seenAsins.add(asin);
		for (const raw of list as Array<Record<string, unknown>>) {
			const row: Record<string, unknown> = {};
			for (const [field, path] of Object.entries(reviews.fields)) {
				row[field] = path === REQUEST_ASIN_SENTINEL ? asin : pickPath(raw, path);
			}
			// 行内没有 id，去重只能按内容指纹。同一个 ASIN 被调两次时这道去重也挡住重复行。
			// 用 JSON 数组而不是自选分隔符拼接：既天然无歧义（转义把边界处理掉了），又**全是可打印字符**。
			// 别用 NUL 之类的控制字符当分隔符（连注释里都不能写出那个字节）——那会让本文件被 grep 判成二进制，
			// 于是公开仓库卫生检查扫到它时静默跳过，从此对这个文件永久假绿（2026-09-06 交付评审核出）。
			const fingerprint = JSON.stringify([asin, String(row.date ?? ""), String(row.title ?? ""), String(row.body ?? "")]);
			if (fingerprints.has(fingerprint)) continue;
			fingerprints.add(fingerprint);
			rows.push(row);
			perAsinCount.set(asin, (perAsinCount.get(asin) ?? 0) + 1);
		}
	}

	const missingAsins = input.asins.filter((asin) => !seenAsins.has(asin));
	if (!rows.length) {
		// 一条评论都没有就没什么可聚类的，写出去只会让运营对着空材料派一次子代理。
		// 载荷不可恢复的那几次要单独说：它们已经调过、已经扣过钱，重试同一步同样会失败
		const lost = input.payloads.filter((payload) => payload.unavailable);
		if (lost.length) {
			const reasons = [...new Set(lost.map((payload) => payload.unavailable as string))].join("；");
			throw new Error(
				`差评材料转换被拒绝：这一批有 ${lost.length} 次调用的返回体**已经拿不回来了**（${reasons}）。` +
					`这几次的钱已经花了，但正文被截断且溢写文件没写成，**重试同一步不会变好**——` +
					`先解决溢写失败（多半是磁盘满或临时目录不可写），再重新 approve。`,
			);
		}
		const skipped = resolved.filter((item) => item.skipped !== undefined).map((item) => item.skipped as string);
		const skippedNote = skipped.length ? `另有 ${skipped.length} 条返回体不是 JSON、已跳过：${skipped.join("、")}。` : "";
		throw new Error(`差评材料转换被拒绝：这一批一条评论都没有（批准的 ASIN：${input.asins.join("、") || "无"}）。请确认调用真的发出去了再转换。${skippedNote}`);
	}

	const source = input.source ?? "sorftime";
	const fixed = reviews.chain[0]?.fixed ?? {};
	const base = `mcp-${input.capturedAt.slice(0, 10)}-${slugForFileName(input.marketName)}-reviews`;
	const materialPath = await deps.repo.writeMaterial(`${base}.json`, {
		kind: "review_material",
		version: 1,
		market: input.marketName,
		source,
		tool: reviews.chain[0]?.tool ?? "",
		captured_at: input.capturedAt,
		review_type: fixed.review_type,
		sample_cap: reviews.sampleCap,
		asins: input.asins.filter((asin) => seenAsins.has(asin)),
		missing_asins: missingAsins,
		reviews: rows,
	});
	const { archivedRaw, cleaned } = await archiveAndClean(deps, resolved, base);
	return {
		materialPath,
		reviewsTotal: rows.length,
		perAsin: [...perAsinCount.entries()].map(([asin, count]) => ({ asin, rows: count })),
		missingAsins,
		droppedAsins: [...droppedAsins],
		archivedRaw,
		cleaned,
	};
}

export interface CostReferencePayloadInput {
	/** 必须是带 requestSearchName 的缓存条目：调用方已按确认单的关键词过滤过 */
	payloads: McpPayloadEntry[];
	map: SorftimeFieldMap;
	marketName: string;
	/** YYYY-MM-DD，从这批载荷的 capturedAt 派生，归档文件名用 */
	capturedDate: string;
	source?: string;
	/**
	 * 只归档、先不清溢写文件，把清理动作作为 `cleanup` 交回调用方。
	 * 本链在解析与写库之间要逐条弹同款确认（最长 12 分钟且可中断重跑），提前清理会让重跑读不回载荷。
	 */
	deferCleanup?: boolean;
}

export interface CostReferencePayloadResult {
	/** 取自最后收到的那份返回的商品行（原样对象，交 cost-reference.ts 归一） */
	rows: unknown[];
	usedToolCallId?: string;
	/** 同一确认单里多出来的返回份数（都已归档，只是不参与取样） */
	droppedCalls: number;
	/** 服务端返回哨兵或 0 行：正常空值，不是失败 */
	emptyResult: boolean;
	skipped: string[];
	unavailable: string[];
	archivedRaw: string[];
	cleaned: string[];
	/** 只在 `deferCleanup` 时下发：这一批真正落幕（写库成功 / 判空结果）后调它清溢写文件 */
	cleanup?: () => Promise<string[]>;
}

/**
 * 把 1688 参考成本链的返回体解析成商品行。与另外两条链的三条差异：
 *  1. **只有一步、只取第 1 页**：多份返回时取最后收到的一份，其余归档但不参与取样。
 *  2. **哨兵是正常空值**：服务端无结果时返回纯文本（映射表 empty_sentinel），判成 0 行并把这段文本
 *     归档留痕，不走「返回体不是 JSON、那一步要重调」——那会诱导运营再花一次钱。
 *  3. **产物不是 CSV 也不是材料**：这里只解析与归档，取价 / 排序 / 中位数在纯函数层 cost-reference.ts。
 * 一份可用返回都没有且不是哨兵时抛错，与快照链同样说清「载荷不可恢复」还是「返回体不是 JSON」。
 */
export async function resolveCostReferencePayload(deps: ConvertDeps, input: CostReferencePayloadInput): Promise<CostReferencePayloadResult> {
	const section = input.map.costReference;
	if (!section) throw new Error("补数映射表没有声明 cost_reference 链：1688 参考成本需要它才能把返回体映射成候选行，请先在工作区补上再试。");

	const ordered = [...input.payloads].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
	const resolved: Array<{ payload: McpPayloadEntry } & ResolvedPayload> = [];
	for (const payload of ordered) {
		resolved.push({ payload, ...(await resolvePayload(payload, section.emptySentinel)) });
	}

	let usedToolCallId: string | undefined;
	let rows: unknown[] = [];
	let droppedCalls = 0;
	let sawSentinel = false;
	const skipped: string[] = [];
	for (const item of resolved) {
		if (item.empty) {
			sawSentinel = true;
			// 归档哨兵而不是丢掉：这次调用已经计费，运营要能回头看到「那天搜这个词确实没结果」
			item.body = { empty_sentinel: section.emptySentinel };
			continue;
		}
		if (item.skipped !== undefined) {
			skipped.push(item.skipped);
			continue;
		}
		const list = pickPath(item.body, section.rows);
		if (!Array.isArray(list)) {
			skipped.push(`${item.payload.tool}（返回体里没有 ${section.rows} 数组）`);
			continue;
		}
		if (usedToolCallId !== undefined) droppedCalls += 1;
		usedToolCallId = item.payload.toolCallId;
		rows = list;
	}

	const unavailable = [...new Set(input.payloads.filter((payload) => payload.unavailable).map((payload) => payload.unavailable as string))];
	if (usedToolCallId === undefined && !sawSentinel) {
		if (unavailable.length) {
			throw new Error(
				`参考成本转换被拒绝：这一批有 ${unavailable.length} 种返回体**已经拿不回来了**（${unavailable.join("；")}）。` +
					`这次的钱已经花了，但正文被截断且溢写文件没写成，**重试同一步不会变好**——先解决溢写失败（多半是磁盘满或临时目录不可写），再重新 approve。`,
			);
		}
		throw new Error(`参考成本转换被拒绝：确认单窗口内没有一份可解析的返回体${skipped.length ? `（${skipped.join("、")}）` : ""}。请确认调用真的发出去了再转换；失败就重新 approve，不要在同一张单里重试。`);
	}

	const source = input.source ?? "sorftime";
	const base = `mcp-${input.capturedDate}-${slugForFileName(input.marketName)}-${source}-cost-reference`;
	const { archivedRaw, cleaned, cleanup } = await archiveAndClean(deps, resolved, base, input.deferCleanup === true);
	return {
		rows,
		usedToolCallId,
		droppedCalls,
		emptyResult: rows.length === 0,
		skipped,
		unavailable,
		archivedRaw,
		cleaned,
		cleanup,
	};
}

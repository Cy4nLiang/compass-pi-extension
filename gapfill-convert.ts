import { readFile, rmdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { CSV_ALIAS_HEADERS } from "./csv.ts";
import type { CompassRepository } from "./store.ts";

// 补数转换：把缓存下来的 MCP 载荷按点路径映射成一份 compass 能直接导入的市场 CSV。
//
// 分层：这是**编排层**，与 importer.ts 平级——它做文件 I/O（读溢写文件、写 CSV、归档原始
// JSON、清理临时文件），所以不能放进 csv.ts / metrics.ts / gaps.ts 那一层的纯函数模块里。
// 依赖方向单向：只 import csv.ts（拿表头）与 store.ts 的类型；绝不 import index.ts /
// importer.ts / service.ts / ui.ts / web/*——convert 只产出 CSV，回写走现有的
// compass_import_csv，不另开第二条导入链路。反向也不许：纯函数层不得 import 本模块。
//
// 数字不经 LLM：取值一律按映射文件里的点路径直取，不 eval、不推断、缺字段留空。

export interface SorftimeFieldMap {
	/** 两类行各自所在的数组的点路径，如 data.top100_products */
	rows: { listing: string; keyword: string };
	/** compass 列名（= FIELD_ALIASES 每组首别名） → 载荷里的字段名或点路径 */
	listing: Record<string, string>;
	keyword: Record<string, string>;
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
	const cleanupPaths = [guard?.fullOutputPath, summary?.fullResultPath].filter((path): path is string => typeof path === "string" && path.length > 0);

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
	if (typeof summary?.fullResultPath === "string" && summary.fullResultPath) {
		return { payload: { filePath: summary.fullResultPath, fileHoldsToolResult: true, cleanupPaths }, approxBytes: 0 };
	}
	if (typeof guard?.fullOutputPath === "string" && guard.fullOutputPath) {
		return { payload: { filePath: guard.fullOutputPath, cleanupPaths }, approxBytes: 0 };
	}
	return undefined;
}

export interface McpPayloadEntry extends CachedPayload {
	toolCallId: string;
	receivedAt: string;
	approxBytes: number;
}

export interface McpPayloadCache {
	/** 收下一次 MCP 结果里的载荷；抽不出可用载荷时什么都不做 */
	remember(sample: { server: string; tool: string }, event: { toolCallId: string; details?: unknown; content?: ReadonlyArray<{ type?: string; text?: string }>; receivedAt?: string }): void;
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

async function resolvePayload(payload: CachedPayload): Promise<unknown> {
	if (payload.value !== undefined) return payload.value;
	// 文本形态在热路径上只存不 parse，到这里才解析
	if (payload.text !== undefined) return JSON.parse(payload.text) as unknown;
	if (!payload.filePath) return undefined;
	const raw = await readFile(payload.filePath, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (!payload.fileHoldsToolResult) return parsed;
	// mcpResult.fullResultPath 那条链存的是整个 CallToolResult：正文在 content[].text 里，
	// 要二次 parse 才是业务载荷
	const content = (parsed as { content?: Array<{ type?: string; text?: string }> }).content;
	if (!Array.isArray(content)) return parsed;
	const text = content
		.filter((item) => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("\n");
	return text ? (JSON.parse(text) as unknown) : undefined;
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
	const resolved: Array<{ payload: CachedPayload; body: unknown }> = [];
	for (const payload of input.payloads) {
		resolved.push({ payload, body: await resolvePayload(payload) });
	}

	const listingRows: Array<Record<string, unknown>> = [];
	const keywordRows: Array<Record<string, unknown>> = [];
	for (const { body } of resolved) {
		const listings = pickPath(body, input.map.rows.listing);
		if (Array.isArray(listings)) listingRows.push(...(listings as Array<Record<string, unknown>>));
		const keywords = pickPath(body, input.map.rows.keyword);
		if (Array.isArray(keywords)) keywordRows.push(...(keywords as Array<Record<string, unknown>>));
	}

	if (!listingRows.length || !keywordRows.length) {
		const missing = !listingRows.length ? " listing 行" : "关键词行";
		throw new Error(
			`补数转换被拒绝：本批载荷里没有${missing}，只能合成残缺快照。` +
				`残缺快照会让策略指标静默消失（只有关键词行时 21 个指标只剩 4 个），且导入链对此零告警。` +
				`请先补齐这一步的调用再转换。`,
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

	// 原始 JSON 归档：CSV 是派生物，出了问题要能回到载荷本身核对
	const archivedRaw: string[] = [];
	for (const [index, { body }] of resolved.entries()) {
		if (body === undefined) continue;
		const archiveName = `${fileName.replace(/\.csv$/u, "")}-payload-${index + 1}.json`;
		archivedRaw.push(await deps.repo.archiveRaw(archiveName, Buffer.from(JSON.stringify(body), "utf8"), new Date().toISOString()));
	}

	// 溢写文件与其目录都要删——经营数据不留在 /tmp。两条链各自 mkdtemp 过一个目录，
	// 所以文件和目录都要清，且失败不能影响已经写好的 CSV
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

	return { csvPath, listingRows: listingRows.length, keywordRows: keywordRows.length, coverage, unmappedFields: [...unmapped].sort(), archivedRaw, cleaned };
}

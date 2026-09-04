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

/** 一份缓存下来的 MCP 载荷。value 与 filePath 二选一：正文被截断时只有溢写文件。 */
export interface CachedPayload {
	server: string;
	tool: string;
	/** 内联载荷（未被摘要/截断时可用） */
	value?: unknown;
	/** 溢写文件路径。两条链的字段名不同，这里统一成一个路径 + 是否需要二次取 result */
	filePath?: string;
	/** filePath 指向的是完整 CallToolResult 而不是正文时为真（mcpResult.fullResultPath 那条链） */
	fileHoldsToolResult?: boolean;
	/** 读完要删的临时文件；目录随之一并清理 */
	cleanupPaths?: string[];
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

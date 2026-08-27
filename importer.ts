import { readFile, stat, unlink } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { decodeCsvBuffer, parseMarketCsv } from "./csv.ts";
import { findDuplicateImport, importContentHash, importMarketAndScreen } from "./service.ts";
import type { CompassRepository } from "./store.ts";
import type { CompassStore } from "./types.ts";

// CSV 导入编排：把「路径解析 → 查重 → 解析 → 归档 → 写事务」串成一条链。
// 与 pi 会话解耦：事务语义（信任检查、计量 flush、状态栏刷新）由调用方通过 deps.mutate 注入，
// 因此 index.ts（pi 工具/命令）与 Web 服务可以共用同一条导入链路。

// CSV 上限：正常市场快照约 100 行 / 数十 KB，10MB 足够宽松又能挡住误指的大文件
const MAX_CSV_BYTES = 10 * 1_048_576;

export interface CsvImportDeps {
	repo: CompassRepository;
	/** 写事务入口：实现方负责锁与持久化（如 index.ts 的 mutateStore、Web 服务的串行队列 + repo.update） */
	mutate: <T>(mutator: (store: CompassStore) => T) => Promise<{ store: CompassStore; result: T }>;
}

export interface CsvImportInput {
	path: string;
	marketName: string;
	source?: string;
	keywords?: string[];
	capturedAt?: string;
	actor: string;
	runScreen?: boolean;
}

export function normalizeCapturedAt(value?: string): string {
	if (!value) return new Date().toISOString();
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error(`captured_at 无效：${value}；请使用合法的 ISO 时间`);
	return date.toISOString();
}

export async function performCsvImport(deps: CsvImportDeps, input: CsvImportInput) {
	const path = deps.repo.resolveInputPath(input.path);
	// 先看大小再读：resolveInputPath 只限制「在项目内」，指向 node_modules 里的大文件
	// 会把整个文件读进内存（解码后常驻约 3 倍），同时占着写队列队头堵住后续写
	// stat 失败（不存在/不可读）不在此处报错，交由下面的 readFile 统一给出中文错误
	const info = await stat(path).catch(() => undefined);
	if (info && info.size > MAX_CSV_BYTES) {
		throw new Error(`CSV 文件过大（${(info.size / 1_048_576).toFixed(1)}MB，上限 ${MAX_CSV_BYTES / 1_048_576}MB）：${input.path}`);
	}
	let buffer: Buffer;
	try {
		buffer = await readFile(path);
	} catch (error) {
		// 手输路径打错是导入的头号失败模式，中文化以免把 Node 的 ENOENT/EISDIR 原样甩给运营
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error(`CSV 文件不存在：${input.path}`);
		if (code === "EISDIR") throw new Error(`路径是目录而不是 CSV 文件：${input.path}`);
		throw new Error(`CSV 文件读取失败（${input.path}）：${error instanceof Error ? error.message : String(error)}`);
	}
	const fileHash = importContentHash(buffer);
	// 查重在归档之前：重复文件直接拒绝，不往 raw/ 落任何东西
	const duplicate = findDuplicateImport(await deps.repo.load(), fileHash);
	if (duplicate) throw new Error(`重复 CSV：该文件已于 ${duplicate.importedAt} 导入为 ${duplicate.id}`);
	const capturedAt = normalizeCapturedAt(input.capturedAt);
	const parsed = parseMarketCsv(decodeCsvBuffer(buffer), { source: input.source, capturedAt });
	const archivedFile = await deps.repo.archiveRaw(basename(path), buffer, capturedAt);
	try {
		const { result, store } = await deps.mutate((data) => importMarketAndScreen(data, {
			marketName: input.marketName,
			keywords: input.keywords,
			parsed,
			capturedAt,
			// 基准用 repo.projectRoot（已 canonicalPath）而非调用方 cwd：resolveInputPath 返回的是
			// 规范化路径，跨符号链接（如 macOS /var → /private/var）时 cwd 会算出 ../../ 形式的错误相对路径
			fileName: relative(deps.repo.projectRoot, path),
			archivedFile,
			fileHash,
			actor: input.actor,
			runScreen: input.runScreen,
		}));
		return { ...result, store, parsed, archivedFile };
	} catch (error) {
		// 事务失败（事务内二次查重、锁超时、落盘故障）时回收刚写的归档，
		// 否则每次失败的导入都会在 raw/ 留下一份无人引用的副本
		await unlink(join(deps.repo.projectRoot, archivedFile)).catch(() => undefined);
		throw error;
	}
}

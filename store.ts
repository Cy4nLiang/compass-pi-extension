import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { CompassStore } from "./types.ts";

export function createEmptyStore(now = new Date().toISOString()): CompassStore {
	return {
		schemaVersion: 1,
		createdAt: now,
		updatedAt: now,
		markets: [],
		snapshots: [],
		candidates: [],
		profitEstimates: [],
		riskRecords: [],
		reviewAnalyses: [],
		strategies: [],
		strategyRuns: [],
		decisionLog: [],
		budgetPools: [],
		costEvents: [],
	};
}

function assertStore(value: unknown): asserts value is CompassStore {
	if (!value || typeof value !== "object") throw new Error("罗盘数据文件不是 JSON 对象");
	const record = value as Partial<CompassStore>;
	if (record.schemaVersion !== 1) throw new Error(`不支持的罗盘数据版本：${String(record.schemaVersion)}`);
	for (const key of [
		"markets",
		"snapshots",
		"candidates",
		"profitEstimates",
		"riskRecords",
		"reviewAnalyses",
		"strategies",
		"strategyRuns",
		"decisionLog",
		"budgetPools",
		"costEvents",
	] as const) {
		if (!Array.isArray(record[key])) throw new Error(`罗盘数据字段 ${key} 损坏`);
	}
}

function safeBaseName(fileName: string): string {
	return basename(fileName)
		.normalize("NFKC")
		.replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/gu, "-")
		.slice(0, 120) || "import.csv";
}

export class CompassRepository {
	readonly projectRoot: string;
	readonly dataDir: string;
	readonly storePath: string;
	readonly rawDir: string;
	readonly reportsDir: string;

	constructor(projectRoot: string, configDirName = ".pi") {
		this.projectRoot = resolve(projectRoot);
		this.dataDir = resolve(this.projectRoot, configDirName, "compass");
		this.storePath = resolve(this.dataDir, "store.json");
		this.rawDir = resolve(this.dataDir, "raw");
		this.reportsDir = resolve(this.dataDir, "reports");
	}

	async load(): Promise<CompassStore> {
		try {
			const text = await readFile(this.storePath, "utf8");
			const parsed = JSON.parse(text) as unknown;
			assertStore(parsed);
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return createEmptyStore();
			throw error;
		}
	}

	async save(store: CompassStore): Promise<void> {
		await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		store.updatedAt = new Date().toISOString();
		const tempPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(tempPath, this.storePath);
		await chmod(this.storePath, 0o600).catch(() => undefined);
	}

	async update<T>(mutator: (store: CompassStore) => T | Promise<T>): Promise<{ store: CompassStore; result: T }> {
		const store = await this.load();
		const result = await mutator(store);
		await this.save(store);
		return { store, result };
	}

	resolveInputPath(path: string): string {
		const candidate = isAbsolute(path) ? resolve(path) : resolve(this.projectRoot, path.replace(/^@/, ""));
		const rel = relative(this.projectRoot, candidate);
		if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("CSV 路径必须位于当前项目目录内");
		return candidate;
	}

	resolveOutputPath(path?: string, fallbackName = "report.md"): string {
		const candidate = path
			? isAbsolute(path) ? resolve(path) : resolve(this.projectRoot, path.replace(/^@/, ""))
			: resolve(this.reportsDir, fallbackName);
		const rel = relative(this.projectRoot, candidate);
		if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("输出路径必须位于当前项目目录内");
		return candidate;
	}

	async archiveRaw(fileName: string, content: Buffer, capturedAt: string): Promise<string> {
		await mkdir(this.rawDir, { recursive: true, mode: 0o700 });
		const stamp = capturedAt.replace(/[:.]/g, "-");
		const target = resolve(this.rawDir, `${stamp}-${randomUUID().slice(0, 8)}-${safeBaseName(fileName)}`);
		await writeFile(target, content, { mode: 0o600 });
		return relative(this.projectRoot, target);
	}

	async writeReport(outputPath: string, markdown: string): Promise<void> {
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, markdown, { encoding: "utf8", mode: 0o600 });
	}
}

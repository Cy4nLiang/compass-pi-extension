import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { CompassStore, MarketSnapshot } from "./types.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nextUpdatedAt(previous: string): string {
	const previousTime = Date.parse(previous);
	const now = Date.now();
	return new Date(Number.isFinite(previousTime) ? Math.max(now, previousTime + 1) : now).toISOString();
}

function assertString(record: Record<string, unknown>, field: string, path: string): void {
	if (typeof record[field] !== "string" || !record[field]) throw new Error(`罗盘数据字段 ${path}.${field} 损坏`);
}

function assertRecordArray(record: Record<string, unknown>, field: string): Record<string, unknown>[] {
	const value = record[field];
	if (!Array.isArray(value)) throw new Error(`罗盘数据字段 ${field} 损坏`);
	for (const [index, item] of value.entries()) {
		if (!isRecord(item)) throw new Error(`罗盘数据字段 ${field}[${index}] 损坏`);
	}
	return value;
}

function assertStore(value: unknown): asserts value is CompassStore {
	if (!isRecord(value)) throw new Error("罗盘数据文件不是 JSON 对象");
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1) throw new Error(`不支持的罗盘数据版本：${String(record.schemaVersion)}`);
	assertString(record, "createdAt", "store");
	assertString(record, "updatedAt", "store");

	const arrays: Record<string, Record<string, unknown>[]> = {};
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
	] as const) arrays[key] = assertRecordArray(record, key);

	for (const [index, market] of arrays.markets.entries()) {
		assertString(market, "id", `markets[${index}]`);
		assertString(market, "name", `markets[${index}]`);
		if (!Array.isArray(market.keywords)) throw new Error(`罗盘数据字段 markets[${index}].keywords 损坏`);
	}
	for (const [index, snapshot] of arrays.snapshots.entries()) {
		for (const field of ["id", "marketId", "source", "capturedAt", "importedAt"]) assertString(snapshot, field, `snapshots[${index}]`);
		if (!Array.isArray(snapshot.listings) || !Array.isArray(snapshot.keywords) || !Array.isArray(snapshot.warnings) || !isRecord(snapshot.metrics)) {
			throw new Error(`罗盘数据字段 snapshots[${index}] 的 listings/keywords/metrics/warnings 损坏`);
		}
		if (snapshot.dataFile !== undefined && typeof snapshot.dataFile !== "string") throw new Error(`罗盘数据字段 snapshots[${index}].dataFile 损坏`);
	}
	for (const [index, candidate] of arrays.candidates.entries()) {
		for (const field of ["id", "marketId", "stage"]) assertString(candidate, field, `candidates[${index}]`);
		if (!Array.isArray(candidate.tags)) throw new Error(`罗盘数据字段 candidates[${index}].tags 损坏`);
	}
	for (const [index, strategy] of arrays.strategies.entries()) {
		for (const field of ["id", "name", "yaml", "createdAt", "actor"]) assertString(strategy, field, `strategies[${index}]`);
		if (typeof strategy.version !== "number" || !Number.isFinite(strategy.version)) throw new Error(`罗盘数据字段 strategies[${index}].version 损坏`);
		if (!isRecord(strategy.definition) || !isRecord(strategy.definition.meta) || typeof strategy.definition.meta.name !== "string" ||
			(strategy.definition.meta.display_name !== undefined && typeof strategy.definition.meta.display_name !== "string")) {
			throw new Error(`罗盘数据字段 strategies[${index}].definition 损坏`);
		}
	}
	for (const [index, run] of arrays.strategyRuns.entries()) {
		for (const field of ["id", "strategyId", "marketId", "snapshotId", "runAt", "actor"]) assertString(run, field, `strategyRuns[${index}]`);
		if (typeof run.strategyVersion !== "number" || !isRecord(run.result)) throw new Error(`罗盘数据字段 strategyRuns[${index}] 损坏`);
	}
	for (const [index, decision] of arrays.decisionLog.entries()) {
		for (const field of ["id", "marketId", "type", "conclusion", "reason", "actor", "createdAt"]) assertString(decision, field, `decisionLog[${index}]`);
	}
	for (const [index, pool] of arrays.budgetPools.entries()) {
		assertString(pool, "source", `budgetPools[${index}]`);
		if (!(["A", "B", "C"] as unknown[]).includes(pool.tier) || typeof pool.monthlyLimitCny !== "number" || typeof pool.enabled !== "boolean") {
			throw new Error(`罗盘数据字段 budgetPools[${index}] 损坏`);
		}
	}
	for (const [index, event] of arrays.costEvents.entries()) {
		for (const field of ["id", "source", "createdAt", "actor"]) assertString(event, field, `costEvents[${index}]`);
		if (typeof event.amountCny !== "number" || !Number.isFinite(event.amountCny)) throw new Error(`罗盘数据字段 costEvents[${index}].amountCny 损坏`);
	}
	for (const [index, estimate] of arrays.profitEstimates.entries()) {
		for (const field of ["id", "createdAt", "actor"]) assertString(estimate, field, `profitEstimates[${index}]`);
		if (!isRecord(estimate.input) || !isRecord(estimate.result)) throw new Error(`罗盘数据字段 profitEstimates[${index}] 损坏`);
	}
	for (const [index, risk] of arrays.riskRecords.entries()) {
		for (const field of ["id", "marketId", "overall", "createdAt", "actor"]) assertString(risk, field, `riskRecords[${index}]`);
		if (!Array.isArray(risk.evidence)) throw new Error(`罗盘数据字段 riskRecords[${index}].evidence 损坏`);
	}
	for (const [index, review] of arrays.reviewAnalyses.entries()) {
		for (const field of ["id", "marketId", "createdAt", "actor"]) assertString(review, field, `reviewAnalyses[${index}]`);
		if (!Array.isArray(review.sourceAsins) || !Array.isArray(review.themes)) throw new Error(`罗盘数据字段 reviewAnalyses[${index}] 损坏`);
	}
}

function safeBaseName(fileName: string): string {
	return basename(fileName)
		.normalize("NFKC")
		.replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/gu, "-")
		.slice(0, 120) || "import.csv";
}

function emptySnapshotPayload(snapshot: MarketSnapshot): MarketSnapshot {
	const metadata: MarketSnapshot = {
		id: snapshot.id,
		marketId: snapshot.marketId,
		source: snapshot.source,
		capturedAt: snapshot.capturedAt,
		importedAt: snapshot.importedAt,
		rowCount: snapshot.rowCount,
		listings: [],
		keywords: [],
		metrics: snapshot.metrics,
		warnings: snapshot.warnings,
	};
	if (snapshot.fileName !== undefined) metadata.fileName = snapshot.fileName;
	if (snapshot.archivedFile !== undefined) metadata.archivedFile = snapshot.archivedFile;
	if (snapshot.fileHash !== undefined) metadata.fileHash = snapshot.fileHash;
	if (snapshot.dataFile !== undefined) metadata.dataFile = snapshot.dataFile;
	return metadata;
}

function pathWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalPath(candidate: string, seen = new Set<string>()): string {
	const normalized = resolve(candidate);
	if (seen.has(normalized)) throw new Error(`路径符号链接循环：${normalized}`);
	seen.add(normalized);
	try {
		return resolve(realpathSync(normalized));
	} catch {
		try {
			if (lstatSync(normalized).isSymbolicLink()) {
				const target = readlinkSync(normalized);
				return canonicalPath(isAbsolute(target) ? target : resolve(dirname(normalized), target), seen);
			}
		} catch {
			// The final component may not exist yet; resolve its existing parent below.
		}
		const parent = dirname(normalized);
		if (parent === normalized) return normalized;
		return resolve(canonicalPath(parent, seen), basename(normalized));
	}
}

export class CompassRepository {
	readonly projectRoot: string;
	readonly dataDir: string;
	readonly storePath: string;
	readonly rawDir: string;
	readonly reportsDir: string;
	readonly snapshotDataDir: string;
	readonly lockPath: string;

	constructor(projectRoot: string, configDirName = ".pi") {
		this.projectRoot = canonicalPath(resolve(projectRoot));
		if (isAbsolute(configDirName)) throw new Error("罗盘配置目录必须位于当前项目内");
		const configRoot = canonicalPath(resolve(this.projectRoot, configDirName));
		const compassRoot = canonicalPath(resolve(configRoot, "compass"));
		if (!pathWithin(this.projectRoot, compassRoot)) throw new Error("罗盘数据目录必须位于当前项目内");
		this.dataDir = compassRoot;
		this.storePath = resolve(this.dataDir, "store.json");
		this.rawDir = resolve(this.dataDir, "raw");
		this.reportsDir = resolve(this.dataDir, "reports");
		this.snapshotDataDir = resolve(this.dataDir, "snapshots");
		this.lockPath = `${this.storePath}.lock`;
	}

	private resolveSnapshotDataPath(dataFile: string): string {
		if (isAbsolute(dataFile)) throw new Error("快照数据文件路径必须为相对路径");
		const candidate = canonicalPath(resolve(this.projectRoot, dataFile));
		const root = canonicalPath(this.snapshotDataDir);
		if (!pathWithin(this.projectRoot, root) || !pathWithin(root, candidate)) throw new Error("快照数据文件路径越界");
		return candidate;
	}

	private installLazySnapshotData(store: CompassStore): void {
		for (const snapshot of store.snapshots) {
			if (!snapshot.dataFile) continue;
			const dataFile = snapshot.dataFile;
			let loaded = false;
			let listings: MarketSnapshot["listings"] = [];
			let keywords: MarketSnapshot["keywords"] = [];
			const loadPayload = (): void => {
				if (loaded) return;
				loaded = true;
				try {
					const dataPath = this.resolveSnapshotDataPath(dataFile);
					const payload = JSON.parse(readFileSync(dataPath, "utf8")) as unknown;
					if (!isRecord(payload) || !Array.isArray(payload.listings) || !Array.isArray(payload.keywords)) {
						throw new Error("数据文件结构不是 listings/keywords 数组");
					}
					listings = payload.listings as MarketSnapshot["listings"];
					keywords = payload.keywords as MarketSnapshot["keywords"];
				} catch {
					const warning = `快照明细文件缺失或损坏，listing/keyword 指标按缺数据处理：${dataFile}`;
					if (!snapshot.warnings.includes(warning)) snapshot.warnings.push(warning);
				}
			};
			Object.defineProperties(snapshot, {
				listings: {
					configurable: true,
					enumerable: false,
					get: () => {
						loadPayload();
						return listings;
					},
					set: (value: MarketSnapshot["listings"]) => {
						loaded = true;
						listings = value;
					},
				},
				keywords: {
					configurable: true,
					enumerable: false,
					get: () => {
						loadPayload();
						return keywords;
					},
					set: (value: MarketSnapshot["keywords"]) => {
						loaded = true;
						keywords = value;
					},
				},
			});
		}
	}

	async load(): Promise<CompassStore> {
		try {
			const text = await readFile(this.storePath, "utf8");
			const parsed = JSON.parse(text) as unknown;
			assertStore(parsed);
			this.installLazySnapshotData(parsed);
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return createEmptyStore();
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`读取罗盘数据失败（${this.storePath}）：${reason}`);
		}
	}

	private async unlinkLockIfOwned(lockContent: string): Promise<void> {
		try {
			if ((await readFile(this.lockPath, "utf8")) === lockContent) await unlink(this.lockPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		const deadline = Date.now() + 10_000;
		const lockContent = `${process.pid}\n${randomUUID()}\n${new Date().toISOString()}\n`;
		while (true) {
			try {
				await writeFile(this.lockPath, lockContent, { encoding: "utf8", mode: 0o600, flag: "wx" });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					const lockStat = await stat(this.lockPath);
					const currentLock = await readFile(this.lockPath, "utf8");
					let stale = Date.now() - lockStat.mtimeMs > 30_000;
					const lockPid = Number(currentLock.split("\n", 1)[0]);
					if (Number.isInteger(lockPid) && lockPid > 0) {
						try {
							process.kill(lockPid, 0);
							stale = false;
						} catch (processError) {
							stale = (processError as NodeJS.ErrnoException).code === "ESRCH";
						}
					}
					if (stale) await this.unlinkLockIfOwned(currentLock);
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
				}
				if (Date.now() >= deadline) throw new Error(`罗盘数据文件被其他进程锁定超过 10 秒：${this.storePath}`);
				await delay(50);
			}
		}
		try {
			return await operation();
		} finally {
			await this.unlinkLockIfOwned(lockContent);
		}
	}

	private async writeAtomic(path: string, content: string, mode: number): Promise<void> {
		const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(tempPath, content, { encoding: "utf8", mode });
			await rename(tempPath, path);
		} catch (error) {
			await unlink(tempPath).catch(() => undefined);
			throw error;
		}
	}

	private async persistSnapshotPayload(snapshot: MarketSnapshot): Promise<void> {
		await mkdir(this.snapshotDataDir, { recursive: true, mode: 0o700 });
		const dataFile = snapshot.dataFile ?? relative(this.projectRoot, resolve(this.snapshotDataDir, `${safeBaseName(snapshot.id)}.json`));
		const dataPath = this.resolveSnapshotDataPath(dataFile);
		snapshot.dataFile = relative(this.projectRoot, dataPath);
		try {
			await stat(dataPath);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await this.writeAtomic(dataPath, JSON.stringify({ listings: snapshot.listings, keywords: snapshot.keywords }), 0o600);
	}

	private async assertCurrentVersion(store: CompassStore): Promise<void> {
		try {
			const current = JSON.parse(await readFile(this.storePath, "utf8")) as unknown;
			if (!isRecord(current) || current.updatedAt !== store.updatedAt) {
				throw new Error(`罗盘数据在本次读取后已被其他进程更新：${this.storePath}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}

	private async saveUnlocked(store: CompassStore): Promise<void> {
		await this.assertCurrentVersion(store);
		store.updatedAt = nextUpdatedAt(store.updatedAt);
		const validationStore: CompassStore = {
			...store,
			snapshots: store.snapshots.map(emptySnapshotPayload),
		};
		assertStore(validationStore);
		await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		for (const snapshot of store.snapshots) await this.persistSnapshotPayload(snapshot);
		const persisted: CompassStore = {
			...store,
			snapshots: store.snapshots.map((snapshot) => snapshot.dataFile ? emptySnapshotPayload(snapshot) : snapshot),
		};
		assertStore(persisted);
		await this.writeAtomic(this.storePath, `${JSON.stringify(persisted)}\n`, 0o600);
		await chmod(this.storePath, 0o600).catch(() => undefined);
	}

	async save(store: CompassStore): Promise<void> {
		await this.withStoreLock(() => this.saveUnlocked(store));
	}

	async update<T>(
		mutator: (store: CompassStore) => T | Promise<T>,
		options: { shouldSave?: (result: T) => boolean } = {},
	): Promise<{ store: CompassStore; result: T }> {
		return this.withStoreLock(async () => {
			const store = await this.load();
			const result = await mutator(store);
			if (options.shouldSave?.(result) ?? true) await this.saveUnlocked(store);
			return { store, result };
		});
	}

	resolveInputPath(path: string): string {
		const candidate = isAbsolute(path) ? resolve(path) : resolve(this.projectRoot, path.replace(/^@/, ""));
		const resolvedCandidate = canonicalPath(candidate);
		if (!pathWithin(this.projectRoot, resolvedCandidate)) throw new Error("CSV 路径必须位于当前项目目录内");
		return resolvedCandidate;
	}

	resolveOutputPath(path?: string, fallbackName = "report.md"): string {
		const candidate = path
			? isAbsolute(path) ? resolve(path) : resolve(this.projectRoot, path.replace(/^@/, ""))
			: resolve(this.reportsDir, fallbackName);
		if (!candidate.toLowerCase().endsWith(".md")) throw new Error("报告输出路径必须使用 .md 扩展名");
		const resolvedCandidate = canonicalPath(candidate);
		const reportsRoot = canonicalPath(this.reportsDir);
		if (!pathWithin(this.projectRoot, reportsRoot) || !pathWithin(reportsRoot, resolvedCandidate)) throw new Error("报告输出路径必须位于 .pi/compass/reports 目录内");
		return resolvedCandidate;
	}

	async archiveRaw(fileName: string, content: Buffer, capturedAt: string): Promise<string> {
		await mkdir(this.rawDir, { recursive: true, mode: 0o700 });
		const stamp = capturedAt.replace(/[:.]/g, "-");
		const target = resolve(this.rawDir, `${stamp}-${randomUUID().slice(0, 8)}-${safeBaseName(fileName)}`);
		await writeFile(target, content, { mode: 0o600 });
		return relative(this.projectRoot, target);
	}

	async writeReport(outputPath: string, markdown: string): Promise<void> {
		const safePath = this.resolveOutputPath(outputPath);
		await mkdir(dirname(safePath), { recursive: true, mode: 0o700 });
		await writeFile(safePath, markdown, { encoding: "utf8", mode: 0o600 });
		await chmod(safePath, 0o600).catch(() => undefined);
	}
}

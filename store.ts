import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { CompassStore, MarketSnapshot } from "./types.ts";

const STORE_NEEDS_MIGRATION_WRITE = Symbol("compass-store-needs-migration-write");
type MigratingStore = CompassStore & { [STORE_NEEDS_MIGRATION_WRITE]?: boolean };

// 罗盘数据的读写/加锁故障：与「用户输入被业务规则拒绝」区分开。
// 调用方（如 Web 层的 HTTP 状态码分级）应按类型判定，而不是匹配错误文案——
// 底层 fs 错误的措辞由运行时决定，正则白名单必然漏判。
export class StoreIoError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "StoreIoError";
	}
}

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
		outcomeChecks: [],
		lessons: [],
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

function assertRecordArray(record: Record<string, unknown>, field: string, optional = false): Record<string, unknown>[] {
	if (optional && record[field] === undefined) record[field] = [];
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
	arrays.outcomeChecks = assertRecordArray(record, "outcomeChecks", true);
	arrays.lessons = assertRecordArray(record, "lessons", true);

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
		if (candidate.gateOutcome !== undefined && !( ["pass", "review", "reject"] as unknown[]).includes(candidate.gateOutcome)) throw new Error(`罗盘数据字段 candidates[${index}].gateOutcome 损坏`);
		if (candidate.decisionStatus !== undefined && !( ["go", "waitlist", "no_go"] as unknown[]).includes(candidate.decisionStatus)) throw new Error(`罗盘数据字段 candidates[${index}].decisionStatus 损坏`);
		for (const field of ["gateReason", "gateReasonAt", "gateReasonActor", "stageReason", "stageReasonAt", "stageReasonActor", "decisionReason", "decisionAt", "decisionActor"]) {
			if (candidate[field] !== undefined && typeof candidate[field] !== "string") throw new Error(`罗盘数据字段 candidates[${index}].${field} 损坏`);
		}
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
		if (!( ["lead", "import", "strategy", "stage_move", "decision", "risk", "profit", "review", "retro"] as unknown[]).includes(decision.type)) throw new Error(`罗盘数据字段 decisionLog[${index}].type 损坏`);
		if (decision.decisionStatus !== undefined && !( ["go", "waitlist", "no_go"] as unknown[]).includes(decision.decisionStatus)) throw new Error(`罗盘数据字段 decisionLog[${index}].decisionStatus 损坏`);
	}
	for (const [index, check] of arrays.outcomeChecks.entries()) {
		for (const field of ["id", "marketId", "baselineSnapshotId", "verdict", "verdictReason", "createdAt", "actor"]) assertString(check, field, `outcomeChecks[${index}]`);
		if (!( ["validated", "challenged", "inconclusive"] as unknown[]).includes(check.verdict)) throw new Error(`罗盘数据字段 outcomeChecks[${index}].verdict 损坏`);
		if (check.decisionStatus !== undefined && !( ["go", "waitlist", "no_go"] as unknown[]).includes(check.decisionStatus)) throw new Error(`罗盘数据字段 outcomeChecks[${index}].decisionStatus 损坏`);
		if (typeof check.elapsedDays !== "number" || !Number.isInteger(check.elapsedDays) || check.elapsedDays < 0) throw new Error(`罗盘数据字段 outcomeChecks[${index}].elapsedDays 损坏`);
		if (!Array.isArray(check.deltas)) throw new Error(`罗盘数据字段 outcomeChecks[${index}].deltas 损坏`);
		for (const [deltaIndex, delta] of check.deltas.entries()) {
			if (!isRecord(delta)) throw new Error(`罗盘数据字段 outcomeChecks[${index}].deltas[${deltaIndex}] 损坏`);
			assertString(delta, "metric", `outcomeChecks[${index}].deltas[${deltaIndex}]`);
			if (!( ["improved", "worsened", "flat", "unknown"] as unknown[]).includes(delta.direction)) throw new Error(`罗盘数据字段 outcomeChecks[${index}].deltas[${deltaIndex}].direction 损坏`);
			for (const scalar of [delta.baseline, delta.current]) {
				if (scalar !== null && !["number", "string", "boolean"].includes(typeof scalar)) throw new Error(`罗盘数据字段 outcomeChecks[${index}].deltas[${deltaIndex}] 指标值损坏`);
				if (typeof scalar === "number" && !Number.isFinite(scalar)) throw new Error(`罗盘数据字段 outcomeChecks[${index}].deltas[${deltaIndex}] 指标值损坏`);
			}
		}
		if (check.actuals !== undefined && !isRecord(check.actuals)) throw new Error(`罗盘数据字段 outcomeChecks[${index}].actuals 损坏`);
		const hasSnapshotEvidence = typeof check.evidenceSnapshotId === "string" && Boolean(check.evidenceSnapshotId);
		const actuals = isRecord(check.actuals) ? check.actuals : undefined;
		if (actuals) {
			for (const field of ["dailyUnits", "tacos", "returnRate", "netMargin"]) if (actuals[field] !== undefined && (typeof actuals[field] !== "number" || !Number.isFinite(actuals[field] as number))) throw new Error(`罗盘数据字段 outcomeChecks[${index}].actuals.${field} 损坏`);
			if (typeof actuals.dailyUnits === "number" && actuals.dailyUnits < 0) throw new Error(`罗盘数据字段 outcomeChecks[${index}].actuals.dailyUnits 损坏`);
			for (const field of ["tacos", "returnRate"]) if (typeof actuals[field] === "number" && ((actuals[field] as number) < 0 || (actuals[field] as number) > 1)) throw new Error(`罗盘数据字段 outcomeChecks[${index}].actuals.${field} 损坏`);
			if (typeof actuals.netMargin === "number" && actuals.netMargin > 1) throw new Error(`罗盘数据字段 outcomeChecks[${index}].actuals.netMargin 损坏`);
			if (actuals.note !== undefined && typeof actuals.note !== "string") throw new Error(`罗盘数据字段 outcomeChecks[${index}].actuals.note 损坏`);
		}
		const hasActualEvidence = Boolean(actuals && typeof actuals.dailyUnits === "number" && Number.isFinite(actuals.dailyUnits) && typeof actuals.netMargin === "number" && Number.isFinite(actuals.netMargin));
		if (check.verdict !== "inconclusive" && !hasSnapshotEvidence && !hasActualEvidence) throw new Error(`罗盘数据字段 outcomeChecks[${index}] 缺少支持 verdict 的新快照或完整实绩证据`);
	}
	for (const [index, lesson] of arrays.lessons.entries()) {
		for (const field of ["id", "title", "detail", "status", "createdAt", "updatedAt", "actor"]) assertString(lesson, field, `lessons[${index}]`);
		if (!( ["active", "retired"] as unknown[]).includes(lesson.status)) throw new Error(`罗盘数据字段 lessons[${index}].status 损坏`);
		if (!isRecord(lesson.scope)) throw new Error(`罗盘数据字段 lessons[${index}].scope 损坏`);
		for (const field of ["categories", "keywords", "metrics"]) if (lesson.scope[field] !== undefined && (!Array.isArray(lesson.scope[field]) || lesson.scope[field].some((item) => typeof item !== "string"))) throw new Error(`罗盘数据字段 lessons[${index}].scope.${field} 损坏`);
		if (!Array.isArray(lesson.evidence) || lesson.evidence.length === 0 || lesson.evidence.some((item) => typeof item !== "string" || !item)) throw new Error(`罗盘数据字段 lessons[${index}].evidence 必须非空`);
		if (lesson.sourceRetro !== undefined && typeof lesson.sourceRetro !== "string") throw new Error(`罗盘数据字段 lessons[${index}].sourceRetro 损坏`);
		if (lesson.status === "retired" && (typeof lesson.retiredReason !== "string" || !lesson.retiredReason.trim())) throw new Error(`罗盘数据字段 lessons[${index}].retiredReason 损坏`);
	}
	for (const [index, pool] of arrays.budgetPools.entries()) {
		assertString(pool, "source", `budgetPools[${index}]`);
		if (!(["A", "B", "C"] as unknown[]).includes(pool.tier) || typeof pool.monthlyLimitCny !== "number" || !Number.isFinite(pool.monthlyLimitCny) || typeof pool.enabled !== "boolean") {
			throw new Error(`罗盘数据字段 budgetPools[${index}] 损坏`);
		}
		if (pool.costPerCallCny !== undefined && (typeof pool.costPerCallCny !== "number" || !Number.isFinite(pool.costPerCallCny) || pool.costPerCallCny < 0)) {
			throw new Error(`罗盘数据字段 budgetPools[${index}].costPerCallCny 损坏`);
		}
		if (pool.monthlyCallLimit !== undefined && (typeof pool.monthlyCallLimit !== "number" || !Number.isInteger(pool.monthlyCallLimit) || pool.monthlyCallLimit < 1)) {
			throw new Error(`罗盘数据字段 budgetPools[${index}].monthlyCallLimit 损坏`);
		}
	}
	for (const [index, event] of arrays.costEvents.entries()) {
		for (const field of ["id", "source", "createdAt", "actor"]) assertString(event, field, `costEvents[${index}]`);
		if (typeof event.amountCny !== "number" || !Number.isFinite(event.amountCny)) throw new Error(`罗盘数据字段 costEvents[${index}].amountCny 损坏`);
		if (event.kind !== undefined && event.kind !== "mcp_call") throw new Error(`罗盘数据字段 costEvents[${index}].kind 损坏`);
		if (event.tool !== undefined && typeof event.tool !== "string") throw new Error(`罗盘数据字段 costEvents[${index}].tool 损坏`);
		if (event.calls !== undefined && (typeof event.calls !== "number" || !Number.isInteger(event.calls) || event.calls < 1)) {
			throw new Error(`罗盘数据字段 costEvents[${index}].calls 损坏`);
		}
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
			const needsMigrationWrite = isRecord(parsed) && (parsed.outcomeChecks === undefined || parsed.lessons === undefined);
			assertStore(parsed);
			if (needsMigrationWrite) Object.defineProperty(parsed, STORE_NEEDS_MIGRATION_WRITE, { value: true, configurable: true, enumerable: false, writable: true });
			this.installLazySnapshotData(parsed);
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return createEmptyStore();
			const reason = error instanceof Error ? error.message : String(error);
			throw new StoreIoError(`读取罗盘数据失败（${this.storePath}）：${reason}`, { cause: error });
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
				if (Date.now() >= deadline) throw new StoreIoError(`罗盘数据文件被其他进程锁定超过 10 秒：${this.storePath}`);
				// 重试定时器必须持有 event loop 引用（默认 ref）：调用方正在 await 这次写入，
				// unref 会让 loop 一空进程就退，pending 的写静默丢失（CI 上两个锁测试
				// 正是死于「Promise resolution is still pending but the event loop has
				// already resolved」）。代价是进程退出最多被在途写拖 10 秒，属正确语义
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
			// 磁盘满、只读挂载、权限错乱都在这里：包成 StoreIoError 让调用方能识别为系统故障
			throw new StoreIoError(`写入罗盘数据失败（${path}）：${error instanceof Error ? error.message : String(error)}`, { cause: error });
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
				throw new StoreIoError(`罗盘数据在本次读取后已被其他进程更新：${this.storePath}`);
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
			const store = await this.load() as MigratingStore;
			const needsMigrationWrite = store[STORE_NEEDS_MIGRATION_WRITE] === true;
			const result = await mutator(store);
			if (needsMigrationWrite || (options.shouldSave?.(result) ?? true)) {
				delete store[STORE_NEEDS_MIGRATION_WRITE];
				await this.saveUnlocked(store);
			}
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
		// 与 store.json 同样走临时文件 + rename：同市场同日重复生成会命中同一路径，
		// 裸 writeFile 的「先截断后写」会让并发写方读到截断内容、失败时毁掉上一份好报告
		await this.writeAtomic(safePath, markdown, 0o600);
		await chmod(safePath, 0o600).catch(() => undefined);
	}
}

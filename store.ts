import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
	DECISION_LOG_TYPES,
	DECISION_STATUSES,
	GATE_OUTCOMES,
	OUTCOME_VERDICTS,
	RESOLVABLE_TODO_KINDS,
	TODO_RESOLUTION_BASIS_ANCHORS,
	TODO_RESOLUTION_STATUSES,
	type CompassStore,
	type MarketSnapshot,
	type ResolvableTodoKind,
} from "./types.ts";

// 残留锁判 stale 的年龄阈值。合法持锁只覆盖「抢锁→load→改内存→saveUnlocked」这一段：
// 真实 25 快照实测约 15~25ms，合成 2000 快照约 190~265ms，写事务内不允许有网络/LLM 等待（见
// skills/secure-store-write §1），所以 5 分钟是三个数量级的余量。反方向不能激进：误杀活锁后两个
// 进程会各自通过 assertCurrentVersion 再先后 rename，后写者静默覆盖先写者且双方都不报错。
const STALE_LOCK_MAX_AGE_MS = 5 * 60_000;

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
		todoResolutions: [],
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

// 抑制水位对象的形状校验：记录级 basis 与 attempt 级 basisAtSubmit 共用同一形状。
// 两者都是可选字段——缺失即合法（语义由 service 的状态机决定），只在存在时校验字段类型
function assertBasisShape(value: unknown, path: string): void {
	if (value === undefined) return;
	if (!isRecord(value)) throw new Error(`罗盘数据字段 ${path} 损坏`);
	for (const field of ["month", "snapshotWatermark", "stageEnteredAt"]) {
		if (value[field] !== undefined && (typeof value[field] !== "string" || !value[field])) throw new Error(`罗盘数据字段 ${path}.${field} 损坏`);
	}
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
	arrays.todoResolutions = assertRecordArray(record, "todoResolutions", true);

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
		if (candidate.gateOutcome !== undefined && !(GATE_OUTCOMES as readonly unknown[]).includes(candidate.gateOutcome)) throw new Error(`罗盘数据字段 candidates[${index}].gateOutcome 损坏`);
		if (candidate.decisionStatus !== undefined && !(DECISION_STATUSES as readonly unknown[]).includes(candidate.decisionStatus)) throw new Error(`罗盘数据字段 candidates[${index}].decisionStatus 损坏`);
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
		if (!(DECISION_LOG_TYPES as readonly unknown[]).includes(decision.type)) throw new Error(`罗盘数据字段 decisionLog[${index}].type 损坏`);
		if (decision.decisionStatus !== undefined && !(DECISION_STATUSES as readonly unknown[]).includes(decision.decisionStatus)) throw new Error(`罗盘数据字段 decisionLog[${index}].decisionStatus 损坏`);
	}
	for (const [index, check] of arrays.outcomeChecks.entries()) {
		for (const field of ["id", "marketId", "baselineSnapshotId", "verdict", "verdictReason", "createdAt", "actor"]) assertString(check, field, `outcomeChecks[${index}]`);
		if (!(OUTCOME_VERDICTS as readonly unknown[]).includes(check.verdict)) throw new Error(`罗盘数据字段 outcomeChecks[${index}].verdict 损坏`);
		if (check.decisionStatus !== undefined && !(DECISION_STATUSES as readonly unknown[]).includes(check.decisionStatus)) throw new Error(`罗盘数据字段 outcomeChecks[${index}].decisionStatus 损坏`);
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
	// 待办处理记录：记录本身即审计链，因此校验必须守住「状态 ⇔ 末轮验证结论」的一致性——
	// 仿 outcomeChecks「无证据不得非 inconclusive」，杜绝未经验证就落已处理（绕过服务端校验写入的脏数据）
	const seenTodoIds = new Set<string>();
	for (const [index, resolution] of arrays.todoResolutions.entries()) {
		const path = `todoResolutions[${index}]`;
		for (const field of ["id", "todoId", "kind", "titleSnapshot", "status", "createdAt", "updatedAt"]) assertString(resolution, field, path);
		for (const field of ["marketId", "candidateId", "source", "resolvedAt", "resolvedBy"]) {
			if (resolution[field] !== undefined && (typeof resolution[field] !== "string" || !resolution[field])) throw new Error(`罗盘数据字段 ${path}.${field} 损坏`);
		}
		if (!(RESOLVABLE_TODO_KINDS as readonly unknown[]).includes(resolution.kind)) throw new Error(`罗盘数据字段 ${path}.kind 损坏`);
		if (!(TODO_RESOLUTION_STATUSES as readonly unknown[]).includes(resolution.status)) throw new Error(`罗盘数据字段 ${path}.status 损坏`);
		if (seenTodoIds.has(resolution.todoId as string)) throw new Error(`罗盘数据字段 ${path}.todoId 重复`);
		seenTodoIds.add(resolution.todoId as string);
		if (!Array.isArray(resolution.attempts) || resolution.attempts.length === 0) throw new Error(`罗盘数据字段 ${path}.attempts 必须非空`);
		for (const [attemptIndex, attempt] of resolution.attempts.entries()) {
			const attemptPath = `${path}.attempts[${attemptIndex}]`;
			if (!isRecord(attempt)) throw new Error(`罗盘数据字段 ${attemptPath} 损坏`);
			for (const field of ["submittedAt", "submittedBy"]) assertString(attempt, field, attemptPath);
			if (typeof attempt.note !== "string" || !attempt.note.trim()) throw new Error(`罗盘数据字段 ${attemptPath}.note 必须非空`);
			if (!Array.isArray(attempt.evidence)) throw new Error(`罗盘数据字段 ${attemptPath}.evidence 损坏`);
			for (const [evidenceIndex, item] of attempt.evidence.entries()) {
				const evidencePath = `${attemptPath}.evidence[${evidenceIndex}]`;
				if (!isRecord(item)) throw new Error(`罗盘数据字段 ${evidencePath} 损坏`);
				if (typeof item.ref !== "string" || !item.ref.trim()) throw new Error(`罗盘数据字段 ${evidencePath}.ref 必须非空`);
				if (item.note !== undefined && typeof item.note !== "string") throw new Error(`罗盘数据字段 ${evidencePath}.note 损坏`);
			}
			assertBasisShape(attempt.basisAtSubmit, `${attemptPath}.basisAtSubmit`);
			if (attempt.verdict !== undefined) {
				if (!(["pass", "reject"] as unknown[]).includes(attempt.verdict)) throw new Error(`罗盘数据字段 ${attemptPath}.verdict 损坏`);
				if (typeof attempt.verdictReason !== "string" || !attempt.verdictReason.trim()) throw new Error(`罗盘数据字段 ${attemptPath}.verdictReason 必须非空`);
				for (const field of ["verifiedAt", "verifiedBy"]) assertString(attempt, field, attemptPath);
			} else if (attempt.verdictReason !== undefined || attempt.verifiedAt !== undefined || attempt.verifiedBy !== undefined) {
				// 半截验证留痕 = 审计链断裂：宁可判损坏，也不让「有理由无结论」的记录混进已处理分区
				throw new Error(`罗盘数据字段 ${attemptPath} 有验证留痕但缺 verdict`);
			}
		}
		if (!Array.isArray(resolution.reopens)) throw new Error(`罗盘数据字段 ${path}.reopens 损坏`);
		for (const [reopenIndex, reopen] of resolution.reopens.entries()) {
			const reopenPath = `${path}.reopens[${reopenIndex}]`;
			if (!isRecord(reopen)) throw new Error(`罗盘数据字段 ${reopenPath} 损坏`);
			for (const field of ["reopenedAt", "reopenedBy"]) assertString(reopen, field, reopenPath);
			if (typeof reopen.reason !== "string" || !reopen.reason.trim()) throw new Error(`罗盘数据字段 ${reopenPath}.reason 必须非空`);
		}
		assertBasisShape(resolution.basis, `${path}.basis`);
		const lastVerdict = resolution.attempts[resolution.attempts.length - 1].verdict;
		const expectedVerdict: Record<string, unknown> = { submitted: undefined, rejected: "reject", verified: "pass", resolved: "pass" };
		if (resolution.status !== "reopened" && lastVerdict !== expectedVerdict[resolution.status as string]) {
			throw new Error(`罗盘数据字段 ${path} 的状态 ${String(resolution.status)} 与末轮验证结论不一致`);
		}
		if (resolution.status === "resolved") {
			if (!resolution.resolvedAt || !resolution.resolvedBy) throw new Error(`罗盘数据字段 ${path} 的 resolved 状态缺少勾选留痕`);
			const anchor = TODO_RESOLUTION_BASIS_ANCHORS[resolution.kind as ResolvableTodoKind];
			const basis = isRecord(resolution.basis) ? resolution.basis : undefined;
			if (typeof basis?.[anchor] !== "string" || !basis[anchor]) throw new Error(`罗盘数据字段 ${path} 的 resolved 状态缺少水位锚点 ${anchor}`);
		}
		if (resolution.status === "reopened" && resolution.reopens.length === 0) throw new Error(`罗盘数据字段 ${path} 的 reopened 状态缺少重开留痕`);
	}
}

// 写事务的版本判定（乐观锁）只需要顶层 updatedAt 一个字段，不必把整份 store.json 重新 parse
// （真实 591 KB store 上这一笔占 update(noop) 的 26%）。正则从 ^\{ 锚定、且只放行标量顶层键，
// 因此匹配成功必定取到顶层 updatedAt；遇到嵌套对象/数组、缩进、转义、非 ISO 字符一律不匹配，
// 回退全量 parse。绝不能换成裸的 /"updatedAt":"…"/：键序被人手改过时它会取到 markets[0].updatedAt，
// 那是乐观锁的判定输入，取错即漏判并发写。
const STORE_HEAD_UPDATED_AT = /^\{(?:"[A-Za-z0-9_]+":(?:"[^"\\]*"|-?\d+(?:\.\d+)?|true|false|null),)*"updatedAt":"([0-9A-Za-z:.+-]*)"/;

async function readStoreHead(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(256);
		const { bytesRead } = await handle.read(buffer, 0, 256, 0);
		// latin1：256 字节可能切在多字节 UTF-8 中间，按 utf8 解会产生替换字符；
		// 锚定正则在捕获组前只匹配 ASCII，截断只会导致不匹配→回退，不会误取
		return buffer.subarray(0, bytesRead).toString("latin1");
	} finally {
		await handle.close();
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
	readonly gapfillDir: string;
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
		this.gapfillDir = resolve(this.dataDir, "gapfill");
		this.lockPath = `${this.storePath}.lock`;
	}

	private resolveSnapshotDataPath(dataFile: string, snapshotRoot?: string): string {
		if (isAbsolute(dataFile)) throw new Error("快照数据文件路径必须为相对路径");
		const candidate = canonicalPath(resolve(this.projectRoot, dataFile));
		// snapshotRoot 由写事务一次算好传进来（循环不变量）；省略时按原样每次自算，读侧走的就是这条
		const root = snapshotRoot ?? canonicalPath(this.snapshotDataDir);
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
			const needsMigrationWrite = isRecord(parsed) && (parsed.outcomeChecks === undefined || parsed.lessons === undefined || parsed.todoResolutions === undefined);
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

	// 当前写事务持有的锁令牌。写队列保证同一实例同时只有一个 withStoreLock 在跑，
	// 所以单个字段足够；未持锁时为 undefined。
	private heldLock: string | undefined;

	// 落盘前复核：锁被判 stale 回收后，原持有者若照常 rename 就会静默覆盖抢锁方写入的内容，
	// 且两边都不报错——这是回收策略无论取多长阈值都消不掉的那个失败模式（笔记本休眠、
	// SIGSTOP、NFS 卡顿都能跨过任何静态阈值）。这里把它变成一次响亮失败。
	private async assertStillHoldingLock(): Promise<void> {
		if (this.heldLock === undefined) return;
		let current: string;
		try {
			current = await readFile(this.lockPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			current = "";
		}
		if (current === this.heldLock) return;
		throw new StoreIoError(
			`本次写入的锁已被回收（${this.lockPath}），为避免覆盖其他进程刚写入的内容，这次写入已中止；请重试。若反复出现，说明有写事务卡在 ${STALE_LOCK_MAX_AGE_MS / 60_000} 分钟以上（进程被挂起、磁盘或网络存储卡顿），先排查那一头`,
		);
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
					// 两级判定：① 持锁进程确定已死（ESRCH）立即回收；② 进程还活着、属于别的用户
					// （EPERM）或 pid 读不出来时不下断言，退回 mtime 年龄判据。pid 会被系统复用，
					// 「存活」不等于「还在写罗盘」——旧实现让存活无条件否决 mtime，崩溃残留锁的 pid
					// 一旦被复用就永远回收不了，每次写空转满 10 秒后失败。
					let stale = Date.now() - lockStat.mtimeMs > STALE_LOCK_MAX_AGE_MS;
					const lockPid = Number(currentLock.split("\n", 1)[0]);
					if (Number.isInteger(lockPid) && lockPid > 0) {
						try {
							process.kill(lockPid, 0);
						} catch (processError) {
							if ((processError as NodeJS.ErrnoException).code === "ESRCH") stale = true;
						}
					}
					if (stale) await this.unlinkLockIfOwned(currentLock);
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
				}
				if (Date.now() >= deadline) throw new StoreIoError(`罗盘数据文件被其他进程锁定超过 10 秒：${this.storePath}；确认没有其他 pi 会话或 Web 工作台在运行后，删除锁文件 ${this.lockPath} 再重试`);
				// 重试定时器必须持有 event loop 引用（默认 ref）：调用方正在 await 这次写入，
				// unref 会让 loop 一空进程就退，pending 的写静默丢失（CI 上两个锁测试
				// 正是死于「Promise resolution is still pending but the event loop has
				// already resolved」）。代价是进程退出最多被在途写拖 10 秒，属正确语义
				await delay(50);
			}
		}
		this.heldLock = lockContent;
		try {
			return await operation();
		} finally {
			this.heldLock = undefined;
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

	// snapshotRoot 必填：调用方必须先 mkdir 出 snapshotDataDir 再算它的 canonicalPath，
	// 一次写事务只算一次。做成必填而非带默认值，是为了让将来新增的调用方被类型检查拦下来想清楚。
	private async persistSnapshotPayload(snapshot: MarketSnapshot, snapshotRoot: string): Promise<void> {
		const dataFile = snapshot.dataFile ?? relative(this.projectRoot, resolve(this.snapshotDataDir, `${safeBaseName(snapshot.id)}.json`));
		const dataPath = this.resolveSnapshotDataPath(dataFile, snapshotRoot);
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
			// 先读前 256 字节取顶层 updatedAt；键序异常 / 缩进 / 空文件 / 非对象一律不匹配，回退全量解析
			const fastUpdatedAt = STORE_HEAD_UPDATED_AT.exec(await readStoreHead(this.storePath))?.[1];
			const current = fastUpdatedAt !== undefined ? { updatedAt: fastUpdatedAt } : (JSON.parse(await readFile(this.storePath, "utf8")) as unknown);
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
		if (store.snapshots.length > 0) {
			// mkdir 与 snapshots 根目录的 realpath 都是循环不变量：原实现对每个快照各做一次，
			// N=2000 时白花 mkdir 33 ms + realpath 29 ms。提到循环外不改变语义——
			// 越界判定（pathWithin 双检）与 dataFile 归一仍逐快照执行，一个都不能少。
			await mkdir(this.snapshotDataDir, { recursive: true, mode: 0o700 });
			const snapshotRoot = canonicalPath(this.snapshotDataDir);
			for (const snapshot of store.snapshots) await this.persistSnapshotPayload(snapshot, snapshotRoot);
		}
		const persisted: CompassStore = {
			...store,
			snapshots: store.snapshots.map((snapshot) => snapshot.dataFile ? emptySnapshotPayload(snapshot) : snapshot),
		};
		assertStore(persisted);
		// 复核放在 rename 之前、所有校验与 sidecar 落盘之后：这时才是真正会改变
		// 「别人读到什么」的那一步。
		await this.assertStillHoldingLock();
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

	// 上一份复盘报告的落盘时刻（ISO），没有报告时返回 undefined。
	// 用文件 mtime 而不是解析文件名里的日期：文件名里的是生成机器的本地日历日，
	// 跨时区反解回瞬时会错一天。必须在写入本次报告之前调用，否则会探到自己。
	// 只读、不加锁、失败一律 fail open（返回 undefined 让「本次沉淀」退回本地日历日窗口）。
	async latestRetroReportAt(): Promise<string | undefined> {
		let entries: string[];
		try {
			entries = await readdir(this.reportsDir);
		} catch {
			return undefined;
		}
		let latest: number | undefined;
		for (const name of entries) {
			if (!/^retro-.+\.md$/iu.test(name)) continue;
			try {
				const info = await stat(resolve(this.reportsDir, name));
				if (info.isFile() && (latest === undefined || info.mtimeMs > latest)) latest = info.mtimeMs;
			} catch {
				// 列目录与 stat 之间文件被移走：跳过该条
			}
		}
		return latest === undefined ? undefined : new Date(latest).toISOString();
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

	// 补数档位与静音清单。resolveOutputPath 复用不了（它硬性要求 .md 且必须落在 reports/ 内），
	// 所以这里自建一条路径解析，写法与 writeReport 相同：mkdir 0700 → 临时文件 + rename → 0600。
	// 扩展名必须是 .jsonc：index.ts 的 bash 读守卫会拦住 .pi/compass/ 下命中 `.json\b` 的命令，
	// 叫 state.json 会让运营连 cat 一眼都不行。
	get gapfillStatePath(): string {
		const candidate = canonicalPath(resolve(this.gapfillDir, "state.jsonc"));
		if (!pathWithin(this.dataDir, candidate)) throw new Error("补数状态文件必须位于 .pi/compass/gapfill 目录内");
		return candidate;
	}

	// 读侧 fail open（补数档位只是个开关，读不到绝不能拦住会话启动），但**要分清两种失败**：
	// 文件不存在是第一次使用的常态，静默即可；解析失败 / 权限不足是运营手改坏了或环境有问题，
	// 必须让调用方能说出来——一律吞掉的话，档位与整份静音清单会无声回到默认值。
	async readGapfillState(): Promise<{ value?: unknown; error?: string }> {
		let raw: string;
		try {
			raw = await readFile(this.gapfillStatePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return {};
			return { error: `读取失败：${error instanceof Error ? error.message : String(error)}` };
		}
		try {
			return { value: JSON.parse(raw) };
		} catch (error) {
			return { error: `解析失败：${error instanceof Error ? error.message : String(error)}` };
		}
	}

	// backupExisting：上一次读失败时置真。写是整份覆盖，直接盖掉就等于把运营手改坏的那份
	// （以及里面还认得出的静音清单）永久销毁；先留一份 .bak 再覆盖，代价一次 copy。
	async writeGapfillState(state: unknown, options: { backupExisting?: boolean } = {}): Promise<void> {
		const target = this.gapfillStatePath;
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		if (options.backupExisting) {
			try {
				await this.writeAtomic(`${target}.bak`, await readFile(target, "utf8"), 0o600);
			} catch {
				// 没有旧文件或读不动：没什么可备份的，继续写新的
			}
		}
		await this.writeAtomic(target, `${JSON.stringify(state, null, "\t")}\n`, 0o600);
		await chmod(target, 0o600).catch(() => undefined);
	}
}

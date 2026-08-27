import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_BUDGET_POOLS, DEFAULT_STRATEGY_YAML } from "./defaults.ts";
import { profitMetrics } from "./economics.ts";
import {
	calculateMetricDeltas,
	dueRetroItems,
	filterLessons,
	formatDelta,
	matchingLessonsForMarket,
	outcomeStatistics,
	replayOutcomeVerdict,
	renderHistoryNote,
	renderRetroReport,
	retroDueConfig,
	similarMarkets,
	strategyReferencedMetrics,
	actualsOutcomeVerdict,
	buildTimeline,
	searchDecisionHistory,
	type HistoryTimelineItem,
	type OutcomeStats,
	type RetroDueItem,
	type SimilarMarketResult,
} from "./history.ts";
import { calculateMarketMetrics } from "./metrics.ts";
import { renderMarketReport, type GeneratedReport, type MarketReportData } from "./report.ts";
import { evaluateStrategy, parseStrategyYaml, slugify, strategyToYaml, type StrategyContext } from "./strategy.ts";
import { deriveTodos } from "./todo.ts";
import type {
	BudgetPool,
	Candidate,
	CandidateStage,
	CompassStore,
	CostEvent,
	DecisionLog,
	DecisionStatus,
	GateOutcome,
	Lesson,
	Market,
	MarketSnapshot,
	MetricEvidence,
	MetricMap,
	OutcomeActuals,
	OutcomeCheck,
	ParsedMarketCsv,
	ProfitEstimate,
	ProfitInput,
	ProfitResult,
	ReviewAnalysis,
	ReviewTheme,
	RiskEvidenceItem,
	RiskRecord,
	RiskStatus,
	StrategyEvaluation,
	StrategyRun,
	StrategyVersion,
	WorkbenchTodo,
} from "./types.ts";

function nowIso(): string {
	return new Date().toISOString();
}

// 模块加载时解析一次默认策略 id；完整 definition 只在缺省注入时 fresh parse，
// 避免共享可变对象进入多个 store 实例（ensureDefaults 会被每次读库与 MCP gate 调用）
const DEFAULT_STRATEGY_ID = slugify(parseStrategyYaml(DEFAULT_STRATEGY_YAML).meta.name);

function shortId(prefix: string): string {
	return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function stableMarketId(name: string): string {
	const hash = createHash("sha256").update(name.normalize("NFKC").trim().toLocaleLowerCase()).digest("hex").slice(0, 8);
	return `mkt_${slugify(name).slice(0, 32)}_${hash}`;
}

function normalizeLookup(value: unknown): string {
	return typeof value === "string" ? value.normalize("NFKC").trim().toLocaleLowerCase() : "";
}

function requireMarketName(value: string): string {
	const name = typeof value === "string" ? value.trim() : "";
	if (!name) throw new Error("市场名称不能为空");
	return name;
}

export function importContentHash(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

export function findDuplicateImport(store: CompassStore, fileHash: string): MarketSnapshot | undefined {
	return store.snapshots.find((snapshot) => snapshot.fileHash === fileHash);
}

function backfillStatusReasons(store: CompassStore): boolean {
	let changed = false;
	// 先按 candidateId 建一次索引：ensureDefaults 在 Web 层每请求都会跑，
	// 逐候选全量 filter 整个 decisionLog 会让开销随两者乘积增长
	const logsByCandidate = new Map<string, DecisionLog[]>();
	for (const decision of store.decisionLog) {
		if (!decision.candidateId) continue;
		const bucket = logsByCandidate.get(decision.candidateId);
		if (bucket) bucket.push(decision);
		else logsByCandidate.set(decision.candidateId, [decision]);
	}
	for (const candidate of store.candidates) {
		const logs = (logsByCandidate.get(candidate.id) ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const stageLog = logs.find((decision) => ["stage_move", "lead", "import"].includes(decision.type));
		if (!candidate.stageReason?.trim()) {
			candidate.stageReason = stageLog?.reason || "历史候选状态（详见 decisionLog）";
			candidate.stageReasonAt = stageLog?.createdAt ?? candidate.updatedAt;
			candidate.stageReasonActor = stageLog?.actor ?? "compass-migration";
			changed = true;
		}
		if (candidate.gateOutcome && !candidate.gateReason?.trim()) {
			const gateLog = logs.find((decision) => decision.type === "strategy");
			candidate.gateReason = gateLog?.reason || `历史 Gate 状态：${candidate.gateOutcome}（详见 strategyRuns）`;
			candidate.gateReasonAt = gateLog?.createdAt ?? candidate.updatedAt;
			candidate.gateReasonActor = gateLog?.actor ?? "compass-migration";
			changed = true;
		}
		if (candidate.decisionStatus && !candidate.decisionReason?.trim()) {
			const decisionLog = logs.find((decision) => decision.type === "decision");
			candidate.decisionReason = decisionLog?.reason || `历史最终决策：${candidate.decisionStatus}（详见 decisionLog）`;
			candidate.decisionAt = decisionLog?.createdAt ?? candidate.updatedAt;
			candidate.decisionActor = decisionLog?.actor ?? "compass-migration";
			changed = true;
		}
	}
	return changed;
}

export function ensureDefaults(store: CompassStore, actor = "compass"): boolean {
	let changed = false;
	const legacy = store as CompassStore & { outcomeChecks?: OutcomeCheck[]; lessons?: Lesson[] };
	if (!Array.isArray(legacy.outcomeChecks)) {
		legacy.outcomeChecks = [];
		changed = true;
	}
	if (!Array.isArray(legacy.lessons)) {
		legacy.lessons = [];
		changed = true;
	}
	if (!store.strategies.some((strategy) => strategy.id === DEFAULT_STRATEGY_ID)) {
		const definition = parseStrategyYaml(DEFAULT_STRATEGY_YAML);
		store.strategies.push({
			id: DEFAULT_STRATEGY_ID,
			version: 1,
			name: definition.meta.display_name ?? definition.meta.name,
			yaml: DEFAULT_STRATEGY_YAML,
			definition,
			createdAt: nowIso(),
			actor,
			changeNote: "内置默认策略",
		});
		changed = true;
	}
	for (const defaultPool of DEFAULT_BUDGET_POOLS) {
		if (!store.budgetPools.some((pool) => pool.source === defaultPool.source)) {
			store.budgetPools.push({ ...defaultPool });
			changed = true;
		}
	}
	if (backfillStatusReasons(store)) changed = true;
	return changed;
}

export function findMarket(store: CompassStore, reference: string): Market {
	const normalized = normalizeLookup(reference);
	const exact = store.markets.find(
		(market) => market.id === reference || normalizeLookup(market.name) === normalized,
	);
	if (exact) return exact;
	const matches = store.markets.filter(
		(market) => normalizeLookup(market.name).includes(normalized) || market.keywords.some((keyword) => normalizeLookup(keyword).includes(normalized)),
	);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new Error(`市场引用“${reference}”不唯一：${matches.map((market) => market.id).join(", ")}`);
	throw new Error(`未找到市场：${reference}`);
}

export function findCandidate(store: CompassStore, reference: string): Candidate {
	const direct = store.candidates.find((candidate) => candidate.id === reference);
	if (direct) return direct;
	let market: Market;
	try {
		market = findMarket(store, reference);
	} catch (error) {
		// 按市场找不到时，错误应说的是「候选」——报「未找到市场」会把排障方向带偏
		if (error instanceof Error && error.message.startsWith("未找到市场：")) throw new Error(`未找到候选：${reference}`);
		throw error;
	}
	const candidate = store.candidates.find((item) => item.marketId === market.id);
	if (!candidate) throw new Error(`市场 ${market.id} 尚无候选卡`);
	return candidate;
}

export function latestSnapshotIfPresent(store: CompassStore, marketId: string): MarketSnapshot | undefined {
	// 单趟线性取最大：Web 层按市场逐个调用，filter+sort 会让整体退化成 O(市场数 × 快照数 log)
	let latest: MarketSnapshot | undefined;
	for (const snapshot of store.snapshots) {
		if (snapshot.marketId !== marketId) continue;
		if (!latest || snapshot.capturedAt.localeCompare(latest.capturedAt) > 0) latest = snapshot;
	}
	return latest;
}

export function latestSnapshot(store: CompassStore, marketId: string): MarketSnapshot {
	const snapshot = latestSnapshotIfPresent(store, marketId);
	if (!snapshot) throw new Error(`市场 ${marketId} 尚无数据快照`);
	return snapshot;
}

export function latestStrategy(store: CompassStore, strategyId = "jingpu-daily10"): StrategyVersion {
	const normalized = normalizeLookup(strategyId);
	const versions = store.strategies
		.filter((strategy) => strategy.id === strategyId || normalizeLookup(strategy.name) === normalized || normalizeLookup(strategy.definition?.meta?.name) === normalized)
		.sort((a, b) => b.version - a.version);
	if (!versions.length) throw new Error(`未找到策略：${strategyId}`);
	return versions[0];
}

export function findStrategyVersion(store: CompassStore, reference = "jingpu-daily10"): StrategyVersion {
	const versionMatch = reference.match(/^(.*?)(?:@v|:v?)(\d+)$/u);
	if (!versionMatch) return latestStrategy(store, reference);
	const [, rawId, rawVersion] = versionMatch;
	const normalized = normalizeLookup(rawId);
	const version = Number(rawVersion);
	const strategy = store.strategies.find((item) => item.version === version && (item.id === rawId || normalizeLookup(item.name) === normalized || normalizeLookup(item.definition.meta.name) === normalized));
	if (!strategy) throw new Error(`未找到策略版本：${reference}`);
	return strategy;
}

function appendDecision(store: CompassStore, input: Omit<DecisionLog, "id" | "createdAt">): DecisionLog {
	const decision: DecisionLog = { ...input, id: shortId("dec"), createdAt: nowIso() };
	store.decisionLog.push(decision);
	return decision;
}

export function createLead(
	store: CompassStore,
	input: { marketName: string; keywords?: string[]; category?: string; owner?: string; tags?: string[]; actor: string },
): { market: Market; candidate: Candidate; created: boolean } {
	const timestamp = nowIso();
	const marketName = requireMarketName(input.marketName);
	const normalizedName = normalizeLookup(marketName);
	let market = store.markets.find((item) => normalizeLookup(item.name) === normalizedName);
	const created = !market;
	if (!market) {
		market = {
			id: stableMarketId(marketName),
			name: marketName,
			keywords: [...new Set(input.keywords ?? [])],
			category: input.category,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		store.markets.push(market);
	} else {
		market.keywords = [...new Set([...market.keywords, ...(input.keywords ?? [])])];
		market.category ??= input.category;
		market.updatedAt = timestamp;
	}
	let candidate = store.candidates.find((item) => item.marketId === market.id);
	if (!candidate) {
		candidate = {
			id: shortId("cand"),
			marketId: market.id,
			stage: "lead",
			owner: input.owner,
			tags: [...new Set(input.tags ?? [])],
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		store.candidates.push(candidate);
	} else {
		candidate.owner = input.owner ?? candidate.owner;
		candidate.tags = [...new Set([...candidate.tags, ...(input.tags ?? [])])];
		candidate.updatedAt = timestamp;
	}
	const leadReason = `关键词：${market.keywords.join("、") || "未填写"}${input.category ? `；类目：${input.category}` : ""}`;
	if (!candidate.stageReason) {
		candidate.stageReason = leadReason;
		candidate.stageReasonAt = timestamp;
		candidate.stageReasonActor = input.actor;
	}
	appendDecision(store, {
		candidateId: candidate.id,
		marketId: market.id,
		type: "lead",
		conclusion: created ? "创建市场线索" : "更新市场线索",
		reason: leadReason,
		actor: input.actor,
	});
	return { market, candidate, created };
}

function dominantCategory(parsed: ParsedMarketCsv): string | undefined {
	const counts = new Map<string, number>();
	for (const listing of parsed.listings) {
		if (listing.category) counts.set(listing.category, (counts.get(listing.category) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function importParsedMarket(
	store: CompassStore,
	input: {
		marketName: string;
		keywords?: string[];
		parsed: ParsedMarketCsv;
		capturedAt: string;
		fileName?: string;
		archivedFile?: string;
		fileHash?: string;
		actor: string;
	},
): { market: Market; snapshot: MarketSnapshot; candidate: Candidate; created: boolean } {
	const timestamp = nowIso();
	const marketName = requireMarketName(input.marketName);
	if (input.fileHash) {
		const duplicate = findDuplicateImport(store, input.fileHash);
		if (duplicate) throw new Error(`重复 CSV：该文件已于 ${duplicate.importedAt} 导入为 ${duplicate.id}`);
	}
	const normalizedName = normalizeLookup(marketName);
	let market = store.markets.find((item) => normalizeLookup(item.name) === normalizedName);
	const created = !market;
	if (!market) {
		market = {
			id: stableMarketId(marketName),
			name: marketName,
			keywords: [],
			category: dominantCategory(input.parsed),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		store.markets.push(market);
	}
	market.keywords = [...new Set([...market.keywords, ...(input.keywords ?? []), ...input.parsed.keywords.map((item) => item.keyword)])];
	market.category ??= dominantCategory(input.parsed);
	market.updatedAt = timestamp;

	const defaultStrategy = latestStrategy(store);
	const targetMonthlyUnits = Number(defaultStrategy.definition.meta.monthly_units_q ?? 300);
	const metrics = calculateMarketMetrics({
		listings: input.parsed.listings,
		keywords: input.parsed.keywords,
		source: input.parsed.source,
		capturedAt: input.capturedAt,
		targetMonthlyUnits,
	});
	const snapshot: MarketSnapshot = {
		id: shortId("snap"),
		marketId: market.id,
		source: input.parsed.source,
		capturedAt: input.capturedAt,
		importedAt: timestamp,
		fileName: input.fileName,
		archivedFile: input.archivedFile,
		fileHash: input.fileHash,
		rowCount: input.parsed.rowCount,
		listings: input.parsed.listings,
		keywords: input.parsed.keywords,
		metrics,
		warnings: input.parsed.warnings,
	};
	store.snapshots.push(snapshot);
	market.latestSnapshotId = snapshot.id;

	let candidate = store.candidates.find((item) => item.marketId === market.id);
	if (!candidate) {
		candidate = {
			id: shortId("cand"),
			marketId: market.id,
			stage: "lead",
			tags: [],
			stageReason: `${input.parsed.source} CSV 导入 ${input.parsed.rowCount} 行`,
			stageReasonAt: timestamp,
			stageReasonActor: input.actor,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		store.candidates.push(candidate);
	} else {
		candidate.updatedAt = timestamp;
		if (!candidate.stageReason) {
			candidate.stageReason = `${input.parsed.source} CSV 导入 ${input.parsed.rowCount} 行`;
			candidate.stageReasonAt = timestamp;
			candidate.stageReasonActor = input.actor;
		}
	}

	appendDecision(store, {
		candidateId: candidate.id,
		marketId: market.id,
		type: "import",
		conclusion: created ? "创建市场快照" : "更新市场快照",
		reason: `${input.parsed.source} CSV 导入 ${input.parsed.rowCount} 行`,
		snapshotId: snapshot.id,
		actor: input.actor,
	});
	return { market, snapshot, candidate, created };
}

export function importMarketAndScreen(
	store: CompassStore,
	input: Parameters<typeof importParsedMarket>[1] & { runScreen?: boolean },
): ReturnType<typeof importParsedMarket> & { screenRun?: StrategyRun; outcomeCheck?: OutcomeCheck } {
	const imported = importParsedMarket(store, input);
	const screenRun = input.runScreen === false ? undefined : runStrategy(store, {
		marketRef: imported.market.id,
		mode: "screen",
		actor: input.actor,
	});
	const outcomeCheck = autoCheckImportedOutcome(store, imported.market.id, imported.snapshot.id);
	return { ...imported, screenRun, outcomeCheck };
}

export function recordProfitEstimate(
	store: CompassStore,
	input: ProfitInput,
	result: ProfitResult,
	actor: string,
): ProfitEstimate {
	let marketId = input.marketId;
	let candidateId = input.candidateId;
	if (candidateId) {
		const candidate = findCandidate(store, candidateId);
		candidateId = candidate.id;
		marketId = candidate.marketId;
	} else if (marketId) {
		const market = findMarket(store, marketId);
		marketId = market.id;
		candidateId = store.candidates.find((candidate) => candidate.marketId === marketId)?.id;
	}
	const estimate: ProfitEstimate = {
		id: shortId("profit"),
		marketId,
		candidateId,
		input: { ...input, marketId, candidateId },
		result,
		createdAt: nowIso(),
		actor,
	};
	store.profitEstimates.push(estimate);
	if (marketId) {
		appendDecision(store, {
			candidateId,
			marketId,
			type: "profit",
			conclusion: result.grossMargin >= 0.4 ? "毛利 Gate 达标" : "毛利 Gate 未达标",
			reason: `毛利率 ${(result.grossMargin * 100).toFixed(1)}%，CPC承受度 ${result.cpcRatio?.toFixed(2) ?? "缺数据"}`,
			snapshotId: latestSnapshotIfPresent(store, marketId)?.id,
			actor,
		});
	}
	return estimate;
}

function overallRisk(input: {
	certStatus: RiskStatus;
	ipRiskLevel: RiskStatus;
	seasonFlag: "clear" | "strong" | "review" | "unknown";
	policyFlag: "clear" | "review" | "red" | "unknown";
	logisticsRisk: RiskStatus;
}): RiskStatus {
	if ([input.certStatus, input.ipRiskLevel, input.logisticsRisk].includes("red") || input.policyFlag === "red") return "red";
	if (
		[input.certStatus, input.ipRiskLevel, input.logisticsRisk].some((value) => value === "review" || value === "unknown") ||
		input.seasonFlag !== "clear" || input.policyFlag !== "clear"
	) return "review";
	return "pass";
}

export function recordRisk(
	store: CompassStore,
	input: {
		marketRef: string;
		certStatus: RiskStatus;
		ipRiskLevel: RiskStatus;
		seasonFlag: "clear" | "strong" | "review" | "unknown";
		policyFlag: "clear" | "review" | "red" | "unknown";
		logisticsRisk: RiskStatus;
		evidence: Omit<RiskEvidenceItem, "checkedAt">[];
		notes?: string;
		actor: string;
	},
): RiskRecord {
	const market = findMarket(store, input.marketRef);
	const candidate = store.candidates.find((item) => item.marketId === market.id);
	const preliminaryOverall = overallRisk(input);
	const hasLinkedEvidence = input.evidence.some((item) => Boolean(item.url?.trim()));
	const downgradedForEvidence = preliminaryOverall === "pass" && !hasLinkedEvidence;
	const record: RiskRecord = {
		id: shortId("risk"),
		marketId: market.id,
		candidateId: candidate?.id,
		certStatus: input.certStatus,
		ipRiskLevel: input.ipRiskLevel,
		seasonFlag: input.seasonFlag,
		policyFlag: input.policyFlag,
		logisticsRisk: input.logisticsRisk,
		overall: downgradedForEvidence ? "review" : preliminaryOverall,
		evidence: input.evidence.map((item) => ({ ...item, checkedAt: nowIso() })),
		notes: [input.notes, downgradedForEvidence ? "各项虽填 pass/clear，但没有可点击证据链接，系统自动降级为 review" : undefined].filter(Boolean).join("；") || undefined,
		createdAt: nowIso(),
		actor: input.actor,
	};
	store.riskRecords.push(record);
	appendDecision(store, {
		candidateId: candidate?.id,
		marketId: market.id,
		type: "risk",
		conclusion: `风险 ${record.overall}`,
		reason: input.notes || `认证=${input.certStatus}，IP=${input.ipRiskLevel}，季节=${input.seasonFlag}，政策=${input.policyFlag}，物流=${input.logisticsRisk}`,
		snapshotId: latestSnapshotIfPresent(store, market.id)?.id,
		actor: input.actor,
	});
	return record;
}

export function recordReviewAnalysis(
	store: CompassStore,
	input: {
		marketRef: string;
		sourceAsins: string[];
		reviewCount: number;
		themes: ReviewTheme[];
		estimatedRating?: number;
		waistRating?: number;
		notes?: string;
		actor: string;
	},
): ReviewAnalysis {
	const market = findMarket(store, input.marketRef);
	const snapshot = latestSnapshotIfPresent(store, market.id);
	const waistFromSnapshot = snapshot?.metrics.waist_rating_median?.value;
	const waistRating = input.waistRating ?? (typeof waistFromSnapshot === "number" ? waistFromSnapshot : undefined);
	const estimatedRatingGap = input.estimatedRating !== undefined && waistRating !== undefined
		? Math.round((input.estimatedRating - waistRating) * 100) / 100
		: undefined;
	const analysis: ReviewAnalysis = {
		id: shortId("review"),
		marketId: market.id,
		sourceAsins: input.sourceAsins,
		reviewCount: input.reviewCount,
		themes: input.themes,
		estimatedRating: input.estimatedRating,
		waistRating,
		estimatedRatingGap,
		notes: input.notes,
		createdAt: nowIso(),
		actor: input.actor,
	};
	store.reviewAnalyses.push(analysis);
	const candidate = store.candidates.find((item) => item.marketId === market.id);
	appendDecision(store, {
		candidateId: candidate?.id,
		marketId: market.id,
		type: "review",
		conclusion: "差评主题已留痕",
		reason: `${input.reviewCount} 条评论，${input.themes.length} 个主题，预估星级差 ${estimatedRatingGap ?? "缺数据"}`,
		snapshotId: snapshot?.id,
		actor: input.actor,
	});
	return analysis;
}

function latestForMarket<T extends { marketId?: string; createdAt: string }>(items: T[], marketId: string): T | undefined {
	return items.filter((item) => item.marketId === marketId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function riskMetrics(record: RiskRecord | undefined): MetricMap {
	if (!record) return {};
	const confidence = Math.min(0.9, 0.5 + record.evidence.length * 0.05);
	const metric = (value: string, note?: string): MetricEvidence => ({
		value,
		source: "risk_checklist",
		capturedAt: record.createdAt,
		confidence,
		note,
	});
	return {
		risk_overall: metric(record.overall, "无可点击证据链接时，即使各项填 pass 也会自动降级为 review"),
		cert_status: metric(record.certStatus),
		ip_risk_level: metric(record.ipRiskLevel),
		season_flag: metric(record.seasonFlag),
		policy_flag: metric(record.policyFlag),
		logistics_risk: metric(record.logisticsRisk),
	};
}

function reviewMetrics(analysis: ReviewAnalysis | undefined): MetricMap {
	if (!analysis) return {};
	const fixable = analysis.themes
		.filter((theme) => theme.fixability !== "none" && theme.fixability !== "unknown")
		.reduce((sum, theme) => sum + theme.count, 0);
	const total = analysis.themes.reduce((sum, theme) => sum + theme.count, 0);
	const confidence = Math.min(0.85, 0.55 + Math.log10(Math.max(1, analysis.reviewCount)) * 0.1);
	const metric = (value: number | null, note?: string): MetricEvidence => ({
		value,
		source: "review_analysis",
		capturedAt: analysis.createdAt,
		confidence,
		note,
	});
	return {
		est_rating_gap: metric(analysis.estimatedRatingGap ?? null, "预估星级－腰部星级中位数"),
		pain_fixability: metric(total > 0 ? fixable / total : null, "可由工厂、包装或文案解决的痛点占比"),
	};
}

export function buildStrategyContextForSnapshot(store: CompassStore, marketId: string, snapshotId?: string): { snapshot: MarketSnapshot; context: StrategyContext } {
	const snapshot = snapshotId
		? store.snapshots.find((item) => item.id === snapshotId && item.marketId === marketId)
		: latestSnapshot(store, marketId);
	if (!snapshot) throw new Error(`市场 ${marketId} 未找到快照 ${snapshotId}`);
	const metrics: MetricMap = { ...snapshot.metrics };
	const profit = latestForMarket(store.profitEstimates, marketId);
	if (profit) Object.assign(metrics, profitMetrics(profit.input, profit.result, profit.createdAt));
	const risk = latestForMarket(store.riskRecords, marketId);
	Object.assign(metrics, riskMetrics(risk));
	const review = latestForMarket(store.reviewAnalyses, marketId);
	Object.assign(metrics, reviewMetrics(review));
	// listings 用惰性 getter 委托：只有策略表达式真正引用榜单数据时才触发快照明细的磁盘读；
	// 只消费 metrics 的路径（市场档案、待办推导）不再产生无谓 I/O。
	// enumerable:false 与 store.ts 的快照懒属性对齐：spread / JSON.stringify 不会静默触发读盘
	const context = Object.defineProperty({ metrics } as StrategyContext, "listings", {
		enumerable: false,
		configurable: true,
		get: () => snapshot.listings,
	});
	return { snapshot, context };
}

export function buildStrategyContext(store: CompassStore, marketId: string): { snapshot: MarketSnapshot; context: StrategyContext } {
	return buildStrategyContextForSnapshot(store, marketId);
}

export function mainCpcForMarket(store: CompassStore, marketId: string): number | undefined {
	const snapshot = latestSnapshotIfPresent(store, marketId);
	const value = snapshot?.metrics.main_cpc?.value;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function runStrategy(
	store: CompassStore,
	input: { marketRef: string; strategyRef?: string; mode: "screen" | "full"; actor: string },
): StrategyRun {
	const market = findMarket(store, input.marketRef);
	const strategy = latestStrategy(store, input.strategyRef);
	const { snapshot, context } = buildStrategyContext(store, market.id);
	context.targetMonthlyUnits = Number(strategy.definition.meta.monthly_units_q ?? 300);
	const result = evaluateStrategy(strategy.definition, context, input.mode);
	const gateReason = result.rules.filter((rule) => rule.status !== "pass").map((rule) => rule.message).join("；") || "全部规则通过";
	const runAt = nowIso();
	const run: StrategyRun = {
		id: shortId("run"),
		strategyId: strategy.id,
		strategyVersion: strategy.version,
		marketId: market.id,
		snapshotId: snapshot.id,
		mode: input.mode,
		result,
		runAt,
		actor: input.actor,
	};
	store.strategyRuns.push(run);
	const candidate = store.candidates.find((item) => item.marketId === market.id);
	if (candidate) {
		candidate.gateOutcome = result.outcome;
		candidate.gateReason = gateReason;
		candidate.gateReasonAt = run.runAt;
		candidate.gateReasonActor = input.actor;
		candidate.score = result.score;
		candidate.latestStrategyRunId = run.id;
		candidate.updatedAt = run.runAt;
	}
	appendDecision(store, {
		candidateId: candidate?.id,
		marketId: market.id,
		type: "strategy",
		conclusion: `${input.mode} Gate=${result.outcome}，Score=${result.score}`,
		reason: gateReason,
		snapshotId: snapshot.id,
		strategyId: strategy.id,
		strategyVersion: strategy.version,
		actor: input.actor,
	});
	return run;
}

export function evaluateStrategyVersionOnSnapshot(
	store: CompassStore,
	marketId: string,
	strategy: StrategyVersion,
	mode: "screen" | "full" = "screen",
	snapshotId?: string,
): StrategyEvaluation {
	const { context } = buildStrategyContextForSnapshot(store, marketId, snapshotId);
	context.targetMonthlyUnits = Number(strategy.definition.meta.monthly_units_q ?? 300);
	return evaluateStrategy(strategy.definition, context, mode);
}

export function evaluateMarketWithoutPersisting(
	store: CompassStore,
	marketId: string,
	strategyRef = "jingpu-daily10",
	mode: "screen" | "full" = "screen",
): StrategyEvaluation {
	return evaluateStrategyVersionOnSnapshot(store, marketId, findStrategyVersion(store, strategyRef), mode);
}

export function saveStrategyVersion(
	store: CompassStore,
	input: { yaml: string; actor: string; changeNote?: string; forceId?: string },
): StrategyVersion {
	const definition = parseStrategyYaml(input.yaml);
	const id = input.forceId ?? slugify(definition.meta.name);
	const latest = store.strategies.filter((strategy) => strategy.id === id).sort((a, b) => b.version - a.version)[0];
	const version: StrategyVersion = {
		id,
		version: (latest?.version ?? 0) + 1,
		name: definition.meta.display_name ?? definition.meta.name,
		yaml: input.yaml,
		definition,
		createdAt: nowIso(),
		actor: input.actor,
		changeNote: input.changeNote,
	};
	store.strategies.push(version);
	return version;
}

export function cloneStrategy(
	store: CompassStore,
	input: { sourceRef: string; newName: string; actor: string; changeNote?: string },
): StrategyVersion {
	const source = latestStrategy(store, input.sourceRef);
	const definition = structuredClone(source.definition);
	definition.meta.name = slugify(input.newName);
	definition.meta.display_name = input.newName;
	return saveStrategyVersion(store, {
		yaml: strategyToYaml(definition),
		actor: input.actor,
		changeNote: input.changeNote ?? `复制自 ${source.id}@v${source.version}`,
	});
}

export function targetMonthlyUnits(store: CompassStore): number {
	const versions = store.strategies.filter((strategy) => strategy.id === "jingpu-daily10").sort((a, b) => b.version - a.version);
	const value = versions[0]?.definition?.meta?.monthly_units_q;
	return typeof value === "number" && Number.isFinite(value) ? value : 300;
}

// TUI 总览与 Web 总览共用同一行默认 Gate 文案，避免阈值调整时两处静默漂移
export function gateDefaultsLine(store: CompassStore): string {
	return `默认 Gate：QRD(${targetMonthlyUnits(store)})≥20 · 新品占比≥15% · 毛利≥40% · CPC承受度≤0.60 · 风险非红`;
}

export function moveCandidate(
	store: CompassStore,
	input: { candidateRef: string; stage: CandidateStage; reason: string; actor: string },
): Candidate {
	const reason = input.reason.trim();
	if (!reason) throw new Error("移动候选阶段必须填写 reason，确保决策可追溯");
	const candidate = findCandidate(store, input.candidateRef);
	const previous = candidate.stage;
	if (previous === input.stage) throw new Error(`候选已处于 ${input.stage} 阶段`);
	const movedAt = nowIso();
	candidate.stage = input.stage;
	candidate.stageReason = reason;
	candidate.stageReasonAt = movedAt;
	candidate.stageReasonActor = input.actor;
	candidate.updatedAt = movedAt;
	const latestRun = candidate.latestStrategyRunId
		? store.strategyRuns.find((run) => run.id === candidate.latestStrategyRunId)
		: undefined;
	appendDecision(store, {
		candidateId: candidate.id,
		marketId: candidate.marketId,
		type: "stage_move",
		conclusion: `${previous} → ${input.stage}`,
		reason,
		snapshotId: store.snapshots
			.filter((snapshot) => snapshot.marketId === candidate.marketId)
			.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0]?.id,
		strategyId: latestRun?.strategyId,
		strategyVersion: latestRun?.strategyVersion,
		actor: input.actor,
	});
	return candidate;
}

export function decideCandidate(
	store: CompassStore,
	input: { candidateRef: string; status: DecisionStatus; reason: string; actor: string },
): Candidate {
	const reason = input.reason.trim();
	if (!reason) throw new Error("记录最终决策必须填写 reason，确保所有状态可追溯");
	const candidate = findCandidate(store, input.candidateRef);
	const decidedAt = nowIso();
	candidate.decisionStatus = input.status;
	candidate.decisionReason = reason;
	candidate.decisionAt = decidedAt;
	candidate.decisionActor = input.actor;
	const latestRun = candidate.latestStrategyRunId
		? store.strategyRuns.find((run) => run.id === candidate.latestStrategyRunId)
		: undefined;
	const labels: Record<DecisionStatus, string> = { go: "Go", waitlist: "Waitlist", no_go: "No Go" };
	appendDecision(store, {
		candidateId: candidate.id,
		marketId: candidate.marketId,
		type: "decision",
		decisionStatus: input.status,
		conclusion: `最终决策：${labels[input.status]}`,
		reason,
		snapshotId: latestSnapshotIfPresent(store, candidate.marketId)?.id,
		strategyId: latestRun?.strategyId,
		strategyVersion: latestRun?.strategyVersion,
		actor: input.actor,
	});
	return candidate;
}

export interface PoolCandidateItem {
	candidate: Candidate;
	marketName?: string;
}

export function listPoolCandidates(
	store: CompassStore,
	filter: { stage?: CandidateStage; outcome?: GateOutcome; decisionStatus?: DecisionStatus } = {},
): PoolCandidateItem[] {
	const marketNames = new Map(store.markets.map((market) => [market.id, market.name]));
	return store.candidates
		.filter(
			(candidate) =>
				(!filter.stage || candidate.stage === filter.stage) &&
				(!filter.outcome || candidate.gateOutcome === filter.outcome) &&
				(!filter.decisionStatus || candidate.decisionStatus === filter.decisionStatus),
		)
		.map((candidate) => ({ candidate, marketName: marketNames.get(candidate.marketId) }));
}

export interface CandidateDetail {
	candidate: Candidate;
	marketName?: string;
	decisions: DecisionLog[];
}

export function candidateDetail(store: CompassStore, reference: string): CandidateDetail {
	const candidate = findCandidate(store, reference);
	const decisions = store.decisionLog
		.filter((item) => item.candidateId === candidate.id)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return {
		candidate,
		marketName: store.markets.find((market) => market.id === candidate.marketId)?.name,
		decisions,
	};
}

// ── Amazon 链接生成：Web 决策页与 compass_pool 输出共用的单一真相源 ──
// ASIN/关键词来自外部 CSV，属不可信输入：ASIN 白名单校验、关键词 URL 编码后才进入 href
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

export function amazonProductUrl(asin: string | undefined): string | undefined {
	if (typeof asin !== "string") return undefined;
	// CSV 中的 ASIN 可能为小写；归一为大写后再过白名单
	const normalized = asin.trim().toUpperCase();
	return ASIN_PATTERN.test(normalized) ? `https://www.amazon.com/dp/${normalized}` : undefined;
}

export function amazonSearchUrl(keyword: string): string {
	return `https://www.amazon.com/s?k=${encodeURIComponent(keyword.trim())}`;
}

// 契约：url/keyword/title 均为原文透传（url 已过白名单/编码，keyword/title 完全未清洗）。
// 进入 HTML 时消费方必须做含引号的全量转义（沿用 web/assets/app.js 的 escapeHtml，
// 其已覆盖 ' 与 "）且属性一律用双引号——encodeURIComponent 不编码单引号。
export interface MarketAmazonLinks {
	searches: Array<{ keyword: string; url: string }>;
	topListings: Array<{
		rank: number;
		asin?: string;
		url?: string;
		title?: string;
		price?: number;
		rating?: number;
		monthlySales?: number;
	}>;
}

// 负数会让 slice(0, n) 语义反转成「除末 n 条外全部」；NaN 会让 Math.max 失效——先 isFinite
function clampCount(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

// 读取该市场最新快照 listings 的前 topN 条（rank 升序）。会触碰快照明细懒加载——
// 仅限单品详情类消费方调用，列表类 DTO 禁止（web/data.ts 红线）
export function marketAmazonLinks(
	store: CompassStore,
	marketId: string,
	options?: { topN?: number; maxKeywords?: number },
): MarketAmazonLinks {
	const topN = clampCount(options?.topN ?? 5, 5);
	const maxKeywords = clampCount(options?.maxKeywords ?? 3, 3);
	const market = store.markets.find((item) => item.id === marketId);
	const searches = (market?.keywords ?? [])
		// 手改 store 可能混入非字符串词条：过滤降级而非让整个详情页抛错
		.filter((keyword): keyword is string => typeof keyword === "string")
		.map((keyword) => keyword.trim())
		.filter(Boolean)
		.slice(0, maxKeywords)
		.map((keyword) => ({ keyword, url: amazonSearchUrl(keyword) }));
	const snapshot = latestSnapshotIfPresent(store, marketId);
	const topListings = (snapshot ? [...snapshot.listings] : [])
		// sidecar 强转无逐条校验：坏 rank（NaN）会按原位挤占 top-N 席位，先过滤
		.filter((listing) => Number.isFinite(listing.rank))
		.sort((a, b) => a.rank - b.rank)
		.slice(0, topN)
		.map((listing) => ({
			rank: listing.rank,
			asin: listing.asin,
			url: amazonProductUrl(listing.asin),
			title: listing.title,
			// 与上方 keywords/rank 同级防御：手改 sidecar 的字符串数值会让前端 toFixed 抛错，非有限数值一律降级为缺失
			price: Number.isFinite(listing.price) ? listing.price : undefined,
			rating: Number.isFinite(listing.rating) ? listing.rating : undefined,
			monthlySales: Number.isFinite(listing.monthlySales) ? listing.monthlySales : undefined,
		}));
	return { searches, topListings };
}

function monthPrefix(date = new Date()): string {
	return date.toISOString().slice(0, 7);
}

export function budgetStatus(
	store: CompassStore,
	month = monthPrefix(),
	pendingCalls?: Record<string, number>,
): Array<BudgetPool & { spentCny: number; remainingCny: number; utilization: number | null; callCount: number; callUtilization: number | null; state: "ok" | "warning" | "fused" | "free" }> {
	return store.budgetPools.map((pool) => {
		const monthEvents = store.costEvents.filter((event) => event.source === pool.source && event.createdAt.startsWith(month));
		// pending 为会话内尚未落盘的计量次数；并入次数与折算金额，避免告警/熔断判断滞后于 flush
		const pending = pendingCalls?.[pool.source] ?? 0;
		const spentCny = monthEvents.reduce((sum, event) => sum + event.amountCny, 0) + pending * (pool.costPerCallCny ?? 0);
		const callCount = monthEvents.reduce((sum, event) => sum + (event.kind === "mcp_call" ? event.calls ?? 1 : 0), 0) + pending;
		const utilization = pool.monthlyLimitCny > 0 ? spentCny / pool.monthlyLimitCny : null;
		const callUtilization = pool.monthlyCallLimit !== undefined && pool.monthlyCallLimit > 0 ? callCount / pool.monthlyCallLimit : null;
		const ratios = [utilization, callUtilization].filter((ratio): ratio is number => ratio !== null);
		const state = ratios.length === 0 ? "free" : ratios.some((ratio) => ratio >= 1) ? "fused" : ratios.some((ratio) => ratio >= 0.8) ? "warning" : "ok";
		return {
			...pool,
			spentCny: Math.round(spentCny * 100) / 100,
			remainingCny: Math.max(0, Math.round((pool.monthlyLimitCny - spentCny) * 100) / 100),
			utilization: utilization === null ? null : Math.round(utilization * 1000) / 1000,
			callCount,
			callUtilization: callUtilization === null ? null : Math.round(callUtilization * 1000) / 1000,
			state,
		};
	});
}

export function recordCost(
	store: CompassStore,
	input: { source: string; marketRef?: string; amountCny: number; description?: string; actor: string; force?: boolean },
): CostEvent {
	if (!Number.isFinite(input.amountCny) || input.amountCny < 0) throw new Error("amountCny 必须为非负数字");
	const pool = store.budgetPools.find((item) => item.source === input.source);
	if (!pool) throw new Error(`预算池不存在：${input.source}`);
	if (!pool.enabled && !input.force) throw new Error(`数据源 ${input.source} 已禁用`);
	const spent = budgetStatus(store).find((item) => item.source === input.source)?.spentCny ?? 0;
	if (pool.monthlyLimitCny === 0 && input.amountCny > 0 && !input.force) {
		throw new Error(`数据源 ${input.source} 配置为零成本；若确需记账，请先配置预算或 force=true`);
	}
	if (pool.monthlyLimitCny > 0 && spent + input.amountCny > pool.monthlyLimitCny && !input.force) {
		throw new Error(`预算熔断：${input.source} 本月已用 ¥${spent}，本次 ¥${input.amountCny} 将超过 ¥${pool.monthlyLimitCny}`);
	}
	const marketId = input.marketRef ? findMarket(store, input.marketRef).id : undefined;
	const event: CostEvent = {
		id: shortId("cost"),
		source: input.source,
		marketId,
		amountCny: input.amountCny,
		description: input.description,
		createdAt: nowIso(),
		actor: input.actor,
	};
	store.costEvents.push(event);
	return event;
}

export function configureBudget(
	store: CompassStore,
	input: { source: string; tier?: "A" | "B" | "C"; monthlyLimitCny?: number; enabled?: boolean; note?: string; costPerCallCny?: number; monthlyCallLimit?: number },
): BudgetPool {
	if (input.monthlyLimitCny !== undefined && (!Number.isFinite(input.monthlyLimitCny) || input.monthlyLimitCny < 0)) {
		throw new Error("monthlyLimitCny 必须为非负数字");
	}
	if (input.costPerCallCny !== undefined && (!Number.isFinite(input.costPerCallCny) || input.costPerCallCny < 0)) {
		throw new Error("costPerCallCny 必须为非负数字（0 表示只计数不折算成本）");
	}
	if (input.monthlyCallLimit !== undefined && (!Number.isInteger(input.monthlyCallLimit) || input.monthlyCallLimit < 0)) {
		throw new Error("monthlyCallLimit 必须为非负整数（0 表示清除次数上限）");
	}
	// trim 与计量/拦截侧口径一致：带空白的 source 会建出永不计量、不拦截的幽灵池
	const source = input.source.trim();
	if (!source) throw new Error("source 不能为空");
	let pool = store.budgetPools.find((item) => item.source === source);
	if (!pool) {
		if (!input.tier || input.monthlyLimitCny === undefined) throw new Error("新预算池需要 tier 与 monthlyLimitCny");
		pool = {
			source,
			tier: input.tier,
			monthlyLimitCny: input.monthlyLimitCny,
			enabled: input.enabled ?? true,
			note: input.note,
		};
		store.budgetPools.push(pool);
	} else {
		if (input.tier !== undefined) pool.tier = input.tier;
		if (input.monthlyLimitCny !== undefined) pool.monthlyLimitCny = input.monthlyLimitCny;
		if (input.enabled !== undefined) pool.enabled = input.enabled;
		if (input.note !== undefined) pool.note = input.note;
	}
	if (input.costPerCallCny !== undefined) pool.costPerCallCny = input.costPerCallCny;
	// 0 与 undefined 双义在存储层被 assertStore 封死：清除动作在此归一为字段删除
	if (input.monthlyCallLimit !== undefined) {
		if (input.monthlyCallLimit === 0) delete pool.monthlyCallLimit;
		else pool.monthlyCallLimit = input.monthlyCallLimit;
	}
	return pool;
}

export interface McpCallSample {
	server: string;
	tool: string;
	billable: boolean;
}

// tool_result 计量分类器：识别 MCP 调用结果并判定是否计费。
// 计费口径（spec 4.2.5）：已到达服务端的调用消耗点数——成功（无 error）与服务端业务错误
// （error === "tool_error"）计；认证/连接/退避/中止等未到达服务端的失败不计。
// direct 工具的 details 无 mode 字段；mcp 代理为 mode==="call"，其余 mode（search/describe/
// status/script…）不是对服务端工具的调用。返回 undefined 表示与 MCP 计量无关。
export function classifyMcpToolResult(toolName: string, details: unknown): McpCallSample | undefined {
	if (toolName.startsWith("compass_")) return undefined;
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const record = details as Record<string, unknown>;
	// trim 与 recordMcpUsage 的池名匹配口径保持一致，避免 pending 键与落账键分裂
	const server = typeof record.server === "string" ? record.server.trim() : "";
	if (!server) return undefined;
	if (record.mode !== undefined && record.mode !== "call") return undefined;
	if (record.error !== undefined && typeof record.error !== "string") return undefined;
	const billable = record.error === undefined || record.error === "tool_error";
	const tool = typeof record.tool === "string" && record.tool
		? record.tool
		: typeof record.resourceUri === "string" && record.resourceUri ? record.resourceUri : "unknown";
	return { server, tool, billable };
}

// 计量落账：事后记账，钱已花出，绝不因熔断/禁用丢账（与 recordCost 的事前拦截语义相反）。
// 只有与预算池同名的 server 才计量；非法条目（hook 侧数据）静默跳过。
export function recordMcpUsage(
	store: CompassStore,
	usage: Array<{ server: string; tool: string; calls: number }>,
	actor: string,
): CostEvent[] {
	const merged = new Map<string, { server: string; tool: string; calls: number }>();
	for (const entry of usage) {
		if (!Number.isSafeInteger(entry.calls) || entry.calls < 1) continue;
		const server = typeof entry.server === "string" ? entry.server.trim() : "";
		if (!server || !store.budgetPools.some((pool) => pool.source === server)) continue;
		const tool = (typeof entry.tool === "string" && entry.tool.trim()) || "unknown";
		// NUL 分隔避免与含下划线等常规字符的池名/工具名歧义拼接；必须保持 \u0000 转义写法，
		// 源码中出现原始 0x00 字节会让 grep 把整个文件当二进制
		const key = `${server}\u0000${tool}`;
		const existing = merged.get(key);
		if (existing) existing.calls += entry.calls;
		else merged.set(key, { server, tool, calls: entry.calls });
	}
	const events: CostEvent[] = [];
	for (const { server, tool, calls } of merged.values()) {
		const unitPrice = store.budgetPools.find((pool) => pool.source === server)?.costPerCallCny ?? 0;
		const event: CostEvent = {
			id: shortId("cost"),
			source: server,
			amountCny: Math.round(unitPrice * calls * 100) / 100,
			description: `MCP 自动计量：${tool} × ${calls}`,
			kind: "mcp_call",
			tool,
			calls,
			createdAt: nowIso(),
			actor,
		};
		store.costEvents.push(event);
		events.push(event);
	}
	return events;
}

function mcpCallTargetServers(store: CompassStore, call: { toolName: string; input?: Record<string, unknown> }): string[] {
	// 最长前缀优先，防止短池名抢占长池名的工具（与 pi-mcp-adapter 的 server 解析口径一致）
	const byLength = [...store.budgetPools].sort((a, b) => b.source.length - a.source.length);
	for (const pool of byLength) {
		if (call.toolName.startsWith(`${pool.source}_`)) return [pool.source];
	}
	if (call.toolName === "mcp") {
		if (typeof call.input?.server === "string" && call.input.server) return [call.input.server];
		const tool = call.input?.tool;
		if (typeof tool === "string") {
			for (const pool of byLength) {
				if (tool === pool.source || tool.startsWith(`${pool.source}_`)) return [pool.source];
			}
		}
		return [];
	}
	if (call.toolName === "mcpScript") {
		// 脚本内部调用不逐条上报，无法精确归因；按池名子串做提示性匹配（spec 2.1 非目标）。
		// 返回全部命中池：任一熔断即拦截，避免 first-match 归因到未熔断池而漏拦
		const code = call.input?.code;
		if (typeof code !== "string") return [];
		const lowered = code.toLowerCase();
		return store.budgetPools.filter((pool) => lowered.includes(pool.source.toLowerCase())).map((pool) => pool.source);
	}
	return [];
}

// tool_call 熔断拦截判定：只读，不写 store。仅对「配置了上限」（monthlyCallLimit 或
// monthlyLimitCny>0）且当月已熔断的池返回拦截理由；默认 sorftime 池（¥0、无次数上限）
// 永不拦截——无惊吓原则。返回 undefined 表示放行。
export function evaluateMcpGate(
	store: CompassStore,
	call: { toolName: string; input?: Record<string, unknown> },
	pendingCalls?: Record<string, number>,
): { server: string; reason: string } | undefined {
	const servers = mcpCallTargetServers(store, call);
	if (!servers.length) return undefined;
	const budgets = budgetStatus(store, undefined, pendingCalls);
	for (const server of servers) {
		const pool = budgets.find((item) => item.source === server);
		if (!pool) continue;
		if (pool.monthlyCallLimit === undefined && pool.monthlyLimitCny <= 0) continue;
		if (pool.state !== "fused") continue;
		const callsText = pool.monthlyCallLimit !== undefined
			? `本月 ${pool.callCount} 次 / 限 ${pool.monthlyCallLimit} 次`
			: `本月 ${pool.callCount} 次`;
		const amountText = pool.monthlyLimitCny > 0
			? `¥${pool.spentCny.toFixed(2)} / ¥${pool.monthlyLimitCny.toFixed(0)}`
			: `¥${pool.spentCny.toFixed(2)}`;
		return {
			server,
			reason: `${server} 预算已熔断：${callsText}（${amountText}）。解除：compass_budget configure source=${server} 提高 monthly_call_limit（0=清除）或 monthly_limit_cny，次月自动恢复。`,
		};
	}
	return undefined;
}

export interface MarketScanResult {
	market: Market;
	snapshot: MarketSnapshot;
	candidate?: Candidate;
	evaluation: StrategyEvaluation;
	ageDays: number;
}

export function scanMarkets(
	store: CompassStore,
	input: {
		query?: string;
		strategyRef?: string;
		outcome?: "pass" | "review" | "reject";
		minQrd?: number;
		minNewListingShare?: number;
		maxCpcRatio?: number;
		limit?: number;
	},
): MarketScanResult[] {
	const query = input.query ? normalizeLookup(input.query) : undefined;
	const strategy = latestStrategy(store, input.strategyRef);
	const rows: Array<MarketScanResult & { metrics: MetricMap }> = [];
	for (const market of store.markets) {
		if (query && !normalizeLookup(`${market.name} ${market.keywords.join(" ")} ${market.category ?? ""}`).includes(query)) continue;
		const snapshot = store.snapshots
			.filter((item) => item.marketId === market.id)
			.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
		if (!snapshot) continue;
		const metrics = buildStrategyContext(store, market.id).context.metrics;
		rows.push({
			market,
			snapshot,
			candidate: store.candidates.find((candidate) => candidate.marketId === market.id),
			evaluation: evaluateMarketWithoutPersisting(store, market.id, strategy.id, "screen"),
			ageDays: Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.capturedAt)) / 86_400_000)),
			metrics,
		});
	}

	// 同批候选采用分位数归一化。单市场运行没有比较组，保留策略引擎的有界基准分；
	// 批量 scan 时把各维度的有界分转换为同批 percentile，再按策略权重汇总。
	if (strategy.definition.scoring.normalize === "percentile" && rows.length > 1) {
		const dimensions = Object.keys(strategy.definition.scoring.weights);
		for (const dimension of dimensions) {
			const values = rows.map((row) => row.evaluation.dimensionScores[dimension] ?? 50);
			for (let index = 0; index < rows.length; index++) {
				const value = values[index];
				const lower = values.filter((candidate) => candidate < value).length;
				const equal = values.filter((candidate) => candidate === value).length;
				const percentile = ((lower + (equal - 1) / 2) / (values.length - 1)) * 100;
				rows[index].evaluation.dimensionScores[dimension] = Math.round(percentile * 10) / 10;
			}
		}
		const weights = Object.entries(strategy.definition.scoring.weights);
		const totalWeight = weights.reduce((sum, [, weight]) => sum + weight, 0);
		for (const row of rows) {
			const score = weights.reduce((sum, [dimension, weight]) => sum + (row.evaluation.dimensionScores[dimension] ?? 50) * weight, 0) / totalWeight;
			row.evaluation.score = Math.round(score * 10) / 10;
		}
	}

	return rows
		.filter((row) => {
			const number = (name: string) => typeof row.metrics[name]?.value === "number" ? row.metrics[name].value as number : undefined;
			if (input.outcome && row.evaluation.outcome !== input.outcome) return false;
			if (input.minQrd !== undefined && (number("qualify_rank_depth") ?? -Infinity) < input.minQrd) return false;
			if (input.minNewListingShare !== undefined && (number("new_listing_share_12m") ?? -Infinity) < input.minNewListingShare) return false;
			if (input.maxCpcRatio !== undefined && (number("cpc_ratio") ?? Infinity) > input.maxCpcRatio) return false;
			return true;
		})
		.sort((a, b) => b.evaluation.score - a.evaluation.score)
		.slice(0, input.limit ?? 30)
		.map(({ metrics: _metrics, ...row }) => row);
}

export function metricDivergences(store: CompassStore, marketId: string): Array<{ metric: string; values: Array<{ source: string; value: number; capturedAt: string }>; divergence: number }> {
	const snapshots = store.snapshots
		.filter((snapshot) => snapshot.marketId === marketId)
		.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
	const latestBySource = new Map<string, MarketSnapshot>();
	for (const snapshot of snapshots) if (!latestBySource.has(snapshot.source)) latestBySource.set(snapshot.source, snapshot);
	const names = ["category_monthly_sales", "qualify_rank_depth", "cr3", "amz_share", "new_listing_share_12m"];
	const divergences: Array<{ metric: string; values: Array<{ source: string; value: number; capturedAt: string }>; divergence: number }> = [];
	for (const metric of names) {
		const values = [...latestBySource.values()]
			.map((snapshot) => ({ source: snapshot.source, value: snapshot.metrics[metric]?.value, capturedAt: snapshot.capturedAt }))
			.filter((item): item is { source: string; value: number; capturedAt: string } => typeof item.value === "number");
		if (values.length < 2) continue;
		const numbers = values.map((item) => item.value);
		const max = Math.max(...numbers.map(Math.abs));
		const divergence = max > 0 ? (Math.max(...numbers) - Math.min(...numbers)) / max : 0;
		if (divergence > 0.3) divergences.push({ metric, values, divergence: Math.round(divergence * 1000) / 1000 });
	}
	return divergences;
}

export function listStrategies(store: CompassStore): StrategyVersion[] {
	const latest = new Map<string, StrategyVersion>();
	for (const strategy of store.strategies) {
		const existing = latest.get(strategy.id);
		if (!existing || existing.version < strategy.version) latest.set(strategy.id, strategy);
	}
	return [...latest.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

interface RetroBaseline {
	candidate?: Candidate;
	decision?: DecisionLog;
	decisionStatus?: DecisionStatus;
	snapshot: MarketSnapshot;
	run?: StrategyRun;
}

function snapshotCapturedTime(snapshot: MarketSnapshot): number {
	const parsed = Date.parse(snapshot.capturedAt);
	return Number.isFinite(parsed) ? parsed : 0;
}

function findRetroBaseline(store: CompassStore, marketId: string, beforeSnapshot?: MarketSnapshot, requiredStatus?: DecisionStatus): RetroBaseline | undefined {
	const cutoff = beforeSnapshot ? snapshotCapturedTime(beforeSnapshot) : Number.POSITIVE_INFINITY;
	const candidate = store.candidates.find((item) => item.marketId === marketId);
	const decisions = store.decisionLog
		.filter((item) => item.marketId === marketId && item.type === "decision" && (!requiredStatus || item.decisionStatus === requiredStatus))
		.map((decision) => ({ decision, snapshot: decision.snapshotId ? store.snapshots.find((item) => item.id === decision.snapshotId) : undefined }))
		.filter((item): item is { decision: DecisionLog; snapshot: MarketSnapshot } => Boolean(item.snapshot && snapshotCapturedTime(item.snapshot) < cutoff))
		.sort((a, b) => b.decision.createdAt.localeCompare(a.decision.createdAt));
	const decisionAnchor = decisions[0];
	if (decisionAnchor) {
		const run = store.strategyRuns
			.filter((item) => item.marketId === marketId && item.snapshotId === decisionAnchor.snapshot.id)
			.filter((item) => !decisionAnchor.decision.strategyId || item.strategyId === decisionAnchor.decision.strategyId)
			.filter((item) => decisionAnchor.decision.strategyVersion === undefined || item.strategyVersion === decisionAnchor.decision.strategyVersion)
			.sort((a, b) => b.runAt.localeCompare(a.runAt))[0];
		return { candidate, decision: decisionAnchor.decision, decisionStatus: decisionAnchor.decision.decisionStatus ?? candidate?.decisionStatus, snapshot: decisionAnchor.snapshot, run };
	}
	if (requiredStatus) return undefined;
	const run = store.strategyRuns
		.map((item) => ({ run: item, snapshot: store.snapshots.find((snapshot) => snapshot.id === item.snapshotId) }))
		.filter((item): item is { run: StrategyRun; snapshot: MarketSnapshot } => Boolean(item.snapshot && item.run.marketId === marketId && snapshotCapturedTime(item.snapshot) < cutoff))
		.sort((a, b) => b.run.runAt.localeCompare(a.run.runAt))[0];
	return run ? { candidate, decisionStatus: candidate?.decisionStatus, snapshot: run.snapshot, run: run.run } : undefined;
}

function exactStrategyForRun(store: CompassStore, run: StrategyRun | undefined): StrategyVersion | undefined {
	if (!run) return undefined;
	return store.strategies.find((strategy) => strategy.id === run.strategyId && strategy.version === run.strategyVersion);
}

function appendRetroDecision(store: CompassStore, check: OutcomeCheck): DecisionLog {
	const baselineRun = check.baselineRunId ? store.strategyRuns.find((run) => run.id === check.baselineRunId) : undefined;
	return appendDecision(store, {
		candidateId: check.candidateId,
		marketId: check.marketId,
		type: "retro",
		conclusion: `复盘对照：${check.verdict}`,
		decisionStatus: check.decisionStatus,
		reason: `${check.id} · ${check.verdictReason}`,
		snapshotId: check.evidenceSnapshotId ?? check.baselineSnapshotId,
		strategyId: baselineRun?.strategyId,
		strategyVersion: baselineRun?.strategyVersion,
		actor: check.actor,
	});
}

function createSnapshotOutcomeCheck(
	store: CompassStore,
	baseline: RetroBaseline,
	evidence: MarketSnapshot,
	actor: string,
): OutcomeCheck {
	const strategy = exactStrategyForRun(store, baseline.run);
	let currentEvaluation: StrategyEvaluation | undefined;
	if (strategy) currentEvaluation = evaluateStrategyVersionOnSnapshot(store, evidence.marketId, strategy, baseline.run?.mode ?? "screen", evidence.id);
	const metricNames = [...new Set([...strategyReferencedMetrics(baseline.run), ...Object.keys(baseline.snapshot.metrics).filter((name) => ["price_p50", "category_monthly_sales", "waist_monthly_sales", "qualify_rank_depth", "cr3", "amz_share", "new_listing_share_12m", "main_cpc"].includes(name))])];
	const baselineMetrics: MetricMap = { ...baseline.snapshot.metrics };
	for (const rule of baseline.run?.result.rules ?? []) for (const [name, metric] of Object.entries(rule.evidence)) if (metric) baselineMetrics[name] = metric;
	const currentMetrics: MetricMap = { ...evidence.metrics };
	for (const rule of currentEvaluation?.rules ?? []) for (const [name, metric] of Object.entries(rule.evidence)) if (metric) currentMetrics[name] = metric;
	const deltas = calculateMetricDeltas(baselineMetrics, currentMetrics, metricNames);
	const replayableReject = baseline.decisionStatus === "no_go" || (!baseline.decisionStatus && baseline.run?.result.outcome === "reject");
	const staleReplayEvidence = baseline.run?.result.rules
		.filter((rule) => rule.status === "veto" || rule.status === "fail")
		.flatMap((rule) => rule.references.map((reference) => ({
			rule: rule.id,
			reference,
			baselineEvidence: rule.evidence[reference],
			currentEvidence: currentEvaluation?.rules.find((item) => item.id === rule.id)?.evidence[reference],
		})))
		.filter((item) => {
			const baselineCaptured = item.baselineEvidence ? Date.parse(item.baselineEvidence.capturedAt) : Number.NaN;
			const currentCaptured = item.currentEvidence ? Date.parse(item.currentEvidence.capturedAt) : Number.NaN;
			return !Number.isFinite(baselineCaptured) || !Number.isFinite(currentCaptured) || currentCaptured <= baselineCaptured;
		}) ?? [];
	const replay = replayableReject
		? staleReplayEvidence.length
			? { verdict: "inconclusive" as const, reason: `重放证据没有晚于 T0：${staleReplayEvidence.slice(0, 5).map((item) => `${item.rule}/${item.reference}`).join("、")}` }
			: replayOutcomeVerdict(baseline.run, currentEvaluation, deltas)
		: { verdict: "inconclusive" as const, reason: baseline.decisionStatus === "go" ? "市场快照变化不能替代 go 品经营实绩，需录入 actuals" : "waitlist/未决策对象仅记录市场变化，需人工判断" };
	const check: OutcomeCheck = {
		id: shortId("chk"),
		marketId: evidence.marketId,
		candidateId: baseline.candidate?.id,
		decisionLogId: baseline.decision?.id,
		decisionStatus: baseline.decisionStatus,
		baselineSnapshotId: baseline.snapshot.id,
		baselineRunId: baseline.run?.id,
		evidenceSnapshotId: evidence.id,
		deltas,
		verdict: replay.verdict,
		verdictReason: replay.reason,
		elapsedDays: Math.max(0, Math.floor((snapshotCapturedTime(evidence) - snapshotCapturedTime(baseline.snapshot)) / 86_400_000)),
		createdAt: nowIso(),
		actor,
	};
	store.outcomeChecks.push(check);
	appendRetroDecision(store, check);
	return check;
}

export function autoCheckImportedOutcome(store: CompassStore, marketId: string, evidenceSnapshotId: string): OutcomeCheck | undefined {
	const evidence = store.snapshots.find((snapshot) => snapshot.id === evidenceSnapshotId && snapshot.marketId === marketId);
	if (!evidence) return undefined;
	if (store.outcomeChecks.some((check) => check.marketId === marketId && check.evidenceSnapshotId === evidence.id)) return undefined;
	const baseline = findRetroBaseline(store, marketId, evidence);
	if (!baseline) return undefined;
	const elapsedDays = Math.floor((snapshotCapturedTime(evidence) - snapshotCapturedTime(baseline.snapshot)) / 86_400_000);
	if (elapsedDays < 7) return undefined;
	return createSnapshotOutcomeCheck(store, baseline, evidence, "compass-auto");
}

export function performRetroCheck(
	store: CompassStore,
	input: { marketRef?: string; candidateRef?: string; evidenceSnapshotId?: string; actor: string },
): OutcomeCheck {
	const candidate = input.candidateRef ? findCandidate(store, input.candidateRef) : undefined;
	const market = candidate ? findMarket(store, candidate.marketId) : input.marketRef ? findMarket(store, input.marketRef) : undefined;
	if (!market) throw new Error("check 需要 market_ref 或 candidate_ref");
	const evidence = input.evidenceSnapshotId
		? store.snapshots.find((snapshot) => snapshot.id === input.evidenceSnapshotId && snapshot.marketId === market.id)
		: latestSnapshotIfPresent(store, market.id);
	if (!evidence) throw new Error(`市场 ${market.id} 尚无可用于复盘的快照`);
	if (store.outcomeChecks.some((check) => check.marketId === market.id && check.evidenceSnapshotId === evidence.id)) throw new Error(`快照 ${evidence.id} 已有 OutcomeCheck，避免重复统计`);
	const baseline = findRetroBaseline(store, market.id, evidence);
	if (!baseline) throw new Error(`市场 ${market.id} 没有早于 ${evidence.id} 的决策/策略基线`);
	return createSnapshotOutcomeCheck(store, baseline, evidence, input.actor);
}

function validateActuals(actuals: OutcomeActuals): void {
	if (!["dailyUnits", "tacos", "returnRate", "netMargin"].some((field) => typeof actuals[field as keyof OutcomeActuals] === "number")) throw new Error("record_actuals 至少需要一项数字实绩");
	if (actuals.dailyUnits !== undefined && (!Number.isFinite(actuals.dailyUnits) || actuals.dailyUnits < 0)) throw new Error("daily_units 必须为非负数字");
	for (const [name, value] of [["tacos", actuals.tacos], ["return_rate", actuals.returnRate]] as const) {
		if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`${name} 必须在 0–1 之间`);
	}
	if (actuals.netMargin !== undefined && (!Number.isFinite(actuals.netMargin) || actuals.netMargin > 1)) throw new Error("net_margin 必须为不高于 1 的数字，可为负数");
}

export function recordRetroActuals(
	store: CompassStore,
	input: { candidateRef: string; actuals: OutcomeActuals; actor: string },
): OutcomeCheck {
	validateActuals(input.actuals);
	const candidate = findCandidate(store, input.candidateRef);
	if (candidate.decisionStatus !== "go") throw new Error(`候选 ${candidate.id} 当前不是 go，不能走 go 品实绩复盘`);
	const baseline = findRetroBaseline(store, candidate.marketId, undefined, "go");
	if (!baseline) throw new Error(`候选 ${candidate.id} 没有可锚定的 go 决策与基线快照`);
	const strategy = exactStrategyForRun(store, baseline.run);
	const target = Number(strategy?.definition.meta.target_daily_units ?? 10);
	const verdict = actualsOutcomeVerdict(input.actuals, Number.isFinite(target) && target > 0 ? target : 10);
	const check: OutcomeCheck = {
		id: shortId("chk"),
		marketId: candidate.marketId,
		candidateId: candidate.id,
		decisionLogId: baseline.decision?.id,
		decisionStatus: "go",
		baselineSnapshotId: baseline.snapshot.id,
		baselineRunId: baseline.run?.id,
		actuals: { ...input.actuals, note: input.actuals.note?.trim() || undefined },
		deltas: [],
		verdict: verdict.verdict,
		verdictReason: verdict.reason,
		elapsedDays: Math.max(0, Math.floor((Date.now() - snapshotCapturedTime(baseline.snapshot)) / 86_400_000)),
		createdAt: nowIso(),
		actor: input.actor,
	};
	store.outcomeChecks.push(check);
	appendRetroDecision(store, check);
	return check;
}

function evidenceMarketId(store: CompassStore, evidence: string[]): string | undefined {
	for (const id of evidence) {
		const check = store.outcomeChecks.find((item) => item.id === id);
		if (check) return check.marketId;
		const decision = store.decisionLog.find((item) => item.id === id);
		if (decision) return decision.marketId;
		const run = store.strategyRuns.find((item) => item.id === id);
		if (run) return run.marketId;
	}
	return undefined;
}

function assertLessonEvidence(store: CompassStore, evidence: string[]): string {
	const normalized = [...new Set(evidence.map((item) => item.trim()).filter(Boolean))];
	if (!normalized.length) throw new Error("Lesson 必须挂非空 evidence（chk_*/dec_*/run_*）");
	const known = new Set([...store.outcomeChecks.map((item) => item.id), ...store.decisionLog.map((item) => item.id), ...store.strategyRuns.map((item) => item.id)]);
	const unknown = normalized.filter((id) => !known.has(id));
	if (unknown.length) throw new Error(`Lesson evidence 不存在：${unknown.join("、")}`);
	return normalized.join("\n");
}

export function saveLesson(
	store: CompassStore,
	input: {
		title: string;
		detail: string;
		scope?: { categories?: string[]; keywords?: string[]; metrics?: string[] };
		evidence: string[];
		sourceRetro?: string;
		actor: string;
	},
): Lesson {
	const title = input.title.trim();
	const detail = input.detail.trim();
	if (!title || !detail) throw new Error("Lesson title 与 detail 必填");
	const evidence = assertLessonEvidence(store, input.evidence).split("\n");
	const timestamp = nowIso();
	const lesson: Lesson = {
		id: shortId("les"),
		title,
		detail,
		scope: {
			categories: input.scope?.categories?.map((item) => item.trim()).filter(Boolean),
			keywords: input.scope?.keywords?.map((item) => item.trim()).filter(Boolean),
			metrics: input.scope?.metrics?.map((item) => item.trim()).filter(Boolean),
		},
		evidence,
		status: "active",
		sourceRetro: input.sourceRetro,
		createdAt: timestamp,
		updatedAt: timestamp,
		actor: input.actor,
	};
	store.lessons.push(lesson);
	const marketId = evidenceMarketId(store, evidence);
	if (!marketId) throw new Error("Lesson evidence 无法关联市场");
	appendDecision(store, {
		candidateId: store.candidates.find((candidate) => candidate.marketId === marketId)?.id,
		marketId,
		type: "retro",
		conclusion: `保存经验卡 ${lesson.id}`,
		reason: `${lesson.title}；evidence=${evidence.join("、")}`,
		actor: input.actor,
	});
	return lesson;
}

export function retireLesson(store: CompassStore, input: { lessonRef: string; reason: string; actor: string }): Lesson {
	const reason = input.reason.trim();
	if (!reason) throw new Error("退役 Lesson 必须填写 reason");
	const lesson = store.lessons.find((item) => item.id === input.lessonRef);
	if (!lesson) throw new Error(`未找到 Lesson：${input.lessonRef}`);
	if (lesson.status === "retired") throw new Error(`Lesson ${lesson.id} 已退役`);
	lesson.status = "retired";
	lesson.retiredReason = reason;
	lesson.updatedAt = nowIso();
	lesson.actor = input.actor;
	const marketId = evidenceMarketId(store, lesson.evidence);
	if (!marketId) throw new Error(`Lesson ${lesson.id} evidence 无法关联市场`);
	appendDecision(store, {
		candidateId: store.candidates.find((candidate) => candidate.marketId === marketId)?.id,
		marketId,
		type: "retro",
		conclusion: `退役经验卡 ${lesson.id}`,
		reason,
		actor: input.actor,
	});
	return lesson;
}

export function listRetroDue(store: CompassStore, now = nowIso()): RetroDueItem[] {
	const strategy = store.strategies.filter((item) => item.id === "jingpu-daily10").sort((a, b) => b.version - a.version)[0];
	return dueRetroItems(store, now, retroDueConfig(strategy?.definition.meta));
}

// 工作台待办：组合预算态、复盘到期、深研指标与多源偏差后委托 todo.ts 纯函数推导
export function listWorkbenchTodos(store: CompassStore, now = nowIso()): WorkbenchTodo[] {
	// 非法 now 统一回退当前时钟，避免预算月界与时间类待办各用一套时钟
	const resolvedNow = Number.isFinite(Date.parse(now)) ? now : nowIso();
	const budgets = budgetStatus(store, monthPrefix(new Date(resolvedNow)));
	const retroDue = listRetroDue(store, resolvedNow);
	const deepResearchMetrics = store.candidates
		.filter((candidate) => candidate.stage === "deep_research")
		.map((candidate): { marketId: string; metrics: MetricMap } => {
			// 仅「无快照」按全缺处理；其余异常（如 store 局部损坏）照常抛出，不伪装成缺数据
			const snapshot = latestSnapshotIfPresent(store, candidate.marketId);
			return { marketId: candidate.marketId, metrics: snapshot ? buildStrategyContext(store, candidate.marketId).context.metrics : {} };
		});
	const divergentMarkets = [...new Set(store.candidates.filter((candidate) => candidate.stage !== "archived").map((candidate) => candidate.marketId))]
		.map((marketId) => ({ marketId, metrics: metricDivergences(store, marketId).map((item) => item.metric) }))
		.filter((item) => item.metrics.length > 0);
	return deriveTodos({ store, budgets, retroDue, deepResearchMetrics, divergentMarkets, now: resolvedNow });
}

export function historyTimeline(store: CompassStore, marketRef: string, candidateRef?: string): HistoryTimelineItem[] {
	const candidate = candidateRef ? findCandidate(store, candidateRef) : undefined;
	const market = candidate ? findMarket(store, candidate.marketId) : findMarket(store, marketRef);
	return buildTimeline(store, market.id, candidate?.id);
}

export function historySearch(store: CompassStore, input: Parameters<typeof searchDecisionHistory>[1]): DecisionLog[] {
	return searchDecisionHistory(store, input);
}

export function historySimilar(
	store: CompassStore,
	input: { marketRef?: string; name?: string; keywords?: string[]; category?: string; limit?: number },
): SimilarMarketResult[] {
	const market = input.marketRef ? findMarket(store, input.marketRef) : undefined;
	return similarMarkets(store, { marketId: market?.id, name: input.name, keywords: input.keywords, category: input.category, limit: input.limit });
}

export function historyOutcomes(store: CompassStore, marketRef?: string): { checks: OutcomeCheck[]; stats: OutcomeStats } {
	const marketId = marketRef ? findMarket(store, marketRef).id : undefined;
	const checks = store.outcomeChecks.filter((check) => !marketId || check.marketId === marketId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return { checks, stats: outcomeStatistics(store, checks) };
}

export function historyLessons(
	store: CompassStore,
	input: { category?: string; keywords?: string[]; metric?: string; includeRetired?: boolean; limit?: number },
): Lesson[] {
	return filterLessons(store, input);
}

export interface BacktestMarketRow {
	marketId: string;
	marketName: string;
	snapshotId: string;
	baselineOutcome: StrategyEvaluation["outcome"];
	strategyOutcome: StrategyEvaluation["outcome"];
	baselineScore: number;
	strategyScore: number;
}

export interface BacktestResult {
	strategy: string;
	baselineStrategy: string;
	matrix: Record<string, number>;
	flips: BacktestMarketRow[];
	rows: BacktestMarketRow[];
	alignment: { strategy: number | null; baseline: number | null; comparableChecks: number };
}

function desiredOutcomeForCheck(check: OutcomeCheck): "pass" | "reject" | undefined {
	if (check.verdict === "inconclusive") return undefined;
	if (check.decisionStatus === "go") return check.verdict === "validated" ? "pass" : "reject";
	if (check.decisionStatus === "no_go") return check.verdict === "validated" ? "reject" : "pass";
	return undefined;
}

export function backtestStrategies(store: CompassStore, strategyRef: string, baselineStrategyRef?: string): BacktestResult {
	const strategy = findStrategyVersion(store, strategyRef);
	const baseline = findStrategyVersion(store, baselineStrategyRef ?? "jingpu-daily10");
	const rows: BacktestMarketRow[] = [];
	for (const market of store.markets) {
		const snapshot = latestSnapshotIfPresent(store, market.id);
		if (!snapshot) continue;
		const baselineEvaluation = evaluateStrategyVersionOnSnapshot(store, market.id, baseline, "full", snapshot.id);
		const strategyEvaluation = evaluateStrategyVersionOnSnapshot(store, market.id, strategy, "full", snapshot.id);
		rows.push({
			marketId: market.id,
			marketName: market.name,
			snapshotId: snapshot.id,
			baselineOutcome: baselineEvaluation.outcome,
			strategyOutcome: strategyEvaluation.outcome,
			baselineScore: baselineEvaluation.score,
			strategyScore: strategyEvaluation.score,
		});
	}
	const matrix: Record<string, number> = {};
	for (const before of ["pass", "review", "reject"] as const) for (const after of ["pass", "review", "reject"] as const) matrix[`${before}→${after}`] = 0;
	for (const row of rows) {
		const key = `${row.baselineOutcome}→${row.strategyOutcome}`;
		matrix[key] = (matrix[key] ?? 0) + 1;
	}
	const latestComparable = new Map<string, OutcomeCheck>();
	for (const check of [...store.outcomeChecks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
		if (desiredOutcomeForCheck(check) && !latestComparable.has(check.marketId)) latestComparable.set(check.marketId, check);
	}
	let strategyCorrect = 0;
	let baselineCorrect = 0;
	let comparable = 0;
	for (const [marketId, check] of latestComparable) {
		const row = rows.find((item) => item.marketId === marketId);
		const desired = desiredOutcomeForCheck(check);
		if (!row || !desired) continue;
		comparable++;
		if (row.strategyOutcome === desired) strategyCorrect++;
		if (row.baselineOutcome === desired) baselineCorrect++;
	}
	return {
		strategy: `${strategy.id}@v${strategy.version}`,
		baselineStrategy: `${baseline.id}@v${baseline.version}`,
		matrix,
		flips: rows.filter((row) => row.baselineOutcome !== row.strategyOutcome),
		rows,
		alignment: {
			strategy: comparable ? strategyCorrect / comparable : null,
			baseline: comparable ? baselineCorrect / comparable : null,
			comparableChecks: comparable,
		},
	};
}

export function generateRetroReport(store: CompassStore, generatedAt = nowIso()): string {
	return renderRetroReport(store, generatedAt);
}

export function leadHistoryNote(store: CompassStore, marketId: string): string[] {
	const similar = similarMarkets(store, { marketId, limit: 1 })[0];
	if (!similar) return [];
	return renderHistoryNote([`与 ${similar.market.id}「${similar.market.name}」相似度 ${(similar.score * 100).toFixed(0)}%（关键词重合 ${similar.keywordOverlap}）；历史结论 ${similar.finalDecision ?? "未决策"}${similar.latestVerdict ? ` / 复盘 ${similar.latestVerdict}` : ""}。`, `先用 compass_history action=timeline market_ref=${similar.market.id} 查看证据，再决定是否重复立项。`]);
}

export function importHistoryNote(store: CompassStore, marketId: string, snapshotId: string, check?: OutcomeCheck): string[] {
	const snapshots = store.snapshots.filter((item) => item.marketId === marketId).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
	const current = store.snapshots.find((item) => item.id === snapshotId);
	const previous = snapshots.find((item) => item.id !== snapshotId && current && item.capturedAt < current.capturedAt);
	const lines: string[] = [];
	if (previous && current) {
		const deltas = calculateMetricDeltas(previous.metrics, current.metrics).filter((item) => item.baseline !== item.current).slice(0, 5);
		if (deltas.length) lines.push(`快照对照 ${previous.id}→${current.id}：${deltas.map(formatDelta).join("；")}`);
	}
	const decision = store.decisionLog.filter((item) => item.marketId === marketId && item.type === "decision").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	if (decision) lines.push(`既往决策：${decision.decisionStatus ?? "—"} · ${decision.reason}`);
	if (check) lines.push(`已生成 ${check.id}：${check.verdict} · ${check.verdictReason}${check.verdict === "challenged" ? "；建议重跑 compass_strategy_run" : ""}`);
	return renderHistoryNote(lines);
}

export function strategyHistoryNote(store: CompassStore, run: StrategyRun): string[] {
	const previous = store.strategyRuns.filter((item) => item.marketId === run.marketId && item.id !== run.id).sort((a, b) => b.runAt.localeCompare(a.runAt))[0];
	const lines: string[] = [];
	if (previous) {
		const previousVeto = previous.result.rules.filter((rule) => rule.status === "veto").length;
		const currentVeto = run.result.rules.filter((rule) => rule.status === "veto").length;
		const changedRules = run.result.rules.filter((rule) => previous.result.rules.find((item) => item.id === rule.id)?.status !== rule.status).map((rule) => `${rule.id}:${previous.result.rules.find((item) => item.id === rule.id)?.status ?? "—"}→${rule.status}`);
		lines.push(`上次 ${previous.id}→本次 ${run.id}：outcome ${previous.result.outcome}→${run.result.outcome}，Score ${previous.result.score}→${run.result.score}，veto ${previousVeto}→${currentVeto}。`);
		if (changedRules.length) lines.push(`规则变化：${changedRules.slice(0, 5).join("；")}`);
	}
	const stats = outcomeStatistics(store);
	const accuracy = stats.byStrategy.find((item) => item.strategy === `${run.strategyId}@v${run.strategyVersion}`);
	if (accuracy) lines.push(`该策略版本历史准确率 ${accuracy.accuracy === null ? "—" : `${(accuracy.accuracy * 100).toFixed(0)}%`}（validated ${accuracy.validated} / challenged ${accuracy.challenged} / inconclusive ${accuracy.inconclusive}）。`);
	return renderHistoryNote(lines);
}

export function decisionHistoryNote(store: CompassStore, candidate: Candidate): string[] {
	const market = store.markets.find((item) => item.id === candidate.marketId);
	const chain = store.decisionLog.filter((item) => item.candidateId === candidate.id);
	const lines = [`决策链：${chain.length} 条留痕；当前 ${candidate.decisionStatus ?? "未决策"}，stage=${candidate.stage}。`];
	if (market) {
		const peers = similarMarkets(store, { marketId: market.id, limit: 3 });
		const peerChecks = peers.flatMap((peer) => store.outcomeChecks.filter((check) => check.marketId === peer.market.id && check.decisionStatus === "go" && check.verdict !== "inconclusive"));
		if (peerChecks.length) lines.push(`相似市场 go 品实绩达成率 ${(peerChecks.filter((check) => check.verdict === "validated").length / peerChecks.length * 100).toFixed(0)}%（${peerChecks.length} 条可判定复盘）。`);
		for (const lesson of matchingLessonsForMarket(store, market.id, 2)) lines.push(`命中经验 ${lesson.id}：${lesson.title}（evidence: ${lesson.evidence.slice(0, 3).join("、")}）`);
	}
	return renderHistoryNote(lines);
}

export function generateMarketReport(
	store: CompassStore,
	marketRef: string,
	strategyRef = "jingpu-daily10",
): GeneratedReport {
	const market = findMarket(store, marketRef);
	const snapshot = latestSnapshot(store, market.id);
	const strategy = findStrategyVersion(store, strategyRef);
	const { context } = buildStrategyContext(store, market.id);
	context.targetMonthlyUnits = Number(strategy.definition.meta.monthly_units_q ?? 300);
	const evaluation = evaluateStrategy(strategy.definition, context, "full");
	const candidate = store.candidates.find((item) => item.marketId === market.id);
	const decisions = store.decisionLog.filter((item) => item.marketId === market.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const risk = store.riskRecords.filter((item) => item.marketId === market.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	const review = store.reviewAnalyses.filter((item) => item.marketId === market.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	const profit = store.profitEstimates.filter((item) => item.marketId === market.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	const attributedCostCny = store.costEvents.filter((item) => item.marketId === market.id).reduce((sum, item) => sum + item.amountCny, 0);
	const fusedBudgetSources = budgetStatus(store).filter((pool) => pool.state === "fused").map((pool) => pool.source);
	const data: MarketReportData = {
		market,
		snapshot,
		strategy,
		metrics: context.metrics,
		evaluation,
		candidate,
		risk,
		review,
		profit,
		decisions,
		outcomeChecks: store.outcomeChecks.filter((item) => item.marketId === market.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
		lessons: matchingLessonsForMarket(store, market.id),
		divergences: metricDivergences(store, market.id),
		attributedCostCny,
		fusedBudgetSources,
	};
	return renderMarketReport(data);
}

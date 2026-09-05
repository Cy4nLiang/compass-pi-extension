import { createHash, randomUUID } from "node:crypto";
import { compareSnapshotRecency, compareSnapshotRecencyDesc, DEFAULT_BUDGET_POOLS, DEFAULT_STRATEGY_ID, DEFAULT_STRATEGY_YAML, isNewerSnapshot } from "./defaults.ts";
import { profitMetrics } from "./economics.ts";
import {
	calculateMetricDeltas,
	dueRetroItems,
	filterLessons,
	formatDelta,
	matchingLessonsForMarket,
	isComparableCheck,
	latestComparableChecks,
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
	type RetroDueConfig,
	type RetroDueItem,
	type RetroReportOptions,
	type SimilarMarketResult,
} from "./history.ts";
import { calculateMarketMetrics, targetDependentMetrics, TARGET_DEPENDENT_METRIC_NAMES } from "./metrics.ts";
import { renderMarketReport, type GeneratedReport, type MarketReportData } from "./report.ts";
import { evaluateStrategy, parseStrategyYaml, slugify, strategyTargetDailyUnits, strategyTargetMonthlyUnits, strategyToYaml, type StrategyContext } from "./strategy.ts";
import { deriveTodos, divergenceWatermarks, isResolvableTodoKind, missingDeepResearchFields, stageEntryTimes } from "./todo.ts";
import { TODO_RESOLUTION_STATUS_LABELS } from "./types.ts";
import type {
	BudgetPool,
	Candidate,
	CandidateStage,
	CompassStore,
	CostEvent,
	DecisionLog,
	DecisionStatus,
	DecisionTrigger,
	GateOutcome,
	Lesson,
	Market,
	MarketSnapshot,
	MetricEvidence,
	MetricMap,
	OutcomeActuals,
	OutcomeCheck,
	ParsedMarketCsv,
	PolicyFlag,
	ProfitEstimate,
	ProfitInput,
	ProfitResult,
	ResolvableTodoKind,
	ReviewAnalysis,
	ReviewTheme,
	RiskEvidenceItem,
	RiskRecord,
	RiskStatus,
	SeasonFlag,
	StrategyEvaluation,
	StrategyMode,
	StrategyRun,
	StrategyVersion,
	TodoEvidenceRef,
	TodoResolution,
	TodoResolutionAttempt,
	TodoResolutionBasis,
	TodoResolutionStatus,
	TodoResolutionVerdict,
	WorkbenchTodo,
} from "./types.ts";

function nowIso(): string {
	return new Date().toISOString();
}

// 默认策略 id 唯一定义在 defaults.ts（DEFAULT_STRATEGY_ID）；本文件不再复制字面量。
// 完整 definition 只在缺省注入时 fresh parse，避免共享可变对象进入多个 store 实例
// （ensureDefaults 会被每次读库与 MCP gate 调用）

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
	// 待办处理记录：可选顶层集合，回填后下游（派生/工具/Web）可无条件按数组消费
	if (!Array.isArray(store.todoResolutions)) {
		store.todoResolutions = [];
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
		if (isNewerSnapshot(snapshot, latest)) latest = snapshot;
	}
	return latest;
}

export function latestSnapshot(store: CompassStore, marketId: string): MarketSnapshot {
	const snapshot = latestSnapshotIfPresent(store, marketId);
	if (!snapshot) throw new Error(`市场 ${marketId} 尚无数据快照`);
	return snapshot;
}

// 策略引用先按 id 精确解析：id 才是策略链的唯一身份。
// 一旦退回显示名 / meta.name 匹配，必须按 id 分组后只在唯一一条链内取版本——
// 跨链拉平取 max(version) 会让别人把 display_name 改成同名就劫持默认引用。
function resolveStrategyChain(store: CompassStore, reference: string): StrategyVersion[] {
	const byId = store.strategies.filter((strategy) => strategy.id === reference);
	if (byId.length) return byId;
	const normalized = normalizeLookup(reference);
	const chains = new Map<string, StrategyVersion[]>();
	for (const strategy of store.strategies) {
		if (normalizeLookup(strategy.name) !== normalized && normalizeLookup(strategy.definition?.meta?.name) !== normalized) continue;
		const bucket = chains.get(strategy.id);
		if (bucket) bucket.push(strategy);
		else chains.set(strategy.id, [strategy]);
	}
	if (chains.size > 1) throw new Error(`策略引用“${reference}”不唯一：${[...chains.keys()].join("、")}；请改用 strategy_id 精确指定`);
	return [...chains.values()][0] ?? [];
}

// 「取某策略的最高版本」的唯一实现。读侧总览类调用（Gate 文案、复盘到期）用它，
// 缺策略时回退默认口径而不是崩掉整块界面；需要硬失败的调用点用下面的 latestStrategy。
export function latestStrategyIfPresent(store: CompassStore, strategyId = DEFAULT_STRATEGY_ID): StrategyVersion | undefined {
	const chain = resolveStrategyChain(store, strategyId);
	return chain.length ? chain.reduce((latest, item) => (item.version > latest.version ? item : latest)) : undefined;
}

export function latestStrategy(store: CompassStore, strategyId = DEFAULT_STRATEGY_ID): StrategyVersion {
	const strategy = latestStrategyIfPresent(store, strategyId);
	if (!strategy) throw new Error(`未找到策略：${strategyId}`);
	return strategy;
}

export function findStrategyVersion(store: CompassStore, reference = DEFAULT_STRATEGY_ID): StrategyVersion {
	const versionMatch = reference.match(/^(.*?)(?:@v|:v?)(\d+)$/u);
	if (!versionMatch) return latestStrategy(store, reference);
	const [, rawId, rawVersion] = versionMatch;
	const version = Number(rawVersion);
	const strategy = resolveStrategyChain(store, rawId).find((item) => item.version === version);
	if (strategy) return strategy;
	// 策略名字本身就以 :N / @vN 收尾时（clone 出来的「价格战:2」就是这样），后缀不是版本号：
	// 回退到整串按名字取最新版，保证 findStrategyVersion 是 latestStrategy 的严格超集，
	// 各入口从 latestStrategy 换过来才不会丢原有的可查性。
	const byWholeName = latestStrategyIfPresent(store, reference);
	if (byWholeName) return byWholeName;
	throw new Error(`未找到策略版本：${reference}`);
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
	// 早于现有最新的补录快照不会成为「最新」：所有读面（看板/档案/报告/粗筛）继续用那份更新的，
	// 而导入成功页只展示本次快照 —— 不显式告警运营会以为补录已生效
	const previousLatest = latestSnapshotIfPresent(store, market.id);
	market.keywords = [...new Set([...market.keywords, ...(input.keywords ?? []), ...input.parsed.keywords.map((item) => item.keyword)])];
	market.category ??= dominantCategory(input.parsed);
	market.updatedAt = timestamp;

	const defaultStrategy = latestStrategy(store);
	const targetMonthlyUnits = strategyTargetMonthlyUnits(defaultStrategy.definition);
	const metrics = calculateMarketMetrics({
		listings: input.parsed.listings,
		keywords: input.parsed.keywords,
		source: input.parsed.source,
		capturedAt: input.capturedAt,
		targetMonthlyUnits,
	});
	const warnings = [...input.parsed.warnings];
	if (previousLatest && compareSnapshotRecency({ capturedAt: input.capturedAt, importedAt: timestamp }, previousLatest) < 0) {
		// 两边同一天时只回显日期会写成「2026-09-04 早于 2026-09-04」——排序是按完整时间戳比的
		// （纯日期归一到 UTC 零点），日期相同就把时分秒露出来，运营才看得出为什么被判旧、该怎么改
		const sameDay = input.capturedAt.slice(0, 10) === previousLatest.capturedAt.slice(0, 10);
		const shown = (iso: string) => (sameDay ? iso : iso.slice(0, 10));
		warnings.push(`本次快照采集于 ${shown(input.capturedAt)}，早于该市场现有最新快照 ${previousLatest.id}（${shown(previousLatest.capturedAt)}）：看板、市场档案、五维报告与粗筛仍以那份更新的快照为准`);
	}
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
		warnings,
	};
	store.snapshots.push(snapshot);

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
		// 例行导入的默认粗筛不是人工处置：标记后 todo.ts 才不会把它当成 challenged 的处置留痕
		trigger: "auto_import",
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
	seasonFlag: SeasonFlag;
	policyFlag: PolicyFlag;
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
		seasonFlag: SeasonFlag;
		policyFlag: PolicyFlag;
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
	return latestBy(items.filter((item) => item.marketId === marketId), (item) => item.createdAt);
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

// 明细缺失时的退化：只有确认冻结值就是按当前 q 算的才敢沿用，否则一律判缺失。
// 领域不变式「缺失硬指标 → 结论为 review，绝不把缺数据伪装成 pass」：口径不明的旧值
// 不是「数据」，是「另一个口径的数据」，拿来充当当前口径的结论比缺数据更危险。
function recomputeTargetDependentMetric(
	snapshot: MarketSnapshot,
	name: (typeof TARGET_DEPENDENT_METRIC_NAMES)[number],
	units: number,
): MetricEvidence {
	const frozen = snapshot.metrics[name];
	const listings = snapshot.listings;
	if (listings.length === 0) {
		if (frozen && frozen.targetMonthlyUnits === units) return frozen;
		return {
			value: null,
			source: snapshot.source,
			capturedAt: snapshot.capturedAt,
			confidence: 0,
			note: `快照明细缺失，无法按目标月销 ${units} 重算；导入时冻结口径${frozen?.targetMonthlyUnits === undefined ? "未知" : `为 ${frozen.targetMonthlyUnits}`}，按缺数据处理`,
		};
	}
	const fresh = targetDependentMetrics({
		listings,
		source: snapshot.source,
		capturedAt: snapshot.capturedAt,
		targetMonthlyUnits: units,
	})[name];
	// 口径变过时在 note 里留一行对照，报告与工作台能看出「历史是按哪个 q 冻结的」
	if (frozen && frozen.targetMonthlyUnits !== units && typeof frozen.value === "number") {
		return { ...fresh, note: `${fresh.note}（导入时按 q=${frozen.targetMonthlyUnits ?? "未知"} 冻结为 ${frozen.value}）` };
	}
	return fresh;
}

// q 相关指标不能沿用导入时冻结的值：调过目标月销之后冻结值的口径就过期了，会同时造出
// 「标签写 QRD(800) 却显示 q=300 的 22」「规则 evidence 与自己的表达式求值不一致」
// 「同一份数据被判成 81.8% 多源偏差并派生待办」三种假象（M15）。
// 懒 getter：只消费其它指标的路径（待办派生的深研四项、预算面）仍然一次盘都不读。
// **但 q 相关指标本身一读就会触发 sidecar**：`metricDivergences` 为了同口径比较会对多来源市场
// 逐快照取这些值，那条路径经 listWorkbenchTodos 一直通到 /api/overview 与 /api/todos。
// 单来源市场被 `latestBySource.size < 2` 提前退出挡住，所以「读端点零明细读」只对单来源成立。
function installTargetDependentMetrics(snapshot: MarketSnapshot, metrics: MetricMap, units: number): void {
	for (const name of TARGET_DEPENDENT_METRIC_NAMES) {
		let cached: MetricEvidence | undefined;
		Object.defineProperty(metrics, name, {
			enumerable: true,
			configurable: true,
			get: () => (cached ??= recomputeTargetDependentMetric(snapshot, name, units)),
			// 与 store.ts 的懒 listings/keywords 同形：留 setter，调用方覆盖指标时不至于在严格模式抛错
			set: (value: MetricEvidence) => { cached = value; },
		});
	}
}

export function buildStrategyContextForSnapshot(
	store: CompassStore,
	marketId: string,
	snapshotId?: string,
	// 默认取默认策略的 q：与 web/data.ts 的 QRD(units) 标签同源，标签与值天然一致。
	// 用别的策略评估时由调用方显式传入该策略的 q。
	units: number = targetMonthlyUnits(store),
): { snapshot: MarketSnapshot; context: StrategyContext } {
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
	// 必须在全部 Object.assign 之后装：往只读属性上 assign 会在严格模式抛错
	installTargetDependentMetrics(snapshot, metrics, units);
	// listings 用惰性 getter 委托：只有策略表达式真正引用榜单数据时才触发快照明细的磁盘读；
	// 只消费**非 q 相关** metrics 的路径（市场档案、待办推导）不再产生无谓 I/O；
	// q 相关指标走上面的懒重算，多来源市场的待办推导仍会读到 sidecar（见该函数注释）。
	// enumerable:false 与 store.ts 的快照懒属性对齐：spread / JSON.stringify 不会静默触发读盘
	// q 必须同时落到两处：installTargetDependentMetrics 管 QRD 一类「按目标月销重算」的指标，
	// 而 calculateDimensionScores 的 demand 维度（waistSales / (q*2)）读的是 context 上这个字段。
	// 改动前是三个调用点各自 `context.targetMonthlyUnits = Number(meta.monthly_units_q ?? 300)`，
	// 收敛进构造点时漏掉了赋值，于是所有 q ≠ 300 的策略都按 300 归一、Score 全错。
	const context = Object.defineProperty({ metrics, targetMonthlyUnits: units } as StrategyContext, "listings", {
		enumerable: false,
		configurable: true,
		get: () => snapshot.listings,
	});
	return { snapshot, context };
}

export function buildStrategyContext(store: CompassStore, marketId: string, units?: number): { snapshot: MarketSnapshot; context: StrategyContext } {
	return buildStrategyContextForSnapshot(store, marketId, undefined, units);
}

export function mainCpcForMarket(store: CompassStore, marketId: string): number | undefined {
	const snapshot = latestSnapshotIfPresent(store, marketId);
	const value = snapshot?.metrics.main_cpc?.value;
	// 0 同样按缺失处理：快照 metrics 是导入时算好落库的，metrics.ts 的过滤追溯不到存量快照，
	// 这里兜住老数据，避免 0 被当默认 cpc 灌进利润测算。
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// 运营填 0 与不填是同一个意思（「我没有主词 CPC」），两者都回落到市场最新快照的主词 CPC。
// 回落不到时保留原样：0 会让 estimateProfit 给出「主词 CPC 为 0，按缺数据处理」这条更具体的
// 警告，比统一折成 undefined 后只说「未提供主词 CPC」更能指向运营实际做过的操作。
export function resolveProfitCpc(store: CompassStore, marketId: string, providedCpc?: number): number | undefined {
	if (providedCpc !== undefined && providedCpc > 0) return providedCpc;
	return mainCpcForMarket(store, marketId) ?? providedCpc;
}

export function runStrategy(
	store: CompassStore,
	input: { marketRef: string; strategyRef?: string; mode: StrategyMode; actor: string; trigger?: DecisionTrigger },
): StrategyRun {
	const market = findMarket(store, input.marketRef);
	const strategy = findStrategyVersion(store, input.strategyRef);
	// q 在建 context 时就要给：q 相关指标按它在读侧重算，事后赋值来不及
	const { snapshot, context } = buildStrategyContext(store, market.id, strategyTargetMonthlyUnits(strategy.definition));
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
		// 触发来源随日志落库：todo.ts 靠它区分「例行导入自动粗筛」与「人工重跑」
		trigger: input.trigger,
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
	mode: StrategyMode = "screen",
	snapshotId?: string,
): StrategyEvaluation {
	const { context } = buildStrategyContextForSnapshot(store, marketId, snapshotId, strategyTargetMonthlyUnits(strategy.definition));
	return evaluateStrategy(strategy.definition, context, mode);
}

export function evaluateMarketWithoutPersisting(
	store: CompassStore,
	marketId: string,
	strategyRef = DEFAULT_STRATEGY_ID,
	mode: StrategyMode = "screen",
): StrategyEvaluation {
	return evaluateStrategyVersionOnSnapshot(store, marketId, findStrategyVersion(store, strategyRef), mode);
}

export function saveStrategyVersion(
	store: CompassStore,
	input: { yaml: string; actor: string; changeNote?: string; expectedId?: string },
): StrategyVersion {
	const definition = parseStrategyYaml(input.yaml);
	// 策略归属只由 meta.name 决定。slugify 有损（大小写、空格、标点都会被抹平），
	// 不同的 meta.name 可能落到同一个 id；直接按 id 续版本会把别人的策略悄悄改掉，
	// 默认引用、QRD 口径、复盘周期随之全部切换，而历史 run 的 strategyId 不变、极难察觉。
	const id = slugify(definition.meta.name);
	if (input.expectedId !== undefined && input.expectedId !== id) {
		throw new Error(`策略归属冲突：strategy_id“${input.expectedId}”与 meta.name“${definition.meta.name}”推导出的 id“${id}”不一致；策略归属由 meta.name 决定，只改显示名请改 meta.display_name，要新建策略请换 meta.name`);
	}
	const latest = store.strategies.filter((strategy) => strategy.id === id).sort((a, b) => b.version - a.version)[0];
	if (latest && normalizeLookup(latest.definition?.meta?.name) !== normalizeLookup(definition.meta.name)) {
		throw new Error(`策略 id 冲突：meta.name“${definition.meta.name}”与已存在的“${latest.definition?.meta?.name}”生成同一个 id“${id}”，保存会被当成同一条策略的新版本；请换一个 meta.name（显示名请用 meta.display_name 单独设置）`);
	}
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
	const source = findStrategyVersion(store, input.sourceRef);
	const definition = structuredClone(source.definition);
	definition.meta.name = slugify(input.newName);
	definition.meta.display_name = input.newName;
	// 复制只允许开新链：撞上已有 id 就变成往别人的策略上追加版本，直接拒绝而不是静默并链
	const id = slugify(definition.meta.name);
	if (store.strategies.some((strategy) => strategy.id === id)) {
		throw new Error(`策略名“${input.newName}”与已存在的策略 id“${id}”冲突：复制只会新建策略，不会往旧链追加版本；请换一个名字`);
	}
	return saveStrategyVersion(store, {
		yaml: strategyToYaml(definition),
		actor: input.actor,
		changeNote: input.changeNote ?? `复制自 ${source.id}@v${source.version}`,
	});
}

export function targetMonthlyUnits(store: CompassStore): number {
	return strategyTargetMonthlyUnits(latestStrategyIfPresent(store)?.definition);
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
		snapshotId: latestSnapshotIfPresent(store, candidate.marketId)?.id,
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
		// snapshotId 与 strategyRunId 可以指向不同快照（中途 run_screen=false 导入过），
		// 复盘要重放的是这条 run，所以把它本身记下来，不再靠「同快照」反查
		strategyRunId: latestRun?.id,
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

// 预算结算月 = **UTC 月**（`YYYY-MM`）。budgetStatus / 熔断拦截 / 待办抑制水位 / Web 总览 /
// Web 预算页五个面共用这一个口径，绝不能改用本地时间：CostEvent.createdAt 存的是 UTC ISO，
// 拿本地月去 startsWith 匹配，会在 UTC+8 的 00:00–08:00 之间把上月事件算进本月（反之亦然）。
// 运营口径：UTC+8 下每月 1 日 08:00 整清零，凌晨 0–8 点的调用仍记上月。
export function budgetMonth(date = new Date()): string {
	return date.toISOString().slice(0, 7);
}

export function budgetStatus(
	store: CompassStore,
	month = budgetMonth(),
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
		throw new Error(`预算熔断：${input.source} 本月（${budgetMonth()} UTC）已用 ¥${spent}，本次 ¥${input.amountCny} 将超过 ¥${pool.monthlyLimitCny}`);
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

// 未到达服务端的 adapter 错误码（pi-mcp-adapter 2.27.0 穷举 details.error 取值得出）：
// 这些分支都在 client.callTool 发出请求之前就返回，Sorftime 不会扣点。名单之外的一切
// （含 call_failed / aborted / url_elicitation_required）一律计费——
// call_failed 覆盖 30 秒超时（SDK 先 send，再发 notifications/cancelled 并 reject）、
// 服务端 JSON-RPC 错误应答、发出后传输中断。
// aborted **不是**「一定发生在 callTool 之后」——adapter 的连接期分支也会以 aborted 收场，
// 那种情况请求根本没发出去、不该计费。这里仍把它留在计费面是**刻意的取舍**：details 里没有
// 任何字段能把两种 aborted 区分开，而方向上宁多勿漏（见下一句）。
// 所以看到连接期 aborted 的反例时，不要据此把 aborted 挪进拒绝名单——那是漏计方向。
// 方向：多计一次让 monthly_call_limit 熔断提前触发（保守），少计让熔断滞后（危险），
// 故按「花钱保护宁多勿漏」取拒绝名单而非白名单。
const NON_BILLABLE_MCP_ERRORS = new Set([
	"auth_required",
	"not_authenticated",
	"server_unavailable",
	"server_not_connected",
	"not_connected",
	"server_backoff",
	"server_disabled",
	"server_not_found",
	"connect_failed",
	"tool_not_found",
	"tool_not_found_after_reconnect",
	"ambiguous_tool",
	"native_tool",
	"approval_denied",
	"approval_required",
	"not_initialized",
	"init_failed",
	"init_timeout",
]);

// tool_result 计量分类器：识别 MCP 调用结果并判定是否计费。
// 计费口径（spec 4.2.5）：已到达服务端的调用消耗点数——成功、服务端业务错误
// （tool_error）、以及请求发出后才失败的 call_failed / aborted 都计；只有
// NON_BILLABLE_MCP_ERRORS 里「请求根本没发出去」的失败不计。
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
	const billable = record.error === undefined || !NON_BILLABLE_MCP_ERRORS.has(record.error);
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

// 导出给 index.ts 的 strict 档确认单判定用：与熔断门解析同一个「这次调用打向哪个池」，
// 两边各写一份迟早分裂成「熔断按 A 池算、确认单按 B 池算」
export function mcpCallTargetServers(store: CompassStore, call: { toolName: string; input?: Record<string, unknown> }): string[] {
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

// tool_call 拦截判定：只读，不写 store。两类拦截——① 预算池被禁用（enabled=false，
// 手册定义「当前不允许使用」，不看上限也不看熔断）；② 「配置了上限」（monthlyCallLimit 或
// monthlyLimitCny>0）且当月已熔断。默认 sorftime 池（enabled、¥0、无次数上限）
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
		// 禁用 = 当前不允许使用（手册预算状态表、recordCost 同口径）：先于「配了上限才拦」
		// 的前提判定，否则默认零成本池（sorftime ¥0、无次数上限）被禁用后依然放行
		if (!pool.enabled) {
			return {
				server,
				reason: `${server} 预算池已禁用：当前不允许调用该数据源。恢复：compass_budget configure source=${server} enabled=true。`,
			};
		}
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
			reason: `${server} 预算已熔断：${callsText}（${amountText}）。解除：compass_budget configure source=${server} 提高 monthly_call_limit（0=清除）或 monthly_limit_cny；否则 UTC 次月自动恢复（北京时间次月 1 日 08:00 清零）。`,
		};
	}
	return undefined;
}

export interface MarketScanResult {
	market: Market;
	snapshot: MarketSnapshot;
	candidate?: Candidate;
	evaluation: StrategyEvaluation;
	// 按本次扫描所用策略的 q 重算的 QRD：调用方不要再去读 snapshot.metrics 里的冻结值
	qrd: number | null;
	ageDays: number;
}

export function scanMarkets(
	store: CompassStore,
	input: {
		query?: string;
		strategyRef?: string;
		outcome?: GateOutcome;
		minQrd?: number;
		minNewListingShare?: number;
		maxCpcRatio?: number;
		limit?: number;
	},
): MarketScanResult[] {
	const query = input.query ? normalizeLookup(input.query) : undefined;
	const strategy = findStrategyVersion(store, input.strategyRef);
	const rows: Array<MarketScanResult & { metrics: MetricMap }> = [];
	for (const market of store.markets) {
		if (query && !normalizeLookup(`${market.name} ${market.keywords.join(" ")} ${market.category ?? ""}`).includes(query)) continue;
		const snapshot = latestSnapshotIfPresent(store, market.id);
		if (!snapshot) continue;
		const metrics = buildStrategyContext(store, market.id, strategyTargetMonthlyUnits(strategy.definition)).context.metrics;
		const qrd = metrics.qualify_rank_depth?.value;
		rows.push({
			market,
			snapshot,
			candidate: store.candidates.find((candidate) => candidate.marketId === market.id),
			evaluation: evaluateStrategyVersionOnSnapshot(store, market.id, strategy, "screen"),
			ageDays: Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.capturedAt)) / 86_400_000)),
			qrd: typeof qrd === "number" ? qrd : null,
			metrics,
		});
	}

	// 同批候选采用分位数归一化。单市场运行没有比较组，保留策略引擎的有界基准分；
	// 批量 scan 时把各维度的有界分转换为同批 percentile，再按策略权重汇总。
	if (strategy.definition.scoring.normalize === "percentile" && rows.length > 1) {
		const dimensions = Object.keys(strategy.definition.scoring.weights);
		for (const dimension of dimensions) {
			const values = rows.map((row) => Object.hasOwn(row.evaluation.dimensionScores, dimension) ? row.evaluation.dimensionScores[dimension] : 50);
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
			const score = weights.reduce((sum, [dimension, weight]) => sum + (Object.hasOwn(row.evaluation.dimensionScores, dimension) ? row.evaluation.dimensionScores[dimension] : 50) * weight, 0) / totalWeight;
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
		.sort(compareSnapshotRecencyDesc);
	const latestBySource = new Map<string, MarketSnapshot>();
	for (const snapshot of snapshots) if (!latestBySource.has(snapshot.source)) latestBySource.set(snapshot.source, snapshot);
	// 单来源不构成多源偏差：提前退出，顺带保证单来源市场不会为下面的重算白读快照明细
	if (latestBySource.size < 2) return [];
	// q 相关指标的冻结值各自带着导入当时的 q，直接比会把「调过目标月销」误报成来源打架
	// （M15：同一份数据被判成 81.8% 偏差并派生 metric_divergence 待办）。快照本身不记录 q，
	// 无法靠元数据配对「同 q 的两份」，因此统一换算到当前 q ——同口径由构造保证。
	// 重算不出来的快照（明细缺失 → null）会被下面的 typeof 过滤掉，不会伪造数值参与比较。
	const units = targetMonthlyUnits(store);
	const recomputed = new Map<string, MetricMap>();
	const metricValue = (snapshot: MarketSnapshot, metric: string): MetricEvidence["value"] | undefined => {
		if (!(TARGET_DEPENDENT_METRIC_NAMES as readonly string[]).includes(metric)) return snapshot.metrics[metric]?.value;
		let metrics = recomputed.get(snapshot.id);
		if (!metrics) {
			metrics = buildStrategyContextForSnapshot(store, marketId, snapshot.id, units).context.metrics;
			recomputed.set(snapshot.id, metrics);
		}
		return metrics[metric]?.value;
	};
	const names = ["category_monthly_sales", "qualify_rank_depth", "cr3", "amz_share", "new_listing_share_12m"];
	const divergences: Array<{ metric: string; values: Array<{ source: string; value: number; capturedAt: string }>; divergence: number }> = [];
	for (const metric of names) {
		const values = [...latestBySource.values()]
			.map((snapshot) => ({ source: snapshot.source, value: metricValue(snapshot, metric), capturedAt: snapshot.capturedAt }))
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

// 决策锚定「决策当下的最新快照」，而 strategyId/Version 抄自 candidate.latestStrategyRunId：
// 中间只要有一次 run_screen=false 的导入，两者就落在不同快照上，「同快照 run」永远找不到，
// 该市场从此复盘恒为 inconclusive（归入「无策略锚点」，noGoAccuracyRate/falseKillRate 恒 null）。
// 三级解析：① 同快照 run（原语义）② 决策自己记下的 strategyRunId ③ 同策略版本、不晚于决策的最新 run。
// ②③ 都不是启发式：decision.strategyId/Version 本来就是从那条 run 上抄下来的，这里只是把它找回来。
// decision.strategyId 为空 ⇒ 决策落定时该候选从未跑过策略，没有可重放的否决前提，
// 宁可保持 inconclusive 也不去捡一条无关的 run（领域不变式：缺证据只能 inconclusive）。
// 「最新一条」的并列规则：时间字符串相等时取**后插入**的那条。
// 全部调用点传进来的数组都必须是 store 数组的 filter/map 结果——那样才保持追加顺序、索引即时间序。
// 新增调用点前先确认这一条：先 sort 过的、或来自 Map/Set 迭代的数组会让这个前提失效。
// 不用 sort(...)[0]：sort 稳定，比较返回 0 时保持原序，[0] 反而会取到并列里最早的那条；
// 也不用 id 破并列——shortId 是随机 UUID，给出的顺序稳定但与时间无关。
function latestBy<T>(items: readonly T[], timeOf: (item: T) => string): T | undefined {
	let best: T | undefined;
	let bestTime = "";
	for (const item of items) {
		const time = timeOf(item);
		if (best === undefined || time >= bestTime) {
			best = item;
			bestTime = time;
		}
	}
	return best;
}

function decisionBaselineRun(store: CompassStore, decision: DecisionLog, anchorSnapshot: MarketSnapshot, cutoff: number): StrategyRun | undefined {
	const sameStrategy = (run: StrategyRun): boolean =>
		(!decision.strategyId || run.strategyId === decision.strategyId) &&
		(decision.strategyVersion === undefined || run.strategyVersion === decision.strategyVersion);
	const marketRuns = store.strategyRuns.filter((run) => run.marketId === decision.marketId && sameStrategy(run));
	const exact = latestBy(marketRuns.filter((run) => run.snapshotId === anchorSnapshot.id), (run) => run.runAt);
	if (exact) return exact;
	if (!decision.strategyId) return undefined;
	const replayable = marketRuns
		.filter((run) => run.runAt <= decision.createdAt)
		.map((run) => ({ run, snapshot: store.snapshots.find((item) => item.id === run.snapshotId) }))
		.filter((item): item is { run: StrategyRun; snapshot: MarketSnapshot } => Boolean(item.snapshot && snapshotCapturedTime(item.snapshot) < cutoff));
	const pinned = decision.strategyRunId ? replayable.find((item) => item.run.id === decision.strategyRunId) : undefined;
	return (pinned ?? latestBy(replayable, (item) => item.run.runAt))?.run;
}

function findRetroBaseline(store: CompassStore, marketId: string, beforeSnapshot?: MarketSnapshot, requiredStatus?: DecisionStatus): RetroBaseline | undefined {
	const cutoff = beforeSnapshot ? snapshotCapturedTime(beforeSnapshot) : Number.POSITIVE_INFINITY;
	const candidate = store.candidates.find((item) => item.marketId === marketId);
	const decisions = store.decisionLog
		.filter((item) => item.marketId === marketId && item.type === "decision" && (!requiredStatus || item.decisionStatus === requiredStatus))
		.map((decision) => ({ decision, snapshot: decision.snapshotId ? store.snapshots.find((item) => item.id === decision.snapshotId) : undefined }))
		.filter((item): item is { decision: DecisionLog; snapshot: MarketSnapshot } => Boolean(item.snapshot && snapshotCapturedTime(item.snapshot) < cutoff));
	const decisionAnchor = latestBy(decisions, (item) => item.decision.createdAt);
	if (decisionAnchor) {
		const run = decisionBaselineRun(store, decisionAnchor.decision, decisionAnchor.snapshot, cutoff);
		// 回退命中时基线快照跟着 run 走：baselineRunId 与 baselineSnapshotId 必须描述同一份证据，
		// 否则 deltas 的基线列会把两个采集时点混在一起，elapsedDays 也会与重放的规则错位
		const snapshot = run && run.snapshotId !== decisionAnchor.snapshot.id
			? store.snapshots.find((item) => item.id === run.snapshotId) ?? decisionAnchor.snapshot
			: decisionAnchor.snapshot;
		return { candidate, decision: decisionAnchor.decision, decisionStatus: decisionAnchor.decision.decisionStatus ?? candidate?.decisionStatus, snapshot, run };
	}
	if (requiredStatus) return undefined;
	const runsWithSnapshot = store.strategyRuns
		.map((item) => ({ run: item, snapshot: store.snapshots.find((snapshot) => snapshot.id === item.snapshotId) }))
		.filter((item): item is { run: StrategyRun; snapshot: MarketSnapshot } => Boolean(item.snapshot && item.run.marketId === marketId && snapshotCapturedTime(item.snapshot) < cutoff));
	const run = latestBy(runsWithSnapshot, (item) => item.run.runAt);
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
	// 回退基线（run 的快照 ≠ 决策锚定的快照）多了一层不确定：run 的规则状态是 T_run 的，
	// 未必还是决策当下的前提。把同一策略版本在决策锚定快照上重算一遍——基线的 veto/fail
	// 规则若在那时就已经 pass，说明这次 no_go 根本不是这条 run 否决的（运营是为别的理由
	// 否决的），再拿它重放会把「无法判定」讲成「错杀」，直接污染 falseKillRate 与规则归因。
	// 只有「明确转 pass」才推翻回退；missing/review/error 判不出来时仍以决策记录的策略为准，
	// 免得评估噪声反过来批量制造 inconclusive。
	const decisionSnapshotId = baseline.decision?.snapshotId;
	const fellBack = Boolean(baseline.run && decisionSnapshotId && decisionSnapshotId !== baseline.snapshot.id);
	const premiseAtDecision = fellBack && strategy
		? evaluateStrategyVersionOnSnapshot(store, evidence.marketId, strategy, baseline.run?.mode ?? "screen", decisionSnapshotId)
		: undefined;
	const lapsedPremise = (premiseAtDecision ? baseline.run?.result.rules ?? [] : [])
		.filter((rule) => rule.status === "veto" || rule.status === "fail")
		.filter((rule) => premiseAtDecision?.rules.find((item) => item.id === rule.id)?.status === "pass");
	const replay = !replayableReject
		? { verdict: "inconclusive" as const, reason: baseline.decisionStatus === "go" ? "市场快照变化不能替代 go 品经营实绩，需录入 actuals" : "waitlist/未决策对象仅记录市场变化，需人工判断" }
		: lapsedPremise.length
			? { verdict: "inconclusive" as const, reason: `基线否决前提在决策当下已经转 pass：${lapsedPremise.map((rule) => rule.id).join("、")}；这次 ${baseline.decisionStatus} 不是该策略运行否决的，无法据此判定` }
			: staleReplayEvidence.length
				? { verdict: "inconclusive" as const, reason: `重放证据没有晚于 T0：${staleReplayEvidence.slice(0, 5).map((item) => `${item.rule}/${item.reference}`).join("、")}` }
				: replayOutcomeVerdict(baseline.run, currentEvaluation, deltas);
	// 基线快照与决策锚定快照不一致 = 走了回退，读复盘的人必须看得见这件事
	const fallbackNote = fellBack && baseline.run
		? `（基线取决策前最近一次 ${baseline.run.strategyId}@v${baseline.run.strategyVersion} 运行 ${baseline.run.id} 及其快照 ${baseline.snapshot.id}，决策锚定的是 ${decisionSnapshotId}）`
		: "";
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
		verdictReason: `${replay.reason}${fallbackNote}`,
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
	// 自动对照只对「人工决策」做后验：findRetroBaseline 在无决策时会回退到最新 strategy run，
	// 那条路径会让从未有人决策的市场在每次例行再导入时凭空产出 validated/challenged，
	// 直接推高「验证率」与「策略历史准确率」。策略自我对照要留档就走 compass_retro action=check 显式发起。
	if (!baseline.decision) return undefined;
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
	const verdict = actualsOutcomeVerdict(input.actuals, strategyTargetDailyUnits(strategy?.definition));
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

// 复盘到期节奏取自默认策略 meta 的 retro_* 字段；缺策略或缺字段时由 retroDueConfig 回退内置口径。
// listRetroDue 与复盘报告必须共用同一份配置，否则 TUI/Web 的到期数会和报告正文对不上。
function defaultRetroDueConfig(store: CompassStore): RetroDueConfig {
	return retroDueConfig(latestStrategyIfPresent(store)?.definition.meta);
}

export function listRetroDue(store: CompassStore, now = nowIso()): RetroDueItem[] {
	return dueRetroItems(store, now, defaultRetroDueConfig(store));
}

// 深研阶段的合并指标（快照 + 利润 + 风险 + 评论）：待办派生与 verify 硬门槛共用同一口径。
// 仅「无快照」按全缺处理；其余异常（如 store 局部损坏）照常抛出，不伪装成缺数据
function deepResearchMetricsFor(store: CompassStore, marketId: string): MetricMap {
	return latestSnapshotIfPresent(store, marketId) ? buildStrategyContext(store, marketId).context.metrics : {};
}

// 工作台待办：组合预算态、复盘到期、深研指标与多源偏差后委托 todo.ts 纯函数推导
export function listWorkbenchTodos(store: CompassStore, now = nowIso()): WorkbenchTodo[] {
	// 非法 now 统一回退当前时钟，避免预算月界与时间类待办各用一套时钟
	const resolvedNow = Number.isFinite(Date.parse(now)) ? now : nowIso();
	const budgets = budgetStatus(store, budgetMonth(new Date(resolvedNow)));
	const retroDue = listRetroDue(store, resolvedNow);
	const deepResearchMetrics = store.candidates
		.filter((candidate) => candidate.stage === "deep_research")
		.map((candidate): { marketId: string; metrics: MetricMap } => ({ marketId: candidate.marketId, metrics: deepResearchMetricsFor(store, candidate.marketId) }));
	const divergentMarkets = [...new Set(store.candidates.filter((candidate) => candidate.stage !== "archived").map((candidate) => candidate.marketId))]
		.map((marketId) => ({ marketId, metrics: metricDivergences(store, marketId).map((item) => item.metric) }))
		.filter((item) => item.metrics.length > 0);
	return deriveTodos({ store, budgets, retroDue, deepResearchMetrics, divergentMarkets, now: resolvedNow });
}

// —— 待办人工处理闭环：提交 → 验证 → 勾选 → 重开 ——
// 状态机迁移的唯一入口。每个动作的 actor / 时间 / 说明或理由全部留痕于记录自身，
// **不写 decisionLog**：旧版 assertStore 对 decisionLog.type 是严格白名单，新增取值会让回滚后的
// store 打不开（spec §5 方案 F）；审计链由记录本身 + 读侧时间线合并承载。

interface TodoResolutionRules {
	// verify verdict=pass 前的硬门槛，返回全部未满足项（中文）；空数组 = 通过
	gate(store: CompassStore, record: TodoResolution): string[];
	// 硬门槛查不了的语义部分：verify 时列给 agent 照单核对（spec §4.3 A 右列）
	reviewPoints: string;
	// 勾选时刻的抑制水位；无法确定时返回 undefined，由调用方拒绝勾选
	// （口径必须与 todo.ts 的抑制判定同源——直接复用其导出函数，不另写一套）
	basis(store: CompassStore, record: TodoResolution, now: string): TodoResolutionBasis | undefined;
}

const monthBasis = (_store: CompassStore, _record: TodoResolution, now: string): TodoResolutionBasis => ({ month: budgetMonth(new Date(now)) });

// per-kind 查表：扩闭环 kind 只需加一行，四个动作的主流程不动
const TODO_RESOLUTION_RULES: Record<ResolvableTodoKind, TodoResolutionRules> = {
	// 预算两类与偏差类无可代码化门槛：是否给出结论/决定属语义判断，由 agent 终审兜底
	budget_warning: {
		gate: () => [],
		reviewPoints: "是否给出用量核对结论与后续动作（提额 / 收紧补数 / 接受现状）",
		basis: monthBasis,
	},
	budget_fused: {
		gate: () => [],
		reviewPoints: "是否给出明确决定（提额 or 本月接受停摆）与理由",
		basis: monthBasis,
	},
	metric_divergence: {
		gate: () => [],
		reviewPoints: "说明是否明确「以哪个来源为准」及理由",
		basis: (store, record) => {
			const watermark = record.marketId ? divergenceWatermarks(store).get(record.marketId) : undefined;
			return watermark ? { snapshotWatermark: watermark } : undefined;
		},
	},
	deep_missing_data: {
		reviewPoints: "提交说明是否真含供应商 / 具体 SKU / 成本构成",
		// ① 四项硬指标齐备（口径同深研派生）② 该市场存在具体的利润测算记录
		gate: (store, record) => {
			const unmet = record.marketId
				? missingDeepResearchFields(deepResearchMetricsFor(store, record.marketId)).map((label) => `缺${label}`)
				: ["缺市场归属，无法核对硬指标"];
			const hasProfit = store.profitEstimates.some((estimate) =>
				(record.marketId !== undefined && estimate.marketId === record.marketId)
				|| (record.candidateId !== undefined && estimate.candidateId === record.candidateId));
			if (!hasProfit) unmet.push("缺利润测算记录");
			return unmet;
		},
		basis: (store, record) => {
			const enteredAt = record.candidateId ? stageEntryTimes(store, "deep_research").get(record.candidateId) : undefined;
			return enteredAt ? { stageEnteredAt: enteredAt } : undefined;
		},
	},
};

export function findTodoResolution(store: CompassStore, todoRef: string): TodoResolution | undefined {
	return store.todoResolutions?.find((record) => record.todoId === todoRef);
}

// 只读验证工作台（compass_todo 的待验证队列消费）：把该 kind 的硬门槛预检结果与语义终审要点
// 一并给 agent，避免任何消费面复刻门槛口径。纯读，不改任何状态。
export function todoResolutionReviewGuide(store: CompassStore, record: TodoResolution): { reviewPoints: string; unmetGate: string[] } {
	const rules = TODO_RESOLUTION_RULES[record.kind];
	return { reviewPoints: rules.reviewPoints, unmetGate: rules.gate(store, record) };
}

function requireTodoResolution(store: CompassStore, todoRef: string): TodoResolution {
	const record = findTodoResolution(store, todoRef);
	if (!record) throw new Error(`待办 ${todoRef} 尚无处理记录，请先提交处理结果`);
	return record;
}

function currentAttempt(record: TodoResolution): TodoResolutionAttempt {
	const attempt = record.attempts[record.attempts.length - 1];
	if (!attempt) throw new Error(`待办 ${record.todoId} 的处理记录损坏：无提交轮次`);
	return attempt;
}

function statusLabel(status: TodoResolutionStatus): string {
	return TODO_RESOLUTION_STATUS_LABELS[status];
}

// 水位比对：per-kind 规则每次只落其中一个锚点字段，三个字段全等即同一水位
function sameBasis(a: TodoResolutionBasis, b: TodoResolutionBasis): boolean {
	return a.month === b.month && a.snapshotWatermark === b.snapshotWatermark && a.stageEnteredAt === b.stageEnteredAt;
}

// 水位变化的人话提示：拒绝勾选时必须让运营看懂「到底什么变了」，而不是只丢一句「水位不一致」
const BASIS_CHANGE_HINTS: Record<ResolvableTodoKind, string> = {
	metric_divergence: "该市场进来了新的导出快照，参与比较的数据已变",
	budget_warning: "已跨入新的预算月，用量重新计算",
	budget_fused: "已跨入新的预算月，用量重新计算",
	deep_missing_data: "候选重新进入了深研阶段，属新一轮周期",
};

// 末轮提交时记下的水位是否已失效。**complete 的拒绝条件与 submit 的重入放行条件共用同一判据**：
// 保证「勾不了 ⇔ 能重新提交」，运营任何时候都有出路，不会卡死在「验证通过却勾不掉」的中间态
function attemptBasisStale(store: CompassStore, record: TodoResolution, now: string): boolean {
	const submitted = record.attempts[record.attempts.length - 1]?.basisAtSubmit;
	// 本字段上线前的旧记录一律按失效处理：错位的最坏情况只能是多提醒一次，绝不能是漏提醒
	if (!submitted) return true;
	const current = TODO_RESOLUTION_RULES[record.kind].basis(store, record, now);
	return !current || !sameBasis(submitted, current);
}

export function submitTodoResolution(
	store: CompassStore,
	input: { todoRef: string; note: string; evidence?: Array<{ ref: string; note?: string }> },
	actor: string,
	now = nowIso(),
): TodoResolution {
	const note = input.note?.trim();
	if (!note) throw new Error("处理说明不能为空：请写清做了什么、结论与关键数值");
	const evidence: TodoEvidenceRef[] = (input.evidence ?? []).map((item) => {
		const ref = item.ref?.trim();
		if (!ref) throw new Error("证据引用不能为空：填写 URL 或项目内文件路径");
		const itemNote = item.note?.trim();
		return itemNote ? { ref, note: itemNote } : { ref };
	});
	// 状态前置校验先于活跃清单查询：已勾选的条目本就被抑制在清单外，
	// 若先查清单会把「请先重开」误报成「待办不存在」，把运营指向错误的下一步
	const existing = findTodoResolution(store, input.todoRef);
	if (existing?.status === "submitted") throw new Error(`待办 ${input.todoRef} 已提交，正在等待 agent 验证（当前「待验证」）`);
	// verified 态默认不接受重复提交；但当提交时的水位已失效（新导出 / 新预算月 / 重入深研）时
	// complete 必然拒绝勾选——此处必须放行重新提交，否则运营卡死在「勾不了也提交不了」
	if (existing?.status === "verified" && !attemptBasisStale(store, existing, now)) {
		throw new Error(`待办 ${input.todoRef} 已验证通过，请直接勾选已处理`);
	}
	if (existing?.status === "resolved") throw new Error(`待办 ${input.todoRef} 已勾选处理，如需重新处理请先重开`);
	// 必须命中当前活跃派生清单：条件已自然解决的待办不接受提交
	const todo = listWorkbenchTodos(store, now).find((item) => item.id === input.todoRef);
	if (!todo) throw new Error(`待办 ${input.todoRef} 不存在或已消失（可能条件已解决）`);
	if (!isResolvableTodoKind(todo.kind)) throw new Error(`待办 ${input.todoRef} 属 ${todo.kind}，该类待办由系统动作自动消失，无需提交处理结果`);
	const attempt: TodoResolutionAttempt = { submittedAt: now, submittedBy: actor, note, evidence };
	// 提交时刻的水位：complete 据此判断「提交→勾选之间是否出现未经核对的新事实」。
	// 与勾选时同源（同一张 per-kind 规则表）；取不到时留空，后续按失效处理
	const stampBasis = (target: TodoResolution): void => {
		const basisAtSubmit = TODO_RESOLUTION_RULES[target.kind].basis(store, target, now);
		if (basisAtSubmit) attempt.basisAtSubmit = basisAtSubmit;
	};
	if (!existing) {
		const record: TodoResolution = {
			id: shortId("tdr"),
			todoId: todo.id,
			kind: todo.kind,
			titleSnapshot: todo.title,
			status: "submitted",
			attempts: [attempt],
			reopens: [],
			createdAt: now,
			updatedAt: now,
		};
		if (todo.marketId) record.marketId = todo.marketId;
		if (todo.candidateId) record.candidateId = todo.candidateId;
		if (todo.source) record.source = todo.source;
		stampBasis(record);
		(store.todoResolutions ??= []).push(record);
		return record;
	}
	// rejected / reopened / 水位已失效的 verified：追加新一轮，历史轮次与重开留痕全部保留；标题快照刷新为当前派生标题
	stampBasis(existing);
	existing.attempts.push(attempt);
	existing.status = "submitted";
	existing.titleSnapshot = todo.title;
	existing.updatedAt = now;
	return existing;
}

export function verifyTodoResolution(
	store: CompassStore,
	input: { todoRef: string; verdict: TodoResolutionVerdict; reason: string },
	actor: string,
	now = nowIso(),
): TodoResolution {
	const reason = input.reason?.trim();
	if (!reason) throw new Error("验证结论必须填写理由");
	if (input.verdict !== "pass" && input.verdict !== "reject") throw new Error(`验证结论只能是 pass 或 reject：${String(input.verdict)}`);
	const record = requireTodoResolution(store, input.todoRef);
	if (record.status !== "submitted") throw new Error(`待办 ${input.todoRef} 当前为「${statusLabel(record.status)}」，只有待验证的记录可以验证`);
	if (input.verdict === "pass") {
		// 硬门槛不满足时拒绝落「通过」：agent 只能改判 reject 或先补齐数据（前置于任何写入）
		const unmet = TODO_RESOLUTION_RULES[record.kind].gate(store, record);
		if (unmet.length) throw new Error(`待办 ${input.todoRef} 未达硬门槛，不得判定通过：${unmet.join("、")}；请先补齐数据，或改判 reject`);
	}
	const attempt = currentAttempt(record);
	attempt.verdict = input.verdict;
	attempt.verdictReason = reason;
	attempt.verifiedAt = now;
	attempt.verifiedBy = actor;
	record.status = input.verdict === "pass" ? "verified" : "rejected";
	record.updatedAt = now;
	return record;
}

export function completeTodoResolution(store: CompassStore, input: { todoRef: string }, actor: string, now = nowIso()): TodoResolution {
	const record = requireTodoResolution(store, input.todoRef);
	if (record.status === "resolved") throw new Error(`待办 ${input.todoRef} 已勾选处理，无需重复勾选`);
	// 服务端强制校验：前端置灰只是辅助，绕过前端直连端点同样拦下
	if (record.status !== "verified") throw new Error(`待办 ${input.todoRef} 须先经 agent 验证通过才能勾选已处理（当前「${statusLabel(record.status)}」）`);
	const basis = TODO_RESOLUTION_RULES[record.kind].basis(store, record, now);
	if (!basis) throw new Error(`待办 ${input.todoRef} 无法确定抑制水位（关联市场或候选已不可用），暂不能勾选已处理`);
	// 勾选 = 给「尚未发生的事实」预埋抑制，因此必须在勾选这一刻重新确认两件事：
	// ① 条目仍在活跃清单——条件已自然解决时勾选只会埋下未来的告警黑洞（跨月后勾选预算告警会落次月
	//    水位，把整个次月的新告警吞掉）；listWorkbenchTodos 对单来源市场是纯内存派生，多来源市场
	//    会经 metricDivergences 的 q 重算读到快照明细 sidecar（勾选是写路径，这点开销可接受）；
	// ② 水位与提交时一致——提交后到达的新导出 / 新预算月 / 新深研周期没有任何人核对过，
	//    按旧结论勾选会把它们一并抑制。两条都是「宁可多提醒一次，绝不漏提醒」的直接落地。
	const todo = listWorkbenchTodos(store, now).find((item) => item.id === record.todoId);
	if (!todo) {
		throw new Error(`待办 ${input.todoRef} 已不在活跃清单（条件可能已自然解决，如预算已跨月或偏差已消失），无需勾选；若日后重新浮出，请重新提交处理结果`);
	}
	const submitted = currentAttempt(record).basisAtSubmit;
	if (!submitted) {
		throw new Error(`待办 ${input.todoRef} 的处理记录缺少提交时水位（本校验上线前的旧记录），为免漏提醒不放行勾选；请重新提交处理结果并请 agent 重新验证`);
	}
	if (!sameBasis(submitted, basis)) {
		throw new Error(`待办 ${input.todoRef} 自提交后已出现新事实（${BASIS_CHANGE_HINTS[record.kind]}），不能按旧结论勾选；请重新提交处理结果并请 agent 重新验证（compass_todo action=submit todo_id=${record.todoId}）`);
	}
	record.status = "resolved";
	record.resolvedAt = now;
	record.resolvedBy = actor;
	record.basis = basis;
	record.updatedAt = now;
	return record;
}

export function reopenTodoResolution(store: CompassStore, input: { todoRef: string; reason: string }, actor: string, now = nowIso()): TodoResolution {
	const reason = input.reason?.trim();
	if (!reason) throw new Error("重开必须填写理由");
	const record = requireTodoResolution(store, input.todoRef);
	if (record.status !== "resolved") throw new Error(`待办 ${input.todoRef} 当前为「${statusLabel(record.status)}」，只有已处理的记录可以重开`);
	record.reopens.push({ reopenedAt: now, reopenedBy: actor, reason });
	record.status = "reopened";
	record.updatedAt = now;
	// resolvedAt/resolvedBy/basis 保留为「曾于何时被谁勾选」的历史事实，下次勾选时整体覆盖；
	// 消费方判断「已处理」一律以 status === "resolved" 为准，不得看 resolvedAt 是否存在
	return record;
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
	// 该行用哪一档模式重跑：对照复盘时取产生基线决策那次 run 的模式，否则按自动粗筛的 screen
	mode: StrategyMode;
	// 该行对照的复盘 id；缺省表示这是「市场最新快照」翻转行，不参与对齐率
	checkId?: string;
	baselineOutcome: StrategyEvaluation["outcome"];
	strategyOutcome: StrategyEvaluation["outcome"];
	baselineScore: number;
	strategyScore: number;
}

// 单侧对齐口径：review 是策略主动弃权（「缺硬指标，转人工」），既不算对也不算错。
// 把弃权算错，「敢下结论」的策略被无差别扣分；把弃权算进分母，对齐率随弃权数单调下降。
// 两种口径都会让「多弃权」变成免费的挡箭牌，所以分母只算 decided，
// 另报 coverage = decided / 可比对照数，让运营自己看样本够不够。
export interface BacktestAlignmentSide {
	decided: number;
	correct: number;
	abstained: number;
	rate: number | null;
	coverage: number | null;
}

export interface BacktestResult {
	strategy: string;
	baselineStrategy: string;
	markets: number;
	matrix: Record<string, number>;
	flips: BacktestMarketRow[];
	rows: BacktestMarketRow[];
	alignment: { strategy: BacktestAlignmentSide; baseline: BacktestAlignmentSide; comparableChecks: number };
}

function desiredOutcomeForCheck(check: OutcomeCheck): "pass" | "reject" | undefined {
	// 「可判」判据的唯一所有者是 history.ts 的 isComparableCheck；这里只负责把可判 check
	// 翻译成期望 outcome。各写一套会让「比率认这条、alignment 不认」重新分叉（审计 G16）。
	if (!isComparableCheck(check)) return undefined;
	if (check.decisionStatus === "go") return check.verdict === "validated" ? "pass" : "reject";
	return check.verdict === "validated" ? "reject" : "pass";
}

function emptyAlignmentSide(): BacktestAlignmentSide {
	return { decided: 0, correct: 0, abstained: 0, rate: null, coverage: null };
}

function tallyAlignment(side: BacktestAlignmentSide, outcome: StrategyEvaluation["outcome"], desired: "pass" | "reject"): void {
	if (outcome !== "pass" && outcome !== "reject") {
		side.abstained += 1;
		return;
	}
	side.decided += 1;
	if (outcome === desired) side.correct += 1;
}

export function backtestStrategies(store: CompassStore, strategyRef: string, baselineStrategyRef?: string): BacktestResult {
	const strategy = findStrategyVersion(store, strategyRef);
	const baseline = findStrategyVersion(store, baselineStrategyRef ?? DEFAULT_STRATEGY_ID);
	const marketNames = new Map(store.markets.map((market) => [market.id, market.name]));
	// 同一 (市场, 快照, 模式) 只重跑一次：复盘证据快照往往就是市场最新快照，
	// 每次重跑都要新建 StrategyContext，且引用榜单的规则会触发快照明细读盘。
	const rowsByKey = new Map<string, BacktestMarketRow>();
	const evaluateRow = (marketId: string, snapshotId: string, mode: StrategyMode): BacktestMarketRow | undefined => {
		const key = `${marketId}|${snapshotId}|${mode}`;
		const cached = rowsByKey.get(key);
		if (cached) return cached;
		const marketName = marketNames.get(marketId);
		if (marketName === undefined) return undefined;
		// 证据快照可能已随市场清理消失：跳过该行，而不是让整次回测抛错
		if (!store.snapshots.some((item) => item.id === snapshotId && item.marketId === marketId)) return undefined;
		const baselineEvaluation = evaluateStrategyVersionOnSnapshot(store, marketId, baseline, mode, snapshotId);
		const strategyEvaluation = evaluateStrategyVersionOnSnapshot(store, marketId, strategy, mode, snapshotId);
		const row: BacktestMarketRow = {
			marketId,
			marketName,
			snapshotId,
			mode,
			baselineOutcome: baselineEvaluation.outcome,
			strategyOutcome: strategyEvaluation.outcome,
			baselineScore: baselineEvaluation.score,
			strategyScore: strategyEvaluation.score,
		};
		rowsByKey.set(key, row);
		return row;
	};
	// 翻转矩阵仍看「市场最新快照」：运营关心换策略后当前看板会怎么翻。
	// 模式固定 screen——粗筛是导入时自动跑的那一档；用 full 会把「还没做利润测算/风险清单」
	// 的市场一律折成 review，矩阵与看板对不上。
	const latestRows: BacktestMarketRow[] = [];
	for (const market of store.markets) {
		const snapshot = latestSnapshotIfPresent(store, market.id);
		if (!snapshot) continue;
		const row = evaluateRow(market.id, snapshot.id, "screen");
		if (row) latestRows.push(row);
	}
	const matrix: Record<string, number> = {};
	for (const before of ["pass", "review", "reject"] as const) for (const after of ["pass", "review", "reject"] as const) matrix[`${before}→${after}`] = 0;
	for (const row of latestRows) matrix[`${row.baselineOutcome}→${row.strategyOutcome}`] += 1;
	// 与 outcomeStatistics 的四率共用同一份去重样本：两个面不得各排各的序。
	// 就地重写会漏掉 id 兜底——同毫秒并列时（真实导入链路上会自然发生）两边会选中相反的 check，
	// 「复盘比率与 backtest 一致率同口径」这句话就不成立了。
	const latestComparable = latestComparableChecks(store.outcomeChecks);
	const strategySide = emptyAlignmentSide();
	const baselineSide = emptyAlignmentSide();
	let comparable = 0;
	for (const check of latestComparable) {
		const desired = desiredOutcomeForCheck(check);
		if (!desired) continue;
		// 对齐标签取自这条复盘，重跑就必须落在同一张证据快照上：市场最新快照可能是
		// 之后一次 inconclusive 导入带来的，两者不是一回事（否则一次缺列导入就能把对齐打到 0）。
		// 模式同理取产生基线决策那次 run 的模式，缺省 screen。
		const mode = (check.baselineRunId ? store.strategyRuns.find((run) => run.id === check.baselineRunId)?.mode : undefined) ?? "screen";
		const row = evaluateRow(check.marketId, check.evidenceSnapshotId ?? check.baselineSnapshotId, mode);
		if (!row) continue;
		row.checkId ??= check.id;
		comparable += 1;
		tallyAlignment(strategySide, row.strategyOutcome, desired);
		tallyAlignment(baselineSide, row.baselineOutcome, desired);
	}
	for (const side of [strategySide, baselineSide]) {
		side.rate = side.decided ? side.correct / side.decided : null;
		side.coverage = comparable ? side.decided / comparable : null;
	}
	return {
		strategy: `${strategy.id}@v${strategy.version}`,
		baselineStrategy: `${baseline.id}@v${baseline.version}`,
		markets: latestRows.length,
		matrix,
		flips: latestRows.filter((row) => row.baselineOutcome !== row.strategyOutcome),
		rows: [...rowsByKey.values()],
		alignment: { strategy: strategySide, baseline: baselineSide, comparableChecks: comparable },
	};
}

export function generateRetroReport(store: CompassStore, generatedAt = nowIso(), options: RetroReportOptions = {}): string {
	return renderRetroReport(store, generatedAt, defaultRetroDueConfig(store), options);
}

export function leadHistoryNote(store: CompassStore, marketId: string): string[] {
	const similar = similarMarkets(store, { marketId, limit: 1 })[0];
	if (!similar) return [];
	return renderHistoryNote([`与 ${similar.market.id}「${similar.market.name}」相似度 ${(similar.score * 100).toFixed(0)}%（关键词重合 ${similar.keywordOverlap}）；历史结论 ${similar.finalDecision ?? "未决策"}${similar.latestVerdict ? ` / 复盘 ${similar.latestVerdict}` : ""}。`, `先用 compass_history action=timeline market_ref=${similar.market.id} 查看证据，再决定是否重复立项。`]);
}

export function importHistoryNote(store: CompassStore, marketId: string, snapshotId: string, check?: OutcomeCheck): string[] {
	const snapshots = store.snapshots.filter((item) => item.marketId === marketId).sort(compareSnapshotRecencyDesc);
	const current = store.snapshots.find((item) => item.id === snapshotId);
	const previous = snapshots.find((item) => item.id !== snapshotId && current && compareSnapshotRecency(item, current) < 0);
	const lines: string[] = [];
	if (previous && current) {
		const deltas = calculateMetricDeltas(previous.metrics, current.metrics).filter((item) => item.baseline !== item.current).slice(0, 5);
		if (deltas.length) lines.push(`快照对照 ${previous.id}→${current.id}：${deltas.map(formatDelta).join("；")}`);
	}
	const decision = latestBy(store.decisionLog.filter((item) => item.marketId === marketId && item.type === "decision"), (item) => item.createdAt);
	if (decision) lines.push(`既往决策：${decision.decisionStatus ?? "—"} · ${decision.reason}`);
	if (check) lines.push(`已生成 ${check.id}：${check.verdict} · ${check.verdictReason}${check.verdict === "challenged" ? "；建议重跑 compass_strategy_run" : ""}`);
	return renderHistoryNote(lines);
}

export function strategyHistoryNote(store: CompassStore, run: StrategyRun): string[] {
	const previous = latestBy(store.strategyRuns.filter((item) => item.marketId === run.marketId && item.id !== run.id), (item) => item.runAt);
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
		// 与 history.outcomeStatistics 同口径：**按市场去重**，一个市场只投一票。
		// 按条数加权会让长期跟踪的 peer（每次例行导入攒一条 check）主导整条比率——
		// 3 个 peer 里的一个就能把数字带偏。复用 latestComparableChecks，绝不在这里
		// 另写一份去重：批次四 Deviation 15 记着「第二份实现缺 id 兜底、同毫秒时两个面
		// 选中相反的 check」那次事故。
		const peerIds = new Set(peers.map((peer) => peer.market.id));
		const peerChecks = latestComparableChecks(store.outcomeChecks.filter((check) => peerIds.has(check.marketId)))
			.filter((check) => check.decisionStatus === "go");
		if (peerChecks.length) lines.push(`相似市场 go 品实绩达成率 ${(peerChecks.filter((check) => check.verdict === "validated").length / peerChecks.length * 100).toFixed(0)}%（${peerChecks.length} 个市场，按市场去重：同一市场只取最新一条可判对照）。`);
		for (const lesson of matchingLessonsForMarket(store, market.id, 2)) lines.push(`命中经验 ${lesson.id}：${lesson.title}（evidence: ${lesson.evidence.slice(0, 3).join("、")}）`);
	}
	return renderHistoryNote(lines);
}

export function generateMarketReport(
	store: CompassStore,
	marketRef: string,
	strategyRef = DEFAULT_STRATEGY_ID,
): GeneratedReport {
	const market = findMarket(store, marketRef);
	const snapshot = latestSnapshot(store, market.id);
	const strategy = findStrategyVersion(store, strategyRef);
	const { context } = buildStrategyContext(store, market.id, strategyTargetMonthlyUnits(strategy.definition));
	const evaluation = evaluateStrategy(strategy.definition, context, "full");
	const candidate = store.candidates.find((item) => item.marketId === market.id);
	// 并列时后插入的排前面，与 latestBy 同口径（sort 稳定，比较返回 0 会保持原序即最早在前）
	const decisions = store.decisionLog
		.map((item, index) => ({ item, index }))
		.filter(({ item }) => item.marketId === market.id)
		.sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt) || b.index - a.index)
		.map(({ item }) => item);
	const risk = latestBy(store.riskRecords.filter((item) => item.marketId === market.id), (item) => item.createdAt);
	const review = latestBy(store.reviewAnalyses.filter((item) => item.marketId === market.id), (item) => item.createdAt);
	const profit = latestBy(store.profitEstimates.filter((item) => item.marketId === market.id), (item) => item.createdAt);
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

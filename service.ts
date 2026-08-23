import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_BUDGET_POOLS, DEFAULT_STRATEGY_YAML } from "./defaults.ts";
import { profitMetrics } from "./economics.ts";
import { calculateMarketMetrics } from "./metrics.ts";
import { renderMarketReport, type GeneratedReport, type MarketReportData } from "./report.ts";
import { evaluateStrategy, parseStrategyYaml, slugify, strategyToYaml, type StrategyContext } from "./strategy.ts";
import type {
	BudgetPool,
	Candidate,
	CandidateStage,
	CompassStore,
	CostEvent,
	DecisionLog,
	Market,
	MarketSnapshot,
	MetricEvidence,
	MetricMap,
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
} from "./types.ts";

function nowIso(): string {
	return new Date().toISOString();
}

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

export function ensureDefaults(store: CompassStore, actor = "compass"): boolean {
	let changed = false;
	const definition = parseStrategyYaml(DEFAULT_STRATEGY_YAML);
	const defaultId = slugify(definition.meta.name);
	if (!store.strategies.some((strategy) => strategy.id === defaultId)) {
		store.strategies.push({
			id: defaultId,
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
	const market = findMarket(store, reference);
	const candidate = store.candidates.find((item) => item.marketId === market.id);
	if (!candidate) throw new Error(`市场 ${market.id} 尚无候选卡`);
	return candidate;
}

export function latestSnapshotIfPresent(store: CompassStore, marketId: string): MarketSnapshot | undefined {
	return store.snapshots
		.filter((snapshot) => snapshot.marketId === marketId)
		.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
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
	appendDecision(store, {
		candidateId: candidate.id,
		marketId: market.id,
		type: "lead",
		conclusion: created ? "创建市场线索" : "更新市场线索",
		reason: `关键词：${market.keywords.join("、") || "未填写"}${input.category ? `；类目：${input.category}` : ""}`,
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
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		store.candidates.push(candidate);
	} else candidate.updatedAt = timestamp;

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
): ReturnType<typeof importParsedMarket> & { screenRun?: StrategyRun } {
	const imported = importParsedMarket(store, input);
	const screenRun = input.runScreen === false ? undefined : runStrategy(store, {
		marketRef: imported.market.id,
		mode: "screen",
		actor: input.actor,
	});
	return { ...imported, screenRun };
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

export function buildStrategyContext(store: CompassStore, marketId: string): { snapshot: MarketSnapshot; context: StrategyContext } {
	const snapshot = latestSnapshot(store, marketId);
	const metrics: MetricMap = { ...snapshot.metrics };
	const profit = latestForMarket(store.profitEstimates, marketId);
	if (profit) Object.assign(metrics, profitMetrics(profit.input, profit.result, profit.createdAt));
	const risk = latestForMarket(store.riskRecords, marketId);
	Object.assign(metrics, riskMetrics(risk));
	const review = latestForMarket(store.reviewAnalyses, marketId);
	Object.assign(metrics, reviewMetrics(review));
	return { snapshot, context: { metrics, listings: snapshot.listings } };
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
	const run: StrategyRun = {
		id: shortId("run"),
		strategyId: strategy.id,
		strategyVersion: strategy.version,
		marketId: market.id,
		snapshotId: snapshot.id,
		mode: input.mode,
		result,
		runAt: nowIso(),
		actor: input.actor,
	};
	store.strategyRuns.push(run);
	const candidate = store.candidates.find((item) => item.marketId === market.id);
	if (candidate) {
		candidate.gateOutcome = result.outcome;
		candidate.score = result.score;
		candidate.latestStrategyRunId = run.id;
		candidate.updatedAt = run.runAt;
	}
	appendDecision(store, {
		candidateId: candidate?.id,
		marketId: market.id,
		type: "strategy",
		conclusion: `${input.mode} Gate=${result.outcome}，Score=${result.score}`,
		reason: result.rules.filter((rule) => rule.status !== "pass").map((rule) => rule.message).join("；") || "全部规则通过",
		snapshotId: snapshot.id,
		strategyId: strategy.id,
		strategyVersion: strategy.version,
		actor: input.actor,
	});
	return run;
}

export function evaluateMarketWithoutPersisting(
	store: CompassStore,
	marketId: string,
	strategyRef = "jingpu-daily10",
	mode: "screen" | "full" = "screen",
): StrategyEvaluation {
	const strategy = latestStrategy(store, strategyRef);
	const { context } = buildStrategyContext(store, marketId);
	context.targetMonthlyUnits = Number(strategy.definition.meta.monthly_units_q ?? 300);
	return evaluateStrategy(strategy.definition, context, mode);
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

export function moveCandidate(
	store: CompassStore,
	input: { candidateRef: string; stage: CandidateStage; reason: string; actor: string },
): Candidate {
	if (!input.reason.trim()) throw new Error("移动候选阶段必须填写 reason，确保决策可追溯");
	const candidate = findCandidate(store, input.candidateRef);
	const previous = candidate.stage;
	if (previous === input.stage) throw new Error(`候选已处于 ${input.stage} 阶段`);
	candidate.stage = input.stage;
	candidate.updatedAt = nowIso();
	const latestRun = candidate.latestStrategyRunId
		? store.strategyRuns.find((run) => run.id === candidate.latestStrategyRunId)
		: undefined;
	appendDecision(store, {
		candidateId: candidate.id,
		marketId: candidate.marketId,
		type: "stage_move",
		conclusion: `${previous} → ${input.stage}`,
		reason: input.reason,
		snapshotId: store.snapshots
			.filter((snapshot) => snapshot.marketId === candidate.marketId)
			.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0]?.id,
		strategyId: latestRun?.strategyId,
		strategyVersion: latestRun?.strategyVersion,
		actor: input.actor,
	});
	return candidate;
}

function monthPrefix(date = new Date()): string {
	return date.toISOString().slice(0, 7);
}

export function budgetStatus(store: CompassStore, month = monthPrefix()): Array<BudgetPool & { spentCny: number; remainingCny: number; utilization: number | null; state: "ok" | "warning" | "fused" | "free" }> {
	return store.budgetPools.map((pool) => {
		const spentCny = store.costEvents
			.filter((event) => event.source === pool.source && event.createdAt.startsWith(month))
			.reduce((sum, event) => sum + event.amountCny, 0);
		const utilization = pool.monthlyLimitCny > 0 ? spentCny / pool.monthlyLimitCny : null;
		const state = pool.monthlyLimitCny === 0
			? "free"
			: spentCny >= pool.monthlyLimitCny ? "fused" : spentCny >= pool.monthlyLimitCny * 0.8 ? "warning" : "ok";
		return {
			...pool,
			spentCny: Math.round(spentCny * 100) / 100,
			remainingCny: Math.max(0, Math.round((pool.monthlyLimitCny - spentCny) * 100) / 100),
			utilization: utilization === null ? null : Math.round(utilization * 1000) / 1000,
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
	input: { source: string; tier?: "A" | "B" | "C"; monthlyLimitCny?: number; enabled?: boolean; note?: string },
): BudgetPool {
	if (input.monthlyLimitCny !== undefined && (!Number.isFinite(input.monthlyLimitCny) || input.monthlyLimitCny < 0)) {
		throw new Error("monthlyLimitCny 必须为非负数字");
	}
	let pool = store.budgetPools.find((item) => item.source === input.source);
	if (!pool) {
		if (!input.tier || input.monthlyLimitCny === undefined) throw new Error("新预算池需要 tier 与 monthlyLimitCny");
		pool = {
			source: input.source,
			tier: input.tier,
			monthlyLimitCny: input.monthlyLimitCny,
			enabled: input.enabled ?? true,
			note: input.note,
		};
		store.budgetPools.push(pool);
		return pool;
	}
	if (input.tier !== undefined) pool.tier = input.tier;
	if (input.monthlyLimitCny !== undefined) pool.monthlyLimitCny = input.monthlyLimitCny;
	if (input.enabled !== undefined) pool.enabled = input.enabled;
	if (input.note !== undefined) pool.note = input.note;
	return pool;
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

export function generateMarketReport(
	store: CompassStore,
	marketRef: string,
	strategyRef = "jingpu-daily10",
): GeneratedReport {
	const market = findMarket(store, marketRef);
	const snapshot = latestSnapshot(store, market.id);
	const strategy = latestStrategy(store, strategyRef);
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
		divergences: metricDivergences(store, market.id),
		attributedCostCny,
		fusedBudgetSources,
	};
	return renderMarketReport(data);
}

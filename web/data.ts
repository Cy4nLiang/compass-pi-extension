import { confidenceLabel, DIMENSIONS, formatMetric, METRIC_LABELS, outcomeLabel } from "../report.ts";
import {
	budgetStatus,
	buildStrategyContext,
	candidateDetail,
	evaluateMarketWithoutPersisting,
	findMarket,
	gateDefaultsLine,
	latestSnapshotIfPresent,
	listPoolCandidates,
	listRetroDue,
	listWorkbenchTodos,
	marketAmazonLinks,
	metricDivergences,
	targetMonthlyUnits,
} from "../service.ts";
import {
	CANDIDATE_STAGES,
	STAGE_LABELS,
	TODO_GROUP_LABELS,
	TODO_PRIORITIES,
	type Candidate,
	type CandidateStage,
	type CompassStore,
	type DecisionLog,
	type DecisionStatus,
	type GateOutcome,
	type MetricEvidence,
	type MetricScalar,
	type StrategyEvaluation,
	type StrategyRun,
} from "../types.ts";

// Web API 的 DTO 组装层：全部为只读纯函数 (store, ...) => JSON 安全对象。
// 红线：列表类 DTO 绝不序列化 snapshot.listings / snapshot.keywords —— 它们是懒加载
// getter，展开会触发全量快照明细的磁盘读取；本层只显式挑选标量字段与 metrics。
// 唯一豁免：单品详情（poolCandidateData）经 service.marketAmazonLinks 有界读取一个市场
// 最新快照的前 N 条 listing 生成链接——不得在任何列表类 DTO 复制该模式。

const DIMENSION_SCORE_LABELS: Array<{ key: string; label: string }> = [
	{ key: "demand", label: "需求" },
	{ key: "competition", label: "竞争" },
	{ key: "unit_economics", label: "单位经济" },
	{ key: "product", label: "产品力" },
	{ key: "risk", label: "风险" },
];

export type SnapshotFreshness = "deep_fresh" | "screen_only" | "stale" | "missing";

const FRESHNESS_LABELS: Record<SnapshotFreshness, string> = {
	deep_fresh: "深研新鲜（≤7天）",
	screen_only: "仅适合粗筛（≤30天）",
	stale: "已过期（>30天）",
	missing: "无快照",
};

// 与 service.ts 待办派生同口径：非法 now 回退真实时钟，避免同一响应内时间派生数据分裂
function resolveNow(value: string): string {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function ageDaysFrom(capturedAt: string, now: string): number {
	return Math.max(0, Math.floor((Date.parse(now) - Date.parse(capturedAt)) / 86_400_000));
}

function freshnessTier(age: number | null): SnapshotFreshness {
	if (age === null) return "missing";
	if (age <= 7) return "deep_fresh";
	if (age <= 30) return "screen_only";
	return "stale";
}

function numberMetric(metric: MetricEvidence | undefined): number | null {
	return typeof metric?.value === "number" ? metric.value : null;
}

function metricLabel(key: string, units: number): string {
	return key === "qualify_rank_depth" ? `QRD(${units})` : METRIC_LABELS[key] ?? key;
}

export interface MetricRowDto {
	key: string;
	label: string;
	value: MetricScalar | null;
	display: string;
	source: string | null;
	capturedAt: string | null;
	confidence: number | null;
	confidenceTier: string;
	note: string | null;
}

function metricRow(key: string, metric: MetricEvidence | undefined, units: number): MetricRowDto {
	return {
		key,
		label: metricLabel(key, units),
		value: metric?.value ?? null,
		display: metric ? formatMetric(key, metric) : "缺",
		source: metric?.source ?? null,
		capturedAt: metric?.capturedAt ?? null,
		confidence: metric?.confidence ?? null,
		confidenceTier: metric ? confidenceLabel(metric.confidence) : "缺失",
		note: metric?.note ?? null,
	};
}

export interface MarketRowDto {
	marketId: string;
	name: string;
	category: string | null;
	stage: CandidateStage | null;
	stageLabel: string | null;
	gateOutcome: GateOutcome | null;
	decisionStatus: DecisionStatus | null;
	score: number | null;
	qrd: number | null;
	newListingShare: number | null;
	mainCpc: number | null;
	snapshotAgeDays: number | null;
	freshness: SnapshotFreshness;
	freshnessLabel: string;
	source: string | null;
	updatedAt: string;
}

function marketRows(store: CompassStore, now: string): MarketRowDto[] {
	return [...store.markets]
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.map((market) => {
			const candidate = store.candidates.find((item) => item.marketId === market.id);
			const snapshot = latestSnapshotIfPresent(store, market.id);
			const metrics = snapshot?.metrics ?? {};
			const age = snapshot ? ageDaysFrom(snapshot.capturedAt, now) : null;
			const freshness = freshnessTier(age);
			return {
				marketId: market.id,
				name: market.name,
				category: market.category ?? null,
				stage: candidate?.stage ?? null,
				stageLabel: candidate ? STAGE_LABELS[candidate.stage] : null,
				gateOutcome: candidate?.gateOutcome ?? null,
				decisionStatus: candidate?.decisionStatus ?? null,
				score: candidate?.score ?? null,
				qrd: numberMetric(metrics.qualify_rank_depth),
				newListingShare: numberMetric(metrics.new_listing_share_12m),
				mainCpc: numberMetric(metrics.main_cpc),
				snapshotAgeDays: age,
				freshness,
				freshnessLabel: FRESHNESS_LABELS[freshness],
				source: snapshot?.source ?? null,
				updatedAt: market.updatedAt,
			};
		});
}

function pickDecision(decision: DecisionLog) {
	return {
		id: decision.id,
		createdAt: decision.createdAt,
		type: decision.type,
		conclusion: decision.conclusion,
		decisionStatus: decision.decisionStatus ?? null,
		reason: decision.reason,
		actor: decision.actor,
		snapshotId: decision.snapshotId ?? null,
		strategyId: decision.strategyId ?? null,
		strategyVersion: decision.strategyVersion ?? null,
	};
}

function pickCandidate(candidate: Candidate, marketName?: string) {
	return {
		id: candidate.id,
		marketId: candidate.marketId,
		marketName: marketName ?? null,
		stage: candidate.stage,
		stageLabel: STAGE_LABELS[candidate.stage],
		owner: candidate.owner ?? null,
		tags: candidate.tags,
		gateOutcome: candidate.gateOutcome ?? null,
		gateReason: candidate.gateReason ?? null,
		score: candidate.score ?? null,
		stageReason: candidate.stageReason ?? null,
		stageReasonAt: candidate.stageReasonAt ?? null,
		stageReasonActor: candidate.stageReasonActor ?? null,
		decisionStatus: candidate.decisionStatus ?? null,
		decisionReason: candidate.decisionReason ?? null,
		decisionAt: candidate.decisionAt ?? null,
		decisionActor: candidate.decisionActor ?? null,
		createdAt: candidate.createdAt,
		updatedAt: candidate.updatedAt,
	};
}

function pickRule(rule: StrategyEvaluation["rules"][number]) {
	return {
		id: rule.id,
		stage: rule.stage,
		action: rule.action,
		label: rule.label,
		when: rule.when,
		status: rule.status,
		message: rule.message,
	};
}

function mapEvaluation(evaluation: StrategyEvaluation) {
	return {
		outcome: evaluation.outcome,
		outcomeLabel: outcomeLabel(evaluation.outcome),
		score: evaluation.score,
		dimensionScores: DIMENSION_SCORE_LABELS.map(({ key, label }) => ({
			key,
			label,
			score: typeof evaluation.dimensionScores[key] === "number" ? evaluation.dimensionScores[key] : null,
		})),
		rules: evaluation.rules.map(pickRule),
		missingMetrics: evaluation.missingMetrics,
	};
}

function latestRunForMarket(store: CompassStore, marketId: string): StrategyRun | undefined {
	return [...store.strategyRuns]
		.filter((run) => run.marketId === marketId)
		.sort((a, b) => b.runAt.localeCompare(a.runAt))[0];
}

function verdictStats(store: CompassStore) {
	const validated = store.outcomeChecks.filter((check) => check.verdict === "validated").length;
	const challenged = store.outcomeChecks.filter((check) => check.verdict === "challenged").length;
	const inconclusive = store.outcomeChecks.filter((check) => check.verdict === "inconclusive").length;
	const conclusive = validated + challenged;
	return {
		checks: store.outcomeChecks.length,
		validated,
		challenged,
		inconclusive,
		activeLessons: store.lessons.filter((lesson) => lesson.status === "active").length,
		// 验证率排除 inconclusive；无可判样本时为 null（前端显示 —）
		validationRate: conclusive ? validated / conclusive : null,
	};
}

export function overviewData(store: CompassStore, now = new Date().toISOString()) {
	now = resolveNow(now);
	// 预算月份必须由同一个 now 派生：listWorkbenchTodos 内部按 now 算预算待办，两者共用月界
	const pools = budgetStatus(store, now.slice(0, 7));
	const todos = listWorkbenchTodos(store, now);
	const rows = marketRows(store, now);
	const activeCandidates = store.candidates.filter((candidate) => !["archived", "review"].includes(candidate.stage)).length;
	const gate = {
		pass: store.candidates.filter((candidate) => candidate.gateOutcome === "pass").length,
		review: store.candidates.filter((candidate) => candidate.gateOutcome === "review").length,
		reject: store.candidates.filter((candidate) => candidate.gateOutcome === "reject").length,
	};
	const retro = verdictStats(store);
	const monthSpentCny = pools.reduce((sum, pool) => sum + pool.spentCny, 0);
	const totalCostCny = store.costEvents.reduce((sum, event) => sum + event.amountCny, 0);
	const attributedCny = store.costEvents.filter((event) => event.marketId).reduce((sum, event) => sum + event.amountCny, 0);
	return {
		summary: {
			markets: store.markets.length,
			activeCandidates,
			gateReview: gate.review,
			gateReject: gate.reject,
			retroDue: todos.filter((todo) => todo.kind === "retro_due").length,
			todoTotal: todos.length,
			todoP1: todos.filter((todo) => todo.priority === 1).length,
			validationRate: retro.validationRate,
			monthSpentCny,
			storeUpdatedAt: store.updatedAt,
		},
		kpi: {
			staleMarkets30d: rows.filter((row) => row.freshness === "stale" || row.freshness === "missing").length,
			gate,
			fusedPools: pools.filter((pool) => pool.state === "fused").length,
			totalCostCny,
			attributedCny,
			attributionRate: totalCostCny > 0 ? attributedCny / totalCostCny : 1,
		},
		stages: CANDIDATE_STAGES.map((stage) => ({
			stage,
			label: STAGE_LABELS[stage],
			count: store.candidates.filter((candidate) => candidate.stage === stage).length,
		})),
		todoCounts: TODO_PRIORITIES.map((priority) => ({
			priority,
			label: TODO_GROUP_LABELS[priority],
			count: todos.filter((todo) => todo.priority === priority).length,
		})),
		radar: rows.slice(0, 8),
		budget: pools,
		retro,
		gateDefaultsLine: gateDefaultsLine(store),
	};
}

export function todosData(store: CompassStore, now = new Date().toISOString()) {
	now = resolveNow(now);
	// WorkbenchTodo 本身就是派生只读 DTO（todo.ts），无懒加载字段，整体透传
	const todos = listWorkbenchTodos(store, now);
	return {
		total: todos.length,
		groups: TODO_PRIORITIES.map((priority) => ({
			priority,
			label: TODO_GROUP_LABELS[priority],
			todos: todos.filter((todo) => todo.priority === priority),
		})),
	};
}

export function marketsData(store: CompassStore, now = new Date().toISOString()) {
	now = resolveNow(now);
	const rows = marketRows(store, now);
	return {
		total: rows.length,
		gateCounts: {
			pass: rows.filter((row) => row.gateOutcome === "pass").length,
			review: rows.filter((row) => row.gateOutcome === "review").length,
			reject: rows.filter((row) => row.gateOutcome === "reject").length,
		},
		freshnessCounts: {
			deep_fresh: rows.filter((row) => row.freshness === "deep_fresh").length,
			screen_only: rows.filter((row) => row.freshness === "screen_only").length,
			stale: rows.filter((row) => row.freshness === "stale").length,
			missing: rows.filter((row) => row.freshness === "missing").length,
		},
		rows,
	};
}

export function marketDossierData(store: CompassStore, reference: string, now = new Date().toISOString()) {
	now = resolveNow(now);
	const market = findMarket(store, reference);
	const candidate = store.candidates.find((item) => item.marketId === market.id);
	const snapshot = latestSnapshotIfPresent(store, market.id);
	const units = targetMonthlyUnits(store);
	const age = snapshot ? ageDaysFrom(snapshot.capturedAt, now) : null;
	const freshness = freshnessTier(age);

	const run = latestRunForMarket(store, market.id);
	let evaluation: (ReturnType<typeof mapEvaluation> & { source: "run" | "preview"; mode: string; evaluatedAt: string | null; strategyRef: string | null }) | null = null;
	if (run) {
		evaluation = { ...mapEvaluation(run.result), source: "run", mode: run.mode, evaluatedAt: run.runAt, strategyRef: `${run.strategyId}@v${run.strategyVersion}` };
	} else if (snapshot) {
		try {
			// 无落库 run 时做一次只读预览评估；缺策略等异常不阻断档案页
			evaluation = { ...mapEvaluation(evaluateMarketWithoutPersisting(store, market.id)), source: "preview", mode: "screen", evaluatedAt: null, strategyRef: null };
		} catch (error) {
			// 有意降级：评估失败不阻断档案页，但留下痕迹便于排查（前端按"暂无评估"渲染）
			console.warn(`市场 ${market.id} 策略评估预览失败：${error instanceof Error ? error.message : String(error)}`);
			evaluation = null;
		}
	}

	let metricSections: Array<{ title: string; question: string; rows: MetricRowDto[] }> = [];
	if (snapshot) {
		const { context } = buildStrategyContext(store, market.id);
		metricSections = DIMENSIONS.map((dimension) => ({
			title: dimension.title,
			question: dimension.question,
			rows: dimension.metrics.map((key) => metricRow(key, context.metrics[key], units)),
		}));
	}

	return {
		market: { id: market.id, name: market.name, category: market.category ?? null, keywords: market.keywords, createdAt: market.createdAt, updatedAt: market.updatedAt },
		candidate: candidate ? pickCandidate(candidate) : null,
		snapshot: snapshot
			? {
				id: snapshot.id,
				source: snapshot.source,
				capturedAt: snapshot.capturedAt,
				importedAt: snapshot.importedAt,
				rowCount: snapshot.rowCount,
				warnings: snapshot.warnings,
				ageDays: age,
				freshness,
				freshnessLabel: FRESHNESS_LABELS[freshness],
			}
			: null,
		evaluation,
		metricSections,
		divergences: metricDivergences(store, market.id).map((item) => ({
			metric: item.metric,
			label: metricLabel(item.metric, units),
			divergence: item.divergence,
			values: item.values,
		})),
		decisionLog: [...store.decisionLog]
			.filter((decision) => decision.marketId === market.id)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, 30)
			.map(pickDecision),
		gateDefaultsLine: gateDefaultsLine(store),
	};
}

export function poolData(store: CompassStore, now = new Date().toISOString()) {
	now = resolveNow(now);
	const items = listPoolCandidates(store);
	return {
		total: items.length,
		gateCounts: {
			pass: items.filter(({ candidate }) => candidate.gateOutcome === "pass").length,
			review: items.filter(({ candidate }) => candidate.gateOutcome === "review").length,
			reject: items.filter(({ candidate }) => candidate.gateOutcome === "reject").length,
		},
		decisionCounts: {
			go: items.filter(({ candidate }) => candidate.decisionStatus === "go").length,
			waitlist: items.filter(({ candidate }) => candidate.decisionStatus === "waitlist").length,
			no_go: items.filter(({ candidate }) => candidate.decisionStatus === "no_go").length,
		},
		lanes: CANDIDATE_STAGES.map((stage) => ({
			stage,
			label: STAGE_LABELS[stage],
			count: items.filter(({ candidate }) => candidate.stage === stage).length,
			items: items
				.filter(({ candidate }) => candidate.stage === stage)
				.map(({ candidate, marketName }) => {
					const snapshot = latestSnapshotIfPresent(store, candidate.marketId);
					return {
						...pickCandidate(candidate, marketName),
						snapshotAgeDays: snapshot ? ageDaysFrom(snapshot.capturedAt, now) : null,
						snapshotSource: snapshot?.source ?? null,
					};
				}),
		})),
	};
}

// 决策页的核心指标：与粗筛/深研 Gate 口径一致的五个决策锚点
const KEY_DECISION_METRICS = ["qualify_rank_depth", "cr3", "new_listing_share_12m", "gross_margin", "cpc_ratio"] as const;

export function poolCandidateData(store: CompassStore, reference: string) {
	const { candidate, marketName, decisions } = candidateDetail(store, reference);
	const linkedRun = candidate.latestStrategyRunId ? store.strategyRuns.find((run) => run.id === candidate.latestStrategyRunId) : undefined;
	const run = linkedRun ?? latestRunForMarket(store, candidate.marketId);
	const units = targetMonthlyUnits(store);
	// 决策证据：与深研/待办同口径的完整指标上下文（无快照时全部按缺失展示）
	const metrics = latestSnapshotIfPresent(store, candidate.marketId)
		? buildStrategyContext(store, candidate.marketId).context.metrics
		: {};
	const profit = [...store.profitEstimates]
		.filter((item) => item.marketId === candidate.marketId)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	const risk = [...store.riskRecords]
		.filter((item) => item.marketId === candidate.marketId)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	const links = marketAmazonLinks(store, candidate.marketId);
	return {
		candidate: pickCandidate(candidate, marketName),
		decisions: decisions.slice(0, 50).map(pickDecision),
		// helper 侧保持 optional（工具面 TS 惯用形态）；DTO 出口把可选字段归一为 null，
		// 与本层「JSON 安全对象」惯例一致——前端既有判空惯例是严格 !== null
		links: {
			searches: links.searches,
			topListings: links.topListings.map((row) => ({
				rank: row.rank,
				asin: row.asin ?? null,
				url: row.url ?? null,
				title: row.title ?? null,
				price: row.price ?? null,
				rating: row.rating ?? null,
				monthlySales: row.monthlySales ?? null,
			})),
		},
		keyMetrics: KEY_DECISION_METRICS.map((key) => metricRow(key, metrics[key], units)),
		profitSummary: profit
			? {
				grossMargin: profit.result.grossMargin,
				breakEvenCpc: profit.result.breakEvenCpc,
				cpcRatio: profit.result.cpcRatio ?? null,
				startupCapital: profit.result.startupCapital,
				currency: profit.input.currency,
				createdAt: profit.createdAt,
			}
			: null,
		riskSummary: risk
			? {
				overall: risk.overall,
				certStatus: risk.certStatus,
				ipRiskLevel: risk.ipRiskLevel,
				seasonFlag: risk.seasonFlag,
				policyFlag: risk.policyFlag,
				logisticsRisk: risk.logisticsRisk,
				createdAt: risk.createdAt,
			}
			: null,
		latestRun: run
			? {
				id: run.id,
				mode: run.mode,
				runAt: run.runAt,
				strategyRef: `${run.strategyId}@v${run.strategyVersion}`,
				// mapEvaluation 是原手工字段的严格超集（多 dimensionScores）——决策页五维分的唯一来源
				...mapEvaluation(run.result),
			}
			: null,
	};
}

export function budgetData(store: CompassStore, month = new Date().toISOString().slice(0, 7)) {
	const pools = budgetStatus(store, month);
	const totalCostCny = store.costEvents.reduce((sum, event) => sum + event.amountCny, 0);
	const attributedCny = store.costEvents.filter((event) => event.marketId).reduce((sum, event) => sum + event.amountCny, 0);
	const marketNames = new Map(store.markets.map((market) => [market.id, market.name]));
	return {
		month,
		pools,
		events: [...store.costEvents]
			.filter((event) => event.createdAt.startsWith(month))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map((event) => ({
				id: event.id,
				createdAt: event.createdAt,
				source: event.source,
				amountCny: event.amountCny,
				description: event.description ?? null,
				kind: event.kind ?? null,
				tool: event.tool ?? null,
				calls: event.calls ?? null,
				actor: event.actor,
				marketId: event.marketId ?? null,
				marketName: event.marketId ? marketNames.get(event.marketId) ?? null : null,
			})),
		totals: {
			totalCostCny,
			attributedCny,
			attributionRate: totalCostCny > 0 ? attributedCny / totalCostCny : 1,
		},
	};
}

export function retroData(store: CompassStore, now = new Date().toISOString()) {
	now = resolveNow(now);
	const marketNames = new Map(store.markets.map((market) => [market.id, market.name]));
	return {
		due: listRetroDue(store, now),
		stats: verdictStats(store),
		recentChecks: [...store.outcomeChecks]
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, 6)
			.map((check) => ({
				id: check.id,
				marketId: check.marketId,
				marketName: marketNames.get(check.marketId) ?? null,
				verdict: check.verdict,
				verdictReason: check.verdictReason,
				elapsedDays: check.elapsedDays,
				createdAt: check.createdAt,
			})),
		lessons: store.lessons
			.filter((lesson) => lesson.status === "active")
			.map((lesson) => ({
				id: lesson.id,
				title: lesson.title,
				detail: lesson.detail,
				scope: lesson.scope,
				evidence: lesson.evidence,
				createdAt: lesson.createdAt,
			})),
	};
}

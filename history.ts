import type {
	Candidate,
	CompassStore,
	DecisionLog,
	DecisionStatus,
	Lesson,
	Market,
	MarketSnapshot,
	MetricMap,
	MetricScalar,
	OutcomeActuals,
	OutcomeCheck,
	OutcomeDelta,
	OutcomeVerdict,
	StrategyEvaluation,
	StrategyRun,
} from "./types.ts";
// 复盘报告与市场报告共用同一套「自由文本进 Markdown」的转义规则，别再内联复制一份。
// report.ts 只 import type，反向无依赖，不成环。
import { compareSnapshotRecency, compareSnapshotRecencyDesc } from "./defaults.ts";
import { escapeCell } from "./report.ts";

const DAY_MS = 86_400_000;

export const DEFAULT_RETRO_DUE_RULES = {
	goDays: 30,
	testingStaleDays: 60,
	waitlistDays: 45,
	noGoDays: 90,
	reviewDays: 30,
} as const;

export const DEFAULT_DELTA_METRICS = [
	"price_p50",
	"category_monthly_sales",
	"waist_monthly_sales",
	"qualify_rank_depth",
	"cr3",
	"amz_share",
	"new_listing_share_12m",
	"main_cpc",
] as const;

const PERCENT_METRICS = new Set([
	"cr3",
	"cr5",
	"cr10",
	"amz_share",
	"new_listing_share_12m",
	"traffic_concentration",
	"gross_margin",
	"tacos",
	"return_rate",
	"net_margin",
]);

const METRIC_LABELS: Record<string, string> = {
	price_p50: "价格中位数",
	category_monthly_sales: "类目月销",
	waist_monthly_sales: "腰部月销",
	qualify_rank_depth: "QRD",
	cr3: "CR3",
	cr5: "CR5",
	cr10: "CR10",
	hhi: "HHI",
	amz_share: "AMZ占比",
	new_listing_share_12m: "新品占比",
	main_cpc: "主词CPC",
	keyword_search_volume: "词族搜索量",
	traffic_concentration: "流量集中度",
	gross_margin: "毛利率",
	cpc_ratio: "CPC承受度",
};

const HIGHER_IS_BETTER = new Set([
	"category_monthly_sales",
	"category_monthly_revenue",
	"waist_monthly_sales",
	"qualify_rank_depth",
	"keyword_search_volume",
	"new_listing_share_12m",
	"gross_margin",
	"break_even_cpc",
	"pain_fixability",
	"est_rating_gap",
]);

const RISK_DIRECTION_METRICS = new Set(["risk_overall", "cert_status", "ip_risk_level", "season_flag", "policy_flag", "logistics_risk"]);
const RISK_STATUS_RANK: Record<string, number> = { red: 0, strong: 0, unknown: 1, review: 1, pass: 2, clear: 2 };

const LOWER_IS_BETTER = new Set([
	"cr3",
	"cr5",
	"cr10",
	"hhi",
	"amz_share",
	"main_cpc",
	"traffic_concentration",
	"waist_review_median",
	"cpc_ratio",
	"return_loss_rate",
	"capital_share",
]);

export interface HistoryTimelineItem {
	at: string;
	kind: "decision" | "strategy_run" | "snapshot" | "outcome_check" | "todo_resolution";
	id: string;
	marketId: string;
	candidateId?: string;
	summary: string;
	reason?: string;
	snapshotId?: string;
	strategy?: string;
	verdict?: OutcomeVerdict;
	// 待办处理事件专用（读侧合并，不落盘、不写 decisionLog）：动作与操作者
	action?: "submit" | "verify" | "complete" | "reopen";
	actor?: string;
}

export interface SimilarMarketResult {
	market: Market;
	score: number;
	keywordJaccard: number;
	categoryMatch: boolean;
	nameBigramOverlap: number;
	keywordOverlap: number;
	finalDecision?: DecisionStatus;
	decisionReason?: string;
	latestVerdict?: OutcomeVerdict;
	lessons: Lesson[];
}

export interface OutcomeStats {
	/** 对照次数：全部 OutcomeCheck 条数，不是比率分母 */
	total: number;
	/** validated + challenged 的原始条数（历史语义，非比率分母） */
	conclusive: number;
	/** 四率的分母：每个市场最新一条可判 check 只算一票（与 backtest alignment 同口径） */
	ratedMarkets: number;
	/** 无人工决策锚点的条数：策略自我对照，只留档不进任何比率 */
	strategyOnly: number;
	validated: number;
	challenged: number;
	inconclusive: number;
	validationRate: number | null;
	goAttainmentRate: number | null;
	noGoAccuracyRate: number | null;
	falseKillRate: number | null;
	byStrategy: Array<{
		strategy: string;
		validated: number;
		challenged: number;
		inconclusive: number;
		accuracy: number | null;
	}>;
}

export interface RetroDueConfig {
	goDays: number;
	testingStaleDays: number;
	waitlistDays: number;
	noGoDays: number;
	reviewDays: number;
}

export interface RetroDueItem {
	group: "go" | "waitlist" | "no_go" | "review";
	marketId: string;
	candidateId: string;
	marketName: string;
	dueAt: string;
	overdueDays: number;
	reason: string;
	suggestedAction: string;
}

export interface RuleReplayVerdict {
	verdict: OutcomeVerdict;
	reason: string;
}

export interface SessionLedgerItem {
	at: string;
	marketId?: string;
	candidateId?: string;
	action: string;
	conclusion: string;
	ids?: string[];
}

// 处理说明与理由是人工自由文本，可能含换行；时间线是单行展示面（compass_history 管道行），统一压平
function timelineText(value: string | undefined): string | undefined {
	const flattened = value?.replace(/\s+/gu, " ").trim();
	return flattened || undefined;
}

function parseTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function daysBetween(earlier: string, later: string): number {
	const start = parseTime(earlier);
	const end = parseTime(later);
	if (start === undefined || end === undefined || end <= start) return 0;
	return Math.floor((end - start) / DAY_MS);
}

function rounded(value: number, digits = 4): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

export function normalizeHistoryText(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

export function historyKeywordSet(values: string[]): Set<string> {
	const output = new Set<string>();
	for (const value of values) {
		const phrase = normalizeHistoryText(value);
		if (!phrase) continue;
		output.add(phrase);
		for (const token of phrase.split(" ")) if (token.length >= 2 || /^\d+$/u.test(token)) output.add(token);
	}
	return output;
}

function bigramSet(value: string): Set<string> {
	const normalized = normalizeHistoryText(value).replaceAll(" ", "");
	if (!normalized) return new Set();
	if (normalized.length === 1) return new Set([normalized]);
	const output = new Set<string>();
	for (let index = 0; index < normalized.length - 1; index++) output.add(normalized.slice(index, index + 2));
	return output;
}

export function jaccard<T>(left: Set<T>, right: Set<T>): number {
	if (!left.size && !right.size) return 0;
	let intersection = 0;
	for (const item of left) if (right.has(item)) intersection++;
	return intersection / (left.size + right.size - intersection);
}

function setOverlapCount<T>(left: Set<T>, right: Set<T>): number {
	let count = 0;
	for (const item of left) if (right.has(item)) count++;
	return count;
}

function latestDecision(store: CompassStore, marketId: string): DecisionLog | undefined {
	return store.decisionLog
		.filter((item) => item.marketId === marketId && item.type === "decision")
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function latestOutcome(store: CompassStore, marketId: string): OutcomeCheck | undefined {
	return store.outcomeChecks
		.filter((item) => item.marketId === marketId)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function candidateForMarket(store: CompassStore, marketId: string): Candidate | undefined {
	return store.candidates.find((candidate) => candidate.marketId === marketId);
}

// Lesson 召回分档，档与档之间不允许交叉：
// 0 = 写了市场维度 scope 却一条都没命中 → 不召回；
// LESSON_SCORE_GLOBAL = 没写市场维度 scope（含「只写了 metrics scope」）的通用经验，保底进
//   召回池，但恒低于任何一条命中 scope 的专属经验——否则最新的通用条会把 limit=1/2/3 的注入
//   面占满，专属经验永远排不进去；
// LESSON_SCORE_KEYWORD = 命中关键词的起步分，再命中类目额外加 LESSON_SCORE_CATEGORY。
// keywordHits 是 token 展开后的重合数（一个英文词组能贡献 3~6 个，且 for/holder 这类通用
// token 会跨市场误命中），量纲不可信，只作同档内的次级排序并封顶。
const LESSON_SCORE_GLOBAL = 1;
const LESSON_SCORE_KEYWORD = 10;
const LESSON_SCORE_CATEGORY = 100;
const LESSON_KEYWORD_HITS_CAP = 5;

function lessonMatchesMarket(lesson: Lesson, market: Market): number {
	if (lesson.status !== "active") return 0;
	const categories = new Set((lesson.scope.categories ?? []).map(normalizeHistoryText).filter(Boolean));
	const marketCategory = normalizeHistoryText(market.category ?? "");
	const categoryHit = marketCategory && categories.has(marketCategory) ? 1 : 0;
	const scopedKeywords = historyKeywordSet(lesson.scope.keywords ?? []);
	const marketKeywords = historyKeywordSet([market.name, ...market.keywords]);
	const keywordHits = setOverlapCount(scopedKeywords, marketKeywords);
	const hasMarketScope = categories.size > 0 || scopedKeywords.size > 0;
	if (!hasMarketScope) return LESSON_SCORE_GLOBAL;
	if (categoryHit === 0 && keywordHits === 0) return 0;
	return categoryHit * LESSON_SCORE_CATEGORY
		+ (keywordHits > 0 ? LESSON_SCORE_KEYWORD : 0)
		+ Math.min(keywordHits, LESSON_KEYWORD_HITS_CAP);
}

export function matchingLessonsForMarket(store: CompassStore, marketId: string, limit = 20): Lesson[] {
	const market = store.markets.find((item) => item.id === marketId);
	if (!market) return [];
	return store.lessons
		.map((lesson) => ({ lesson, score: lessonMatchesMarket(lesson, market) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || b.lesson.updatedAt.localeCompare(a.lesson.updatedAt))
		.slice(0, limit)
		.map((item) => item.lesson);
}

export function filterLessons(
	store: CompassStore,
	input: { category?: string; keywords?: string[]; metric?: string; includeRetired?: boolean; limit?: number },
): Lesson[] {
	const category = normalizeHistoryText(input.category ?? "");
	const keywords = historyKeywordSet(input.keywords ?? []);
	const metric = normalizeHistoryText(input.metric ?? "");
	return store.lessons
		.filter((lesson) => {
			if (!input.includeRetired && lesson.status !== "active") return false;
			if (category && !(lesson.scope.categories ?? []).some((item) => normalizeHistoryText(item) === category)) return false;
			if (keywords.size) {
				const scoped = historyKeywordSet(lesson.scope.keywords ?? []);
				if (setOverlapCount(keywords, scoped) === 0) return false;
			}
			if (metric && !(lesson.scope.metrics ?? []).some((item) => normalizeHistoryText(item) === metric)) return false;
			return true;
		})
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, input.limit ?? 100);
}

export function similarMarkets(
	store: CompassStore,
	input: {
		marketId?: string;
		name?: string;
		keywords?: string[];
		category?: string;
		threshold?: number;
		limit?: number;
	},
): SimilarMarketResult[] {
	const target = input.marketId ? store.markets.find((market) => market.id === input.marketId) : undefined;
	const name = input.name ?? target?.name ?? "";
	const keywords = input.keywords?.length ? input.keywords : target?.keywords ?? [];
	const category = normalizeHistoryText(input.category ?? target?.category ?? "");
	const targetKeywords = historyKeywordSet(keywords);
	const targetBigrams = bigramSet(name);
	const threshold = input.threshold ?? 0.35;
	return store.markets
		.filter((market) => market.id !== input.marketId)
		.map((market) => {
			const marketKeywords = historyKeywordSet(market.keywords);
			const keywordJaccard = jaccard(targetKeywords, marketKeywords);
			const categoryMatch = Boolean(category && normalizeHistoryText(market.category ?? "") === category);
			const nameBigramOverlap = jaccard(targetBigrams, bigramSet(market.name));
			const score = 0.6 * keywordJaccard + 0.25 * Number(categoryMatch) + 0.15 * nameBigramOverlap;
			const decision = latestDecision(store, market.id);
			const outcome = latestOutcome(store, market.id);
			const candidate = candidateForMarket(store, market.id);
			return {
				market,
				score: rounded(score),
				keywordJaccard: rounded(keywordJaccard),
				categoryMatch,
				nameBigramOverlap: rounded(nameBigramOverlap),
				keywordOverlap: setOverlapCount(targetKeywords, marketKeywords),
				finalDecision: decision?.decisionStatus ?? candidate?.decisionStatus,
				decisionReason: decision?.reason ?? candidate?.decisionReason,
				latestVerdict: outcome?.verdict,
				lessons: matchingLessonsForMarket(store, market.id, 3),
			};
		})
		.filter((item) => item.score >= threshold)
		.sort((a, b) => b.score - a.score || b.market.updatedAt.localeCompare(a.market.updatedAt))
		.slice(0, Math.min(input.limit ?? 3, 3));
}

export function marketMatchesPrompt(store: CompassStore, prompt: string): Market[] {
	const normalized = normalizeHistoryText(prompt);
	const compact = normalized.replaceAll(" ", "");
	const asinMatches = new Set((prompt.toUpperCase().match(/\bB0[A-Z0-9]{8}\b/gu) ?? []));
	return store.markets
		.map((market) => {
			const name = normalizeHistoryText(market.name);
			let score = name && normalized.includes(name) ? 100 + name.length : 0;
			for (const keyword of market.keywords) {
				const term = normalizeHistoryText(keyword);
				if (!term) continue;
				const minimum = /[\u3400-\u9fff]/u.test(term) ? 2 : 3;
				if (term.replaceAll(" ", "").length >= minimum && (normalized.includes(term) || compact.includes(term.replaceAll(" ", "")))) {
					score = Math.max(score, 20 + term.length);
				}
			}
			if (asinMatches.size) {
				const asinHit = store.snapshots
					.filter((snapshot) => snapshot.marketId === market.id)
					.some((snapshot) => snapshot.listings.some((listing) => listing.asin && asinMatches.has(listing.asin.toUpperCase())));
				if (asinHit) score = Math.max(score, 90);
			}
			return { market, score };
		})
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || b.market.updatedAt.localeCompare(a.market.updatedAt))
		.map((item) => item.market);
}

export function buildTimeline(store: CompassStore, marketId: string, candidateId?: string): HistoryTimelineItem[] {
	const decisions: HistoryTimelineItem[] = store.decisionLog
		.filter((item) => item.marketId === marketId && (!candidateId || !item.candidateId || item.candidateId === candidateId))
		.map((item) => ({
			at: item.createdAt,
			kind: "decision",
			id: item.id,
			marketId,
			candidateId: item.candidateId,
			summary: `${item.type} · ${item.conclusion}`,
			reason: item.reason,
			snapshotId: item.snapshotId,
			strategy: item.strategyId ? `${item.strategyId}@v${item.strategyVersion ?? "?"}` : undefined,
		}));
	const runs: HistoryTimelineItem[] = store.strategyRuns
		.filter((run) => run.marketId === marketId)
		.map((run) => ({
			at: run.runAt,
			kind: "strategy_run",
			id: run.id,
			marketId,
			candidateId,
			summary: `${run.mode} Gate=${run.result.outcome} · Score=${run.result.score}`,
			reason: run.result.rules.filter((rule) => rule.status !== "pass").map((rule) => `${rule.id}:${rule.status}`).join("、") || "全部规则通过",
			snapshotId: run.snapshotId,
			strategy: `${run.strategyId}@v${run.strategyVersion}`,
		}));
	const snapshots: HistoryTimelineItem[] = store.snapshots
		.filter((snapshot) => snapshot.marketId === marketId)
		.map((snapshot) => ({
			at: snapshot.capturedAt,
			kind: "snapshot",
			id: snapshot.id,
			marketId,
			candidateId,
			summary: `${snapshot.source} 快照 · ${snapshot.rowCount} 行`,
			reason: snapshot.warnings.length ? snapshot.warnings.join("；") : undefined,
			snapshotId: snapshot.id,
		}));
	const checks: HistoryTimelineItem[] = store.outcomeChecks
		.filter((check) => check.marketId === marketId && (!candidateId || !check.candidateId || check.candidateId === candidateId))
		.map((check) => ({
			at: check.createdAt,
			kind: "outcome_check",
			id: check.id,
			marketId,
			candidateId: check.candidateId,
			summary: `复盘 ${check.verdict} · ${check.elapsedDays}天 · ${check.baselineSnapshotId}→${check.evidenceSnapshotId ?? "actuals"}`,
			reason: check.verdictReason,
			snapshotId: check.evidenceSnapshotId,
			verdict: check.verdict,
		}));
	// 待办处理事件：读侧合并，回滚零影响（记录本身即审计链，不写 decisionLog）。
	// 预算两类记录只有 source、没有市场归属，自然不会进入任何市场时间线
	const resolutions: HistoryTimelineItem[] = [];
	for (const record of store.todoResolutions ?? []) {
		if (record.marketId !== marketId) continue;
		if (candidateId && record.candidateId && record.candidateId !== candidateId) continue;
		const base = { kind: "todo_resolution" as const, marketId, candidateId: record.candidateId };
		// 操作者写进 summary 而不是只放 action/actor 字段：时间线唯一的渲染面（compass_history）
		// 按 `at | kind | id | summary | reason` 逐行输出，不落进 summary 就答不出「谁处理、谁验证」
		const event = (actor: string | undefined, label: string) => `待办处理·${label} · ${actor ?? "未知操作者"} · ${record.titleSnapshot}`;
		for (const [index, attempt] of record.attempts.entries()) {
			const round = record.attempts.length > 1 ? `（第 ${index + 1} 轮）` : "";
			resolutions.push({
				...base,
				at: attempt.submittedAt,
				id: `${record.id}:submit:${index}`,
				summary: event(attempt.submittedBy, `提交${round}`),
				reason: timelineText(attempt.note),
				actor: attempt.submittedBy,
				action: "submit",
			});
			if (!attempt.verdict) continue;
			resolutions.push({
				...base,
				at: attempt.verifiedAt ?? attempt.submittedAt,
				id: `${record.id}:verify:${index}`,
				summary: event(attempt.verifiedBy, `${attempt.verdict === "pass" ? "验证通过" : "验证驳回"}${round}`),
				reason: timelineText(attempt.verdictReason),
				actor: attempt.verifiedBy,
				action: "verify",
			});
		}
		// 记录只留最近一次勾选（resolvedAt 被下一次勾选整体覆盖，见 spec §4.2.3 已知局限），
		// 重开次数仍可从 reopens 全量读出
		if (record.resolvedAt) {
			resolutions.push({
				...base,
				at: record.resolvedAt,
				id: `${record.id}:complete`,
				summary: event(record.resolvedBy, "勾选已处理"),
				action: "complete",
				actor: record.resolvedBy,
			});
		}
		for (const [index, reopen] of record.reopens.entries()) {
			resolutions.push({
				...base,
				at: reopen.reopenedAt,
				id: `${record.id}:reopen:${index}`,
				summary: event(reopen.reopenedBy, "重开"),
				reason: timelineText(reopen.reason),
				actor: reopen.reopenedBy,
				action: "reopen",
			});
		}
	}
	// id 兜底让同一时刻的事件顺序确定，不依赖集合在 store 中的物理顺序
	return [...decisions, ...runs, ...snapshots, ...checks, ...resolutions]
		.sort((a, b) => b.at.localeCompare(a.at) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

export function searchDecisionHistory(
	store: CompassStore,
	input: {
		query?: string;
		types?: DecisionLog["type"][];
		decisionStatus?: DecisionStatus;
		actor?: string;
		since?: string;
		until?: string;
		limit?: number;
	},
): DecisionLog[] {
	const query = normalizeHistoryText(input.query ?? "");
	const actor = normalizeHistoryText(input.actor ?? "");
	const since = parseTime(input.since);
	const until = parseTime(input.until);
	return store.decisionLog
		.filter((item) => {
			if (input.types?.length && !input.types.includes(item.type)) return false;
			if (input.decisionStatus && item.decisionStatus !== input.decisionStatus) return false;
			if (actor && !normalizeHistoryText(item.actor).includes(actor)) return false;
			const at = parseTime(item.createdAt);
			if (since !== undefined && (at === undefined || at < since)) return false;
			if (until !== undefined && (at === undefined || at > until)) return false;
			if (query) {
				const market = store.markets.find((candidate) => candidate.id === item.marketId);
				const haystack = normalizeHistoryText(`${market?.name ?? ""} ${item.conclusion} ${item.reason} ${item.actor} ${item.id}`);
				if (!haystack.includes(query)) return false;
			}
			return true;
		})
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.slice(0, input.limit ?? 100);
}

function scalarDirection(metric: string, baseline: MetricScalar, current: MetricScalar): OutcomeDelta["direction"] {
	if (baseline === null || current === null) return "unknown";
	if (typeof baseline === "number" && typeof current === "number" && Number.isFinite(baseline) && Number.isFinite(current)) {
		const tolerance = Math.max(1e-9, Math.max(Math.abs(baseline), Math.abs(current)) * 0.005);
		if (Math.abs(current - baseline) <= tolerance) return "flat";
		if (HIGHER_IS_BETTER.has(metric)) return current > baseline ? "improved" : "worsened";
		if (LOWER_IS_BETTER.has(metric)) return current < baseline ? "improved" : "worsened";
		return "unknown";
	}
	if (baseline === current) return "flat";
	if (RISK_DIRECTION_METRICS.has(metric) && typeof baseline === "string" && typeof current === "string") {
		const before = RISK_STATUS_RANK[baseline];
		const after = RISK_STATUS_RANK[current];
		if (before !== undefined && after !== undefined) return after > before ? "improved" : after < before ? "worsened" : "flat";
	}
	return "unknown";
}

export function calculateMetricDeltas(
	baseline: MetricMap,
	current: MetricMap,
	metrics: Iterable<string> = DEFAULT_DELTA_METRICS,
): OutcomeDelta[] {
	const output: OutcomeDelta[] = [];
	for (const metric of new Set(metrics)) {
		const before = baseline[metric]?.value ?? null;
		const after = current[metric]?.value ?? null;
		output.push({ metric, baseline: before, current: after, direction: scalarDirection(metric, before, after) });
	}
	return output;
}

export function strategyReferencedMetrics(run: StrategyRun | undefined): string[] {
	if (!run) return [];
	return [...new Set(run.result.rules.flatMap((rule) => rule.references))];
}

export function replayOutcomeVerdict(
	baselineRun: StrategyRun | undefined,
	currentEvaluation: StrategyEvaluation | undefined,
	deltas: OutcomeDelta[],
): RuleReplayVerdict {
	if (!baselineRun || !currentEvaluation) return { verdict: "inconclusive", reason: "缺少可重放的基线策略运行或策略版本" };
	const failed = baselineRun.result.rules.filter((rule) => rule.status === "veto" || rule.status === "fail");
	if (!failed.length) return { verdict: "inconclusive", reason: "基线没有可用于检验否决前提的 veto/fail 规则" };
	const currentById = new Map(currentEvaluation.rules.map((rule) => [rule.id, rule]));
	const replayed = failed.map((rule) => currentById.get(rule.id));
	if (replayed.some((rule) => !rule || ["missing", "error", "review"].includes(rule.status))) {
		return { verdict: "inconclusive", reason: "重放基线失败规则时存在缺数据、规则错误或人工复核项" };
	}
	const stillFailing = failed.filter((rule) => {
		const current = currentById.get(rule.id);
		return current?.status === "veto" || current?.status === "fail";
	});
	if (stillFailing.length) {
		return { verdict: "validated", reason: `基线否决前提仍成立：${stillFailing.map((rule) => rule.id).join("、")}` };
	}
	const references = new Set(failed.flatMap((rule) => rule.references));
	const improved = deltas.filter((delta) => references.has(delta.metric) && delta.direction === "improved");
	if (improved.length) {
		return { verdict: "challenged", reason: `基线 ${failed.length} 条失败规则已全部转 pass，且关键指标改善：${improved.map((item) => item.metric).join("、")}` };
	}
	return { verdict: "inconclusive", reason: "基线失败规则已转 pass，但没有足够的可比关键指标证明前提改善" };
}

export function actualsOutcomeVerdict(actuals: OutcomeActuals, targetDailyUnits = 10): RuleReplayVerdict {
	const units = actuals.dailyUnits;
	const margin = actuals.netMargin;
	if (typeof units !== "number" || !Number.isFinite(units) || typeof margin !== "number" || !Number.isFinite(margin)) {
		return { verdict: "inconclusive", reason: "日销与净利率必须同时有实绩，当前证据不足" };
	}
	if (units >= targetDailyUnits * 0.7 && margin > 0) {
		return { verdict: "validated", reason: `实绩日销 ${units} 达目标 ${(units / targetDailyUnits * 100).toFixed(0)}%，且净利率 ${(margin * 100).toFixed(1)}% 为正` };
	}
	if (units < targetDailyUnits * 0.4 || margin < 0) {
		return { verdict: "challenged", reason: `实绩未达退出线：日销 ${units}（目标 ${targetDailyUnits}），净利率 ${(margin * 100).toFixed(1)}%` };
	}
	return { verdict: "inconclusive", reason: `实绩处于观察区：日销 ${units}（目标 ${targetDailyUnits}），净利率 ${(margin * 100).toFixed(1)}%` };
}

// 可判 check：有人工决策锚点（go / no_go）且结论不是 inconclusive。
// 与 service.ts 的 desiredOutcomeForCheck 是同一道判据——那边把它翻译成期望 outcome，这里只做筛选，
// 两边共用本函数，杜绝「比率认这条、alignment 不认」的双口径。
// decisionStatus 为空（粗筛 reject 但从未有人决策）的 check 只是策略结论的自我对照，
// 不代表任何被验证过的人为判断，一律不进比率——否则从未决策的市场每周例行导入一次
// 就能把「验证率」拉到任意数字（审计 G15）。
export function isComparableCheck(check: OutcomeCheck): boolean {
	return check.verdict !== "inconclusive" && (check.decisionStatus === "go" || check.decisionStatus === "no_go");
}

// 比率样本 = 每个市场最新一条可判 check。同一市场刷 N 次快照只算一票，
// 否则长期跟踪对象会按对照次数主导四率（同一份 store 的 backtest alignment 却是按市场算的，
// 两套权重就是审计 G16 的问题）。同毫秒并列时按 id 降序兜底：调用方传进来的数组有的是原始
// 追加序、有的已按 createdAt 倒序排过，用数组下标做次序会让同一份 store 在不同入口算出不同的「最新」。
export function latestComparableChecks(checks: readonly OutcomeCheck[]): OutcomeCheck[] {
	const latest = new Map<string, OutcomeCheck>();
	for (const check of [...checks].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))) {
		if (isComparableCheck(check) && !latest.has(check.marketId)) latest.set(check.marketId, check);
	}
	return [...latest.values()];
}

export function outcomeStatistics(store: CompassStore, checks = store.outcomeChecks): OutcomeStats {
	const validated = checks.filter((check) => check.verdict === "validated").length;
	const challenged = checks.filter((check) => check.verdict === "challenged").length;
	const inconclusive = checks.filter((check) => check.verdict === "inconclusive").length;
	const conclusive = validated + challenged;
	// 四率一律走去重样本；validated/challenged/inconclusive 与 total 保持原始条数语义（= 对照次数）
	const rated = latestComparableChecks(checks);
	const go = rated.filter((check) => check.decisionStatus === "go");
	const noGo = rated.filter((check) => check.decisionStatus === "no_go");
	const groups = new Map<string, { validated: number; challenged: number; inconclusive: number }>();
	for (const check of checks) {
		const run = check.baselineRunId ? store.strategyRuns.find((candidate) => candidate.id === check.baselineRunId) : undefined;
		const strategy = run ? `${run.strategyId}@v${run.strategyVersion}` : "无策略锚点";
		const group = groups.get(strategy) ?? { validated: 0, challenged: 0, inconclusive: 0 };
		group[check.verdict]++;
		groups.set(strategy, group);
	}
	return {
		total: checks.length,
		conclusive,
		ratedMarkets: rated.length,
		strategyOnly: checks.filter((check) => check.decisionStatus === undefined).length,
		validated,
		challenged,
		inconclusive,
		validationRate: rated.length ? rated.filter((check) => check.verdict === "validated").length / rated.length : null,
		goAttainmentRate: go.length ? go.filter((check) => check.verdict === "validated").length / go.length : null,
		noGoAccuracyRate: noGo.length ? noGo.filter((check) => check.verdict === "validated").length / noGo.length : null,
		falseKillRate: noGo.length ? noGo.filter((check) => check.verdict === "challenged").length / noGo.length : null,
		byStrategy: [...groups.entries()].map(([strategy, group]) => {
			const denominator = group.validated + group.challenged;
			return { strategy, ...group, accuracy: denominator ? group.validated / denominator : null };
		}).sort((a, b) => b.validated + b.challenged - a.validated - a.challenged),
	};
}

// 天数只按整天算。小数一律回落缺省而不是 Math.floor：0.5 会被压成 0 天，
// 那会让 retro_due 恒为到期、录了实绩也清不掉。保存侧（strategy.ts 的
// POSITIVE_INTEGER_META_FIELDS）已经拒了这种值，这里是存量 store 的兜底。
function positiveInteger(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Number.isInteger(value) ? value : fallback;
}

export function retroDueConfig(meta?: Record<string, unknown>): RetroDueConfig {
	return {
		goDays: positiveInteger(meta?.retro_go_days, DEFAULT_RETRO_DUE_RULES.goDays),
		testingStaleDays: positiveInteger(meta?.retro_testing_stale_days, DEFAULT_RETRO_DUE_RULES.testingStaleDays),
		waitlistDays: positiveInteger(meta?.retro_waitlist_days, DEFAULT_RETRO_DUE_RULES.waitlistDays),
		noGoDays: positiveInteger(meta?.retro_no_go_days, DEFAULT_RETRO_DUE_RULES.noGoDays),
		reviewDays: positiveInteger(meta?.retro_review_days, DEFAULT_RETRO_DUE_RULES.reviewDays),
	};
}

function addDays(value: string, days: number): string {
	const time = parseTime(value) ?? 0;
	return new Date(time + days * DAY_MS).toISOString();
}

function latestStageMove(store: CompassStore, candidate: Candidate, stage?: string): DecisionLog | undefined {
	return store.decisionLog
		.filter((log) => log.candidateId === candidate.id && log.type === "stage_move" && (!stage || log.conclusion.endsWith(`→ ${stage}`)))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function latestCheckForCandidate(store: CompassStore, candidate: Candidate): OutcomeCheck | undefined {
	return store.outcomeChecks
		.filter((check) => check.candidateId === candidate.id || check.marketId === candidate.marketId)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function makeDueItem(
	group: RetroDueItem["group"],
	market: Market,
	candidate: Candidate,
	dueAt: string,
	now: string,
	reason: string,
	suggestedAction: string,
): RetroDueItem | undefined {
	const due = parseTime(dueAt);
	const current = parseTime(now);
	if (due === undefined || current === undefined || current < due) return undefined;
	return {
		group,
		marketId: market.id,
		candidateId: candidate.id,
		marketName: market.name,
		dueAt,
		overdueDays: Math.max(0, Math.floor((current - due) / DAY_MS)),
		reason,
		suggestedAction,
	};
}

export function dueRetroItems(
	store: CompassStore,
	now = new Date().toISOString(),
	config: RetroDueConfig = retroDueConfig(),
): RetroDueItem[] {
	const due: RetroDueItem[] = [];
	for (const candidate of store.candidates) {
		const market = store.markets.find((item) => item.id === candidate.marketId);
		if (!market) continue;
		const check = latestCheckForCandidate(store, candidate);
		const actualsCheck = store.outcomeChecks
			.filter((outcome) => (outcome.candidateId === candidate.id || outcome.marketId === candidate.marketId) && outcome.actuals !== undefined)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
		const decisionAt = candidate.decisionAt ?? latestDecision(store, market.id)?.createdAt;
		if (candidate.decisionStatus === "go" && candidate.stage === "testing" && decisionAt) {
			const cadenceBase = actualsCheck && actualsCheck.createdAt > decisionAt ? actualsCheck.createdAt : decisionAt;
			const stageAt = latestStageMove(store, candidate, "testing")?.createdAt ?? candidate.updatedAt;
			const cadenceDue = addDays(cadenceBase, config.goDays);
			const staleDue = addDays(stageAt, config.testingStaleDays);
			const selectedDue = cadenceDue < staleDue ? cadenceDue : staleDue;
			const item = makeDueItem("go", market, candidate, selectedDue, now, selectedDue === staleDue ? "testing 阶段停留超过上限" : "go 品实绩复盘周期到期", "录入日销、TACOS、退货率和净利率");
			if (item) due.push(item);
		}
		if (candidate.decisionStatus === "waitlist" && decisionAt) {
			const moved = latestStageMove(store, candidate)?.createdAt;
			const activity = [decisionAt, moved, check?.createdAt].filter((item): item is string => Boolean(item)).sort().at(-1) as string;
			const item = makeDueItem("waitlist", market, candidate, addDays(activity, config.waitlistDays), now, "waitlist 长期未更新", "升级重评，或记录 no_go 原因");
			if (item) due.push(item);
		}
		if (candidate.decisionStatus === "no_go" && decisionAt) {
			const latestEvidenceSnapshot = check?.evidenceSnapshotId
				? store.snapshots.find((snapshot) => snapshot.id === check.evidenceSnapshotId)
				: undefined;
			const decision = latestDecision(store, market.id);
			const baseline = decision?.snapshotId ? store.snapshots.find((snapshot) => snapshot.id === decision.snapshotId) : undefined;
			// 「未对照的新快照」同样按 (capturedAt, importedAt) 二元组比较：同日重导的修正版
			// 若只比 capturedAt 会被判成「不比证据新」而永远不触发错杀回看。
			// 退化到 decisionAt 时没有对应快照，用决策时刻兜底两端（importedAt 取同值）。
			const evidenceRecency = latestEvidenceSnapshot ?? baseline ?? { capturedAt: decisionAt, importedAt: decisionAt };
			const unseenSnapshot = store.snapshots
				.filter((snapshot) => snapshot.marketId === market.id && compareSnapshotRecency(snapshot, evidenceRecency) > 0)
				.filter((snapshot) => !store.outcomeChecks.some((outcome) => outcome.marketId === market.id && outcome.evidenceSnapshotId === snapshot.id))
				.sort(compareSnapshotRecencyDesc)[0];
			const item = unseenSnapshot
				? makeDueItem("no_go", market, candidate, unseenSnapshot.importedAt, now, `存在未对照的新快照 ${unseenSnapshot.id}`, "重放当时否决规则，检查是否错杀")
				: makeDueItem("no_go", market, candidate, addDays(check?.createdAt ?? decisionAt, config.noGoDays), now, "no_go 抽样回看周期到期", "导入新快照后执行错杀回看");
			if (item) due.push(item);
		}
		if (candidate.stage === "review") {
			const stageAt = latestStageMove(store, candidate, "review")?.createdAt ?? candidate.updatedAt;
			const hasCheckAfterStage = Boolean(check && check.createdAt >= stageAt);
			if (!hasCheckAfterStage) {
				const item = makeDueItem("review", market, candidate, addDays(stageAt, config.reviewDays), now, "进入 review 后尚无 OutcomeCheck", "执行市场对照或录入实绩");
				if (item) due.push(item);
			}
		}
	}
	return due.sort((a, b) => b.overdueDays - a.overdueDays || a.dueAt.localeCompare(b.dueAt));
}

function formatScalar(metric: string, value: MetricScalar): string {
	if (value === null) return "—";
	if (typeof value === "number") {
		if (PERCENT_METRICS.has(metric)) return `${(value * 100).toFixed(1)}%`;
		return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
	}
	return String(value);
}

export function formatDelta(delta: OutcomeDelta): string {
	const label = METRIC_LABELS[delta.metric] ?? delta.metric;
	return `${label} ${formatScalar(delta.metric, delta.baseline)}→${formatScalar(delta.metric, delta.current)} (${delta.direction})`;
}

export function capHistoryLines(lines: string[], maxLines: number, maxChars: number): string[] {
	const output: string[] = [];
	let chars = 0;
	const perLineLimit = Math.max(120, Math.floor(maxChars / Math.max(2, Math.min(maxLines, 8))));
	for (const raw of lines) {
		if (output.length >= maxLines) break;
		const line = raw.replace(/[\r\n]+/gu, " ").trim();
		if (!line) continue;
		const remaining = maxChars - chars;
		if (remaining <= 1) break;
		const limit = Math.min(remaining, perLineLimit);
		const clipped = line.length > limit ? `${line.slice(0, Math.max(0, limit - 1))}…` : line;
		output.push(clipped);
		chars += clipped.length + 1;
	}
	return output;
}

export function renderHistoryBrief(
	store: CompassStore,
	// gapSummary 由调用方派生后传进来：history.ts 只吃 store + 入参，不 import gaps.ts，
	// 也不把「全量待办推导」的成本压进每轮 prompt 都跑的 before_agent_start
	input: { marketId?: string; queryKeywords?: string[]; dueCount?: number; gapSummary?: { total: number; auto: number; confirm: number; manual: number } },
): string {
	const lines = ["【罗盘历史速览】（自动注入，证据以快照为准）"];
	const market = input.marketId ? store.markets.find((item) => item.id === input.marketId) : undefined;
	if (market) {
		const candidate = candidateForMarket(store, market.id);
		const decision = latestDecision(store, market.id);
		const snapshots = store.snapshots.filter((item) => item.marketId === market.id).sort(compareSnapshotRecencyDesc);
		const outcome = latestOutcome(store, market.id);
		lines.push(`· 命中市场「${market.name}」：stage=${candidate?.stage ?? "—"}，${decision?.createdAt.slice(0, 10) ?? "未决策"} ${decision?.decisionStatus ?? candidate?.decisionStatus ?? "—"}（${decision?.reason ?? candidate?.decisionReason ?? "尚无最终理由"}）`);
		if (snapshots[0]) lines.push(`· 最新快照：${snapshots[0].id} · ${snapshots[0].capturedAt.slice(0, 10)} · ${snapshots[0].source}${outcome ? `；最近复盘 ${outcome.verdict}（${outcome.id}）` : "；尚无复盘对照"}`);
		const similar = similarMarkets(store, { marketId: market.id, limit: 1 })[0];
		if (similar) lines.push(`· 相似历史：${similar.market.id}（关键词重合 ${similar.keywordOverlap}）→ ${similar.finalDecision ?? "未决策"}${similar.latestVerdict ? `，复盘 ${similar.latestVerdict}` : ""}（${similar.decisionReason ?? "无最终理由"}）`);
		const lesson = matchingLessonsForMarket(store, market.id, 1)[0];
		if (lesson) lines.push(`· 相关经验 ${lesson.id}：${lesson.title}（evidence: ${lesson.evidence.slice(0, 3).join("、")}）`);
	} else if (input.queryKeywords?.length) {
		const similar = similarMarkets(store, { name: input.queryKeywords.join(" "), keywords: input.queryKeywords, limit: 1 })[0];
		if (similar) lines.push(`· 相似历史：${similar.market.id}「${similar.market.name}」→ ${similar.finalDecision ?? "未决策"}${similar.latestVerdict ? `，复盘 ${similar.latestVerdict}` : ""}`);
		const lesson = filterLessons(store, { keywords: input.queryKeywords, limit: 1 })[0];
		if (lesson) lines.push(`· 相关经验 ${lesson.id}：${lesson.title}（evidence: ${lesson.evidence.slice(0, 3).join("、")}）`);
	}
	const dueCount = input.dueCount ?? dueRetroItems(store).length;
	if (dueCount > 0) lines.push(`· 待复盘：${dueCount} 个候选逾期 → compass_retro action=due`);
	const gaps = input.gapSummary;
	if (gaps && gaps.total > 0) lines.push(`· 补数缺口 ${gaps.total}：可自动 ${gaps.auto} / 需确认 ${gaps.confirm} / 人工 ${gaps.manual} → compass_gaps list`);
	if (market) lines.push(`详情：compass_history action=timeline market_ref=${market.id}；本摘要不替代快照证据。`);
	else lines.push("详情：compass_history action=similar；本摘要不替代快照证据。");
	return capHistoryLines(lines, 12, 1_200).join("\n");
}

export function renderHistoryNote(lines: string[]): string[] {
	return capHistoryLines(lines, 8, 1_600);
}

export function renderSessionLedger(items: SessionLedgerItem[]): string {
	const lines = ["【本会话罗盘操作台账｜压缩时必须保留】"];
	for (const item of items.slice(-12)) {
		const conclusion = item.conclusion.length > 140 ? `${item.conclusion.slice(0, 139)}…` : item.conclusion;
		const ids = item.ids?.slice(0, 5);
		lines.push(`· ${item.at.slice(11, 19)} ${item.action} ${item.marketId ?? "—"}${item.candidateId ? `/${item.candidateId}` : ""} → ${conclusion}${ids?.length ? ` [${ids.join(",")}${item.ids && item.ids.length > ids.length ? ",…" : ""}]` : ""}`);
	}
	lines.push("压缩后不得重复执行以上已完成动作；需要详情时用 compass_history timeline 查询。");
	return capHistoryLines(lines, 20, 4_000).join("\n");
}

function percent(value: number | null): string {
	return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

// 报告的「日」必须是运营看的本地日历日，而不是 UTC 日：原先标题、文件名与「本次沉淀经验」
// 三处都取 generatedAt.slice(0, 10)，沪时早 8 点前生成会写成昨天并原子覆盖昨晚那份同名报告，
// 8 点后又会把当天凌晨（UTC 仍属昨天）沉淀的 Lesson 漏出 §5——月界两侧同一张卡一含一漏。
export interface LocalReportStamp {
	/** 本地日历日 YYYY-MM-DD */
	date: string;
	/** 本地 24 小时钟 HHmm */
	time: string;
}

export function localReportStamp(iso: string, timeZone?: string): LocalReportStamp {
	const parsed = parseTime(iso);
	// 解析不出时间戳就退回 ISO 前缀：宁可标题退化成 UTC 日，也不要让整份报告抛异常
	if (parsed === undefined) return { date: iso.slice(0, 10), time: "0000" };
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(parsed));
	const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
	return { date: `${pick("year")}-${pick("month")}-${pick("day")}`, time: `${pick("hour")}${pick("minute")}` };
}

// 文件名带本地 HHmm：同一天多次生成不再互相覆盖，且路径本身唯一，可直接当 sourceRetro 的配对键。
// 落盘产物仍只有 .md，路径仍由调用方过 resolveOutputPath 限制在 .pi/compass/reports/ 内。
export function retroReportFileName(generatedAt = new Date().toISOString(), timeZone?: string): string {
	const stamp = localReportStamp(generatedAt, timeZone);
	return `retro-${stamp.date}-${stamp.time}.md`;
}

export interface RetroReportOptions {
	/** 本次报告的落盘路径（相对或绝对均可）：与 Lesson.sourceRetro 按文件名精确配对 */
	outputPath?: string;
	/** 上一份复盘报告的落盘时刻（ISO）：sourceRetro 缺失时「本次沉淀」时间窗的开区间下界 */
	previousRetroAt?: string;
	/** 日历时区，缺省用进程本地时区；测试传入以固定断言 */
	timeZone?: string;
}

// sourceRetro 存的是 relative(ctx.cwd, output)，不同入口可能给相对或绝对路径，
// 统一退到文件名比较——文件名已含本地日期 + HHmm，在同一个 reports 目录内唯一
function retroPathKey(path: string | undefined): string | undefined {
	const name = path?.split(/[\\/]/u).pop()?.trim();
	return name ? name.toLowerCase() : undefined;
}

export function renderRetroReport(
	store: CompassStore,
	generatedAt = new Date().toISOString(),
	dueConfig: RetroDueConfig = retroDueConfig(),
	options: RetroReportOptions = {},
): string {
	const checks = [...store.outcomeChecks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const stats = outcomeStatistics(store, checks);
	const decisions = store.candidates.filter((candidate) => candidate.decisionStatus);
	const distribution = {
		go: decisions.filter((candidate) => candidate.decisionStatus === "go").length,
		waitlist: decisions.filter((candidate) => candidate.decisionStatus === "waitlist").length,
		no_go: decisions.filter((candidate) => candidate.decisionStatus === "no_go").length,
	};
	const cycles = decisions
		.map((candidate) => candidate.decisionAt && parseTime(candidate.createdAt) !== undefined && parseTime(candidate.decisionAt) !== undefined ? daysBetween(candidate.createdAt, candidate.decisionAt) : undefined)
		.filter((value): value is number => value !== undefined);
	const averageCycle = cycles.length ? cycles.reduce((sum, value) => sum + value, 0) / cycles.length : null;
	const challenged = checks.filter((check) => check.verdict === "challenged");
	const blame = new Map<string, number>();
	for (const check of challenged) {
		const run = check.baselineRunId ? store.strategyRuns.find((candidate) => candidate.id === check.baselineRunId) : undefined;
		for (const rule of run?.result.rules.filter((item) => item.status === "veto" || item.status === "fail") ?? []) blame.set(rule.id, (blame.get(rule.id) ?? 0) + 1);
	}
	const activeLessons = store.lessons.filter((lesson) => lesson.status === "active").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const stamp = localReportStamp(generatedAt, options.timeZone);
	const reportDate = stamp.date;
	const outputKey = retroPathKey(options.outputPath);
	const generatedTime = parseTime(generatedAt);
	const windowStart = parseTime(options.previousRetroAt);
	// 「本次沉淀」= 结构化归属 ∪ 时间窗兜底，取并集而不是二选一：
	// ① sourceRetro 指向本次报告（/compass-retro 命令流落盘后回填）；
	// ② 工具面直调 compass_retro action=save_lesson 不传 source_retro，只能靠时间窗——
	//    调用方给得出上一份报告就用「上一份之后」，给不出就退到本地日历日当天。
	// 错位的最坏情况必须是多列一条、绝不能是漏列，因此只收下界，不做别的裁剪。
	const reportLessons = activeLessons.filter((lesson) => {
		if (outputKey && retroPathKey(lesson.sourceRetro) === outputKey) return true;
		const createdAt = parseTime(lesson.createdAt);
		if (createdAt === undefined) return false;
		if (generatedTime !== undefined && createdAt > generatedTime) return false;
		if (windowStart !== undefined) return createdAt > windowStart;
		return localReportStamp(lesson.createdAt, options.timeZone).date === reportDate;
	});
	// 复盘节奏由调用方注入（service.generateRetroReport 取默认策略 meta），
	// history.ts 不再自己找「默认策略」，省掉一处会随 meta.name 静默失配的 id 字面量。
	const due = dueRetroItems(store, generatedAt, dueConfig);
	const lines = [
		`# 罗盘复盘报告｜${reportDate}`,
		"",
		`> 生成时间：${generatedAt} · 对照次数 ${checks.length} 次 · 比率样本 ${stats.ratedMarkets} 个市场（按市场去重：同一市场只取最新一条可判对照）· 本报告为经营复盘辅助，店铺实绩以 SP-API/后台为准。`,
		"",
		"## 1. 台账概览",
		"",
		`- 决策分布：go ${distribution.go} / waitlist ${distribution.waitlist} / no_go ${distribution.no_go}。`,
		`- 平均决策周期：${averageCycle === null ? "—" : `${averageCycle.toFixed(1)} 天`}。`,
		`- 验证率：${percent(stats.validationRate)}；go 达成率：${percent(stats.goAttainmentRate)}；no_go 正确率：${percent(stats.noGoAccuracyRate)}；错杀率：${percent(stats.falseKillRate)}（四率按市场去重，样本 ${stats.ratedMarkets} 个市场；无决策锚点与 inconclusive 不计入）。`,
		`- 结论分布（按对照次数 ${stats.total} 次）：validated ${stats.validated} / challenged ${stats.challenged} / inconclusive ${stats.inconclusive}。`,
		"",
		"## 2. 逐项对照",
		"",
		"| 时间 | 市场 / 候选 | T0 决策 | T1 证据 | verdict | 关键 delta / 理由 |",
		"|---|---|---|---|---|---|",
	];
	for (const check of checks.slice(0, 100)) {
		const market = store.markets.find((item) => item.id === check.marketId);
		const evidence = check.evidenceSnapshotId ?? (check.actuals ? `实绩：日销${check.actuals.dailyUnits ?? "—"}/净利${typeof check.actuals.netMargin === "number" ? `${(check.actuals.netMargin * 100).toFixed(1)}%` : "—"}` : "缺证据");
		const delta = check.deltas.filter((item) => item.direction !== "flat").slice(0, 3).map(formatDelta).join("；") || check.verdictReason;
		// 市场名与 evidence 原先完全没转义：名字里一个 | 就能把整行错列。
		lines.push(`| ${check.createdAt.slice(0, 10)} | ${escapeCell(market?.name ?? check.marketId)}${check.candidateId ? ` / ${check.candidateId}` : ""} | ${check.decisionStatus ?? "策略结论"} · ${check.baselineSnapshotId} | ${escapeCell(evidence)} | **${check.verdict}** | ${escapeCell(delta)} |`);
	}
	if (!checks.length) lines.push("| — | — | — | — | 尚无复盘记录 | — |");
	lines.push("", "## 3. 错杀与漏放", "");
	if (challenged.length) {
		// 市场名与 verdictReason 原先拼在同一行、且市场名被模板的 **…** 包着，
		// 与 report.ts 第 1 / 9 章是同一个跨字段配对形状，而且两个字段一个都没转义。
		lines.push("| OutcomeCheck | 市场 | 判断 | 理由 |", "|---|---|---|---|");
		for (const check of challenged) {
			const market = store.markets.find((item) => item.id === check.marketId);
			const label = check.decisionStatus === "no_go" ? "疑似错杀，建议重新入池" : check.decisionStatus === "go" ? "go 实绩失败，需归因与退出判断" : "结论受到挑战，需人工复看";
			lines.push(`| \`${check.id}\` | ${escapeCell(market?.name ?? check.marketId)} | ${label} | ${escapeCell(check.verdictReason)} |`);
		}
	} else lines.push("- 暂无 challenged 记录；inconclusive 不计为验证成功。");
	lines.push("", "## 4. 策略校准建议", "");
	if (blame.size) {
		for (const [rule, count] of [...blame.entries()].sort((a, b) => b[1] - a[1])) lines.push(`- 规则 \`${rule}\` 出现在 ${count} 条 challenged 基线中；先用 compass_retro action=backtest 验证阈值，再保存新策略版本。`);
	} else lines.push("- 当前没有足够的 challenged × rule 证据支持调阈值；不要凭单个案例修改策略。");
	for (const row of stats.byStrategy) lines.push(`- ${row.strategy}：准确率 ${percent(row.accuracy)}（按对照次数，未去重：validated ${row.validated} / challenged ${row.challenged} / inconclusive ${row.inconclusive}）。`);
	lines.push("", "## 5. 新沉淀经验", "");
	if (reportLessons.length) {
		// 与 report.ts 第 9 章同款：title 曾被模板的 **…** 包住会提前闭合并把 detail 一起加粗，
		// 且两个自由文本字段同行。各进一格即根治，顺带补上原先完全缺失的转义。
		lines.push("| 经验卡 | 结论 | 说明 | evidence |", "|---|---|---|---|");
		for (const lesson of reportLessons.slice(0, 30)) {
			lines.push(`| \`${lesson.id}\` | ${escapeCell(lesson.title)} | ${escapeCell(lesson.detail)} | ${lesson.evidence.map((id) => `\`${id}\``).join("、")} |`);
		}
	} else lines.push("- 本次尚未沉淀 Lesson。经验必须由复盘产生、挂非空 evidence，并经用户确认后保存。");
	lines.push("", "## 6. 下一步", "");
	if (due.length) for (const item of due.slice(0, 30)) lines.push(`- [ ] ${item.marketName}（${item.group}，逾期 ${item.overdueDays} 天）：${item.suggestedAction}`);
	else lines.push("- [x] 当前没有到期复盘对象。");
	for (const check of challenged.filter((item) => item.decisionStatus === "no_go")) lines.push(`- [ ] 复看 ${check.marketId}，如确认重新投入，使用 compass_pool move 并填写 reason；challenged 不会自动翻转决策。`);
	lines.push("", "---", "", "*复盘 verdict 仅表示历史判断得到支持、受到挑战或证据不足，不构成法律意见或收益承诺。风险项仍须以最新官方来源复核。*");
	return `${lines.join("\n")}\n`;
}

export function snapshotsForMarket(store: CompassStore, marketId: string): MarketSnapshot[] {
	return store.snapshots.filter((snapshot) => snapshot.marketId === marketId).sort(compareSnapshotRecencyDesc);
}

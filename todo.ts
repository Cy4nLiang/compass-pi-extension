import type { RetroDueItem } from "./history.ts";
import {
	RESOLVABLE_TODO_KINDS,
	TODO_RESOLUTION_STATUS_LABELS,
	type Candidate,
	type CandidateStage,
	type CompassStore,
	type MarketSnapshot,
	type MetricMap,
	type ResolvableTodoKind,
	type RiskRecord,
	type TodoKind,
	type TodoPriority,
	type TodoResolution,
	type WorkbenchTodo,
	type WorkbenchTodoResolution,
} from "./types.ts";

// 待办推导：从 store 派生的只读视图，条件解决即消失。优先级映射与升级规则的唯一所有者。
// 不 import service.ts——需要编排层计算的输入（预算态、复盘到期、深研指标、多源偏差）
// 由 DeriveTodosInput 结构化传入，保持单向分层。
// 闭环四类（RESOLVABLE_TODO_KINDS）另读 store.todoResolutions 合成处理状态：
// 状态徽标 / 已勾选抑制 / 水位失效浮出的唯一所有者。

// budgetStatus 返回值的结构化子集（避免依赖 service 的返回类型）
export interface TodoBudgetPool {
	source: string;
	state: "ok" | "warning" | "fused" | "free";
	spentCny: number;
	monthlyLimitCny: number;
	callCount: number;
	monthlyCallLimit?: number;
}

export interface DeriveTodosInput {
	store: CompassStore;
	budgets: TodoBudgetPool[];
	retroDue: RetroDueItem[];
	// 仅深研阶段候选的市场指标（含利润/风险/评论合并后的完整上下文）
	deepResearchMetrics: Array<{ marketId: string; metrics: MetricMap }>;
	// 活跃候选市场中多源偏差 >30% 的指标名
	divergentMarkets: Array<{ marketId: string; metrics: string[] }>;
	now?: string;
}

const BASE_PRIORITY: Record<TodoKind, TodoPriority> = {
	budget_fused: 1,
	retro_challenged: 1,
	gate_review: 2,
	decision_pending: 2,
	deep_missing_data: 3,
	risk_missing: 3,
	retro_due: 4,
	budget_warning: 4,
	snapshot_stale: 5,
	metric_divergence: 5,
};

// 深研阶段必须齐备的硬指标（与 compass_data_route 的 deep_research 字段口径一致）
export const DEEP_RESEARCH_REQUIRED_FIELDS = ["main_cpc", "gross_margin", "cpc_ratio", "waist_rating_median"] as const;

const FIELD_LABELS: Record<string, string> = {
	main_cpc: "主词CPC",
	gross_margin: "毛利率",
	cpc_ratio: "CPC承受度",
	waist_rating_median: "腰部星级",
};

const DAY_MS = 86_400_000;
const STALE_SNAPSHOT_DAYS = 30;
const LEAD_WITHOUT_SNAPSHOT_DAYS = 7;
const ESCALATE_OVERDUE_DAYS = 30;

// 自由文本（stageReason/gateReason/verdictReason/市场名）可能含内嵌换行；待办会进入
// 单行展示面（TUI 行槽、compass_todo 管道行），在收口处统一压平避免破坏帧结构
function singleLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function daysBetween(fromIso: string, toIso: string): number {
	const from = Date.parse(fromIso);
	const to = Date.parse(toIso);
	if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
	return Math.max(0, Math.floor((to - from) / DAY_MS));
}

// 升级规则：逾期 >30 天升 1 级，P1 封顶；仅对带 dueAt 的事项生效
function escalate(base: TodoPriority, overdueDays: number | undefined): TodoPriority {
	if (overdueDays === undefined || overdueDays <= ESCALATE_OVERDUE_DAYS) return base;
	return Math.max(1, base - 1) as TodoPriority;
}

const RESOLVABLE_KIND_SET = new Set<TodoKind>(RESOLVABLE_TODO_KINDS);

export function isResolvableTodoKind(kind: TodoKind): kind is ResolvableTodoKind {
	return RESOLVABLE_KIND_SET.has(kind);
}

// 深研硬指标缺口（中文标签）：派生文案与 service 的 verify 硬门槛共用同一口径，杜绝两处漂移
export function missingDeepResearchFields(metrics: MetricMap): string[] {
	return DEEP_RESEARCH_REQUIRED_FIELDS
		.filter((field) => {
			const value = metrics[field]?.value;
			return value === undefined || value === null;
		})
		.map((field) => FIELD_LABELS[field] ?? field);
}

// 派生时刻的水位快照：与记录勾选时落的 basis 逐类对比，决定抑制是否仍成立
interface CurrentBasis {
	month?: string;
	snapshotWatermark?: string;
	stageEnteredAt?: string;
	metricsComplete?: boolean;
}

// 阶段周期锚：候选本次进入某阶段的时间 = decisionLog 最近一次「→ stage」的 stage_move createdAt，
// 无留痕时回落建卡时间。**禁用 candidate.updatedAt**——例行 CSV 导入会刷新它，造成水位假失效。
// 导出供 service 勾选时落 basis.stageEnteredAt 复用，杜绝抑制判定与水位口径两处漂移。
export function stageEntryTimes(store: CompassStore, stage: CandidateStage): Map<string, string> {
	const entered = new Map<string, string>();
	const suffix = `→ ${stage}`;
	for (const log of store.decisionLog) {
		if (log.type !== "stage_move" || !log.candidateId || !log.conclusion.endsWith(suffix)) continue;
		const previous = entered.get(log.candidateId);
		if (previous === undefined || log.createdAt > previous) entered.set(log.candidateId, log.createdAt);
	}
	for (const candidate of store.candidates) if (!entered.has(candidate.id)) entered.set(candidate.id, candidate.createdAt);
	return entered;
}

// 偏差水位：标记「参与比较的快照集合」本身，而不是它的最大 capturedAt。
// metricDivergences（service.ts:1243）取各来源最新快照逐指标比较，任一来源被更新的导出替换，
// 参与比较的值就变了。若水位取全市场最大 capturedAt，回填补录（capturedAt 早于全市场最新、
// 但晚于该来源上一份，如补导前天的 Sorftime 导出）会改写偏差事实却不推高水位，已勾选条目
// 静默到下一份更新快照为止——正是 spec §5 方案 G 判为不可接受的告警黑洞。
// 指纹按 source 排序拼接：集合不变则完全相等（同 capturedAt 重导时该来源参与比较的快照不变，
// 指纹同样不变，继续抑制）。导出供 service 勾选时落 basis.snapshotWatermark 复用同一口径。
// 两处约定：① 选「该来源最新」用与 metricDivergences 排序相同的 localeCompare，取值相同者保留先入库那条，
// 与其稳定排序取首条等价；② 指纹分隔符依赖 SNAPSHOT_SOURCES（types.ts）的来源名不含 "@" 与 "|"。
export function divergenceWatermarks(store: CompassStore): Map<string, string> {
	const latestBySource = new Map<string, Map<string, string>>();
	for (const snapshot of store.snapshots) {
		let sources = latestBySource.get(snapshot.marketId);
		if (!sources) {
			sources = new Map<string, string>();
			latestBySource.set(snapshot.marketId, sources);
		}
		const previous = sources.get(snapshot.source);
		if (previous === undefined || snapshot.capturedAt.localeCompare(previous) > 0) sources.set(snapshot.source, snapshot.capturedAt);
	}
	const watermarks = new Map<string, string>();
	for (const [marketId, sources] of latestBySource) {
		watermarks.set(marketId, [...sources.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([source, capturedAt]) => `${source}@${capturedAt}`)
			.join("|"));
	}
	return watermarks;
}

// 抑制判定：仅当勾选时的水位仍成立才隐藏条目，失效即浮出（lapsed）。
// 记录状态只由人工动作迁移，派生层永不改写记录——错位的最坏情况是多提醒一次，绝不漏提醒。
function isSuppressed(record: TodoResolution, current: CurrentBasis): boolean {
	const basis = record.basis;
	if (!basis) return false;
	switch (record.kind) {
		case "budget_warning":
		case "budget_fused":
			// 新预算月开始即自然失效（次月用量重新计算）
			return Boolean(current.month) && basis.month === current.month;
		case "metric_divergence":
			// 参与比较的快照集合指纹一致才继续抑制；水位取不到时按浮出处理
			return basis.snapshotWatermark !== undefined
				&& current.snapshotWatermark !== undefined
				&& current.snapshotWatermark === basis.snapshotWatermark;
		case "deep_missing_data":
			// 同一深研周期内且四项硬指标仍齐备；指标回退或候选重入深研都算新事实
			return current.metricsComplete === true && basis.stageEnteredAt !== undefined && basis.stageEnteredAt === current.stageEnteredAt;
	}
}

// 状态徽标（TUI 与工具面共用；Web 前端按同一措辞自行渲染）：非闭环类返回 undefined
export function todoResolutionBadge(todo: WorkbenchTodo): string | undefined {
	if (!todo.resolvable) return undefined;
	if (!todo.resolution) return "未处理";
	if (todo.resolution.lapsed) return "已处理·失效浮出";
	return TODO_RESOLUTION_STATUS_LABELS[todo.resolution.status];
}

function summarizeResolution(record: TodoResolution, lapsed: boolean): WorkbenchTodoResolution {
	const last = record.attempts[record.attempts.length - 1];
	const summary: WorkbenchTodoResolution = {
		status: record.status,
		attemptCount: record.attempts.length,
		updatedAt: record.updatedAt,
	};
	if (last?.verdict) summary.verdict = last.verdict;
	if (last?.verdictReason) summary.verdictReason = singleLine(last.verdictReason);
	if (lapsed) summary.lapsed = true;
	return summary;
}

export function deriveTodos(input: DeriveTodosInput): WorkbenchTodo[] {
	const { store, budgets, retroDue, deepResearchMetrics, divergentMarkets } = input;
	const now = input.now ?? new Date().toISOString();
	const todos: WorkbenchTodo[] = [];
	const marketName = (marketId: string | undefined): string | undefined =>
		marketId ? store.markets.find((market) => market.id === marketId)?.name : undefined;
	// 处理记录按待办 id 建表（单遍 O(n)）；非闭环 kind 的记录防御性忽略，不参与任何判定
	const resolutionByTodoId = new Map<string, TodoResolution>();
	for (const record of store.todoResolutions ?? []) {
		if (RESOLVABLE_KIND_SET.has(record.kind)) resolutionByTodoId.set(record.todoId, record);
	}
	// 预算水位口径与 budgetStatus 一致（UTC 月前缀）；now 非法时留空 → 一律不抑制
	const currentMonth = Number.isFinite(Date.parse(now)) ? new Date(now).toISOString().slice(0, 7) : "";
	// 深研周期锚与偏差水位都只在真要判抑制时才预扫一次（短路 + Code Motion，不在循环内重复扫描）
	let deepEntryTimes: Map<string, string> | undefined;
	const deepEnteredAt = (candidate: Candidate): string => {
		deepEntryTimes ??= stageEntryTimes(store, "deep_research");
		return deepEntryTimes.get(candidate.id) ?? candidate.createdAt;
	};
	let divergenceWatermarkByMarket: Map<string, string> | undefined;
	const divergenceWatermark = (marketId: string): string | undefined => {
		divergenceWatermarkByMarket ??= divergenceWatermarks(store);
		return divergenceWatermarkByMarket.get(marketId);
	};

	// currentBasis 用 thunk 传入：仅在确有已勾选记录需要比对时才计算水位，避免无谓扫描
	const push = (
		todo: Omit<WorkbenchTodo, "priority" | "basePriority" | "marketName" | "resolvable" | "resolution"> & { marketName?: string },
		currentBasis?: () => CurrentBasis,
	): void => {
		const resolvable = RESOLVABLE_KIND_SET.has(todo.kind);
		const record = resolvable ? resolutionByTodoId.get(todo.id) : undefined;
		// todoId 命中但 kind 不符 = 记录与待办不同源（数据损坏），按无记录处理
		const matched = record?.kind === todo.kind ? record : undefined;
		let lapsed = false;
		if (matched?.status === "resolved") {
			if (isSuppressed(matched, currentBasis?.() ?? {})) return;
			lapsed = true;
		}
		const base = BASE_PRIORITY[todo.kind];
		const name = todo.marketName ?? marketName(todo.marketId);
		const entry: WorkbenchTodo = {
			...todo,
			title: singleLine(todo.title),
			reason: singleLine(todo.reason),
			suggestedAction: singleLine(todo.suggestedAction),
			marketName: name === undefined ? undefined : singleLine(name),
			basePriority: base,
			priority: escalate(base, todo.overdueDays),
			resolvable,
		};
		if (matched) entry.resolution = summarizeResolution(matched, lapsed);
		todos.push(entry);
	};

	// P1 budget_fused / P4 budget_warning：每个告警或熔断的池一条
	for (const pool of budgets) {
		if (pool.state !== "fused" && pool.state !== "warning") continue;
		const usage = [
			pool.monthlyLimitCny > 0 ? `¥${pool.spentCny.toFixed(2)}/¥${pool.monthlyLimitCny.toFixed(0)}` : undefined,
			pool.monthlyCallLimit !== undefined ? `${pool.callCount}/${pool.monthlyCallLimit} 次` : undefined,
		].filter(Boolean).join("，");
		if (pool.state === "fused") {
			push({
				id: `todo_budget_fused_${pool.source}`,
				kind: "budget_fused",
				source: pool.source,
				title: `预算熔断：${pool.source}`,
				reason: `当月用量已达上限（${usage}），付费补数链路停摆`,
				suggestedAction: `compass_budget configure source=${pool.source} 提高上限，或降级 C 档数据源；次月自动恢复`,
			}, () => ({ month: currentMonth }));
		} else {
			push({
				id: `todo_budget_warning_${pool.source}`,
				kind: "budget_warning",
				source: pool.source,
				title: `预算 80% 告警：${pool.source}`,
				reason: `当月用量已达 80%（${usage}）`,
				suggestedAction: "compass_budget status 核对用量，评估是否提高上限或收紧补数",
			}, () => ({ month: currentMonth }));
		}
	}

	// P1 retro_challenged：市场最新复盘结论为 challenged 且此后候选无任何处置动作
	const latestCheckByMarket = new Map<string, CompassStore["outcomeChecks"][number]>();
	for (const check of [...store.outcomeChecks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
		if (!latestCheckByMarket.has(check.marketId)) latestCheckByMarket.set(check.marketId, check);
	}
	for (const check of latestCheckByMarket.values()) {
		if (check.verdict !== "challenged") continue;
		// 处置判据：check 之后该市场出现过 strategy 重跑 / 阶段移动 / 最终决策留痕即视为已处置。
		// 不能用 candidate.updatedAt 做代理——例行 CSV 导入会刷新它（假阳性清除），
		// 而 decideCandidate 不刷新它（真处置清不掉）
		const handled = store.decisionLog.some((log) =>
			log.marketId === check.marketId
			&& (log.type === "strategy" || log.type === "stage_move" || log.type === "decision")
			&& log.createdAt > check.createdAt);
		if (handled) continue;
		const candidate = store.candidates.find((item) => item.marketId === check.marketId);
		push({
			id: `todo_retro_challenged_${check.marketId}`,
			kind: "retro_challenged",
			marketId: check.marketId,
			candidateId: candidate?.id,
			title: "复盘结论 challenged 待处置",
			reason: check.verdictReason,
			suggestedAction: `compass_strategy_run market_ref=${check.marketId} 重跑策略，或 compass_pool decide 更新决策`,
		});
	}

	const latestSnapshotByMarket = new Map<string, MarketSnapshot>();
	for (const snapshot of [...store.snapshots].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))) {
		if (!latestSnapshotByMarket.has(snapshot.marketId)) latestSnapshotByMarket.set(snapshot.marketId, snapshot);
	}
	const latestRiskByMarket = new Map<string, RiskRecord>();
	for (const record of [...store.riskRecords].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
		if (!latestRiskByMarket.has(record.marketId)) latestRiskByMarket.set(record.marketId, record);
	}
	const deepMetricsByMarket = new Map(deepResearchMetrics.map((item) => [item.marketId, item.metrics]));

	for (const candidate of store.candidates) {
		if (candidate.stage === "archived") continue;

		// P2 gate_review：Gate 复核仅在漏斗推进阶段有意义
		if (candidate.gateOutcome === "review" && candidate.stage !== "review") {
			push({
				id: `todo_gate_review_${candidate.id}`,
				kind: "gate_review",
				marketId: candidate.marketId,
				candidateId: candidate.id,
				title: "Gate=review 待人工复核",
				reason: candidate.gateReason ?? "策略运行转人工复核",
				suggestedAction: `compass_pool get candidate_ref=${candidate.id} 查看非通过项，复核后 move/decide`,
			});
		}

		// P2 decision_pending
		if (candidate.stage === "decision" && !candidate.decisionStatus) {
			push({
				id: `todo_decision_pending_${candidate.id}`,
				kind: "decision_pending",
				marketId: candidate.marketId,
				candidateId: candidate.id,
				title: "决策评审待 go/waitlist/no_go",
				reason: candidate.stageReason ?? "候选已进入决策评审阶段",
				suggestedAction: `compass_pool decide candidate_ref=${candidate.id}`,
			});
		}

		// P3 deep_missing_data：闭环类——指标齐备只是验证判据之一，不再自动消失，
		// 须经「提交 → 验证 → 勾选」关闭（派生条件 = 指标有缺 或 无有效抑制记录）
		if (candidate.stage === "deep_research") {
			const missing = missingDeepResearchFields(deepMetricsByMarket.get(candidate.marketId) ?? {});
			const complete = missing.length === 0;
			push({
				id: `todo_deep_missing_data_${candidate.id}`,
				kind: "deep_missing_data",
				marketId: candidate.marketId,
				candidateId: candidate.id,
				title: complete ? "深研数据待人工确认" : "深研缺硬指标",
				reason: complete
					? "四项硬指标齐备，待提交调研说明与利润测算确认"
					: `缺 ${missing.join("、")}`,
				suggestedAction: complete
					? `compass_todo action=submit todo_id=todo_deep_missing_data_${candidate.id} 提交调研说明与利润测算`
					: `compass_data_route market_ref=${candidate.marketId} stage=deep_research 生成补数计划`,
			}, () => ({ stageEnteredAt: deepEnteredAt(candidate), metricsComplete: complete }));
		}

		// P3 risk_missing
		if (candidate.stage === "risk" || candidate.stage === "decision") {
			const risk = latestRiskByMarket.get(candidate.marketId);
			const reason = !risk
				? "风险清单未做"
				: risk.overall === "review" || risk.overall === "unknown"
					? `风险总体为 ${risk.overall}，待人工核查`
					: !risk.evidence.some((item) => Boolean(item.url?.trim()))
						? "风险清单无可点击证据链接"
						: undefined;
			if (reason) {
				push({
					id: `todo_risk_missing_${candidate.id}`,
					kind: "risk_missing",
					marketId: candidate.marketId,
					candidateId: candidate.id,
					title: "风险清单待补",
					reason,
					suggestedAction: `compass_risk_check market_ref=${candidate.marketId} 补录五类清单与官方证据 URL`,
				});
			}
		}

		// P5 snapshot_stale：数据保鲜（含 lead 迟迟未导入首个快照）
		const snapshot = latestSnapshotByMarket.get(candidate.marketId);
		if (snapshot) {
			const age = daysBetween(snapshot.capturedAt, now);
			if (age > STALE_SNAPSHOT_DAYS) {
				push({
					id: `todo_snapshot_stale_${candidate.id}`,
					kind: "snapshot_stale",
					marketId: candidate.marketId,
					candidateId: candidate.id,
					title: "市场快照过期",
					reason: `最新快照已 ${age} 天（>${STALE_SNAPSHOT_DAYS} 天）`,
					suggestedAction: "/compass-import 导入新导出的 CSV 刷新快照",
				});
			}
		} else if (candidate.stage === "lead" && daysBetween(candidate.createdAt, now) > LEAD_WITHOUT_SNAPSHOT_DAYS) {
			push({
				id: `todo_snapshot_stale_${candidate.id}`,
				kind: "snapshot_stale",
				marketId: candidate.marketId,
				candidateId: candidate.id,
				title: "线索尚无数据快照",
				reason: `建卡已 ${daysBetween(candidate.createdAt, now)} 天仍无快照，无法进入粗筛`,
				suggestedAction: "/compass-import 导入首个市场 CSV",
			});
		}
	}

	// P4 retro_due：复用复盘到期推导，逐条映射（升级规则在 push 内按 overdueDays 生效）
	for (const item of retroDue) {
		push({
			id: `todo_retro_due_${item.candidateId}_${item.group}`,
			kind: "retro_due",
			marketId: item.marketId,
			candidateId: item.candidateId,
			marketName: item.marketName,
			title: `到期复盘：${item.group}`,
			reason: item.reason,
			suggestedAction: item.suggestedAction,
			dueAt: item.dueAt,
			overdueDays: item.overdueDays,
		});
	}

	// P5 metric_divergence
	const activeMarkets = new Set(store.candidates.filter((candidate) => candidate.stage !== "archived").map((candidate) => candidate.marketId));
	for (const item of divergentMarkets) {
		if (!item.metrics.length || !activeMarkets.has(item.marketId)) continue;
		push({
			id: `todo_metric_divergence_${item.marketId}`,
			kind: "metric_divergence",
			marketId: item.marketId,
			candidateId: store.candidates.find((candidate) => candidate.marketId === item.marketId && candidate.stage !== "archived")?.id,
			title: "多源指标偏差 >30%",
			reason: `偏差指标：${item.metrics.join("、")}`,
			suggestedAction: "对照报告的多源偏差表，人工确定基准口径后再决策",
		}, () => ({ snapshotWatermark: divergenceWatermark(item.marketId) }));
	}

	return todos.sort((a, b) =>
		a.priority - b.priority
		|| (b.overdueDays ?? -1) - (a.overdueDays ?? -1)
		|| (a.marketName ?? "").localeCompare(b.marketName ?? "")
		|| a.id.localeCompare(b.id));
}

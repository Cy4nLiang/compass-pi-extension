export const CANDIDATE_STAGES = [
	"lead",
	"screen",
	"deep_research",
	"risk",
	"decision",
	"testing",
	"review",
	"archived",
] as const;

export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

// 终局决策三态与数据来源：运行时常量 + 由它派生类型，让入口层的校验与类型互相守护
export const DECISION_STATUSES = ["go", "waitlist", "no_go"] as const;
export const SNAPSHOT_SOURCES = ["auto", "sellersprite", "sorftime", "keepa", "compass_browser", "manual_csv", "generic_csv"] as const;

// 其余领域枚举同样「常量是唯一真相源、类型由它派生」：入口层校验（index.ts 的 StringEnum /
// ui.select）与持久化白名单（store.ts 的 assertStore）一律引用这些常量，禁止再抄字面量。
// 三层各抄一份的老写法一旦漏改，症状是「数据看着没问题却报 XX 损坏」，极难定位。
export const GATE_OUTCOMES = ["pass", "review", "reject"] as const;
export const OUTCOME_VERDICTS = ["validated", "challenged", "inconclusive"] as const;
export const RISK_STATUSES = ["pass", "review", "red", "unknown"] as const;
export const SEASON_FLAGS = ["clear", "strong", "review", "unknown"] as const;
export const POLICY_FLAGS = ["clear", "review", "red", "unknown"] as const;
export const STRATEGY_MODES = ["screen", "full"] as const;
export const REVIEW_THEME_CATEGORIES = ["quality", "size", "damage", "expectation", "usability", "other"] as const;
export const REVIEW_THEME_FIXABILITIES = ["factory", "packaging", "copy", "none", "unknown"] as const;

// ★ 回滚兼容红线 ★ 旧版 assertStore 对 decisionLog.type 是严格白名单：**新增取值会让回滚后的
// store 打不开**。要给决策日志加维度，一律加可选字段（如 trigger / strategyRunId），不要加取值。
// 收敛成一处常量正是为了让「改这里」显眼到必须先想清楚回滚代价。
export const DECISION_LOG_TYPES = ["lead", "import", "strategy", "stage_move", "decision", "risk", "profit", "review", "retro"] as const;

// 阶段中文标签：TUI 与 Web 共用的领域词汇（七个工作阶段 + archived 归档）
export const STAGE_LABELS: Record<CandidateStage, string> = {
	lead: "线索",
	screen: "粗筛",
	deep_research: "深研",
	risk: "风控",
	decision: "决策",
	testing: "测品",
	review: "复盘",
	archived: "归档",
};
export type GateOutcome = (typeof GATE_OUTCOMES)[number];
export type DecisionStatus = (typeof DECISION_STATUSES)[number];
export type OutcomeVerdict = (typeof OUTCOME_VERDICTS)[number];
export type RiskStatus = (typeof RISK_STATUSES)[number];
export type SeasonFlag = (typeof SEASON_FLAGS)[number];
export type PolicyFlag = (typeof POLICY_FLAGS)[number];
export type StrategyMode = (typeof STRATEGY_MODES)[number];
export type ReviewThemeCategory = (typeof REVIEW_THEME_CATEGORIES)[number];
export type ReviewThemeFixability = (typeof REVIEW_THEME_FIXABILITIES)[number];
export type DecisionLogType = (typeof DECISION_LOG_TYPES)[number];
export type Confidence = number;
export type MetricScalar = number | string | boolean | null;

export interface MetricEvidence {
	value: MetricScalar;
	source: string;
	capturedAt: string;
	confidence: Confidence;
	sampleSize?: number;
	note?: string;
	// 仅 q（目标月销）相关指标写入：标明这份证据是按哪个 q 算出来的。
	// 老证据没有本字段 = 口径未知；读侧只在「口径确认与当前 q 相同」时才敢沿用冻结值。
	// 可选字段：emptySnapshotPayload 整体透传 metrics、assertStore 不逐条校验 metrics，
	// 故无需动持久化白名单与硬校验，旧版扩展回滚后忽略即可。
	targetMonthlyUnits?: number;
}

export type MetricMap = Record<string, MetricEvidence>;

export interface ListingRecord {
	asin?: string;
	title?: string;
	rank: number;
	price?: number;
	rating?: number;
	reviewCount?: number;
	monthlySales?: number;
	monthlyRevenue?: number;
	brand?: string;
	seller?: string;
	isAmazon?: boolean;
	launchDate?: string;
	monthsOnline?: number;
	category?: string;
	sourceRow: number;
}

export interface KeywordRecord {
	keyword: string;
	searchVolume?: number;
	cpc?: number;
	rank?: number;
	sourceRow: number;
}

export interface ParsedMarketCsv {
	source: string;
	delimiter: string;
	headers: string[];
	listings: ListingRecord[];
	keywords: KeywordRecord[];
	warnings: string[];
	rowCount: number;
	mappedFields: string[];
}

export interface Market {
	id: string;
	name: string;
	keywords: string[];
	category?: string;
	createdAt: string;
	updatedAt: string;
}

export interface MarketSnapshot {
	id: string;
	marketId: string;
	source: string;
	capturedAt: string;
	importedAt: string;
	fileName?: string;
	archivedFile?: string;
	fileHash?: string;
	dataFile?: string;
	rowCount: number;
	listings: ListingRecord[];
	keywords: KeywordRecord[];
	metrics: MetricMap;
	warnings: string[];
}

export interface Candidate {
	id: string;
	marketId: string;
	stage: CandidateStage;
	owner?: string;
	tags: string[];
	gateOutcome?: GateOutcome;
	gateReason?: string;
	gateReasonAt?: string;
	gateReasonActor?: string;
	score?: number;
	latestStrategyRunId?: string;
	stageReason?: string;
	stageReasonAt?: string;
	stageReasonActor?: string;
	decisionStatus?: DecisionStatus;
	decisionReason?: string;
	decisionAt?: string;
	decisionActor?: string;
	createdAt: string;
	updatedAt: string;
}

export interface ProfitInput {
	marketId?: string;
	candidateId?: string;
	salePrice: number;
	purchaseCost: number;
	firstMileCost: number;
	tariffCost: number;
	referralRate: number;
	fbaFee: number;
	cvr: number;
	cpc?: number;
	returnRate: number;
	returnProcessingFee: number;
	residualValue: number;
	dailyUnits: number;
	stockDays: number;
	testAdBudget: number;
	oneTimeCosts: number;
	portfolioCapital?: number;
	tacosScenarios: number[];
	currency: string;
}

export interface ProfitResult {
	landedCost: number;
	referralFee: number;
	grossProfit: number;
	grossMargin: number;
	breakEvenCpc: number;
	cpcRatio?: number;
	returnLossRate: number;
	netMarginScenarios: Array<{ tacos: number; netMargin: number }>;
	monthlyRevenue: number;
	monthlyNetProfitScenarios: Array<{ tacos: number; monthlyNetProfit: number }>;
	firstInventoryCost: number;
	startupCapital: number;
	paybackMonthsScenarios: Array<{ tacos: number; paybackMonths: number | null }>;
	warnings: string[];
}

export interface ProfitEstimate {
	id: string;
	marketId?: string;
	candidateId?: string;
	input: ProfitInput;
	result: ProfitResult;
	createdAt: string;
	actor: string;
}

export interface RiskEvidenceItem {
	category: string;
	url?: string;
	title?: string;
	note?: string;
	checkedAt: string;
}

export interface RiskRecord {
	id: string;
	marketId: string;
	candidateId?: string;
	certStatus: RiskStatus;
	ipRiskLevel: RiskStatus;
	seasonFlag: SeasonFlag;
	policyFlag: PolicyFlag;
	logisticsRisk: RiskStatus;
	overall: RiskStatus;
	evidence: RiskEvidenceItem[];
	notes?: string;
	createdAt: string;
	actor: string;
}

export interface ReviewTheme {
	name: string;
	category: ReviewThemeCategory;
	count: number;
	share?: number;
	fixability: ReviewThemeFixability;
	evidence?: string[];
	recommendation?: string;
}

export interface ReviewAnalysis {
	id: string;
	marketId: string;
	sourceAsins: string[];
	reviewCount: number;
	themes: ReviewTheme[];
	estimatedRating?: number;
	waistRating?: number;
	estimatedRatingGap?: number;
	notes?: string;
	createdAt: string;
	actor: string;
}

export type RuleAction = "veto" | "require" | "review_if_fail";

export interface StrategyRule {
	id: string;
	when: string;
	action: RuleAction;
	label: string;
}

export interface StrategyStage {
	stage: string;
	rules: StrategyRule[];
}

export interface StrategyDefinition {
	meta: {
		name: string;
		display_name?: string;
		owner?: string;
		target_daily_units?: number;
		monthly_units_q?: number;
		margin_scope?: string;
		[key: string]: unknown;
	};
	stages: StrategyStage[];
	scoring: {
		weights: Record<string, number>;
		normalize?: string;
	};
}

export interface StrategyVersion {
	id: string;
	version: number;
	name: string;
	yaml: string;
	definition: StrategyDefinition;
	createdAt: string;
	actor: string;
	changeNote?: string;
}

export interface RuleEvaluation {
	id: string;
	stage: string;
	action: RuleAction;
	label: string;
	when: string;
	condition: boolean | null;
	status: "pass" | "review" | "fail" | "veto" | "missing" | "error";
	references: string[];
	evidence: Record<string, MetricEvidence | undefined>;
	message: string;
}

export interface StrategyEvaluation {
	outcome: GateOutcome;
	score: number;
	dimensionScores: Record<string, number>;
	rules: RuleEvaluation[];
	missingMetrics: string[];
}

export interface StrategyRun {
	id: string;
	strategyId: string;
	strategyVersion: number;
	marketId: string;
	snapshotId: string;
	mode: StrategyMode;
	result: StrategyEvaluation;
	runAt: string;
	actor: string;
}

// 决策日志的触发来源。只有 "manual" 才算对 retro_challenged 的人工处置动作；字段缺失
// （存量日志、将来忘了传的调用方）一律按「非手动」处理——最坏是多提醒一次，绝不漏提醒。
// 刻意做成新增**可选字段**而不是新增 decisionLog.type 取值：旧版 assertStore 对 type 是
// 严格白名单，新增取值会让回滚后的 store 打不开；未知可选字段被旧版忽略并原样保留。
export type DecisionTrigger = "manual" | "auto_import";

export interface DecisionLog {
	id: string;
	candidateId?: string;
	marketId: string;
	type: DecisionLogType;
	trigger?: DecisionTrigger;
	conclusion: string;
	decisionStatus?: DecisionStatus;
	reason: string;
	snapshotId?: string;
	strategyId?: string;
	strategyVersion?: number;
	// 决策落定时依据的那次策略运行（可选）：决策锚定的是「当下最新快照」，而策略来自
	// candidate.latestStrategyRunId，两者可以落在不同快照上。只有新决策会写，旧记录靠
	// findRetroBaseline 的读侧回退补齐，因此保持可选、不做写回迁移。
	strategyRunId?: string;
	actor: string;
	createdAt: string;
}

export interface OutcomeActuals {
	dailyUnits?: number;
	tacos?: number;
	returnRate?: number;
	netMargin?: number;
	note?: string;
}

export interface OutcomeDelta {
	metric: string;
	baseline: MetricScalar;
	current: MetricScalar;
	direction: "improved" | "worsened" | "flat" | "unknown";
}

export interface OutcomeCheck {
	id: string;
	marketId: string;
	candidateId?: string;
	decisionLogId?: string;
	decisionStatus?: DecisionStatus;
	baselineSnapshotId: string;
	baselineRunId?: string;
	evidenceSnapshotId?: string;
	actuals?: OutcomeActuals;
	deltas: OutcomeDelta[];
	verdict: OutcomeVerdict;
	verdictReason: string;
	elapsedDays: number;
	createdAt: string;
	actor: string;
}

export interface Lesson {
	id: string;
	title: string;
	detail: string;
	scope: {
		categories?: string[];
		keywords?: string[];
		metrics?: string[];
	};
	evidence: string[];
	status: "active" | "retired";
	retiredReason?: string;
	sourceRetro?: string;
	createdAt: string;
	updatedAt: string;
	actor: string;
}

export interface BudgetPool {
	source: string;
	tier: "A" | "B" | "C";
	monthlyLimitCny: number;
	enabled: boolean;
	note?: string;
	// MCP 计量配置：缺省/0 = 只计数不折算成本
	costPerCallCny?: number;
	// 当月调用次数上限；缺省 = 不限次（configure 传 0 表示清除，落库为 undefined）
	monthlyCallLimit?: number;
}

export interface CostEvent {
	id: string;
	source: string;
	marketId?: string;
	amountCny: number;
	description?: string;
	// 缺省 = 手工记账；mcp_call = tool_result 自动计量
	kind?: "mcp_call";
	tool?: string;
	// 本事件合并的调用次数（≥1）；缺省视为 1
	calls?: number;
	createdAt: string;
	actor: string;
}

export const TODO_KINDS = [
	"budget_fused",
	"retro_challenged",
	"gate_review",
	"decision_pending",
	"deep_missing_data",
	"risk_missing",
	"retro_due",
	"budget_warning",
	"snapshot_stale",
	"metric_divergence",
] as const;

export type TodoKind = (typeof TODO_KINDS)[number];
export const TODO_PRIORITIES = [1, 2, 3, 4, 5] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

// 待办优先级分组标签：TUI 与 Web 共用
export const TODO_GROUP_LABELS: Record<TodoPriority, string> = {
	1: "P1 紧急阻塞",
	2: "P2 漏斗阻塞",
	3: "P3 补数据/补证据",
	4: "P4 例行到期",
	5: "P5 保鲜/优化",
};

// 纳入人工处理闭环的四类待办：这四类没有系统内动作可消除（或消除条件不足以证明「实质处理」），
// 需走「提交 → agent 验证 → 勾选已处理」；其余六类保持「条件解决即消失」的纯派生语义
export const RESOLVABLE_TODO_KINDS = [
	"metric_divergence",
	"budget_warning",
	"budget_fused",
	"deep_missing_data",
] as const satisfies readonly TodoKind[];

export type ResolvableTodoKind = (typeof RESOLVABLE_TODO_KINDS)[number];

// 处理记录状态机（迁移入口唯一在 service）：
//   无记录 / rejected / reopened --submit--> submitted
//   submitted --verify--> verified(pass) | rejected(reject)
//   verified --complete--> resolved（活跃清单抑制中）
//   resolved --reopen--> reopened（回活跃清单，历史轮次全保留）
export const TODO_RESOLUTION_STATUSES = ["submitted", "rejected", "verified", "resolved", "reopened"] as const;
export type TodoResolutionStatus = (typeof TODO_RESOLUTION_STATUSES)[number];
export type TodoResolutionVerdict = "pass" | "reject";

// 证据引用：URL 或项目内相对路径，仅作文本记录——服务端不读取其内容
export interface TodoEvidenceRef {
	ref: string;
	note?: string;
}

// 一轮「提交 → 验证」；驳回后重新提交会追加新一轮，末条 = 当前轮
export interface TodoResolutionAttempt {
	submittedAt: string;
	submittedBy: string;
	note: string;
	evidence: TodoEvidenceRef[];
	// 提交时刻的抑制水位快照：勾选时重算并与之比对，拦住「提交→勾选之间新到达、无人核对的事实」。
	// 可选——本字段上线前的旧记录没有，一律按「水位已失效」处理（宁可多走一轮提交，绝不放行可能漏提醒的勾选）
	basisAtSubmit?: TodoResolutionBasis;
	verdict?: TodoResolutionVerdict;
	verdictReason?: string;
	verifiedAt?: string;
	verifiedBy?: string;
}

export interface TodoResolutionReopen {
	reopenedAt: string;
	reopenedBy: string;
	reason: string;
}

// 勾选时快照的抑制水位：抑制到期后待办重新浮出（宁可多提醒，绝不漏提醒）
export interface TodoResolutionBasis {
	month?: string;
	snapshotWatermark?: string;
	stageEnteredAt?: string;
}

// 每类闭环待办勾选时必须落的水位锚点：assertStore 硬校验、派生层抑制判定共用同一张表
export const TODO_RESOLUTION_BASIS_ANCHORS: Record<ResolvableTodoKind, keyof TodoResolutionBasis> = {
	metric_divergence: "snapshotWatermark",
	budget_warning: "month",
	budget_fused: "month",
	deep_missing_data: "stageEnteredAt",
};

// 待办处理记录：以确定性待办 id 关联的持久化真相源，记录本身即完整审计链
// （提交/验证/勾选/重开四类动作各含 actor + 时间 + 说明或理由，不写 decisionLog）
export interface TodoResolution {
	id: string;
	todoId: string;
	kind: ResolvableTodoKind;
	marketId?: string;
	candidateId?: string;
	source?: string;
	// 提交时的待办标题快照：待办自然消失后「已处理」分区仍可展示
	titleSnapshot: string;
	status: TodoResolutionStatus;
	attempts: TodoResolutionAttempt[];
	reopens: TodoResolutionReopen[];
	resolvedAt?: string;
	resolvedBy?: string;
	basis?: TodoResolutionBasis;
	createdAt: string;
	updatedAt: string;
}

// 处理状态徽标：Web / TUI / compass_todo / service 错误文案四端共用同一措辞
export const TODO_RESOLUTION_STATUS_LABELS: Record<TodoResolutionStatus, string> = {
	submitted: "待验证",
	rejected: "已驳回",
	verified: "验证通过·待勾选",
	resolved: "已处理",
	reopened: "已重开·待重新提交",
};

// 活跃待办上合成的处理状态摘要（只读派生，不落盘）
export interface WorkbenchTodoResolution {
	status: TodoResolutionStatus;
	verdict?: TodoResolutionVerdict;
	verdictReason?: string;
	attemptCount: number;
	updatedAt: string;
	// 已勾选但水位失效、重新浮出
	lapsed?: boolean;
}

// 工作台待办：从 store 派生的只读视图，不持久化（条件解决即消失）；
// 闭环四类另附由 store.todoResolutions 合成的处理状态（resolvable / resolution）
export interface WorkbenchTodo {
	id: string;
	kind: TodoKind;
	priority: TodoPriority;
	basePriority: TodoPriority;
	marketId?: string;
	marketName?: string;
	candidateId?: string;
	source?: string;
	title: string;
	reason: string;
	suggestedAction: string;
	dueAt?: string;
	overdueDays?: number;
	resolvable?: boolean;
	resolution?: WorkbenchTodoResolution;
}

export interface CompassStore {
	schemaVersion: 1;
	createdAt: string;
	updatedAt: string;
	markets: Market[];
	snapshots: MarketSnapshot[];
	candidates: Candidate[];
	profitEstimates: ProfitEstimate[];
	riskRecords: RiskRecord[];
	reviewAnalyses: ReviewAnalysis[];
	strategies: StrategyVersion[];
	strategyRuns: StrategyRun[];
	decisionLog: DecisionLog[];
	outcomeChecks: OutcomeCheck[];
	lessons: Lesson[];
	budgetPools: BudgetPool[];
	costEvents: CostEvent[];
	// 可选顶层集合（走 ensureDefaults 回填 + load 迁移回写）：旧版扩展回滚后忽略本字段
	todoResolutions?: TodoResolution[];
}

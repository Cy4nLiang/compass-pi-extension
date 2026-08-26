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
export type GateOutcome = "pass" | "review" | "reject";
export type DecisionStatus = "go" | "waitlist" | "no_go";
export type OutcomeVerdict = "validated" | "challenged" | "inconclusive";
export type RiskStatus = "pass" | "review" | "red" | "unknown";
export type Confidence = number;
export type MetricScalar = number | string | boolean | null;

export interface MetricEvidence {
	value: MetricScalar;
	source: string;
	capturedAt: string;
	confidence: Confidence;
	sampleSize?: number;
	note?: string;
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
	latestSnapshotId?: string;
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
	seasonFlag: "clear" | "strong" | "review" | "unknown";
	policyFlag: "clear" | "review" | "red" | "unknown";
	logisticsRisk: RiskStatus;
	overall: RiskStatus;
	evidence: RiskEvidenceItem[];
	notes?: string;
	createdAt: string;
	actor: string;
}

export interface ReviewTheme {
	name: string;
	category: "quality" | "size" | "damage" | "expectation" | "usability" | "other";
	count: number;
	share?: number;
	fixability: "factory" | "packaging" | "copy" | "none" | "unknown";
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
	mode: "screen" | "full";
	result: StrategyEvaluation;
	runAt: string;
	actor: string;
}

export interface DecisionLog {
	id: string;
	candidateId?: string;
	marketId: string;
	type: "lead" | "import" | "strategy" | "stage_move" | "decision" | "risk" | "profit" | "review" | "retro";
	conclusion: string;
	decisionStatus?: DecisionStatus;
	reason: string;
	snapshotId?: string;
	strategyId?: string;
	strategyVersion?: number;
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

// 工作台待办：从 store 派生的只读视图，不持久化（条件解决即消失）
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
}

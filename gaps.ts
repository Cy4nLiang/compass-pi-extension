import { SNAPSHOT_FRESHNESS_DAYS, isNewerSnapshot, snapshotTtlDays } from "./defaults.ts";
import { METRIC_LABELS } from "./report.ts";
import { BASE_PRIORITY, DEEP_RESEARCH_REQUIRED_FIELDS, FIELD_LABELS } from "./todo.ts";
import {
	STAGE_LABELS,
	type Candidate,
	type CandidateStage,
	type CompassStore,
	type MarketSnapshot,
	type ProfitEstimate,
	type ReviewAnalysis,
	type RiskRecord,
	type StrategyRun,
	type TodoPriority,
	type WorkbenchTodo,
} from "./types.ts";

// 补数缺口派生：把散落在策略、待办、导入告警、利润 / 风险 / 差评 / 复盘里的「缺数据」信号
// 汇成一份**只读**记录，与 todo.ts 同样「不实体化」——不落 store、不新增顶层集合。
//
// 本模块是纯函数层：零 I/O、零写事务、不 import service.ts（保持 defaults / todo / types 这一层的
// 单向依赖）。凡是需要编排结果（待办清单、预算池状态）的地方一律由调用方作为入参传进来——
// 尤其是 todos：compactDashboardSummary 已经算过一遍，deriveGaps 再自己算一遍会让同一次写事务
// 算三遍，且对多来源市场会触发快照 sidecar 的同步磁盘读。

export const GAP_ORIGINS = [
	"strategy_missing",
	"todo_deep_missing",
	"todo_risk_missing",
	"todo_snapshot_stale",
	"todo_metric_divergence",
	"csv_warning",
	"profit_cpc",
	"profit_unpersisted",
	"defaults_silent",
	"risk_url",
	"review_evidence",
	"retro_actuals",
] as const;
export type GapOrigin = (typeof GAP_ORIGINS)[number];

export const GAP_AUTO_TIERS = ["C_auto", "A_confirm", "manual"] as const;
export type GapAutoTier = (typeof GAP_AUTO_TIERS)[number];

export const GAPFILL_MODES = ["guided", "strict", "off"] as const;
export type GapfillMode = (typeof GAPFILL_MODES)[number];

export interface MutedGap {
	id: string;
	until: string;
}

// 预算池状态的结构化切片：只取判「可用 / 已配可生效上限」需要的字段，
// 这样 gaps.ts 不必 import service.ts，调用方直接把 budgetStatus(store) 的结果传进来即可。
export interface GapBudgetPool {
	source: string;
	tier: "A" | "B" | "C";
	enabled: boolean;
	monthlyLimitCny: number;
	monthlyCallLimit?: number;
	costPerCallCny?: number;
	state: "ok" | "warning" | "fused" | "free";
}

export type GapSourceName = "local_history" | "manual_csv" | "sorftime" | "sellersprite" | "keepa" | "sp_api" | "manual";
export type GapWriteBack = "import_csv" | "profit_estimate" | "risk_check" | "reviews_record" | "record_actuals" | "todo_submit" | "none";

// 静态路由表的一行：只含通用词表（来源名取自 DEFAULT_BUDGET_POOLS 已有的池名 + manual），
// how / template 只允许通用填空句。内部 SOP、供应商名、账号归属一律不进本文件——
// 那些由宿主项目的 .pi/gapfill/hints.json 在 plan 时覆盖。
export interface GapSourceTemplate {
	source: GapSourceName;
	tier: "C" | "A" | "manual";
	auto: "yes" | "partial" | "no";
	estimatedCalls?: number;
	writeBack: GapWriteBack;
	how: string;
	template?: string;
}

export interface GapSourceOption extends GapSourceTemplate {
	available: boolean;
	limitConfigured: boolean;
}

export interface GapRecord {
	// gap_<marketId>_<field>；marketId 为 "-" 表示不属于任何市场的瞬时缺口（见 transientProfitUnpersistedGap）
	id: string;
	// id + 触发证据摘要（snapshotId / runId / estimateId / riskId …），变化即判「新增」
	fingerprint: string;
	marketId: string;
	marketName: string;
	candidateId?: string;
	stage: CandidateStage;
	field: string;
	label: string;
	origin: GapOrigin;
	reason: string;
	priority: TodoPriority;
	sources: GapSourceOption[];
	autoTier: GapAutoTier;
	ttlDays: number | null;
	snapshotAgeDays?: number;
	todoId?: string;
	mutedUntil?: string;
}

export interface GapSummary {
	total: number;
	auto: number;
	confirm: number;
	manual: number;
}

export interface DeriveGapsInput {
	// 必传：由调用方复用同一份 listWorkbenchTodos 结果（见文件头注释）
	todos: readonly WorkbenchTodo[];
	// budgetStatus(store) 的结果；缺省视为「没有任何付费池可用」
	budgets?: readonly GapBudgetPool[];
	now?: string;
	muted?: readonly MutedGap[];
	// 只派生这一个市场（写工具尾注、历史速览用）
	marketId?: string;
}

const DAY_MS = 86_400_000;

// ── 静态路由表 ────────────────────────────────────────────────────────────────

const REIMPORT_CSV: GapSourceTemplate = {
	source: "manual_csv",
	tier: "C",
	auto: "yes",
	writeBack: "import_csv",
	how: "重新导出带该列的市场 CSV 后用 compass_import_csv 重导",
};

const SORFTIME_FULL_SNAPSHOT: GapSourceTemplate = {
	source: "sorftime",
	tier: "A",
	auto: "partial",
	estimatedCalls: 3,
	writeBack: "import_csv",
	how: "Sorftime 合成一份完整快照（类目检索 → 类目报告 → 类目关键词），需运营确认后才花钱",
};

const LOCAL_CPC_HISTORY: GapSourceTemplate = {
	source: "local_history",
	tier: "C",
	auto: "partial",
	writeBack: "profit_estimate",
	how: "compass_keyword_metrics 查本地历史 CPC 作参考值，运营确认后填进利润测算（不进指标）",
};

const MANUAL_MAIN_CPC: GapSourceTemplate = {
	source: "manual",
	tier: "manual",
	auto: "no",
	writeBack: "profit_estimate",
	how: "从广告后台或第三方工具取主词 CPC 后手填",
	template: "主词 CPC＝{{金额}} {{币种}}（口径：{{关键词}}）",
};

export const GAP_SOURCE_MATRIX: Record<string, readonly GapSourceTemplate[]> = {
	csv_column: [REIMPORT_CSV, SORFTIME_FULL_SNAPSHOT],
	main_cpc: [LOCAL_CPC_HISTORY, SORFTIME_FULL_SNAPSHOT, MANUAL_MAIN_CPC],
	waist_rating_median: [REIMPORT_CSV, SORFTIME_FULL_SNAPSHOT],
	snapshot: [REIMPORT_CSV, SORFTIME_FULL_SNAPSHOT],
	cost_inputs: [
		{
			source: "manual",
			tier: "manual",
			auto: "no",
			writeBack: "profit_estimate",
			how: "向供应商 / 货代取报价后填进利润测算；未取到的项留空不猜",
			template: "售价＝{{金额}}　采购＝{{金额}}　头程＝{{金额}}　关税＝{{金额}}　FBA＝{{金额}}（同币种；未回答的项不填）",
		},
	],
	conversion_inputs: [
		{
			source: "manual",
			tier: "manual",
			auto: "no",
			writeBack: "profit_estimate",
			how: "用自有后台或类目基准替换默认假设值；不确定就保留默认并在报告里标「暂定」",
			template: "转化率＝{{百分比}}　退货率＝{{百分比}}（大于 1 会按百分数换算并回显）",
		},
	],
	capital_share: [
		{
			source: "manual",
			tier: "manual",
			auto: "no",
			writeBack: "profit_estimate",
			how: "由运营或主管一次性给出总选品资金",
			template: "总选品资金＝{{金额}} {{币种}}",
		},
	],
	risk_evidence_url: [
		{
			source: "manual",
			tier: "manual",
			auto: "no",
			writeBack: "risk_check",
			how: "到官方站核验后把可点击链接贴进风险清单证据项（无联网核验能力，只能人工）",
			template: "{{风险项}}：结论＝{{pass 或 review 或 red}}　证据链接＝{{URL}}",
		},
	],
	risk_check: [
		{
			source: "manual",
			tier: "manual",
			auto: "no",
			writeBack: "risk_check",
			how: "用 compass_risk_check 逐项核验并留痕",
			template: "认证＝{{结论}}　侵权＝{{结论}}　季节性＝{{结论}}　政策＝{{结论}}　物流＝{{结论}}",
		},
	],
	review_evidence: [
		{
			source: "manual",
			tier: "manual",
			auto: "no",
			writeBack: "reviews_record",
			how: "导出差评原句后用 compass_reviews_record 录入主题与证据",
			template: "主题＝{{名称}}　类别＝{{quality 或 size 或 damage 或 expectation 或 usability 或 other}}　原句＝{{不超过 10 句}}",
		},
	],
	estimated_rating: [
		{
			source: "manual",
			tier: "manual",
			auto: "no",
			writeBack: "reviews_record",
			how: "预估星级只能由人给（1–5），系统不猜",
			template: "预估星级＝{{1 到 5}}",
		},
	],
	actuals: [
		{
			source: "manual",
			tier: "manual",
			auto: "no",
			writeBack: "record_actuals",
			how: "到店铺后台取实绩后用 compass_retro record_actuals 录入",
			template: "日销＝{{件}}　TACOS＝{{百分比}}　退货率＝{{百分比}}　净利率＝{{百分比}}（日销与净利率必须同时有值才能判定）",
		},
	],
	metric_divergence: [
		{
			source: "manual",
			tier: "manual",
			auto: "no",
			writeBack: "todo_submit",
			how: "多来源指标打架时由运营定基准口径，再用 compass_todo submit 提交说明",
			template: "以 {{来源}} 为准，理由＝{{一句话}}",
		},
	],
	deep_research_confirm: [
		{
			source: "manual",
			tier: "manual",
			auto: "no",
			writeBack: "todo_submit",
			how: "四项硬指标齐备后仍需人工提交调研说明，用 compass_todo submit",
			template: "调研结论＝{{一句话}}　利润测算 id＝{{estimate_id}}",
		},
	],
	profit_unpersisted: [
		{
			source: "manual",
			tier: "manual",
			auto: "no",
			writeBack: "profit_estimate",
			how: "带 market_ref 重算一次即可持久化并进入策略上下文",
			template: "market_ref＝{{市场名或 id}}",
		},
	],
	generic: [{ source: "manual", tier: "manual", auto: "no", writeBack: "none", how: "该字段没有可自动补的来源，按业务口径人工补齐" }],
};

// 指标名 → 缺列伪字段：底层列缺失时，补数动作就是「重导带该列的 CSV」，
// 把两条缺口折成一条，避免运营看到「腰部星级缺」和「评分列缺」两行同义提示。
const METRIC_TO_CSV_COLUMN: Record<string, string> = {
	waist_rating_median: "csv_column:rating",
	low_rating_high_sales: "csv_column:rating",
	qualify_rank_depth: "csv_column:monthlySales",
	cr3: "csv_column:monthlySales",
	hhi: "csv_column:monthlySales",
	category_monthly_sales: "csv_column:monthlySales",
	brand_concentration: "csv_column:brand",
	amz_share: "csv_column:seller",
	new_listing_share_12m: "csv_column:launchDate",
};

// 只逐字匹配这五条「缺列」告警。同一个 warnings 数组里还有十余类别的告警（编码乱码、
// 未闭合引号、AMZ 样本量、宽表布局、快照乱序、sidecar 读失败时就地追加的那条…），
// 「有 warnings 就算缺口」会把它们全误判成可补数的缺列。csv.ts 改措辞时本表先红。
export const CSV_COLUMN_WARNINGS: ReadonlyArray<{ warning: string; field: string; label: string; extra?: string }> = [
	{ warning: "未识别到月销量列，QRD、CR3、HHI 等销量指标会缺失或降置信度", field: "csv_column:monthlySales", label: "月销量列" },
	{ warning: "未识别到品牌列，品牌集中度指标不可计算", field: "csv_column:brand", label: "品牌列" },
	{ warning: "未识别到评分列，低分高销数与腰部星级指标不可计算", field: "csv_column:rating", label: "评分列" },
	{ warning: "未识别到上架日期/月龄，新品占比不可计算", field: "csv_column:launchDate", label: "上架日期或月龄列", extra: "补上架日期或月龄任一列均可" },
	{ warning: "未识别到卖家类型/自营列，AMZ 自营占比不可计算", field: "csv_column:seller", label: "卖家类型或自营列", extra: "补卖家类型或自营标记任一列均可" },
];

// 利润测算里「值等于系统默认」的四项。注意这是**启发式**：ProfitEstimate.input 存的是
// normalizeProfitInput 归一化之后的值（service.ts recordProfitEstimate），落库后无法区分
// 「运营显式填了 0」与「系统默认成 0」——所以文案一律写「为假设」，绝不写「未填」。
export const PROFIT_ASSUMED_DEFAULTS: ReadonlyArray<{ field: "firstMileCost" | "tariffCost" | "cvr" | "returnRate"; label: string; value: number }> = [
	{ field: "firstMileCost", label: "头程费用", value: 0 },
	{ field: "tariffCost", label: "关税", value: 0 },
	{ field: "cvr", label: "转化率", value: 0.12 },
	{ field: "returnRate", label: "退货率", value: 0.05 },
];

// economics.ts 的三条 cpcRatio 缺失文案里只取前两条：第三条「毛利不足以形成正向盈亏平衡 CPC」
// 说的是毛利为负，补数动作是提高毛利而不是补 CPC，归进 profit_cpc 会给出错误的下一步。
const PROFIT_CPC_WARNINGS = [
	"未提供主词 CPC，CPC 承受度 Gate 保持待复核",
	"主词 CPC 为 0，按缺数据处理（Amazon 最低竞价约 $0.02），CPC 承受度 Gate 保持待复核",
] as const;

const RISK_URL_DOWNGRADE_NOTE = "各项虽填 pass/clear，但没有可点击证据链接";

// service.ts 的 riskMetrics 从**一条** RiskRecord 一次性产出这六个指标：它们一起 missing
// 只说明一件事——风险清单还没做。折成一条 risk_check 缺口，而不是让六行同义提示占满尾注。
export const RISK_CONTEXT_METRICS = new Set(["risk_overall", "cert_status", "ip_risk_level", "season_flag", "policy_flag", "logistics_risk"]);

const ORIGIN_PRIORITY: Record<GapOrigin, TodoPriority> = {
	strategy_missing: 2,
	todo_deep_missing: BASE_PRIORITY.deep_missing_data,
	todo_risk_missing: BASE_PRIORITY.risk_missing,
	todo_snapshot_stale: BASE_PRIORITY.snapshot_stale,
	todo_metric_divergence: BASE_PRIORITY.metric_divergence,
	csv_warning: 3,
	profit_cpc: 3,
	profit_unpersisted: 4,
	defaults_silent: 4,
	risk_url: 3,
	review_evidence: 3,
	retro_actuals: 4,
};

// 同一个 (marketId, field) 上多条来源撞车时谁做主键：越靠前越具体、越指向明确的补数动作
const ORIGIN_PRECEDENCE: readonly GapOrigin[] = [
	"csv_warning",
	"profit_cpc",
	"risk_url",
	"review_evidence",
	"retro_actuals",
	"defaults_silent",
	"todo_deep_missing",
	"todo_risk_missing",
	"todo_snapshot_stale",
	"todo_metric_divergence",
	"strategy_missing",
	"profit_unpersisted",
];

// 深研硬指标的中文标签反查：todo.ts 的 missingDeepResearchFields 只回标签，
// 这里把它折回字段名。todo.ts 改措辞时 tests/gaps.test.ts 的耦合用例先红。
const LABEL_TO_FIELD: Record<string, string> = Object.fromEntries(
	DEEP_RESEARCH_REQUIRED_FIELDS.map((field) => [FIELD_LABELS[field] ?? field, field] as const),
);

// 只放**真指标之外**的伪字段。真指标的中文名一律用 report.ts 的 METRIC_LABELS（五维报告与
// Web 都用它），在这里重抄一份就会出现「同一个指标在报告里叫 A、在缺口清单里叫 B」——
// tasks.md R6 要避免的正是这件事。tests/gaps.test.ts 有一条断言钉死两张表不得有交集。
export const FIELD_LABEL_EXTRA: Record<string, string> = {
	snapshot: "市场快照",
	risk_evidence_url: "风险证据链接",
	risk_check: "风险清单",
	review_evidence: "差评原句",
	estimated_rating: "预估星级",
	actuals: "上线实绩",
	metric_divergence: "多源指标口径",
	deep_research_confirm: "深研确认",
	market_ref: "市场归属",
	portfolio_capital: "总选品资金",
	firstMileCost: "头程费用",
	tariffCost: "关税",
	cvr: "转化率",
	returnRate: "退货率",
};

// ── 小工具 ────────────────────────────────────────────────────────────────────

function daysBetween(fromIso: string, toIso: string): number {
	const from = Date.parse(fromIso);
	const to = Date.parse(toIso);
	if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
	return Math.max(0, Math.floor((to - from) / DAY_MS));
}

function latestByCreatedAt<T extends { marketId?: string; createdAt: string }>(items: readonly T[], marketId: string): T | undefined {
	let latest: T | undefined;
	for (const item of items) {
		if (item.marketId !== marketId) continue;
		if (!latest || Date.parse(item.createdAt) > Date.parse(latest.createdAt)) latest = item;
	}
	return latest;
}

function latestSnapshotOf(store: CompassStore, marketId: string): MarketSnapshot | undefined {
	let latest: MarketSnapshot | undefined;
	for (const snapshot of store.snapshots) {
		if (snapshot.marketId !== marketId) continue;
		if (isNewerSnapshot(snapshot, latest)) latest = snapshot;
	}
	return latest;
}

// 例行导入自动跑的是 screen 模式，只评 market_screen 一个 stage——照「最近一次 run」取
// missingMetrics 会让深研 / 风控阶段的缺口系统性漏报。按 mode 各取最新再取并集。
function latestRunsByMode(store: CompassStore, marketId: string): { full?: StrategyRun; screen?: StrategyRun } {
	let full: StrategyRun | undefined;
	let screen: StrategyRun | undefined;
	for (const run of store.strategyRuns) {
		if (run.marketId !== marketId) continue;
		if (run.mode === "full") {
			if (!full || Date.parse(run.runAt) > Date.parse(full.runAt)) full = run;
		} else if (!screen || Date.parse(run.runAt) > Date.parse(screen.runAt)) {
			screen = run;
		}
	}
	return { full, screen };
}

export function gapTtlDays(stage: CandidateStage): number | null {
	if (stage === "archived") return null;
	// DataRouteStage 只有 5 个取值，CandidateStage 有 8 个：decision 按深研、review 按测试期处理
	if (stage === "decision") return SNAPSHOT_FRESHNESS_DAYS.deepResearch;
	if (stage === "review") return SNAPSHOT_FRESHNESS_DAYS.testing;
	return snapshotTtlDays(stage);
}

// 兜底链的顺序是有讲究的：深研四项先用 todo.ts 的 FIELD_LABELS，让缺口与待办列表里的措辞
// 逐字一致（运营在两个面看到的是同一件事）；其余真指标用 report.ts 的 METRIC_LABELS；
// 最后才是本文件的伪字段表。三层都没有才吐英文 id——那说明有人加了新字段没配标签。
export function gapLabel(field: string): string {
	if (field.startsWith("csv_column:")) {
		const hit = CSV_COLUMN_WARNINGS.find((item) => item.field === field);
		return hit?.label ?? field;
	}
	return FIELD_LABELS[field] ?? METRIC_LABELS[field] ?? FIELD_LABEL_EXTRA[field] ?? field;
}

export function gapRouteKey(field: string): string {
	if (field.startsWith("csv_column:")) return "csv_column";
	if (field === "main_cpc" || field === "cpc_ratio") return "main_cpc";
	if (field === "waist_rating_median") return "waist_rating_median";
	if (field === "snapshot") return "snapshot";
	if (field === "gross_margin" || field === "firstMileCost" || field === "tariffCost") return "cost_inputs";
	if (field === "cvr" || field === "returnRate") return "conversion_inputs";
	if (field === "capital_share" || field === "portfolio_capital") return "capital_share";
	if (field === "risk_evidence_url") return "risk_evidence_url";
	// 六个风险指标由同一条 RiskRecord 一次性产出（service.ts 的 riskMetrics），
	// 补法只有一个：跑一次 compass_risk_check。少写一个就会掉进 generic 的「没有可自动补的来源」
	if (field === "risk_check" || RISK_CONTEXT_METRICS.has(field)) return "risk_check";
	if (field === "review_evidence") return "review_evidence";
	if (field === "estimated_rating" || field === "est_rating_gap") return "estimated_rating";
	if (field === "actuals") return "actuals";
	if (field === "metric_divergence") return "metric_divergence";
	if (field === "deep_research_confirm") return "deep_research_confirm";
	if (field === "market_ref") return "profit_unpersisted";
	return "generic";
}

// 与 compass_data_route 的 available() 同口径：池启用且未熔断。
// limitConfigured 另判「上限是否真的会生效」——只配金额上限而单价缺省时自动计量金额恒 0，
// 熔断门同样空转，等于没配（默认 sorftime 池就是这种情况）。
function resolveSources(routeKey: string, budgets: readonly GapBudgetPool[], localHistoryAuto: boolean): GapSourceOption[] {
	const templates = GAP_SOURCE_MATRIX[routeKey] ?? GAP_SOURCE_MATRIX.generic;
	const options: GapSourceOption[] = templates.map((template) => {
		const pool = budgets.find((item) => item.source === template.source);
		const limitConfigured = Boolean(
			pool?.enabled &&
				((pool.monthlyCallLimit !== undefined && pool.monthlyCallLimit > 0) || (pool.monthlyLimitCny > 0 && (pool.costPerCallCny ?? 0) > 0)),
		);
		const available =
			template.tier === "manual" || template.source === "local_history" || template.source === "manual_csv"
				? true
				: Boolean(pool?.enabled && pool.state !== "fused");
		const auto = template.source === "local_history" && localHistoryAuto ? "yes" : template.auto;
		return { ...template, auto, available, limitConfigured };
	});
	const rank = (option: GapSourceOption) => (option.tier === "C" ? 0 : option.tier === "A" ? 1 : 2);
	return options.sort((a, b) => rank(a) - rank(b));
}

function autoTierOf(sources: readonly GapSourceOption[]): GapAutoTier {
	if (sources.some((option) => option.tier === "C" && option.auto === "yes" && option.available)) return "C_auto";
	if (sources.some((option) => option.tier === "A" && option.available && option.limitConfigured)) return "A_confirm";
	return "manual";
}

// ── 派生 ──────────────────────────────────────────────────────────────────────

interface GapSeed {
	marketId: string;
	candidateId?: string;
	stage: CandidateStage;
	field: string;
	origin: GapOrigin;
	reason: string;
	evidence: string;
	todoId?: string;
	localHistoryAuto?: boolean;
}

function foldField(field: string, missingColumns: ReadonlySet<string>): string {
	const folded = METRIC_TO_CSV_COLUMN[field];
	return folded && missingColumns.has(folded) ? folded : field;
}

const REVIEW_RELEVANT_STAGES: readonly CandidateStage[] = ["deep_research", "risk", "decision", "testing", "review"];

function seedsForMarket(store: CompassStore, candidate: Candidate, todos: readonly WorkbenchTodo[]): GapSeed[] {
	const seeds: GapSeed[] = [];
	const marketId = candidate.marketId;
	const base = { marketId, candidateId: candidate.id, stage: candidate.stage };
	const snapshot = latestSnapshotOf(store, marketId);

	// ① CSV 导入告警（逐字匹配五条缺列文案）
	const missingColumns = new Set<string>();
	if (snapshot) {
		for (const item of CSV_COLUMN_WARNINGS) {
			if (!snapshot.warnings.includes(item.warning)) continue;
			missingColumns.add(item.field);
			seeds.push({
				...base,
				field: item.field,
				origin: "csv_warning",
				reason: item.extra ? `${item.warning}（${item.extra}）` : item.warning,
				evidence: `snap:${snapshot.id}`,
			});
		}
	}

	// ② strategy missing：full 优先、screen 回落，两份取并集
	const runs = latestRunsByMode(store, marketId);
	const missingMetrics = new Set<string>([...(runs.full?.result.missingMetrics ?? []), ...(runs.screen?.result.missingMetrics ?? [])]);
	const runEvidence = `run:${runs.full?.id ?? "-"}+${runs.screen?.id ?? "-"}`;
	// 六个风险指标先折成一条：它们同源同补法，逐个成条会把尾注的前 3 名全占掉
	const missingRiskMetrics = [...missingMetrics].filter((metric) => RISK_CONTEXT_METRICS.has(metric));
	if (missingRiskMetrics.length) {
		seeds.push({
			...base,
			field: "risk_check",
			origin: "strategy_missing",
			reason: `策略评估缺风险指标 ${missingRiskMetrics.map(gapLabel).join("、")}，需先做风险清单`,
			evidence: runEvidence,
		});
	}
	for (const metric of missingMetrics) {
		if (RISK_CONTEXT_METRICS.has(metric)) continue;
		seeds.push({
			...base,
			field: foldField(metric, missingColumns),
			origin: "strategy_missing",
			reason: `策略评估缺指标 ${gapLabel(metric)}，规则转人工复核`,
			evidence: runEvidence,
		});
	}

	// ③ 待办派生四类：复用调用方已算好的 listWorkbenchTodos 结果
	const latestRisk = latestByCreatedAt<RiskRecord>(store.riskRecords, marketId);
	for (const todo of todos) {
		if (todo.marketId !== marketId) continue;
		if (todo.kind === "deep_missing_data") {
			const parsed = /^缺 (.+)$/u.exec(todo.reason);
			const fields = parsed ? parsed[1].split("、").map((label) => LABEL_TO_FIELD[label] ?? label) : ["deep_research_confirm"];
			for (const field of fields) {
				seeds.push({ ...base, field: foldField(field, missingColumns), origin: "todo_deep_missing", reason: todo.reason, evidence: `todo:${todo.id}`, todoId: todo.id });
			}
		} else if (todo.kind === "risk_missing") {
			// 「无可点击证据链接」既可能由 todo 直接给出，也可能被 recordRisk 提前降级成
			// overall=review 而在 todo 里表现为「风险总体为 review」——两者指同一件事
			const noUrl = Boolean(latestRisk && !latestRisk.evidence.some((item) => Boolean(item.url?.trim())));
			// 「清单未做」与「总体待核查」补法相同（都是跑一次 compass_risk_check），归同一条；
			// 只有「有记录但没有可点击链接」才是另一件事
			const field = todo.reason.includes("无可点击证据链接") || (noUrl && latestRisk?.overall === "review") ? "risk_evidence_url" : "risk_check";
			seeds.push({ ...base, field, origin: "todo_risk_missing", reason: todo.reason, evidence: `todo:${todo.id}`, todoId: todo.id });
		} else if (todo.kind === "snapshot_stale") {
			seeds.push({ ...base, field: "snapshot", origin: "todo_snapshot_stale", reason: todo.reason, evidence: `todo:${todo.id}#snap:${snapshot?.id ?? "none"}`, todoId: todo.id });
		} else if (todo.kind === "metric_divergence") {
			seeds.push({ ...base, field: "metric_divergence", origin: "todo_metric_divergence", reason: todo.reason, evidence: `todo:${todo.id}`, todoId: todo.id });
		}
	}

	// ④ 利润测算：缺主词 CPC 与静默默认值
	const estimate = latestByCreatedAt<ProfitEstimate>(store.profitEstimates, marketId);
	if (estimate) {
		const cpcWarning = estimate.result.warnings.find((warning) => (PROFIT_CPC_WARNINGS as readonly string[]).includes(warning));
		// 有历史 CPC 就能给出参考值：只看快照 metrics（普通字段），不碰 listings 懒读
		const hasCpcHistory = store.snapshots.some((item) => {
			if (item.marketId !== marketId) return false;
			const value = item.metrics.main_cpc?.value;
			return value !== undefined && value !== null;
		});
		if (cpcWarning) {
			seeds.push({ ...base, field: "main_cpc", origin: "profit_cpc", reason: cpcWarning, evidence: `est:${estimate.id}`, localHistoryAuto: hasCpcHistory });
		}
		for (const item of PROFIT_ASSUMED_DEFAULTS) {
			if (estimate.input[item.field] !== item.value) continue;
			seeds.push({
				...base,
				field: item.field,
				origin: "defaults_silent",
				reason: `${item.label} 为假设（等于系统默认 ${item.value}；落库值无法区分是显式填写还是默认）`,
				evidence: `est:${estimate.id}`,
			});
		}
	}

	// ⑤ 风险缺官方 URL：判据与 recordRisk 的自动降级条件同源，
	// 不能只判 overall==="review"——那多半是季节性 / 政策未清，不是缺链接
	if (latestRisk) {
		const noUrl = !latestRisk.evidence.some((item) => Boolean(item.url?.trim()));
		const downgraded = latestRisk.notes?.includes(RISK_URL_DOWNGRADE_NOTE) ?? false;
		if (noUrl && (downgraded || latestRisk.overall === "review")) {
			seeds.push({ ...base, field: "risk_evidence_url", origin: "risk_url", reason: "风险清单没有可点击证据链接，系统按 review 处理", evidence: `risk:${latestRisk.id}` });
		}
	}

	// ⑥ 差评缺原句 / 预估星级：只对进入深研之后的候选发起
	if (REVIEW_RELEVANT_STAGES.includes(candidate.stage)) {
		const analysis = latestByCreatedAt<ReviewAnalysis>(store.reviewAnalyses, marketId);
		if (!analysis) {
			seeds.push({ ...base, field: "review_evidence", origin: "review_evidence", reason: "尚无差评分析记录，星级差与痛点可解率均缺数据", evidence: "rev:none" });
		} else {
			if (analysis.estimatedRatingGap === undefined) {
				seeds.push({ ...base, field: "estimated_rating", origin: "review_evidence", reason: "星级差缺数据（预估星级只能由人给，腰部星级可从快照回落）", evidence: `rev:${analysis.id}` });
			}
			if (analysis.themes.length > 0 && analysis.themes.every((theme) => !theme.evidence?.length)) {
				seeds.push({ ...base, field: "review_evidence", origin: "review_evidence", reason: "差评主题没有任何原句证据", evidence: `rev:${analysis.id}` });
			}
		}
	}

	// ⑦ 复盘缺实绩：只对已决 go 的候选有意义（record_actuals 的写入前置条件）
	if (candidate.decisionStatus === "go") {
		let latestCheck: { id: string; createdAt: string; actuals?: { dailyUnits?: number; netMargin?: number } } | undefined;
		for (const check of store.outcomeChecks) {
			if (check.marketId !== marketId || !check.actuals) continue;
			if (!latestCheck || Date.parse(check.createdAt) > Date.parse(latestCheck.createdAt)) latestCheck = check;
		}
		const actuals = latestCheck?.actuals;
		const hasHard =
			typeof actuals?.dailyUnits === "number" && Number.isFinite(actuals.dailyUnits) && typeof actuals.netMargin === "number" && Number.isFinite(actuals.netMargin);
		if (!hasHard) {
			seeds.push({ ...base, field: "actuals", origin: "retro_actuals", reason: "日销与净利率必须同时有实绩，当前证据不足", evidence: `chk:${latestCheck?.id ?? "none"}` });
		}
	}

	return seeds;
}

function materialize(
	seeds: readonly GapSeed[],
	marketNames: ReadonlyMap<string, string>,
	store: CompassStore,
	budgets: readonly GapBudgetPool[],
	muted: readonly MutedGap[],
	now: string,
): GapRecord[] {
	const merged = new Map<string, { primary: GapSeed; reasons: string[]; evidences: Set<string>; todoId?: string; localHistoryAuto: boolean }>();
	for (const seed of seeds) {
		const key = `${seed.marketId} ${seed.field}`;
		const bucket = merged.get(key);
		if (!bucket) {
			merged.set(key, {
				primary: seed,
				reasons: [seed.reason],
				evidences: new Set([seed.evidence]),
				todoId: seed.todoId,
				localHistoryAuto: seed.localHistoryAuto ?? false,
			});
			continue;
		}
		bucket.reasons.push(seed.reason);
		bucket.evidences.add(seed.evidence);
		bucket.todoId ??= seed.todoId;
		bucket.localHistoryAuto ||= seed.localHistoryAuto ?? false;
		if (ORIGIN_PRECEDENCE.indexOf(seed.origin) < ORIGIN_PRECEDENCE.indexOf(bucket.primary.origin)) bucket.primary = seed;
	}

	const records: GapRecord[] = [];
	for (const bucket of merged.values()) {
		const seed = bucket.primary;
		const snapshot = latestSnapshotOf(store, seed.marketId);
		const sources = resolveSources(gapRouteKey(seed.field), budgets, bucket.localHistoryAuto);
		const id = `gap_${seed.marketId}_${seed.field}`;
		const evidence = [...bucket.evidences].sort().join("|");
		// 快照过期缺口的 ttl 固定跟 todo_snapshot_stale 的判据（固定 30 天）走，
		// 否则会出现「gap 说 TTL 7 天已过期、todo 却不认为过期」的双口径
		const ttlDays = seed.origin === "todo_snapshot_stale" ? SNAPSHOT_FRESHNESS_DAYS.screen : gapTtlDays(seed.stage);
		// 取所有命中项里最晚的那个 until，不能用 find 拿第一个：一条中途过期的 gap 级静音
		// 排在市场级静音前面时，find 会先命中它、判为已过期，整个市场的静音就失效了
		// （pruneMutedGaps 只在 session_start 与每次落盘时跑，管不住会话中途的过期）
		const mutedUntil = muted
			.filter((item) => (item.id === id || item.id === seed.marketId) && Date.parse(item.until) > Date.parse(now))
			.map((item) => item.until)
			.sort()
			.at(-1);
		records.push({
			id,
			fingerprint: `${id}#${evidence}`,
			marketId: seed.marketId,
			marketName: marketNames.get(seed.marketId) ?? seed.marketId,
			candidateId: seed.candidateId,
			stage: seed.stage,
			field: seed.field,
			label: gapLabel(seed.field),
			origin: seed.origin,
			reason: [...new Set(bucket.reasons)].join("；"),
			priority: ORIGIN_PRIORITY[seed.origin],
			sources,
			autoTier: autoTierOf(sources),
			ttlDays,
			snapshotAgeDays: snapshot ? daysBetween(snapshot.capturedAt, now) : undefined,
			todoId: bucket.todoId,
			mutedUntil,
		});
	}

	return records.sort((a, b) => a.priority - b.priority || a.marketName.localeCompare(b.marketName) || a.id.localeCompare(b.id));
}

export function deriveGaps(store: CompassStore, input: DeriveGapsInput): GapRecord[] {
	const now = input.now && Number.isFinite(Date.parse(input.now)) ? input.now : new Date().toISOString();
	const marketNames = new Map(store.markets.map((market) => [market.id, market.name] as const));
	const seeds: GapSeed[] = [];
	for (const candidate of store.candidates) {
		if (candidate.stage === "archived") continue;
		if (input.marketId && candidate.marketId !== input.marketId) continue;
		seeds.push(...seedsForMarket(store, candidate, input.todos));
	}
	return materialize(seeds, marketNames, store, input.budgets ?? [], input.muted ?? [], now);
}

// 瞬时缺口：没有 market_ref 的利润测算根本不进 store（recordProfitEstimate 不被调用），
// deriveGaps 永远看不到它。只能由 compass_profit_estimate 的 execute 就地产出一条。
export function transientProfitUnpersistedGap(input: { summary: string; stamp?: string }): GapRecord {
	const sources = resolveSources("profit_unpersisted", [], false);
	return {
		id: "gap_-_market_ref",
		fingerprint: `gap_-_market_ref#${input.stamp ?? "session"}`,
		marketId: "-",
		marketName: "未关联市场",
		stage: "lead",
		field: "market_ref",
		label: gapLabel("market_ref"),
		origin: "profit_unpersisted",
		reason: `本次测算未关联市场、未持久化，不会进入策略上下文（${input.summary}）`,
		priority: ORIGIN_PRIORITY.profit_unpersisted,
		sources,
		autoTier: autoTierOf(sources),
		ttlDays: null,
	};
}

export function diffGaps(seen: ReadonlySet<string>, next: readonly GapRecord[]): { added: GapRecord[]; fingerprints: Set<string> } {
	const fingerprints = new Set<string>();
	const added: GapRecord[] = [];
	for (const gap of next) {
		fingerprints.add(gap.fingerprint);
		if (!seen.has(gap.fingerprint)) added.push(gap);
	}
	return { added, fingerprints };
}

export function summarizeGaps(gaps: readonly GapRecord[]): GapSummary {
	const visible = gaps.filter((gap) => !gap.mutedUntil);
	return {
		total: visible.length,
		auto: visible.filter((gap) => gap.autoTier === "C_auto").length,
		confirm: visible.filter((gap) => gap.autoTier === "A_confirm").length,
		manual: visible.filter((gap) => gap.autoTier === "manual").length,
	};
}

export function gapActionLine(gap: GapRecord): string {
	// 每一档都按档位挑自己那条来源，不能用 sources[0]：排序是 C → A → manual，
	// 而 A_confirm 唯一可达的路由（main_cpc）第一条恰好是 C 档的 local_history，
	// 拿 sources[0] 会打印出「A 档 local_history」这种自相矛盾的行
	if (gap.autoTier === "C_auto") {
		const free = gap.sources.find((option) => option.tier === "C" && option.auto === "yes" && option.available) ?? gap.sources[0];
		return `C 档：${free?.how ?? "本地可补"}`;
	}
	// A 档给的是**可照做的命令**。approve 会当面弹一次确认，所以这里不必替运营犹豫；
	// 但也要说清它会花钱，别让人以为和 C 档一样点了就完事
	if (gap.autoTier === "A_confirm") {
		const paid = gap.sources.find((option) => option.tier === "A" && option.available && option.limitConfigured);
		return `A 档 ${paid?.source ?? "sorftime"} 可补（会花钱）：compass_gaps action=approve market_ref=${gap.marketId} 当面确认后自动补齐`;
	}
	const manual = gap.sources.find((option) => option.tier === "manual") ?? gap.sources[0];
	return manual?.template ? `人工：${manual.template}` : `人工：${manual?.how ?? "按业务口径补齐"}`;
}

// 写工具尾注用的 ≤5 行摘要：只列本市场**新增**缺口，按 priority 取前 3 条。
// 未回答的槽位一律留 {{占位符}}，不填不猜。
export function renderGapNote(
	added: readonly GapRecord[],
	options: { marketName: string; stage: CandidateStage; snapshotAgeDays?: number; ttlDays: number | null },
): string[] {
	const visible = added.filter((gap) => !gap.mutedUntil);
	if (!visible.length) return [];
	const age = options.snapshotAgeDays === undefined ? "无快照" : `快照 ${options.snapshotAgeDays}d`;
	const ttl = options.ttlDays === null ? "TTL —" : `TTL ${options.ttlDays}d`;
	const lines = [`${options.marketName}（${STAGE_LABELS[options.stage]} · ${age} / ${ttl}）· 新增 ${visible.length}`];
	for (const gap of visible.slice(0, 3)) lines.push(`${gap.label} 缺 → ${gapActionLine(gap)}`);
	// 这一行运营最可能直接复制，必须是可调用形态：plan 是 action 参数的取值，不是位置参数
	lines.push(`下一步：compass_gaps action=plan market_ref=${visible[0].marketId} 看完整计划`);
	return lines;
}

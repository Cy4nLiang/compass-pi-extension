import type {
	Candidate,
	DecisionLog,
	GateOutcome,
	Lesson,
	Market,
	MarketSnapshot,
	MetricEvidence,
	MetricMap,
	OutcomeCheck,
	ProfitEstimate,
	ReviewAnalysis,
	RiskRecord,
	StrategyEvaluation,
	StrategyVersion,
} from "./types.ts";

const PERCENT_METRICS = new Set([
	"cr3",
	"cr5",
	"cr10",
	"amz_share",
	"new_listing_share_12m",
	"traffic_concentration",
	"gross_margin",
	"return_loss_rate",
	"capital_share",
	"pain_fixability",
]);

export const METRIC_LABELS: Record<string, string> = {
	category_monthly_sales: "类目月销量",
	category_monthly_revenue: "类目月销售额",
	waist_monthly_sales: "腰部月销",
	price_p25: "价格 P25",
	price_p50: "价格 P50",
	price_p75: "价格 P75",
	keyword_search_volume: "词族搜索量",
	main_cpc: "主词建议 CPC",
	traffic_concentration: "流量集中度",
	cr3: "CR3",
	cr5: "CR5",
	cr10: "CR10",
	hhi: "HHI",
	amz_share: "AMZ 自营占比",
	new_listing_share_12m: "新品占比（≤12月）",
	waist_review_median: "腰部评论数中位数",
	low_rating_high_sales_count: "低分高销数",
	waist_rating_median: "腰部星级中位数",
	top20_age_months_median: "Top20 上架月龄中位数",
	gross_margin: "毛利率",
	break_even_cpc: "盈亏平衡 CPC",
	cpc_ratio: "CPC 承受度",
	return_loss_rate: "退货损失率",
	startup_capital: "单 SKU 启动资金",
	capital_share: "组合资金占比",
	est_rating_gap: "预估星级差",
	pain_fixability: "痛点可改良度",
	risk_overall: "风险总体状态",
	cert_status: "认证状态",
	ip_risk_level: "知识产权风险",
	season_flag: "季节性",
	policy_flag: "政策/擦边",
	logistics_risk: "物流风险",
};

export const DIMENSIONS: Array<{ title: string; question: string; metrics: string[] }> = [
	{
		title: "D1 市场需求",
		question: "能不能装下目标量？",
		metrics: ["category_monthly_sales", "category_monthly_revenue", "waist_monthly_sales", "qualify_rank_depth", "price_p25", "price_p50", "price_p75", "keyword_search_volume"],
	},
	{
		title: "D2 竞争格局",
		question: "进得去吗？",
		metrics: ["cr3", "cr5", "cr10", "hhi", "amz_share", "new_listing_share_12m", "traffic_concentration", "waist_review_median", "low_rating_high_sales_count", "top20_age_months_median"],
	},
	{
		title: "D3 单位经济",
		question: "赚不赚钱、烧不烧得起？",
		metrics: ["gross_margin", "break_even_cpc", "cpc_ratio", "return_loss_rate", "startup_capital", "capital_share"],
	},
	{
		title: "D4 产品力",
		question: "卖出来能有几星？",
		metrics: ["waist_rating_median", "est_rating_gap", "pain_fixability", "low_rating_high_sales_count"],
	},
	{
		title: "D5 准入风险",
		question: "会不会踩坑？",
		metrics: ["risk_overall", "cert_status", "ip_risk_level", "season_flag", "policy_flag", "logistics_risk"],
	},
];

// 唯一的转义点：把自由文本压成「能安全放进一个表格单元格 / 一行列表项」的形状。
// 只处理 | 与换行，**刻意不处理 `*`**：Markdown 的强调以块为单位配对（我们的 markdown.js 逐行
// 逐格、GitHub 与 pi TUI 的 marked 逐段），跨字段串味要靠「一行 / 一格只放一个自由文本字段」
// 这条排版不变式解决，不能靠转义——转义只在我们自己那个渲染器里生效，另外两个渲染器却会把
// `\*` 原样显示，而 app.js 的 <pre class="report-source">、「复制 Markdown」与落盘 .md 都是同
// 一份原文，运营会直接看见那些反斜杠。history.ts 的复盘报告共用本函数，别再内联复制一份。
export function escapeCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

export function formatMetric(name: string, metric: MetricEvidence | undefined): string {
	if (!metric || metric.value === null) return "—";
	if (typeof metric.value === "number") {
		return PERCENT_METRICS.has(name) ? `${(metric.value * 100).toFixed(1)}%` : formatNumber(metric.value);
	}
	return String(metric.value);
}

export function outcomeLabel(outcome: GateOutcome): string {
	return outcome === "pass" ? "通过" : outcome === "review" ? "待人工复核" : "否决";
}

export function confidenceLabel(value: number): string {
	return value >= 0.85 ? "高" : value >= 0.65 ? "中" : value > 0 ? "低" : "缺失";
}

function metricTable(metrics: MetricMap, names: string[], targetMonthlyUnits: number): string[] {
	const lines = ["| 指标 | 值 | 来源 / 时间 | 置信度 |", "|---|---:|---|---|"];
	for (const name of names) {
		const metric = metrics[name];
		const label = name === "qualify_rank_depth" ? `QRD(${targetMonthlyUnits})` : METRIC_LABELS[name] ?? name;
		lines.push(
			`| ${escapeCell(label)} | ${escapeCell(formatMetric(name, metric))} | ${escapeCell(metric ? `${metric.source} · ${metric.capturedAt.slice(0, 10)}` : "—")} | ${metric ? `${confidenceLabel(metric.confidence)} (${metric.confidence.toFixed(2)})` : "缺失"} |`,
		);
	}
	return lines;
}

export interface GeneratedReport {
	markdown: string;
	marketId: string;
	marketName: string;
	outcome: GateOutcome;
	score: number;
	snapshotId: string;
}

export interface MarketReportData {
	market: Market;
	snapshot: MarketSnapshot;
	strategy: StrategyVersion;
	metrics: MetricMap;
	evaluation: StrategyEvaluation;
	candidate?: Candidate;
	risk?: RiskRecord;
	review?: ReviewAnalysis;
	profit?: ProfitEstimate;
	decisions: DecisionLog[];
	outcomeChecks: OutcomeCheck[];
	lessons: Lesson[];
	divergences: Array<{ metric: string; values: Array<{ source: string; value: number; capturedAt: string }>; divergence: number }>;
	attributedCostCny: number;
	fusedBudgetSources: string[];
}

export function renderMarketReport(data: MarketReportData): GeneratedReport {
	const { market, snapshot, strategy, metrics, evaluation, candidate, risk, review, profit, decisions, outcomeChecks, lessons, divergences, attributedCostCny, fusedBudgetSources } = data;
	const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.capturedAt)) / 86_400_000));
	const freshness = ageDays <= 7 ? "深研新鲜" : ageDays <= 30 ? "仅适合粗筛" : "已过期，建议补数";
	const targetMonthlyUnits = typeof strategy.definition.meta.monthly_units_q === "number" && Number.isFinite(strategy.definition.meta.monthly_units_q)
		? strategy.definition.meta.monthly_units_q
		: 300;
	const costs = attributedCostCny;

	const lines: string[] = [
		`# 罗盘选品报告｜${market.name}`,
		"",
		`> **结论：${outcomeLabel(evaluation.outcome)}** · 综合分 **${evaluation.score.toFixed(1)} / 100** · 候选阶段 **${candidate?.stage ?? "未建卡"}** · 最终决策 **${candidate?.decisionStatus ?? "未决策"}**`,
		">",
		`> 数据快照：\`${snapshot.id}\` · ${snapshot.source} · ${snapshot.capturedAt.slice(0, 10)}（${ageDays} 天前，${freshness}）`,
		`> 策略：\`${strategy.id}@v${strategy.version}\` · 报告生成：${new Date().toISOString()}`,
		"",
		"## 1. 决策摘要（GSE）",
		"",
		`- **Gate：** ${outcomeLabel(evaluation.outcome)}；${evaluation.rules.filter((rule) => rule.status === "veto" || rule.status === "fail").length} 个硬失败，${evaluation.rules.filter((rule) => ["review", "missing", "error"].includes(rule.status)).length} 个复核项。`,
		`- **Score：** 需求 ${evaluation.dimensionScores.demand} / 竞争 ${evaluation.dimensionScores.competition} / 单位经济 ${evaluation.dimensionScores.unit_economics} / 产品力 ${evaluation.dimensionScores.product} / 风险 ${evaluation.dimensionScores.risk}（单市场报告使用有界基准；批量扫描按同批候选分位数归一化）。`,
		// 三条原因各占一条列表项。拼在同一行时，运营在任一字段里手打的一个落单 `**`
		// （「**重点」「**必须先复核」这种半截强调在中文里很常见）会跨到下一个字段去配对，
		// 把中间整段染成 <strong>——那个粗体是生成器拼出来的，没人写过。
		// 必须是平级 bullet：markdown.js 不支持嵌套列表，2 空格缩进会被它拉平、GitHub 却会
		// 真嵌套，两个渲染器的版式就分叉了。
		// 三条恒定输出、缺失填 —：报告是证据文档，「没填」必须显式可见，结构稳定也好 diff。
		`- **当前阶段原因：** ${escapeCell(candidate?.stageReason ?? "—")}`,
		`- **Gate 原因：** ${escapeCell(candidate?.gateReason ?? "—")}`,
		`- **最终决策原因：** ${escapeCell(candidate?.decisionReason ?? "—")}`,
		`- **Evidence：** 每个指标保留来源、采集时间与置信度；本市场累计数据成本 **¥${costs.toFixed(2)}**。`,
		"",
		"| 阶段 | 规则 | 结果 | 证据表达式 |",
		"|---|---|---|---|",
	];
	for (const rule of evaluation.rules) {
		const status = rule.status === "pass" ? "通过" : rule.status === "veto" ? "一票否决" : rule.status === "fail" ? "未达门槛" : rule.status === "review" ? "人工复核" : rule.status === "missing" ? "缺数据" : "规则错误";
		lines.push(`| ${escapeCell(rule.stage)} | ${escapeCell(rule.label)} | **${status}** | \`${escapeCell(rule.when)}\` |`);
	}
	if (evaluation.missingMetrics.length) {
		lines.push("", `> 缺失指标：${evaluation.missingMetrics.map((name) => `\`${name}\``).join("、")}。缺数据不会被伪装成通过，而是转人工复核。`);
	}

	lines.push("", "## 2. 五维证据", "");
	for (const dimension of DIMENSIONS) {
		lines.push(`### ${dimension.title}｜${dimension.question}`, "", ...metricTable(metrics, dimension.metrics, targetMonthlyUnits), "");
	}

	lines.push("## 3. 单位经济情景", "");
	if (profit) {
		lines.push(
			`- 售价 ${profit.input.currency} ${profit.input.salePrice.toFixed(2)}；落地成本 ${profit.result.landedCost.toFixed(2)}；佣金 ${profit.result.referralFee.toFixed(2)}；FBA ${profit.input.fbaFee.toFixed(2)}。`,
			`- 毛利率 **${(profit.result.grossMargin * 100).toFixed(1)}%**；BE-CPC **${profit.result.breakEvenCpc.toFixed(2)}**；CPC 承受度 **${profit.result.cpcRatio?.toFixed(2) ?? "缺主词CPC"}**。`,
			`- 启动资金 **${profit.input.currency} ${profit.result.startupCapital.toFixed(2)}**（首批备货 ${profit.result.firstInventoryCost.toFixed(2)}）。`,
			"",
			"| TACOS | 净利率 | 月净利 | 回本月数 |",
			"|---:|---:|---:|---:|",
		);
		for (let index = 0; index < profit.result.netMarginScenarios.length; index++) {
			const margin = profit.result.netMarginScenarios[index];
			const monthly = profit.result.monthlyNetProfitScenarios[index];
			const payback = profit.result.paybackMonthsScenarios[index];
			lines.push(`| ${(margin.tacos * 100).toFixed(0)}% | ${(margin.netMargin * 100).toFixed(1)}% | ${monthly.monthlyNetProfit.toFixed(2)} | ${payback.paybackMonths?.toFixed(2) ?? "无法回本"} |`);
		}
	} else lines.push("> 尚无利润测算。先调用 `compass_profit_estimate`，完整策略中的 D3 会保持“待复核”。");

	lines.push("", "## 4. 产品痛点与改良机会", "");
	if (review) {
		lines.push(`分析 ${review.reviewCount} 条低星评论，来源 ASIN：${review.sourceAsins.join("、") || "未填写"}。`, "", "| 痛点主题 | 类别 | 数量 | 可改良性 | 建议 |", "|---|---|---:|---|---|");
		for (const theme of review.themes) {
			lines.push(`| ${escapeCell(theme.name)} | ${theme.category} | ${theme.count} | ${theme.fixability} | ${escapeCell(theme.recommendation ?? "—")} |`);
		}
	} else lines.push("> 尚无差评聚类。深研阶段应分析 Top10 竞品 1–3 星评论，并用 `compass_reviews_record` 留痕。");

	lines.push("", "## 5. 风险核查", "");
	if (risk) {
		lines.push(
			`- 总体：**${risk.overall}**；认证 ${risk.certStatus} / IP ${risk.ipRiskLevel} / 季节 ${risk.seasonFlag} / 政策 ${risk.policyFlag} / 物流 ${risk.logisticsRisk}。`,
		);
		// 一条证据一行：原先用「；」把多条拼在同一行。有 url 的那些靠 [..](..) 天然隔开
		// （markdown.js 先把整个链接抽成占位符，CommonMark 也不许强调跨 link 边界），
		// 但 title 为空或没填 url 时走的是裸文本分支，两条各带一个落单 `**` 就会跨条目配对。
		// 顺带补 escapeCell：RiskEvidenceItem.title / category 是未校验的自由字符串，
		// 内嵌一个换行就能把这条列表项劈成两块。
		if (risk.evidence.length) {
			for (const item of risk.evidence) {
				const label = escapeCell(item.title ?? item.category);
				lines.push(`- 证据链接：${item.url ? `[${label}](${item.url})` : label}`);
			}
		} else lines.push("- 证据链接：无（不得仅凭模型记忆判绿）");
	} else lines.push("> 尚无风险清单。正式决策前必须核验官方来源；AI 结果只作初筛，不构成法律意见。");

	lines.push("", "## 6. 多源校准与数据质量", "");
	if (divergences.length) {
		for (const divergence of divergences) {
			const label = divergence.metric === "qualify_rank_depth" ? `QRD(${targetMonthlyUnits})` : METRIC_LABELS[divergence.metric] ?? divergence.metric;
			lines.push(`- **标黄：${label} 多源偏差 ${(divergence.divergence * 100).toFixed(1)}%**：${divergence.values.map((item) => `${item.source}=${formatNumber(item.value)} (${item.capturedAt.slice(0, 10)})`).join("；")}。`);
		}
	} else lines.push("- 暂无超过 30% 的多源偏差；若只有一个来源，这不代表数据已被交叉验证。");
	for (const warning of snapshot.warnings) lines.push(`- 数据警告：${warning}`);

	// 决策人与原因分列。原先拼进同一格，落单的 `**` 会在格内串味——表格逐格渲染只挡得住
	// 跨列，挡不住一格里塞两个自由文本字段。
	lines.push("", "## 7. 决策回放", "", "| 时间 | 类型 | 结论 | 决策人 | 原因 |", "|---|---|---|---|---|");
	for (const decision of decisions.slice(0, 30)) {
		lines.push(`| ${decision.createdAt.slice(0, 16).replace("T", " ")} | ${decision.type} | ${escapeCell(decision.conclusion)} | ${escapeCell(decision.actor)} | ${escapeCell(decision.reason)} |`);
	}
	if (!decisions.length) lines.push("| — | — | 尚无决策记录 | — | — |");

	const fused = fusedBudgetSources;
	lines.push(
		"",
		"## 8. 下一步",
		"",
		...(evaluation.outcome === "reject"
			? ["1. 保留否决证据并归档；不要删除市场快照。", "2. 若质疑阈值，复制策略版本后再跑，禁止覆盖历史版本。"]
			: evaluation.outcome === "review"
				? ["1. 优先补齐缺失指标与人工复核项。", "2. 完成风险官方源核验与利润三情景后，再提交决策评审。"]
				: ["1. 进入决策评审；确认组合资金约束与样品改良证据。", "2. 通过后进入测品，并建立 30/60/90 天里程碑与退出标准。"]),
		...(fused.length ? [`3. 预算熔断：${fused.join("、")}；付费补数前先处理预算。`] : []),
		"",
		"## 9. 历史与复盘",
		"",
	);
	if (outcomeChecks.length) {
		lines.push("| 时间 | OutcomeCheck | T0 决策 | verdict | 对照理由 |", "|---|---|---|---|---|");
		for (const check of outcomeChecks.slice(0, 30)) {
			lines.push(`| ${check.createdAt.slice(0, 10)} | \`${check.id}\` | ${check.decisionStatus ?? "策略结论"} · \`${check.baselineSnapshotId}\` | **${check.verdict}** | ${escapeCell(check.verdictReason)} |`);
		}
	} else lines.push("- 尚无 OutcomeCheck；go 品应录入实绩，no_go/waitlist 应在新快照到场后做对照。");
	lines.push("");
	if (lessons.length) {
		// 改表格而不是继续用「- **id｜title**：detail」一行，是因为那个形状有两个独立缺陷：
		// ① title 被模板自己的 **…** 包着，title 里出现一个 `**` 会提前闭合，模板的收尾 `**`
		//    转而开启一段新粗体、把 detail 的开头吃进去；
		// ② title 与 detail 同行，落单的 `**` 还会跨字段配对。
		// 根子不是转义，是模板不该拿 **…** 去包自由文本。进了各自的单元格就不再有模板标记，
		// 两个缺陷一起消失；escapeCell 的 \| 转义本来就是为表格设计的。
		lines.push("### 命中的 active lessons", "", "| 经验卡 | 结论 | 说明 | evidence |", "|---|---|---|---|");
		for (const lesson of lessons.slice(0, 20)) {
			lines.push(`| \`${lesson.id}\` | ${escapeCell(lesson.title)} | ${escapeCell(lesson.detail)} | ${lesson.evidence.map((id) => `\`${id}\``).join("、")} |`);
		}
	} else lines.push("- 当前没有命中该市场的 active lesson。");
	lines.push(
		"",
		"---",
		"",
		"*口径：销量为第三方估算时不代表 Amazon 官方真实销量。风险核查仅作经营初筛；认证与知识产权高风险项应交由专业机构复核。复盘结论不构成收益承诺。*",
	);

	return {
		markdown: `${lines.join("\n")}\n`,
		marketId: market.id,
		marketName: market.name,
		outcome: evaluation.outcome,
		score: evaluation.score,
		snapshotId: snapshot.id,
	};
}

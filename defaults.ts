import type { BudgetPool } from "./types.ts";

// 口径缺省值：策略 meta 未声明时全系统统一按这两个数走（DEFAULT_STRATEGY_YAML 里的字面量与此保持一致）
export const DEFAULT_TARGET_MONTHLY_UNITS = 300;
export const DEFAULT_TARGET_DAILY_UNITS = 10;

export const DEFAULT_STRATEGY_YAML = `# 罗盘内置策略：精铺 · 日均10单
# 内置默认口径；CPC 规则被展开为“≤0.60 通过、0.60–0.80 复核、>0.80 否决”，避免边界语义歧义。
meta:
  name: jingpu-daily10
  display_name: 精铺 · 日均10单
  owner: compass
  target_daily_units: 10
  monthly_units_q: 300
  margin_scope: no_ads_no_returns
  retro_go_days: 30
  retro_testing_stale_days: 60
  retro_waitlist_days: 45
  retro_no_go_days: 90
  retro_review_days: 30

stages:
  - stage: market_screen
    rules:
      - id: red_sea_veto
        when: "amz_share > 0.30 && cr3 > 0.60"
        action: veto
        label: 红海市场（AMZ占比>30% 且 CR3>60%）
      - id: high_activity_entry
        when: "new_listing_share_12m >= 0.15"
        action: require
        label: 新品占比≥15%，市场仍接纳新品
      - id: volume_feasibility
        when: "qualify_rank_depth(300) >= 20"
        action: require
        label: 月销≥300 的坑位至少20个

  - stage: unit_economics
    rules:
      - id: gross_margin_gate
        when: "gross_margin >= 0.40"
        action: require
        label: 不含广告与退货毛利率≥40%
      - id: cpc_hard_ceiling
        when: "cpc_ratio <= 0.80"
        action: require
        label: CPC承受度不得高于0.80
      - id: cpc_affordability
        when: "cpc_ratio <= 0.60"
        action: review_if_fail
        label: CPC承受度0.60–0.80需人工复核词结构
      - id: capital_concentration
        when: "capital_share <= 0.20"
        action: review_if_fail
        label: 单SKU资金占总选品资金不高于20%

  - stage: product_quality
    rules:
      - id: rating_benchmark
        when: "est_rating_gap >= -0.2"
        action: review_if_fail
        label: 预估星级不得显著低于腰部竞品

  - stage: risk_screen
    rules:
      - id: risk_red_veto
        when: "risk_overall == red"
        action: veto
        label: 风险总体为红色，停止投入
      - id: risk_evidence_complete
        when: "risk_overall == pass"
        action: review_if_fail
        label: 风险清单完整且至少有一个可点击证据链接
      - id: certification_red
        when: "cert_status == red"
        action: veto
        label: 认证风险为红色
      - id: certification
        when: "cert_status == pass"
        action: review_if_fail
        label: 认证要求可满足且成本周期已计入
      - id: ip_risk
        when: "ip_risk_level != red"
        action: require
        label: 专利、商标、版权无红色风险
      - id: seasonality
        when: "season_flag != strong"
        action: review_if_fail
        label: 强季节品转人工复核
      - id: policy_red
        when: "policy_flag == red"
        action: veto
        label: 政策或受限品类为红色
      - id: policy_edge
        when: "policy_flag == clear"
        action: review_if_fail
        label: 非擦边或受限品类
      - id: logistics
        when: "logistics_risk != red"
        action: require
        label: 物流属性无红色风险

scoring:
  weights:
    unit_economics: 0.30
    competition: 0.25
    demand: 0.20
    product: 0.15
    risk: 0.10
  normalize: percentile
`;

// 内置默认策略 id：约定等于 slugify(parseStrategyYaml(DEFAULT_STRATEGY_YAML).meta.name)。
// 写成字面量而不是在此派生，是因为 defaults.ts → strategy.ts → metrics.ts → defaults.ts 会成环：
// 一旦 strategy.ts 先于其它模块被加载，本文件顶层的 parseStrategyYaml 就会撞上 ExpressionParser 的
// TDZ 而抛 ReferenceError。二者一致由 tests/strategy.test.ts 的断言用例守住。
export const DEFAULT_STRATEGY_ID = "jingpu-daily10";

export const DEFAULT_BUDGET_POOLS: BudgetPool[] = [
	{ source: "manual_csv", tier: "C", monthlyLimitCny: 0, enabled: true, note: "CSV/人工导入，零增量成本" },
	{ source: "compass_browser", tier: "C", monthlyLimitCny: 0, enabled: true, note: "用户触发的浏览器伴侣采集" },
	{ source: "sellersprite", tier: "A", monthlyLimitCny: 500, enabled: true, note: "关键词、CPC、销量估算" },
	{ source: "sorftime", tier: "A", monthlyLimitCny: 0, enabled: true, note: "Sorftime MCP 在线调用（自动计量）" },
	{ source: "keepa", tier: "A", monthlyLimitCny: 400, enabled: true, note: "价格、BSR、评论历史" },
	{ source: "sp_api", tier: "A", monthlyLimitCny: 0, enabled: true, note: "官方费用与自有数据" },
	{ source: "rainforest", tier: "A", monthlyLimitCny: 300, enabled: false, note: "SERP API 降级源" },
	{ source: "playwright", tier: "B", monthlyLimitCny: 250, enabled: false, note: "代理与采集集群成本" },
	{ source: "ai_risk", tier: "A", monthlyLimitCny: 100, enabled: true, note: "风险初筛与报告 token" },
];

export const SOURCE_BASE_CONFIDENCE: Record<string, number> = {
	sellersprite: 0.82,
	sorftime: 0.82,
	keepa: 0.86,
	sp_api: 0.96,
	compass_browser: 0.75,
	manual_csv: 0.72,
	generic_csv: 0.62,
};


// ---- 「最新快照」排序：全系统唯一口径 ----
// 只比 capturedAt 是不够的：Web 向导只发 YYYY-MM-DD，纯日期一律归一到同一 UTC 零点，
// 稳定排序让先入库那条永远胜出——同一天重导的修正版对看板/档案/报告/粗筛全部不可见。
// 二元组 (capturedAt, importedAt)：采集时刻相同则后入库者更新，即「同日重导 = 修正」。
// 仅依赖字典序：两个字段都由 toISOString() 产出定长 UTC 串，且 normalizeCapturedAt
// 把 capturedAt 限制在 [2000-01-01, now+36h]，不会出现 ISO 扩展年份破坏字典序。
export interface SnapshotRecency {
	capturedAt: string;
	importedAt: string;
}

/** 升序比较器（旧的排前面）。取最新用 compareSnapshotRecencyDesc 或 isNewerSnapshot。 */
export function compareSnapshotRecency(a: SnapshotRecency, b: SnapshotRecency): number {
	const captured = a.capturedAt.localeCompare(b.capturedAt);
	return captured !== 0 ? captured : a.importedAt.localeCompare(b.importedAt);
}

/** 降序比较器（最新的排前面）：直接传给 sort，取 [0] 即该市场最新快照。 */
export function compareSnapshotRecencyDesc(a: SnapshotRecency, b: SnapshotRecency): number {
	return compareSnapshotRecency(b, a);
}

/** 单趟线性取最大时用：candidate 是否比当前保留的 current 更新（current 为空时恒真）。 */
export function isNewerSnapshot(candidate: SnapshotRecency, current: SnapshotRecency | undefined): boolean {
	return current === undefined || compareSnapshotRecency(candidate, current) > 0;
}

// ---- 快照新鲜度：三档阈值与判定的唯一来源 ----
// 三档口径：深研档（≤7 天，深研/风险阶段可用）、粗筛档（≤30 天，只够粗筛）、测试档（≤1 天，
// 测试期实绩必须当日）。以前 web/data.ts、report.ts、index.ts、todo.ts、ui.ts 各自硬编码，
// 数值一致纯属巧合；任何阈值调整只改这里。
export const SNAPSHOT_FRESHNESS_DAYS = {
	deepResearch: 7,
	screen: 30,
	testing: 1,
} as const;

export type SnapshotFreshness = "deep_fresh" | "screen_only" | "stale" | "missing";

// 带阈值的完整文案：Web 市场列表与市场档案用
export const FRESHNESS_LABELS: Record<SnapshotFreshness, string> = {
	deep_fresh: `深研新鲜（≤${SNAPSHOT_FRESHNESS_DAYS.deepResearch}天）`,
	screen_only: `仅适合粗筛（≤${SNAPSHOT_FRESHNESS_DAYS.screen}天）`,
	stale: `已过期（>${SNAPSHOT_FRESHNESS_DAYS.screen}天）`,
	missing: "无快照",
};

// 短文案：五维报告正文的快照行用（末档带行动建议，行内已另有「N 天前」不再重复阈值）
export const FRESHNESS_SHORT_LABELS: Record<SnapshotFreshness, string> = {
	deep_fresh: "深研新鲜",
	screen_only: "仅适合粗筛",
	stale: "已过期，建议补数",
	missing: "无快照",
};

// 边界含端点：恰好 7 天仍算深研新鲜，恰好 30 天仍算仅适合粗筛（与收敛前五处口径一致）。
// ageDays 为 null 表示该市场根本没有快照，与「有快照但过期」必须区分开。
export function snapshotFreshness(ageDays: number | null): SnapshotFreshness {
	if (ageDays === null) return "missing";
	if (ageDays <= SNAPSHOT_FRESHNESS_DAYS.deepResearch) return "deep_fresh";
	if (ageDays <= SNAPSHOT_FRESHNESS_DAYS.screen) return "screen_only";
	return "stale";
}

// 「需要补数」= 过期或压根没有快照：TUI 总览的「30天过期」计数与 Web 总览 KPI 同口径
export function snapshotNeedsRefresh(ageDays: number | null): boolean {
	const tier = snapshotFreshness(ageDays);
	return tier === "stale" || tier === "missing";
}

// compass_data_route 的缓存 TTL：按漏斗阶段落到上面三档中的一档。
// lead/screen 用粗筛档，testing 用测试档，deep_research/risk 用深研档。
export type DataRouteStage = "lead" | "screen" | "deep_research" | "risk" | "testing";

export function snapshotTtlDays(stage: DataRouteStage): number {
	if (stage === "lead" || stage === "screen") return SNAPSHOT_FRESHNESS_DAYS.screen;
	if (stage === "testing") return SNAPSHOT_FRESHNESS_DAYS.testing;
	return SNAPSHOT_FRESHNESS_DAYS.deepResearch;
}

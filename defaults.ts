import type { BudgetPool } from "./types.ts";

export const DEFAULT_STRATEGY_YAML = `# 罗盘内置策略：精铺 · 日均10单
# 内置默认口径；CPC 规则被展开为“≤0.60 通过、0.60–0.80 复核、>0.80 否决”，避免边界语义歧义。
meta:
  name: jingpu-daily10
  display_name: 精铺 · 日均10单
  owner: compass
  target_daily_units: 10
  monthly_units_q: 300
  margin_scope: no_ads_no_returns

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
      - id: risk_evidence_complete
        when: "risk_overall == pass"
        action: require
        label: 风险清单完整且至少有一个可点击证据链接
      - id: certification
        when: "cert_status == pass"
        action: require
        label: 认证要求可满足且成本周期已计入
      - id: ip_risk
        when: "ip_risk_level != red"
        action: require
        label: 专利、商标、版权无红色风险
      - id: seasonality
        when: "season_flag != strong"
        action: review_if_fail
        label: 强季节品转人工复核
      - id: policy_edge
        when: "policy_flag == clear"
        action: require
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

export const DEFAULT_BUDGET_POOLS: BudgetPool[] = [
	{ source: "manual_csv", tier: "C", monthlyLimitCny: 0, enabled: true, note: "CSV/人工导入，零增量成本" },
	{ source: "compass_browser", tier: "C", monthlyLimitCny: 0, enabled: true, note: "用户触发的浏览器伴侣采集" },
	{ source: "sellersprite", tier: "A", monthlyLimitCny: 500, enabled: true, note: "关键词、CPC、销量估算" },
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

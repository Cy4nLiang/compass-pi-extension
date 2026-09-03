import { STAGE_LABELS } from "./types.ts";

// 领域工具清单：index.ts 用它做动态激活的白名单，catalog 是唯一事实来源。
// 新注册一个 compass_* 工具必须同时登记到这里；tests/tool-catalog.test.ts 会比对 index.ts 的注册名兜住漏登记。
export const DOMAIN_TOOLS = [
	"compass_lead",
	"compass_import_csv",
	"compass_market_scan",
	"compass_market_report",
	"compass_profit_estimate",
	"compass_strategy_run",
	"compass_strategy_manage",
	"compass_pool",
	"compass_risk_check",
	"compass_reviews_record",
	"compass_budget",
	"compass_todo",
	"compass_asin_history",
	"compass_keyword_metrics",
	"compass_data_route",
	"compass_gaps",
	"compass_history",
	"compass_retro",
] as const;

export type DomainToolName = (typeof DOMAIN_TOOLS)[number];

export interface ToolCatalogEntry {
	name: DomainToolName;
	keywords: string;
	description: string;
}

// 阶段中文名与流转动词程序化拼入候选池关键词：以后 STAGE_LABELS 增删阶段，路由自动跟上，不会再漂移
const POOL_STAGE_KEYWORDS = `${Object.values(STAGE_LABELS).join(" ")} 移到 推进 流转`;

export const TOOL_CATALOG: ToolCatalogEntry[] = [
	{ name: "compass_lead", keywords: "lead clue keyword root 线索 灵感 词根 市场 创建", description: "把词根、竞品或榜单灵感建立为线索和候选卡" },
	{ name: "compass_import_csv", keywords: "import csv 导入 卖家精灵 西柚 sorftime 快照 市场", description: "导入卖家精灵/Sorftime/通用 CSV，生成不可变市场快照" },
	{ name: "compass_market_scan", keywords: "scan search market 市场 扫描 粗筛 筛选 qrd 新品", description: "扫描本地市场库并按 Gate、QRD、新品占比筛选" },
	{ name: "compass_market_report", keywords: "report 报告 五维 证据 evidence 决策", description: "生成带证据链的五维选品报告" },
	{ name: "compass_profit_estimate", keywords: "profit economics 利润 毛利 cpc fba 回本 资金", description: "计算毛利、BE-CPC、三情景净利和启动资金" },
	{ name: "compass_strategy_run", keywords: "strategy run gate score gse 策略 执行 评分", description: "运行版本化 GSE 策略" },
	{ name: "compass_strategy_manage", keywords: "strategy yaml edit clone 策略 编辑 复制 版本", description: "列出、读取、保存、复制策略 YAML" },
	{ name: "compass_pool", keywords: `pool kanban candidate stage decision go waitlist no_go amazon 候选池 看板 移动 决策 链接 竞品 ${POOL_STAGE_KEYWORDS}`, description: "管理候选池并记录阶段、Gate 与最终 go/waitlist/no_go 状态及原因；get 输出附 Amazon 搜索与竞品链接" },
	{ name: "compass_risk_check", keywords: "risk patent trademark cert policy 风险 风控 专利 商标 认证 擦边 季节", description: "记录五类风险清单与官方证据链接" },
	{ name: "compass_reviews_record", keywords: "review pain kano 差评 评论 痛点 聚类 产品力", description: "保存差评主题、可改良性和预估星级差" },
	{ name: "compass_budget", keywords: "budget cost quota source 预算 成本 配额 数据源 熔断 计量 调用次数", description: "查看、配置预算池并按市场记账；MCP 计量源可配单价与次数上限" },
	{ name: "compass_todo", keywords: "todo task priority next agenda 待办 事项 要做 下一步 优先级 清单 人工 干预 复核 补数 处理 处理结果 提交 验证 核验 勾选 已处理 重开 闭环", description: "查看工作台待办清单（5 级优先级 + 处理状态）；闭环四类待办的提交处理结果、agent 验证、勾选已处理与重开" },
	{ name: "compass_asin_history", keywords: "asin history bsr price 历史 价格 评论", description: "读取同一 ASIN 跨快照历史" },
	{ name: "compass_keyword_metrics", keywords: "keyword search volume cpc 关键词 搜索量", description: "读取关键词跨快照指标" },
	{ name: "compass_data_route", keywords: "route source freshness cost 数据 路由 新鲜度 补数", description: "按阶段、字段、新鲜度和预算规划数据源" },
	{ name: "compass_gaps", keywords: "gap fill missing 缺口 缺数据 补数 缺失 字段 计划 清单 引导 数据", description: "汇总选品数据缺口并给出按成本档分组的补数计划" },
	{ name: "compass_history", keywords: "history retro 历史 复盘 相似 经验 教训 回看 验证 timeline outcome lesson", description: "统一查询时间线、决策检索、相似市场、复盘台账与经验卡" },
	{ name: "compass_retro", keywords: "retro outcome actuals backtest lesson 复盘 实绩 回测 经验 验证 错杀", description: "执行到期复盘、快照对照、实绩录入、策略回测与经验管理" },
];

// 一个词都没命中时的兜底入口，按本数组顺序返回（不是目录顺序）：
// 问法含糊时最该先看到「现在有什么要做」和候选池看板，而不是导入/报告这类需要前置条件的工具
export const FALLBACK_TOOLS: readonly DomainToolName[] = [
	"compass_todo",
	"compass_pool",
	"compass_market_scan",
	"compass_market_report",
	"compass_lead",
];

// 默认返回条数；FALLBACK_TOOLS 长度必须 <= 它，否则兜底尾部会被静默截断
export const DEFAULT_TOOL_LIMIT = 5;

export function searchTerms(query: string): string[] {
	const chunks = query.normalize("NFKC").toLocaleLowerCase().match(/[A-Za-z0-9_]+|[\u4e00-\u9fff]+/gu) ?? [];
	const terms = new Set<string>();
	for (const chunk of chunks) {
		terms.add(chunk);
		if (/^[\u4e00-\u9fff]+$/u.test(chunk)) {
			for (let index = 0; index < chunk.length - 1; index++) terms.add(chunk.slice(index, index + 2));
		}
	}
	return [...terms];
}

export interface RankedTool extends ToolCatalogEntry {
	score: number;
}

export interface RankResult {
	terms: string[];
	matches: RankedTool[];
	fallback: boolean;
}

// 打分：每个查询词（整段中文 + 二元组 + 英文词）在「工具名 + keywords + description」里出现即 +1
export function rankTools(query: string, options: { loadAll?: boolean; limit?: number } = {}): RankResult {
	const terms = searchTerms(query);
	let fallback = false;
	let matches: RankedTool[] = TOOL_CATALOG.map((item) => ({
		...item,
		score: terms.reduce((score, term) => score + (`${item.name} ${item.keywords} ${item.description}`.toLocaleLowerCase().includes(term) ? 1 : 0), 0),
	})).filter((item) => options.loadAll || item.score > 0).sort((a, b) => b.score - a.score);
	if (!matches.length) {
		fallback = true;
		matches = FALLBACK_TOOLS.map((name) => {
			const item = TOOL_CATALOG.find((entry) => entry.name === name);
			if (!item) throw new Error(`兜底工具 ${name} 不在 TOOL_CATALOG 中`);
			return { ...item, score: 0 };
		});
	}
	return { terms, matches: matches.slice(0, options.loadAll ? DOMAIN_TOOLS.length : options.limit ?? DEFAULT_TOOL_LIMIT), fallback };
}

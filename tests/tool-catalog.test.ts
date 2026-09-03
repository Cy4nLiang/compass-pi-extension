import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_TOOL_LIMIT, DOMAIN_TOOLS, FALLBACK_TOOLS, TOOL_CATALOG, rankTools, searchTerms, type DomainToolName } from "../catalog.ts";

const INDEX_SOURCE = new URL("../index.ts", import.meta.url);

// 黄金查询：每条覆盖一个工具的真实问法；期望值全部由 rankTools 实跑得到，断言用 top-5 命中而非排名第一
const GOLDEN: Array<{ query: string; expected: DomainToolName }> = [
	{ query: "有什么要做的", expected: "compass_todo" },
	{ query: "下一步做什么", expected: "compass_todo" },
	{ query: "把这个市场移到深研", expected: "compass_pool" },
	{ query: "把候选推进到风控", expected: "compass_pool" },
	{ query: "归档掉这个候选", expected: "compass_pool" },
	{ query: "把词根灵感建成线索", expected: "compass_lead" },
	{ query: "导入卖家精灵CSV快照", expected: "compass_import_csv" },
	{ query: "扫描市场库粗筛一批", expected: "compass_market_scan" },
	{ query: "生成五维选品报告", expected: "compass_market_report" },
	{ query: "算一下毛利和BE-CPC", expected: "compass_profit_estimate" },
	{ query: "跑一遍GSE策略打分", expected: "compass_strategy_run" },
	{ query: "编辑策略YAML版本", expected: "compass_strategy_manage" },
	{ query: "查专利商标认证风险", expected: "compass_risk_check" },
	{ query: "差评痛点聚类分析", expected: "compass_reviews_record" },
	{ query: "预算配额还剩多少", expected: "compass_budget" },
	{ query: "这个ASIN的历史价格走势", expected: "compass_asin_history" },
	{ query: "关键词搜索量趋势", expected: "compass_keyword_metrics" },
	{ query: "数据新鲜度不够要补数", expected: "compass_data_route" },
	{ query: "缺口清单", expected: "compass_gaps" },
	{ query: "相似市场的经验教训", expected: "compass_history" },
	{ query: "执行到期复盘录实绩", expected: "compass_retro" },
];

test("黄金查询：每条真实问法都能把目标工具带进候选集（M169）", () => {
	const misses: string[] = [];
	for (const { query, expected } of GOLDEN) {
		const ranked = rankTools(query).matches.map((item) => item.name);
		if (!ranked.includes(expected)) misses.push(`「${query}」期望 ${expected}，实际 top-${ranked.length}：${ranked.join(" ")}`);
	}
	assert.deepEqual(misses, [], `以下问法路由不到目标工具：\n${misses.join("\n")}`);
});

test("命中为空时退回入口工具，而不是给一张空表（M169）", () => {
	// 空表会让 agent 无从下手；退回的这几个是「从零开始做一个市场」的入口
	const ranked = rankTools("今天天气怎么样").matches;
	assert.deepEqual(ranked.map((item) => item.name), [...FALLBACK_TOOLS]);
	for (const item of ranked) assert.equal(item.score, 0, "兜底结果不该伪装成有分数的命中");
});

test("catalog 与 DOMAIN_TOOLS 一一对应，没有孤儿条目（M168）", () => {
	const catalogNames = TOOL_CATALOG.map((item) => item.name);
	assert.deepEqual([...catalogNames].sort(), [...DOMAIN_TOOLS].sort(), "TOOL_CATALOG 与 DOMAIN_TOOLS 必须覆盖同一批工具");
	assert.equal(new Set(catalogNames).size, catalogNames.length, "TOOL_CATALOG 有重复条目");
	for (const item of TOOL_CATALOG) {
		assert.ok(item.description.trim().length > 0, `${item.name} 缺描述`);
		assert.ok(item.keywords.trim().length > 0, `${item.name} 缺 keywords——那是路由命中的主要来源`);
	}
	for (const name of FALLBACK_TOOLS) {
		assert.ok((DOMAIN_TOOLS as readonly string[]).includes(name), `兜底工具 ${name} 不在 DOMAIN_TOOLS 里`);
	}
});

test("index.ts 只从 catalog.ts 取工具目录，不再自带一份（M168）", () => {
	const source = readFileSync(INDEX_SOURCE, "utf8");
	// 抽出来的目的就是消掉「index.ts 与文档各存一份、改一处忘另一处」
	assert.doesNotMatch(source, /^const TOOL_CATALOG/mu, "index.ts 不该再定义 TOOL_CATALOG");
	assert.doesNotMatch(source, /^const DOMAIN_TOOLS = \[/mu, "index.ts 不该再定义 DOMAIN_TOOLS");
	assert.match(source, /from "\.\/catalog\.ts"/u, "index.ts 应从 catalog.ts 引入");
});

test("searchTerms 切词：中英文与标点都不影响命中（M169）", () => {
	assert.deepEqual(searchTerms("  "), []);
	const terms = searchTerms("算一下毛利和BE-CPC");
	assert.ok(terms.length > 0, "中文查询切不出任何词");
	// 大小写不该影响命中
	assert.deepEqual(rankTools("BE-CPC").matches.map((i) => i.name), rankTools("be-cpc").matches.map((i) => i.name));
});

test("limit 与 load_all：默认给 5 条，load_all 给全量（M168）", () => {
	assert.equal(DEFAULT_TOOL_LIMIT, 5);
	assert.ok(rankTools("市场").matches.length <= DEFAULT_TOOL_LIMIT);
	assert.equal(rankTools("市场", { limit: 2 }).matches.length, 2);
	assert.equal(rankTools("市场", { loadAll: true }).matches.length, DOMAIN_TOOLS.length);
});

// —— review R09 回归 ——
// compass/CLAUDE.md 声称本文件会比对 index.ts 的 registerTool 名与 DOMAIN_TOOLS，
// 但此前并没有任何测试做这件事。补测试而不是删文档：CLAUDE.md 把「漏登记的工具无法被
// compass_tools 搜到」当成真实风险，那个守护应该存在。
test("index.ts 注册的工具与 DOMAIN_TOOLS 是同一批（R09）", () => {
	const source = readFileSync(INDEX_SOURCE, "utf8");
	// 不要求 name 紧跟在 registerTool({ 的下一行：本仓库注释密度很高，中间加一行注释是迟早的事，
	// 那会让该工具从 registered 里消失、断言报成「DOMAIN_TOOLS 里有工具没注册」，把人指向错误的一头。
	// 懒匹配 + 窗口上限。某个块真漏了 name 时 matchAll 会前进到下一个 registerTool({，
	// 于是**少抽一个**（不是抓重复），由下面的 registered.length 断言兜住——所以那道闸
	// 必须钉死总数，写成 >= 17 正好容得下静默丢一个。
	const registered = [...source.matchAll(/pi\.registerTool\(\{[\s\S]{0,400}?name: "([a-z_]+)"/gu)].map((m) => m[1]);
	// sanity：抽取规则失效时先在这里红，而不是静默变成空集合假绿
	// 结构性 sanity：抽到的名字数必须等于 registerTool({ 出现的次数。
	// 钉 DOMAIN_TOOLS.length + 1 会把「将来多注册一个非域工具」误报成「正则失效」，
	// 而且一旦同时发生「漏抽一个」和「多一个非域工具」，两边正好抵消、这道闸静默放行。
	const blocks = source.split("pi.registerTool({").length - 1;
	assert.equal(
		registered.length,
		blocks,
		`index.ts 有 ${blocks} 个 registerTool 块，只抽到 ${registered.length} 个 name——抽取正则已失效（不是工具没注册）`,
	);
	assert.equal(new Set(registered).size, registered.length, `index.ts 有重复注册：${registered.join(" ")}`);

	// 按**集合**比对，不比顺序：index.ts 的注册顺序与 DOMAIN_TOOLS 的排列顺序本来就不同，
	// deepEqual 会立刻红且毫无意义。
	const domain = new Set<string>(DOMAIN_TOOLS);
	// compass_tools 是路由工具本身，不在 DOMAIN_TOOLS 里
	const registeredDomain = registered.filter((name) => name !== "compass_tools");
	assert.ok(registered.includes("compass_tools"), "compass_tools 应当也是注册的工具");

	const missing = [...domain].filter((name) => !registeredDomain.includes(name));
	const extra = registeredDomain.filter((name) => !domain.has(name));
	assert.deepEqual(missing, [], `DOMAIN_TOOLS 里有工具没在 index.ts 注册：${missing.join(" ")}`);
	assert.deepEqual(extra, [], `index.ts 注册了 DOMAIN_TOOLS 之外的工具（compass_tools 会搜不到它）：${extra.join(" ")}`);
});


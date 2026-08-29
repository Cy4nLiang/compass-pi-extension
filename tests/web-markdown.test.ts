import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarketCsv } from "../csv.ts";
import { estimateProfit, normalizeProfitInput } from "../economics.ts";
import { ensureDefaults, generateMarketReport, importParsedMarket, recordProfitEstimate, recordReviewAnalysis, recordRisk } from "../service.ts";
import { createEmptyStore } from "../store.ts";
// 浏览器资源里唯一被测试覆盖的模块：报告弹窗的 Markdown 渲染器是纯函数、不碰 DOM，
// 又直接决定「报告正文里的自由文本会不会变成可执行 HTML」，值得脱离浏览器单测。
// tsc 靠同目录的 markdown.d.ts 解析这次 import。
import { renderMarkdown } from "../web/assets/markdown.js";

const here = dirname(fileURLToPath(import.meta.url));

test("markdown renderer escapes hostile free text instead of emitting tags", () => {
	const { html } = renderMarkdown([
		"# <img src=x onerror=alert(1)>",
		"",
		"正文 <script>alert(1)</script> 与 \"引号\" 与 '单引号'。",
		"",
		"| 指标 | 值 |",
		"|---|---:|",
		"| <b>粗体注入</b> | 1 |",
	].join("\n"));
	assert.ok(!/<script/i.test(html), "脚本标签必须被转义");
	assert.ok(!/<img/i.test(html), "图片标签必须被转义");
	assert.ok(!/<b>/i.test(html), "表格单元格里的标签必须被转义");
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(html, /&quot;引号&quot;/);
});

test("markdown renderer only links http/https/mailto", () => {
	const { html } = renderMarkdown([
		"[官方页](https://www.amazon.com/dp/B0DEMO0001?a=1&b=2)",
		"",
		"[联系](mailto:ops@example.com)",
		"",
		"[恶意](javascript:alert(1))",
		"",
		"[伪装](data:text/html;base64,PHNjcmlwdD4=)",
	].join("\n"));
	assert.match(html, /<a href="https:\/\/www\.amazon\.com\/dp\/B0DEMO0001\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">官方页<\/a>/);
	assert.match(html, /<a href="mailto:ops@example\.com"/);
	assert.equal(html.match(/<a /g)?.length, 2, "只有两个白名单协议的链接可以变成 <a>");
	// 协议不放行时退回纯文本，正文不丢
	assert.match(html, /\[恶意\]\(javascript:alert\(1\)\)/);
});

test("markdown renderer keeps escaped pipes inside one table cell and honours alignment", () => {
	const { html } = renderMarkdown([
		"| 规则 | 结果 | 表达式 |",
		"|---|:---:|---:|",
		"| 竞争 \\| 集中度 | **未达门槛** | `cr3 > 0.5` |",
	].join("\n"));
	assert.match(html, /<td>竞争 \| 集中度<\/td>/, "\\| 必须还原成一个单元格里的竖线");
	assert.match(html, /<th class="md-center">结果<\/th>/);
	assert.match(html, /<th class="md-right">表达式<\/th>/);
	assert.match(html, /<td class="md-center"><strong>未达门槛<\/strong><\/td>/);
	assert.match(html, /<td class="md-right"><code>cr3 &gt; 0\.5<\/code><\/td>/);
});

test("markdown renderer covers the block syntax report.ts emits", () => {
	const { html, toc } = renderMarkdown([
		"# 罗盘选品报告｜示例",
		"",
		"> **结论：待人工复核** · 综合分 **61.0 / 100**",
		">",
		"> 数据快照：`snap_1` · sellersprite · 2026-08-22",
		"> 策略：`default@v1`",
		"",
		"## 1. 决策摘要（GSE）",
		"",
		"- **Gate：** 待人工复核；1 个硬失败。",
		"- 第二条",
		"",
		"### D1 市场需求｜能不能装下目标量？",
		"",
		"1. 优先补齐缺失指标。",
		"2. 完成风险核验后再评审。",
		"",
		"---",
		"",
		"*口径：销量为第三方估算。*",
	].join("\n"));
	assert.match(html, /<blockquote class="md-quote">/);
	assert.match(html, /<strong>结论：待人工复核<\/strong>/);
	// 引用块里相邻两行是刻意分行的元信息，必须保留换行而不是合成一句
	assert.match(html, /<code>snap_1<\/code>[^<]*· sellersprite · 2026-08-22<br>策略：<code>default@v1<\/code>/);
	assert.match(html, /<ul class="md-list"><li><strong>Gate：<\/strong> 待人工复核；1 个硬失败。<\/li><li>第二条<\/li><\/ul>/);
	assert.match(html, /<ol class="md-list"><li>优先补齐缺失指标。<\/li>/);
	assert.match(html, /<hr class="md-hr">/);
	assert.match(html, /<em>口径：销量为第三方估算。<\/em>/);
	// 小目录只收 h2/h3，且 id 必须真的落在 HTML 上，否则弹窗左侧点击跳不动
	assert.deepEqual(toc.map((item) => item.level), [2, 3]);
	assert.deepEqual(toc.map((item) => item.text), ["1. 决策摘要（GSE）", "D1 市场需求｜能不能装下目标量？"]);
	for (const item of toc) assert.ok(html.includes(`id="${item.id}"`), `目录锚点 ${item.id} 必须存在于正文`);
});

// 以下四条是评审复现出来的真实回归：报告正文里带 `*` 或 `\|` 的用户自由文本
// （尺寸写成 5*7、理由里写 A|B）在中文电商语境里很常见，不是构造出来的极端输入
test("inline formatting never leaks into a generated link's href", () => {
	const { html } = renderMarkdown("- 证据链接：[规格 5*5 争议](https://www.amazon.com/s?k=5*5)");
	assert.match(html, /href="https:\/\/www\.amazon\.com\/s\?k=5\*5"/, "URL 里的 * 不得被斜体正则改写");
	assert.ok(!/href="[^"]*<(em|strong|code)/.test(html), "href 属性值里不得出现标签");
});

test("emphasis never spans across two links on one line", () => {
	// report.ts 第 5 章把所有风险证据用「；」拼在同一行，两条标题各带一个 * 就会撞上
	const { html } = renderMarkdown("- 证据链接：[地垫 5*7 类目要求](https://a.example.com/1)；[商标 3*5 检索](https://b.example.com/2)");
	assert.match(html, />地垫 5\*7 类目要求<\/a>/, "标题里的 * 应原样保留，不该被吃掉");
	assert.match(html, />商标 3\*5 检索<\/a>/);
	assert.ok(!/<em>/.test(html), "跨两个链接的 * 不得配成斜体");
});

test("bold survives a lone asterisk inside it", () => {
	// report.ts 第 9 章把 lesson 的 title 与 detail 拼在同一行、只有 title 包在 **…** 里，
	// 两边各出现一个 * 时，斜体绝不能从粗体内部一路配到粗体外面
	const { html } = renderMarkdown("- **les_1｜价格带 5*7 问题**：腰部价格带被 5*7 规格挤压");
	assert.match(html, /<strong>les_1｜价格带 5\*7 问题<\/strong>：腰部价格带被 5\*7 规格挤压/);
	assert.ok(!html.includes("**"), "不得漏出裸的 **");
	assert.ok(!/<em>/.test(html), "跨 </strong> 的 * 不得配成斜体");
	// CommonMark 语义：粗体内部成对的 * 仍然是斜体
	assert.match(renderMarkdown("**a*b*c**").html, /<strong>a<em>b<\/em>c<\/strong>/);
});

test("escaped pipes are unescaped outside tables too", () => {
	// escapeCell 无条件把 | 写成 \|，而「状态原因」「lesson」都是列表项、不是表格行
	const { html } = renderMarkdown("- **状态原因：** 当前阶段：A\\|B 二选一；Gate：—。");
	assert.match(html, /当前阶段：A\|B 二选一；/);
	assert.ok(!html.includes("\\|"), "表格外也不得留下字面反斜杠");
});

test("markdown renderer protects code spans from inline formatting", () => {
	const { html } = renderMarkdown("行内 `**不是粗体**` 与 `[不是链接](https://example.com)`。");
	assert.match(html, /<code>\*\*不是粗体\*\*<\/code>/);
	assert.match(html, /<code>\[不是链接\]\(https:\/\/example\.com\)<\/code>/);
	assert.ok(!/<strong>/.test(html));
	assert.ok(!/<a /.test(html));
});

test("a real generated market report renders with no leftover markdown markers", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const imported = importParsedMarket(store, { marketName: "render market", parsed, capturedAt: "2026-08-22T00:00:00.000Z", actor: "tester" });
	// 三块可选内容都补上：报告的 3/4/5 章缺数据时会退化成一行提示，
	// 那样测不到「情景表 / 痛点表 / 证据链接」这几种最容易渲染错的结构
	const profitInput = normalizeProfitInput({
		marketId: imported.market.id,
		salePrice: 25.99,
		purchaseCost: 3.5,
		firstMileCost: 0.9,
		fbaFee: 5.2,
		referralRate: 0.15,
		cvr: 0.12,
		cpc: 0.85,
		portfolioCapital: 20_000,
	});
	recordProfitEstimate(store, profitInput, estimateProfit(profitInput), "tester");
	recordReviewAnalysis(store, {
		marketRef: imported.market.id,
		sourceAsins: ["B0DEMO0007"],
		reviewCount: 120,
		// 单元格里带 | 的痛点名是真实会出现的形状（report.ts 会转义成 \|）
		themes: [{ name: "金属扣滑动 | 易脱扣", category: "quality", count: 38, fixability: "factory", recommendation: "增加防滑纹" }],
		estimatedRating: 4.4,
		actor: "tester",
	});
	recordRisk(store, {
		marketRef: imported.market.id,
		certStatus: "pass",
		ipRiskLevel: "review",
		seasonFlag: "clear",
		policyFlag: "clear",
		logisticsRisk: "pass",
		evidence: [{ category: "cert", title: "官方类目要求", url: "https://sellercentral.amazon.com/help" }],
		actor: "tester",
	});
	const report = generateMarketReport(store, imported.market.id);
	const { html, toc } = renderMarkdown(report.markdown);

	assert.ok(!html.includes("**"), "粗体标记必须全部渲染掉");
	assert.ok(!/^\s*\|/m.test(html), "不得残留未渲染的表格行");
	assert.ok(!/^\s*#{1,6} /m.test(html), "不得残留未渲染的标题行");
	assert.ok(!/^\s*&gt; /m.test(html), "不得残留未渲染的引用行");
	assert.ok(!/<script/i.test(html));
	// 报告固定九章，全部要能进小目录
	const sectionCount = report.markdown.split("\n").filter((line) => /^## /.test(line)).length;
	assert.equal(sectionCount, 9);
	assert.equal(toc.filter((item) => item.level === 2).length, 9);
	assert.equal(toc.filter((item) => item.level === 3).length, 5, "五维证据下的 D1–D5 是 h3");
	assert.match(html, /<a href="https:\/\/sellercentral\.amazon\.com\/help"/);
	// 表格是报告的主体，渲染后必须真的是表格
	assert.ok(html.split("<table class=\"md-table\">").length - 1 >= 5);
	// 痛点名里的竖线在 Markdown 里是 \|，渲染后必须回到同一个单元格
	assert.match(html, /<td>金属扣滑动 \| 易脱扣<\/td>/);
	// 三情景表来自利润测算，右对齐列必须带上对齐类
	assert.match(html, /<th class="md-right">回本月数<\/th>/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarketCsv } from "../csv.ts";
import { estimateProfit, normalizeProfitInput } from "../economics.ts";
import { decideCandidate, ensureDefaults, generateMarketReport, importParsedMarket, moveCandidate, recordProfitEstimate, recordReviewAnalysis, recordRisk, saveLesson } from "../service.ts";
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

test("emphasis pairs within one block — report.ts must not put two free-text fields on one line", () => {
	// 这不是渲染器缺陷，是 Markdown 的既定语义：`**` 的配对范围就是一个块（我们逐行逐格，
	// GitHub 与 pi TUI 的 marked 逐段）。运营在「阶段原因」里打一个落单的 `**`——中文电商语境里
	// 「**重点」「**必须」这种半截强调很常见，不是构造出来的极端输入——拼在同一行时就会一路
	// 配到「最终决策原因」里去。上半段说明生成侧为什么必须拆行，下半段验证拆行确实有效。
	const joined = renderMarkdown("- **状态原因：** 当前阶段：价格带 **重点；最终决策：认证 **必须先复核").html;
	assert.match(joined, /<strong>重点；最终决策：认证 <\/strong>/, "同一行拼两个自由文本字段必然串味——report.ts 不得再这么拼");

	const split = renderMarkdown("- **当前阶段原因：** 价格带 **重点\n- **最终决策原因：** 认证 **必须先复核").html;
	assert.match(split, /<li><strong>当前阶段原因：<\/strong> 价格带 \*\*重点<\/li>/, "拆成两条列表项后，落单的 ** 只能以字面量留在自己那条里");
	assert.match(split, /<li><strong>最终决策原因：<\/strong> 认证 \*\*必须先复核<\/li>/);
	assert.ok(!/<strong>[^<]*重点[^<]*认证/.test(split), "拆行后不得再出现跨字段的 <strong>");
});

test("renderMarkdown hands back a plain-text toc and leaves escaping to the caller", () => {
	// 契约测试而非注入复现：报告当前的 h2/h3 全是固定章节名，还轮不到自由文本。但
	// toc[].text 未转义这件事只被 app.js 的 reportTocHtml 那层 escapeHtml 兜着，哪天章节名改成
	// 「### 痛点：<市场名>」，或有人顺手删掉那层，弹窗目录立刻变成注入点。把「未转义」
	// 钉成显式契约，别让它继续当隐式假设。
	const { html, toc } = renderMarkdown("## <img src=x onerror=alert(1)> 与 `代码` 与 **粗体**");
	assert.equal(toc.length, 1);
	assert.equal(toc[0].text, "<img src=x onerror=alert(1)> 与 代码 与 粗体");
	assert.ok(!toc[0].text.includes("&lt;"), "toc[].text 是纯文本契约：renderMarkdown 不转义，调用方必须自己转");
	assert.match(html, /<h2 id="md-h0"[^>]*>&lt;img src=x onerror=alert\(1\)&gt;/, "同一段内容进正文时必须已经转义");
});

test("escaped pipes are unescaped outside tables too", () => {
	// escapeCell 无条件把 | 写成 \|，而第 1 章的三条原因与第 5 章的证据链接都是列表项、不是表格行
	const { html } = renderMarkdown("- **状态原因：** 当前阶段：A\\|B 二选一；Gate：—。");
	assert.match(html, /当前阶段：A\|B 二选一；/);
	assert.ok(!html.includes("\\|"), "表格外也不得留下字面反斜杠");
});

test("每张表格自己进 Tab 序列，名字取自表头首列且照样转义", () => {
	// 宽表在窄窗下会横向溢出，键盘用户得能聚焦上去横滚。只有 Chrome 会隐式让溢出的滚动容器
	// 可聚焦，Firefox / Safari 不会——所以 tabindex 必须显式写出来，这条断言守的就是它。
	// 名字取表头首列而不是统一写死：报告固定九章有 ≥5 张表，同名 region 会把读屏地标列表塞满。
	const { html } = renderMarkdown("| 阶段 | 规则 |\n|---|---|\n| screen | a |");
	assert.match(html, /<div class="md-table-wrap" tabindex="0" role="region" aria-label="阶段 表格（可横向滚动）">/);

	// 表头也是自由文本（痛点表的表头固定，但 escapeCell 的 \| 会漏进来，别的表头将来也可能变），
	// 名字进的是 HTML 属性，必须走同一条转义，不能从属性里逃出去
	const hostile = renderMarkdown('| <img src=x onerror=alert(1)> | b |\n|---|---|\n| a | b |').html;
	assert.match(hostile, /aria-label="&lt;img src=x onerror=alert\(1\)&gt; 表格（可横向滚动）"/);
	assert.ok(!/aria-label="[^"]*<img/.test(hostile), "表头里的标签不得从 aria-label 属性里逃出去");

	// 表头首列带 \| 转义与行内标记时，名字里应还原竖线、剥掉标记
	const marked = renderMarkdown("| **竞争** 集中度 | b |\n|---|---|\n| a | b |").html;
	assert.match(marked, /aria-label="竞争 集中度 表格（可横向滚动）"/);

	// 名字前面要带上所在小节：光靠表头首列不够——五维证据下 D1–D5 各有一张表、首列都叫「指标」，
	// 实测在真实报告里撞名 5 次，读屏的地标列表里就是五个一模一样的条目
	const sectioned = renderMarkdown("### D1 需求\n\n| 指标 | 值 |\n|---|---|\n| a | b |\n\n### D2 竞争\n\n| 指标 | 值 |\n|---|---|\n| a | b |").html;
	const names = [...sectioned.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
	assert.deepEqual(names, ["D1 需求 · 指标 表格（可横向滚动）", "D2 竞争 · 指标 表格（可横向滚动）"]);
	assert.equal(new Set(names).size, names.length, "同一份报告里的表格名字不得重复");
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
	// 三个自由文本字段各塞一个「落单的 **」：运营写「**重点」「**必须先复核」这种半截强调，
	// 在中文语境里就是打字打一半的自然产物，不是构造出来的极端输入。改动前这几个字段会被
	// 拼进同一行 / 同一格，落单的 ** 跨字段配对，把中间整段染成 <strong>。
	moveCandidate(store, { candidateRef: imported.candidate.id, stage: "deep_research", reason: "价格带 **重点，先测品", actor: "tester" });
	decideCandidate(store, { candidateRef: imported.candidate.id, status: "waitlist", reason: "认证 **必须先复核", actor: "tester" });
	// lesson 的 title 曾被模板自己的 **…** 包住：title 里一个 ** 会提前闭合、把 detail 一起加粗。
	// scope 留空 ⇒ 判为通配，必然命中本市场
	const lesson = saveLesson(store, {
		title: "价格带 **重点",
		detail: "腰部被 **挤压，先重跑 Gate",
		evidence: [store.decisionLog.find((item) => item.type === "import")!.id],
		actor: "tester",
	});

	const report = generateMarketReport(store, imported.market.id);
	const { html, toc } = renderMarkdown(report.markdown);

	// 原断言是 !html.includes("**")。喂进落单的 ** 之后它必然为假，但「模板自己的 ** 全部渲染掉」
	// 这条不变式仍要守住，于是改成按文本块归因：剥掉标签后凡是还带 ** 的文本块，都必须能
	// 对应到上面那三个运营手写字段，一个都不许来自报告模板。
	const strayBold = html.split(/<[^>]+>/).filter((chunk) => chunk.includes("**"));
	assert.ok(strayBold.length > 0, "本用例刻意喂了落单的 **，否则下一条断言测不到东西");
	assert.ok(
		strayBold.every((chunk) => /重点|挤压|必须先复核/.test(chunk)),
		`报告模板自己的 ** 必须全部渲染成 <strong>，只有运营手写字段允许残留字面量：${strayBold.join(" / ")}`,
	);
	assert.ok(!/^\s*\|/m.test(html), "不得残留未渲染的表格行");
	assert.ok(!/^\s*#{1,6} /m.test(html), "不得残留未渲染的标题行");
	assert.ok(!/^\s*&gt; /m.test(html), "不得残留未渲染的引用行");
	assert.ok(!/<script/i.test(html));
	// 报告固定九章，全部要能进小目录
	const sectionCount = report.markdown.split("\n").filter((line) => /^## /.test(line)).length;
	assert.equal(sectionCount, 9);
	assert.equal(toc.filter((item) => item.level === 2).length, 9);
	assert.equal(toc.filter((item) => item.level === 3).length, 6, "五维证据下的 D1–D5 是 h3，第 9 章命中的经验卡再加一个");
	assert.match(html, /<a href="https:\/\/sellercentral\.amazon\.com\/help"/);
	// 表格是报告的主体，渲染后必须真的是表格
	assert.ok(html.split("<table class=\"md-table\">").length - 1 >= 5);
	// 痛点名里的竖线在 Markdown 里是 \|，渲染后必须回到同一个单元格
	assert.match(html, /<td>金属扣滑动 \| 易脱扣<\/td>/);
	// app.js 的 REPORT_CHAPTERS 是这九章标题的第二份硬编码（生成前的目录预告），两边没有任何
	// 绑定，章节增删不会变红。不能写等值断言——九项里有四项是有意的缩写（「痛点与改良」对应
	// 「产品痛点与改良机会」等）——所以断的是「条数一致 + 顺序一致 + 归一后是后端标题的子串」。
	const appSource = await readFile(join(here, "../web/assets/app.js"), "utf8");
	const chapters = JSON.parse(/const REPORT_CHAPTERS = (\[[^\]]*\])/.exec(appSource)![1].replaceAll("\"", '"')) as string[];
	const headings = report.markdown.split("\n").filter((line) => /^## /.test(line)).map((line) => line.replace(/^## \d+\.\s*/, ""));
	const normalize = (value: string) => value.replaceAll(" ", "").replaceAll("（", "").replaceAll("）", "");
	assert.equal(chapters.length, headings.length, "app.js 的章节预告与 report.ts 的 ## 标题数量必须一致");
	for (const [index, chapter] of chapters.entries()) {
		assert.ok(
			normalize(headings[index]).includes(normalize(chapter)),
			`第 ${index + 1} 章对不上：app.js 写「${chapter}」，report.ts 生成「${headings[index]}」`,
		);
	}

	// 三情景表来自利润测算，右对齐列必须带上对齐类
	assert.match(html, /<th class="md-right">回本月数<\/th>/);

	// 第 1 章：三条原因各占一条列表项，落单的 ** 留在自己那条里、不跨到下一条
	assert.match(html, /<li><strong>当前阶段原因：<\/strong> 价格带 \*\*重点，先测品<\/li>/, "阶段原因必须独占一条列表项");
	assert.match(html, /<li><strong>最终决策原因：<\/strong> 认证 \*\*必须先复核<\/li>/, "决策原因必须独占一条列表项");
	assert.ok(!/<strong>[^<]*重点[^<]*认证/.test(html), "阶段原因里的落单 ** 不得把决策原因吃进同一个 <strong>");
	// 第 7 章：决策人与原因拆列后，落单的 ** 不得在同一格里串味
	assert.match(html, /<td>tester<\/td><td>价格带 \*\*重点，先测品<\/td>/, "决策回放的决策人与原因必须分列");
	// 第 9 章：lesson 的 title 与 detail 各占一格，模板不再拿 **…** 去包自由文本
	assert.match(
		html,
		new RegExp(`<td><code>${lesson.id}</code></td><td>价格带 \\*\\*重点</td><td>腰部被 \\*\\*挤压，先重跑 Gate</td>`),
		"lesson 的 title 与 detail 必须落在各自单元格，title 里的 ** 不得提前闭合并染黑 detail",
	);
});

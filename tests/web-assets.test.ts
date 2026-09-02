import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// app.js / index.html 不在 tsconfig 的 include 里，npm run check 完全看不见它们；浏览器里
// 又没有任何自动化。这个文件是它们唯一的自动化防线：把「只能靠人肉点浏览器才发现」的三条
// 前端不变式（同 hash 死链接、渲染器抛错后永久停在「加载中…」、外链字体阻塞首屏）钉成断言。
const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, "../web/assets");
const readAsset = (name: string): Promise<string> => readFile(join(assetsDir, name), "utf8");

// app.js 满是 DOM 操作，在 node 里 import 会直接抛错；但里面几个纯逻辑小函数可以按名字截出来、
// 用 new Function 注入桩依赖后脱离浏览器真跑。只截函数体里不含花括号字面量的小函数，配平才可靠。
function extractFunction(source: string, name: string): string {
	const start = source.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `app.js 里找不到 function ${name}`);
	let depth = 0;
	for (let i = source.indexOf("{", start); i < source.length; i += 1) {
		if (source[i] === "{") depth += 1;
		else if (source[i] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`${name} 的函数体没有闭合`);
}


/** 把截出来的函数体注入桩依赖后真跑 */
function runFunction(source: string, name: string, stubs: Record<string, unknown> = {}): (...args: unknown[]) => unknown {
	const body = extractFunction(source, name);
	const keys = Object.keys(stubs);
	const factory = new Function(...keys, `${body}\nreturn ${name};`) as (...deps: unknown[]) => (...args: unknown[]) => unknown;
	return factory(...keys.map((key) => stubs[key]));
}

test("字体外链不阻塞首屏：断网也不会永远停在「正在加载」（M60）", async () => {
	const html = await readAsset("index.html");
	const links = [...html.matchAll(/<link\b[^>]*>/gu)].map((m) => m[0]);
	const external = links.filter((tag) => /href="https?:\/\//u.test(tag));
	// 工作台只绑回环、必须离线可用：render-blocking 的外链样式表在字体主机不可达时
	// 会连 type="module" 的 app.js 都不执行，页面永久停在 boot-loading。
	assert.equal(external.length, 1, `期望全站只有 1 条外链样式表，实际 ${external.length}：${external.join(" ")}`);
	const fontLink = external[0] ?? "";
	assert.match(fontLink, /fonts\.googleapis\.com/u);
	assert.match(fontLink, /media="print"/u, "外链字体必须用 media=\"print\" 让它不阻塞渲染");
	assert.match(fontLink, /onload="this\.media='all'"/u, "加载完要换回 media=all，否则字体永远不生效");
	// 其余样式与脚本必须本地
	for (const tag of links.filter((t) => !external.includes(t))) {
		assert.ok(!/href="\/\//u.test(tag), `协议相对外链也算外链：${tag}`);
	}
	for (const script of [...html.matchAll(/<script\b[^>]*src="([^"]*)"/gu)].map((m) => m[1])) {
		assert.match(script, /^\/assets\//u, `脚本必须本地加载：${script}`);
	}
});

test("静态资源加载失败时页面说人话，而不是干等（M60）", async () => {
	const html = await readAsset("index.html");
	assert.match(html, /id="boot-loading"/u, "占位块要有 id，onerror 才够得着它");
	const scriptTag = /<script\b[^>]*src="\/assets\/app\.js"[^>]*>/u.exec(html)?.[0] ?? "";
	assert.ok(scriptTag, "找不到 app.js 的 script 标签");
	assert.match(scriptTag, /onerror=/u, "app.js 加载失败必须有兜底提示");
	assert.match(scriptTag, /boot-loading/u, "兜底提示应改写 boot-loading 的文案");
});

test("预算页的成本事件按 UTC 日显示，与 UTC 预算月同口径（M59）", async () => {
	const app = await readAsset("app.js");
	const formatUtcDateShort = runFunction(app, "formatUtcDateShort") as (iso?: string) => string;
	// UTC+8 的 00:00–08:00：本地已是 9 月 1 日，UTC 还在 8 月 31 日。混用会让
	// 「标题写 2026-08、事件卡写 09-01」同屏出现。
	assert.equal(formatUtcDateShort("2026-08-31T23:30:00.000Z"), "08-31");
	assert.equal(formatUtcDateShort("2026-09-01T00:30:00.000Z"), "09-01");
	assert.equal(formatUtcDateShort(""), "—");
	assert.equal(formatUtcDateShort(undefined), "—");
	assert.equal(formatUtcDateShort("不是时间"), "—");
	// 必须真的被用上，否则只是段死代码
	assert.match(app, /formatUtcDateShort\(event\.createdAt\)/u, "成本事件的日期应改用 formatUtcDateShort");
	// 本地时间没丢，挪进了 title
	assert.match(app, /title="本地时间 \$\{escapeHtml\(formatDateTime\(event\.createdAt\)\)\}"/u);
});

test("预算面板标题标明 UTC 月份，不再只写「当月」（M59）", async () => {
	const app = await readAsset("app.js");
	assert.match(app, /数据源预算 · \$\{escapeHtml\(data\.budgetMonth\)\} \(UTC\)/u, "标题要带上具体月份并标注 UTC");
	assert.doesNotMatch(app, /数据源预算 · 当月/u, "「当月」在 UTC/本地跨日时是歧义的");
});

test("QRD 列头不再写死 300，逐行用 title 标注各自口径（M61）", async () => {
	const app = await readAsset("app.js");
	// 每行的 QRD 是按导入时那条策略的 q 冻结的，列头写死一个数会误导所有非默认策略的行
	assert.doesNotMatch(app, /QRD\(300\)/u, "列头不能写死目标月销");
	assert.match(app, /<div class="cell-right">QRD<\/div>/u);
	assert.match(app, /qrdTargetUnits/u, "逐行口径应来自 row.qrdTargetUnits");
	assert.match(app, /月销≥\$\{row\.qrdTargetUnits\} 的 listing 数/u);
});

test("verified 状态给出「重新提交」出路，提示说明何时会被拒（M59）", async () => {
	const app = await readAsset("app.js");
	// 提交后水位变化会让勾选被服务端拒绝，此前 UI 没有任何出路，只能干瞪眼
	const actions = extractFunction(app, "buildTodoActionsHtml");
	assert.match(actions, /data-todo-action="toggle-submit">重新提交</u, "verified 分支要有「重新提交」按钮");
	const hint = extractFunction(app, "todoResolutionHint");
	assert.match(hint, /勾选会被服务端拒绝/u, "verified 的提示要说明勾选可能被拒");
	// canSubmit 必须放行 verified，否则按钮点了没有表单
	assert.match(app, /status === "verified";/u, "canSubmit 判据要把 verified 算进去");
});

// ── 外链安全与接线的静态断言 ──────────────────────────────────────────────
// 这些用例是对抗式 mutation 测试补上的：原先的 Proof 行写成 `grep -c '…rel=…' ≥1（当前 2）`，
// 删掉两处外链里的一处 rel 之后计数仍是 1，照样满足 ≥1 —— 「接线计数」不是「测试 pass 数」，
// 阈值留出的余量恰好等于可以被悄悄删掉而不报警的量。下面一律改成**没有余量的全称/位置断言**：
// 违规数必须为 0，或者「这个位置上必须是这个东西」。
//
// 覆盖边界（如实说明，不写成假全称）：
//   1. 只做源文本静态判定。href 的**取值**是否安全由 service.ts 的 amazonProductUrl（ASIN
//      白名单）/ amazonSearchUrl（encodeURIComponent）与 app.js 的 escapeHtml 在运行时保证，
//      那部分由 tests/links.test.ts 覆盖，不在本文件范围。
//   2. `target` 与 `rel` 必须写在同一个开标签内（本仓库所有 <a> 开标签都不跨行）。真跨了行会
//      被判红——这是 fail-closed 的误报，宁可误报也不漏报，改法是把它们写回同一个标签里。
//   3. markdown.js 顺带纳入同一次扫描；它的行为级证明在 tests/web-markdown.test.ts，这里只是
//      静态兜底，避免以后改渲染器时把 rel 丢掉。

/** 开标签内的 rel 是否同时含 noopener 与 noreferrer（按空白切 token，不做子串匹配） */
function hasSafeRel(tag: string): boolean {
	const matched = /\brel\s*=\s*"([^"]*)"/u.exec(tag);
	if (!matched) return false;
	const tokens = (matched[1] ?? "").trim().split(/\s+/u).filter(Boolean);
	return tokens.includes("noopener") && tokens.includes("noreferrer");
}

/** 取 index 处属性所在的那个开标签（前后各找最近的 < 与 >），失败时退回上下文片段便于报错定位 */
function enclosingTag(source: string, index: number): string {
	const start = source.lastIndexOf("<", index);
	const end = source.indexOf(">", index);
	if (start === -1 || end === -1) return source.slice(Math.max(0, index - 80), index + 80);
	return source.slice(start, end + 1);
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;

/** 全站扫描用（带 g，只交给 matchAll；绝不用它 .test()——lastIndex 会在两次调用之间残留） */
const BLANK_TARGET_ALL = /target\s*=\s*(["']?)_blank\1/gu;
/** 单个开标签的判定用（无 g，无状态） */
const hasBlankTarget = (tag: string): boolean => /target\s*=\s*(["']?)_blank\1/u.test(tag);

test("每一处 target=\"_blank\" 都必须带 rel=\"noopener noreferrer\"，违规数为 0", async () => {
	// 被打开的页面能通过 window.opener 反向操纵工作台（改 location、读 origin 内的东西），
	// 工作台无鉴权且可写，这条不是洁癖。全称断言：漏一处就红，不给「还剩几处」的余量。
	for (const asset of ["app.js", "markdown.js"]) {
		const source = await readAsset(asset);
		const offenders = [...source.matchAll(BLANK_TARGET_ALL)]
			.map((m) => ({ line: lineOf(source, m.index), tag: enclosingTag(source, m.index) }))
			.filter((item) => !hasSafeRel(item.tag));
		assert.deepEqual(
			offenders.map((item) => `${asset}:${item.line} ${item.tag}`),
			[],
			`${asset} 里有新标签页外链漏了 rel="noopener noreferrer"`,
		);
	}
	// 反向：rel 不是死代码，两处外链必须真的还在（删掉整个 <a> 也要红）
	const app = await readAsset("app.js");
	assert.equal([...app.matchAll(BLANK_TARGET_ALL)].length, 2, "app.js 的外链应恰好是竞品「打开 ↗」与搜索 chip 两处；增删都要回来确认新链接带了 rel");
	// window.open 是绕开 <a rel> 的另一条路：本文件没有它，新增必须显式带 noopener
	for (const m of app.matchAll(/window\.open\s*\(/gu)) {
		const statement = app.slice(m.index, app.indexOf(";", m.index) + 1);
		assert.match(statement, /noopener/u, `window.open 必须显式传 noopener（app.js:${lineOf(app, m.index)}）`);
	}
});

test("站外 href 只经链接 helper 注入，且必须落在带 rel 的新标签页形态上", async () => {
	const app = await readAsset("app.js");
	// 零硬编码外链：CLAUDE.md 的外链策略是「除 index.html 那条字体外，app.js/markdown.js/style.css
	// 一律零外链」。写死一个 https:// 就绕过了下面按 helper 分类的判定，先在这里拦掉。
	const literals = [...app.matchAll(/https?:\/\//gu)].map((m) => `app.js:${lineOf(app, m.index)}`);
	assert.deepEqual(literals, [], "app.js 不得出现硬编码的绝对 URL；站外地址只能由 service.ts 的链接 helper 生成后经 DTO 传入");

	// 逐条分类全部 href：要么是站内 hash，要么是被证明只产出站内 hash 的表达式，
	// 其余一律视为站外，必须与 target="_blank" + rel 同处一个开标签。
	const PROVEN_INTERNAL_EXPRESSIONS = new Set(["${todoKindRoute(todo)}", "${tab.hash}"]); // 由下面「站内路由表达式」那条用例真跑证明
	const offenders: string[] = [];
	for (const m of app.matchAll(/href\s*=\s*"([^"]*)"/gu)) {
		const value = m[1] ?? "";
		if (value.startsWith("#")) continue; // 站内 hash 路由
		if (PROVEN_INTERNAL_EXPRESSIONS.has(value)) continue;
		const tag = enclosingTag(app, m.index);
		if (hasBlankTarget(tag) && hasSafeRel(tag)) continue;
		offenders.push(`app.js:${lineOf(app, m.index)} href="${value}"`);
	}
	assert.deepEqual(offenders, [], "站外 href 必须写成 target=\"_blank\" rel=\"noopener noreferrer\"；若这是新的站内路由表达式，请把它加进 PROVEN_INTERNAL_EXPRESSIONS 并补上「只产出 # 开头」的证明");
});

test("站内路由表达式确实只产出 # 开头的站内 hash", async () => {
	const app = await readAsset("app.js");
	// TABS：六个 tab 的 hash 全部是 #/<id>
	const tabs = [...app.matchAll(/\{ id: "([\w-]+)", label: "[^"]*", hash: "([^"]*)" \}/gu)].map((m) => ({ id: m[1] ?? "", hash: m[2] ?? "" }));
	assert.equal(tabs.length, 6, "TABS 应有六个 tab（总览/待办/市场/候选池/预算/复盘）");
	for (const tab of tabs) assert.equal(tab.hash, `#/${tab.id}`, `tab ${tab.id} 的 hash 必须是站内 #/ 路由`);

	// todoKindRoute：十种 kind + 未知 kind，带/不带 marketId，全部落在站内
	const kindsBlock = /const TODO_KIND_LABELS = \{([\s\S]*?)\n\};/u.exec(app)?.[1] ?? "";
	const kinds = [...kindsBlock.matchAll(/^\t(\w+):/gmu)].map((m) => m[1] ?? "");
	assert.equal(kinds.length, 10, "TODO_KIND_LABELS 应对照 todo.ts 派生的十种 kind");
	const todoKindRoute = runFunction(app, "todoKindRoute") as (todo: unknown) => string;
	for (const kind of [...kinds, "未知kind"]) {
		for (const marketId of [undefined, "market a/b"]) {
			const route = todoKindRoute({ kind, marketId });
			assert.match(route, /^#\/[\w%./-]*$/u, `todoKindRoute(${kind}, ${String(marketId)}) 逃出了站内 hash：${route}`);
		}
	}

	// parseRoute：#/pool/<ref> 必须解析成 pool + param，这是决策页存在的前提
	const parseRoute = runFunction(app, "parseRoute", {
		decodeRouteParam: (raw: string, fallback: string) => { try { return decodeURIComponent(raw); } catch { return { name: fallback }; } },
		TABS: tabs,
	}) as (hash: string) => { name: string; param?: string };
	assert.deepEqual(parseRoute("#/pool"), { name: "pool" });
	assert.deepEqual(parseRoute("#/pool/cand-1"), { name: "pool", param: "cand-1" });
	assert.deepEqual(parseRoute("#/pool/%E6%89%AB%E5%9C%B0"), { name: "pool", param: "扫地" });
	assert.deepEqual(parseRoute("#/pool/%E4%B8"), { name: "pool" }, "坏编码要退回候选池看板，不能整页抛错");
	assert.deepEqual(parseRoute(""), { name: "overview" });
});

test("决策页的两处外链就位：竞品「打开 ↗」与搜索 chip 都带 rel", async () => {
	const app = await readAsset("app.js");
	// 位置断言（替代 grep -c 的计数形态）：这两处各自必须在自己的函数里，且形态完整
	const listingRow = extractFunction(app, "decisionListingRowHtml");
	assert.match(listingRow, /href="\$\{escapeHtml\(row\.url\)\}" target="_blank" rel="noopener noreferrer"/u, "竞品「打开 ↗」必须是转义后的新标签页外链");
	assert.match(listingRow, /row\.url\s*\n?\s*\?/u, "url 为 null（无/非法 ASIN）时不能出链接");
	assert.match(listingRow, /无链接/u, "无 url 的行要保留参考数据并显式说明「无链接」");

	const linksPanel = extractFunction(app, "buildDecisionLinksPanelHtml");
	assert.match(linksPanel, /href="\$\{escapeHtml\(item\.url\)\}" target="_blank" rel="noopener noreferrer"/u, "搜索 chip 必须是转义后的新标签页外链");
	assert.match(linksPanel, /links\.searches\.map/u, "chip 来自 links.searches");
	assert.match(linksPanel, /links\.topListings\.length/u, "listing 区来自 links.topListings，空时给引导文案");
	assert.match(linksPanel, /decisionListingRowHtml/u, "listing 行必须复用 decisionListingRowHtml，否则外链断言管不到它");
});

test("决策页接线：#/pool/<ref> 经 renderPool 分发到 renderPoolDecision，面包屑能返回候选池", async () => {
	const app = await readAsset("app.js");
	// extractFunction 找不到就直接断言失败，比 grep -n 的「有几行」强
	const renderPool = extractFunction(app, "renderPool");
	assert.match(renderPool, /if \(candidateRef\) return renderPoolDecision\(content, isCurrent, candidateRef\);/u, "带 param 的 #/pool/<ref> 必须转给决策页，否则点候选卡只回到看板");

	const decision = extractFunction(app, "renderPoolDecision");
	assert.match(decision, /fetchApi\(`\/api\/pool\/\$\{encodeURIComponent\(candidateRef\)\}`\)/u, "候选详情走 /api/pool/<ref>，ref 必须编码");
	assert.match(decision, /buildDecisionPageHtml\(detail\)/u);
	assert.match(decision, /<a href="#\/pool">← 返回候选池<\/a>/u, "取数失败也要留一条回看板的出路");
	assert.match(decision, /bindDecisionForms\(/u, "决策/移动表单必须绑定，否则页面只能看不能操作");
	assert.match(decision, /if \(isCurrent\(\)\) location\.hash = "#\/pool"/u, "写成功后回看板，且必须先校验仍在本页");

	// 路由表真的把 pool 接到 renderPool（不是接了个同名空壳）
	const renderers = /const PAGE_RENDERERS = \{([\s\S]*?)\n\};/u.exec(app)?.[1] ?? "";
	assert.match(renderers, /^\tpool: renderPool,$/mu, "PAGE_RENDERERS.pool 必须是 renderPool");

	// 面包屑返回：#/pool 这条链接是决策页唯一的返回入口
	const crumb = extractFunction(app, "buildDecisionBreadcrumbHtml");
	assert.match(crumb, /<a href="#\/pool" class="breadcrumb-back"/u, "面包屑必须有返回候选池的链接");
	assert.match(crumb, /href="#\/market\/\$\{encodeURIComponent\(candidate\.marketId\)\}"/u, "面包屑右侧「查看市场档案」必须带编码");

	// 页面组装把面包屑与链接面板都接了进去（少接一个，前两条断言全成死代码）
	const page = extractFunction(app, "buildDecisionPageHtml");
	assert.match(page, /\$\{buildDecisionBreadcrumbHtml\(detail\.candidate\)\}/u);
	assert.match(page, /\$\{buildDecisionLinksPanelHtml\(detail\.links\)\}/u);
});

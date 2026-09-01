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

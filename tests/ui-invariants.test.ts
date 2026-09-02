import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 本文件只读 ui.ts 的源码文本、不 import 它的运行时：TUI 渲染路径要靠 pi 宿主的 Theme 与 pi-tui
// 才跑得起来，ui.ts 里只有 compactDashboardSummary 一个导出被 tests/retro-stats.test.ts 覆盖，
// 其余五页渲染在自动化测试里是裸奔的。
//
// 守的是「待办这一页在 TUI 的四处接线都还在」（specs/compass-todo-and-mcp-metering 任务 5）。
// 原先的守法是 `grep -c "待办" ui.ts` 期望 `≥ 4（当前 8）`——把整页从 TAB_NAMES 删掉后
// 文件里仍剩 7 处「待办」，阈值照样满足，回归静默漏网。计数不是断言，位置才是：
// 下面四处接线各写一条独立用例，每条都钉死具体位置，不留任何余量。
//
// ⚠️ 脆弱点：三个切片器全靠 ui.ts 现有的缩进形状定位——
//   · TAB_NAMES：顶格的 `const TAB_NAMES = [...] as const;`；
//   · 类方法：行首恰好一个 tab 的 `[private ]名字(`，方法体截到行首恰好一个 tab 的 `}`；
//   · 顶层导出函数：`export function 名字(` 截到行首顶格的 `}`。
// ui.ts 若被重构（六页拆到别的文件、类改写成函数、缩进层级变化、TAB_NAMES 改成对象/Map），
// 必须同步改这三个切片器与 EXPECTED_TABS。每条用例都自带「切片长度」自检，末尾还有一条反向
// 哨兵用例：切片器失效时它先红，而不是让上面几条假绿。
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

/** CLAUDE.md「ui.ts 只做六页 TUI 渲染（总览/待办/市场/候选池/预算/复盘）」——顺序即 tab 序号 */
const EXPECTED_TABS = ["总览", "待办", "市场", "候选池", "预算", "复盘"] as const;

const TODO_TAB = "待办";

/** 抽 `const TAB_NAMES = ["…", …] as const;` 里的字面量条目（按声明顺序） */
function tabNamesFromSource(source: string): string[] {
	const block = /^const TAB_NAMES = \[([^\]]*)\] as const;/mu.exec(source);
	assert.ok(block, "ui.ts 里找不到顶格的 `const TAB_NAMES = [...] as const;`——切片正则已失效，请同步更新本文件");
	return [...block[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

/** 切 CompassDashboard 的某个方法体：行首一个 tab 的方法头 → 行首一个 tab 的 `}` */
function methodBody(source: string, name: string): string {
	const header = new RegExp(`^\\t(?:private |public )?${name}\\(`, "mu").exec(source);
	assert.ok(header, `ui.ts 里找不到 CompassDashboard 的方法 ${name}(——接线点已改名或被删，请确认是有意为之`);
	const rest = source.slice(header.index);
	const end = /\n\t\}\n/u.exec(rest);
	assert.ok(end, `方法 ${name} 切不出结束的 \`\\n\\t}\`——缩进形状已变，请同步更新 methodBody`);
	return rest.slice(0, end.index);
}

/** 切顶层导出函数体：`export function 名字(` → 顶格的 `}` */
function exportedFunctionBody(source: string, name: string): string {
	const header = new RegExp(`^export function ${name}\\(`, "mu").exec(source);
	assert.ok(header, `ui.ts 里找不到 \`export function ${name}(\``);
	const rest = source.slice(header.index);
	const end = /\n\}\n/u.exec(rest);
	assert.ok(end, `函数 ${name} 切不出顶格的结束 \`}\`——请同步更新 exportedFunctionBody`);
	return rest.slice(0, end.index);
}

async function readUiSource(): Promise<string> {
	return await readFile(join(repoRoot, "ui.ts"), "utf8");
}

test("接线一：TAB_NAMES 里必须有「待办」这一页（整页被删即红）", async () => {
	const tabs = await readUiSource().then(tabNamesFromSource);
	assert.ok(tabs.length >= 2, `TAB_NAMES 只抽到 ${tabs.length} 项，切片正则很可能已失效`);
	assert.ok(
		tabs.includes(TODO_TAB),
		`TAB_NAMES 现在是 [${tabs.join(", ")}]，缺少「${TODO_TAB}」页：待办 tab 从 TUI 消失，运营在 /compass 里再也看不到待办清单`,
	);
});

test("接线一（补强）：TAB_NAMES 就是文档写明的六页、顺序固定", async () => {
	// tab 序号即 render() 的分派下标，顺序变了分派也得跟着改；同时挡住「整页被删」与「悄悄插页」
	const tabs = await readUiSource().then(tabNamesFromSource);
	assert.deepEqual(
		tabs,
		[...EXPECTED_TABS],
		"TAB_NAMES 与 CLAUDE.md 记载的六页（总览/待办/市场/候选池/预算/复盘）不一致：增删页面要同步 render() 的分派、CLAUDE.md 与本用例",
	);
});

test("接线二：「待办」页有独立渲染函数 renderTodos，且 render() 按 tab 下标分派到它", async () => {
	const source = await readUiSource();
	const tabs = tabNamesFromSource(source);
	const todoIndex = tabs.indexOf(TODO_TAB);
	assert.notEqual(todoIndex, -1, `TAB_NAMES 里没有「${TODO_TAB}」，待办页无从分派`);

	const renderBody = methodBody(source, "render");
	assert.ok(renderBody.length > 200, `render() 切出的片段只有 ${renderBody.length} 字符，切片很可能已失效`);
	const dispatch = new RegExp(`this\\.tab === ${todoIndex}\\)\\s*this\\.renderTodos\\(`, "u");
	assert.ok(
		dispatch.test(renderBody),
		`render() 里找不到 \`this.tab === ${todoIndex}\` → \`this.renderTodos(\` 的分派：「${TODO_TAB}」在 TAB_NAMES 的下标是 ${todoIndex}，分派必须与之对齐，否则切到待办页会渲染成别的页`,
	);

	const todosBody = methodBody(source, "renderTodos");
	assert.ok(todosBody.length > 200, `renderTodos() 切出的片段只有 ${todosBody.length} 字符，切片很可能已失效`);
	assert.ok(todosBody.includes("待办清单"), "renderTodos() 里没有「待办清单」标题：待办页的页头被删或改写，请确认是有意为之");
	assert.ok(
		/this\.todos/u.test(todosBody),
		"renderTodos() 不再读 this.todos：待办页与 listWorkbenchTodos 的派生口径脱钩",
	);
});

test("接线三：总览页保留「待办」汇总行（含总数与 P1/P2/P3 分档）", async () => {
	const overviewBody = await readUiSource().then((source) => methodBody(source, "renderOverview"));
	assert.ok(overviewBody.length > 400, `renderOverview() 切出的片段只有 ${overviewBody.length} 字符，切片很可能已失效`);
	assert.ok(
		/th\.bold\("待办"\)/u.test(overviewBody),
		'renderOverview() 里找不到 `th.bold("待办")`：总览页的待办汇总行被删，运营在首屏看不到待办总数',
	);
	assert.ok(
		/this\.todos\.length/u.test(overviewBody),
		"renderOverview() 不再输出 this.todos.length：待办汇总行没有总数就失去意义",
	);
	assert.ok(
		/TODO_PRIORITIES/u.test(overviewBody),
		"renderOverview() 不再按 TODO_PRIORITIES 分档：P1/P2/P3 计数消失，紧急待办在总览页被抹平",
	);
});

test("接线四：compactDashboardSummary 保留「待办」计数（含 P1 与待验证）", async () => {
	const summaryBody = await readUiSource().then((source) => exportedFunctionBody(source, "compactDashboardSummary"));
	assert.ok(summaryBody.length > 400, `compactDashboardSummary 切出的片段只有 ${summaryBody.length} 字符，切片很可能已失效`);
	assert.ok(
		/\$\{todos\.length\} 待办/u.test(summaryBody),
		"compactDashboardSummary 的返回串里找不到 `${todos.length} 待办`：会话摘要行不再报待办数",
	);
	assert.ok(
		/listWorkbenchTodos\(store\)/u.test(summaryBody),
		"compactDashboardSummary 不再调用 listWorkbenchTodos(store)：待办口径与待办页脱钩",
	);
	assert.ok(
		/P1 \$\{urgent\}/u.test(summaryBody),
		"compactDashboardSummary 不再提示 P1 数量：最紧急的一档在会话摘要里被抹平",
	);
	assert.ok(
		/待验证 \$\{pendingVerify\}/u.test(summaryBody),
		"compactDashboardSummary 不再提示待验证数量：闭环四类提交后「球在会话侧」变成无声等待",
	);
});

test("反向哨兵：三个切片器对 ui.ts 现有结构仍然有效", async () => {
	// 上面几条用例都建立在切片器能正确定位的前提上；切片一旦错位或失效，这条先红
	const source = await readUiSource();
	for (const name of ["renderOverview", "renderMarkets", "renderPool", "renderBudget", "renderRetro", "renderTodos"]) {
		const body = methodBody(source, name);
		assert.ok(body.length > 200, `${name}() 只切出 ${body.length} 字符，methodBody 已失效`);
		assert.ok(body.startsWith("\t"), `${name}() 切片没有从方法头开始，methodBody 已失效`);
		assert.equal(body.includes("\n}"), false, `${name}() 切片越过了类的结束括号，methodBody 已失效`);
	}
	assert.ok(exportedFunctionBody(source, "compactDashboardSummary").includes("return `"), "compactDashboardSummary 切片里没有 return 模板串，exportedFunctionBody 已失效");
	assert.throws(() => methodBody(source, "renderNoSuchTab"), /找不到 CompassDashboard 的方法 renderNoSuchTab/u, "methodBody 对不存在的方法必须报错，否则上面的用例会集体假绿");
	assert.deepEqual(tabNamesFromSource('const TAB_NAMES = ["甲", "乙"] as const;\n'), ["甲", "乙"], "tabNamesFromSource 对标准形状都抽不出来");
});

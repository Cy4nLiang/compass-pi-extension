import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 本文件只读源码、不 import index.ts：index.ts 是 pi extension 入口，import 会拉起宿主依赖，
// 而这里要守的是「文本层面的静态不变式」，运行时导入既慢又管不到注释与文档。
//
// ⚠️ 脆弱点（M88）：下面 hookBodies() 靠「行首一个 tab + pi.on("<name>"」切片定位热路径 hook。
// 一旦 index.ts 被拆分（hook 移到别的文件、或缩进层级改变），这里必须同步更新 HOOK_SOURCE
// 与 HOOK_HEADER。canaryLifecycle 用例正是为此存在：切片一旦失效，它会先红。
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// 行首恰好一个 tab 的 pi.on("xxx"：extension 顶层注册处的唯一形状
const HOOK_HEADER = /^\tpi\.on\("([a-z_]+)"/gmu;

/** 把 index.ts 按 pi.on(...) 注册点切成 hook 名 → 源码片段 */
function hookBodies(source: string): Map<string, string> {
	const matches = [...source.matchAll(HOOK_HEADER)];
	const bodies = new Map<string, string>();
	for (const [index, match] of matches.entries()) {
		const start = match.index;
		const end = matches[index + 1]?.index ?? source.length;
		bodies.set(match[1], source.slice(start, end));
	}
	return bodies;
}

// 写事务标记：mutateStore（index.ts 的写助手）、repo.update（唯一落盘入口）、writeReport（写报告文件）、
// withFileMutationQueue（写事务的串行闸门）。前三条是审计点名的，第四条一并禁掉——它只在写路径出现，
// 列进来不会误伤只读逻辑，却能挡住「先拿锁再写」的变体。
const WRITE_MARKERS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "mutateStore(", pattern: /\bmutateStore\s*\(/u },
	{ label: ".update(", pattern: /\.update\s*\(/u },
	{ label: "writeReport(", pattern: /\bwriteReport\s*\(/u },
	{ label: "withFileMutationQueue(", pattern: /\bwithFileMutationQueue\s*\(/u },
];

// 热路径 hook：每次 agent 轮次/每次工具调用都会跑，落盘会阻塞用户输入并与写队列抢锁
const HOT_PATH_HOOKS = ["before_agent_start", "tool_result", "tool_call", "session_before_compact"] as const;
// 生命周期 hook：允许写（session_start 初始化默认值，session_shutdown 落盘剩余计量）
const LIFECYCLE_HOOKS = ["session_start", "session_shutdown"] as const;

test("热路径 hook 不含任何写事务", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const bodies = hookBodies(source);
	for (const name of HOT_PATH_HOOKS) {
		const body = bodies.get(name);
		assert.ok(body, `index.ts 里找不到 pi.on("${name}")——切片正则或 hook 注册点已变，请同步更新本用例`);
		assert.ok(body.length > 120, `pi.on("${name}") 切出的片段只有 ${body.length} 字符，切片正则很可能已失效`);
		for (const marker of WRITE_MARKERS) {
			assert.equal(marker.pattern.test(body), false, `热路径 hook ${name} 出现写事务标记 ${marker.label}：hook 必须零写事务`);
		}
	}
});

test("生命周期 hook 仍带写事务——切片失效时这条先红", async () => {
	// 反向哨兵：若 hookBodies 切出空片段或错位，上一条用例会假绿，而这条会立刻失败
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const bodies = hookBodies(source);
	for (const name of LIFECYCLE_HOOKS) {
		const body = bodies.get(name);
		assert.ok(body, `index.ts 里找不到 pi.on("${name}")`);
		assert.ok(
			WRITE_MARKERS.some((marker) => marker.pattern.test(body)),
			`pi.on("${name}") 片段里一个写事务标记都没有，说明切片错位或 hook 已改写`,
		);
	}
});

test("策略表达式求值不得引入 eval / new Function", async () => {
	const source = await readFile(join(repoRoot, "strategy.ts"), "utf8");
	// \b 前缀让 evaluateExpression( / callFunction( 不会被误判
	assert.equal(/\beval\s*\(/u.test(source), false, "strategy.ts 出现 eval(：策略 YAML 来自用户文件，必须走自研 AST 求值");
	assert.equal(/\bnew\s+Function\s*\(/u.test(source), false, "strategy.ts 出现 new Function(：等价于 eval");
	assert.equal(/\bFunction\s*\(\s*["'`]/u.test(source), false, "strategy.ts 出现 Function(\"…\")：等价于 eval");
	// 自证：同样的正则对真 eval 文本会命中
	assert.equal(/\beval\s*\(/u.test("const x = eval(input);"), true);
	assert.equal(/\beval\s*\(/u.test("evaluateExpression(rule.when, context)"), false);
});

// M168 把工具目录抽到了 catalog.ts；这两个抽取器跟着改指向，index.ts 里已经没有这两个定义。
/** 从 catalog.ts 源码抽 DOMAIN_TOOLS 的字面量数组 */
function domainToolsFromSource(source: string): string[] {
	const block = /export const DOMAIN_TOOLS = \[([\s\S]*?)\] as const;/u.exec(source);
	assert.ok(block, "catalog.ts 里找不到 `const DOMAIN_TOOLS = [...] as const;`");
	return [...block[1].matchAll(/"(compass_[a-z_]+)"/gu)].map((match) => match[1]);
}

/** 从 catalog.ts 源码抽 TOOL_CATALOG 每条的 name */
function catalogToolsFromSource(source: string): string[] {
	const block = /export const TOOL_CATALOG: [\s\S]*?\n\];/u.exec(source);
	assert.ok(block, "catalog.ts 里找不到 `export const TOOL_CATALOG: ... = [...];`");
	return [...block[0].matchAll(/\{\s*name:\s*"(compass_[a-z_]+)"/gu)].map((match) => match[1]);
}

test("DOMAIN_TOOLS 与 TOOL_CATALOG 逐条对齐", async () => {
	const source = await readFile(join(repoRoot, "catalog.ts"), "utf8");
	const domain = domainToolsFromSource(source);
	const catalog = catalogToolsFromSource(source);
	assert.equal(domain.length, 17, `DOMAIN_TOOLS 现在是 ${domain.length} 条；增删工具时请同步本用例与 README 工具表`);
	assert.equal(new Set(domain).size, domain.length, "DOMAIN_TOOLS 有重复项");
	assert.equal(new Set(catalog).size, catalog.length, "TOOL_CATALOG 有重复的 name");
	// tsc 只约束 CATALOG→DOMAIN 方向（name 的类型是 DOMAIN_TOOLS[number]），
	// 挡不住「新工具进了 DOMAIN_TOOLS 却漏登记 CATALOG」——compass_tools 就永远搜不到它
	assert.deepEqual(catalog, domain, "TOOL_CATALOG 必须与 DOMAIN_TOOLS 同集合同序（漏登记的工具无法被 compass_tools 搜到）");
});

test("README 工具表覆盖全部对外工具", async () => {
	const source = await readFile(join(repoRoot, "catalog.ts"), "utf8");
	const readme = await readFile(join(repoRoot, "README.md"), "utf8");
	const expected = new Set([...domainToolsFromSource(source), "compass_tools"]);
	// 表格行形如：| `compass_lead` | 说明 |
	const documented = new Set([...readme.matchAll(/^\|\s*`(compass_[a-z_]+)`\s*\|/gmu)].map((match) => match[1]));
	// 低门槛的正则自检：只用来区分「表格格式变了、一行都没抽到」与「确实少写了某个工具」，
	// 阈值必须明显小于工具总数，否则删掉一行会报成「正则失效」而盖住真实原因
	assert.ok(documented.size >= 10, `README 工具表只抽到 ${documented.size} 行，抽取正则可能已失效`);
	for (const name of expected) {
		assert.ok(documented.has(name), `README 工具表缺少 ${name}`);
	}
	for (const name of documented) {
		assert.ok(expected.has(name), `README 工具表列出了不存在的工具 ${name}（改名/下线后文档漂移）`);
	}
});

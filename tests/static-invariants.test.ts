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

// MCP 载荷缓存挂在 tool_result 的非 compass 分支上。两条顺序是安全性要求不是风格：
// 缓存必须排在计量**之后**，且不能与计量共用 catch——否则缓存抛错会把计量一起吞掉，
// 变成「花了钱不记账」。热路径还必须零 I/O：溢写文件只记路径不读，文本只存不 parse。
test("载荷缓存排在计量之后、另起 try，且热路径零 I/O", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = hookBodies(source).get("tool_result");
	assert.ok(body, "找不到 tool_result 片段");
	const meterAt = body.indexOf("addPendingUsage(sample.server, sample.tool)");
	const cacheAt = body.indexOf("mcpPayloads.remember(");
	assert.notEqual(meterAt, -1, "找不到计量自增");
	assert.notEqual(cacheAt, -1, "找不到载荷缓存调用");
	assert.ok(cacheAt > meterAt, "缓存必须排在计量之后：共用一条路径时缓存抛错会把计量吞掉");
	// 两段各自的 try：计量那段的 catch 与缓存那段的 catch 不能是同一个
	assert.equal(body.slice(0, cacheAt).match(/\btry \{/gu)?.length, 2, "缓存必须另起一个 try，不与计量共用");
	// 热路径零 I/O：读文件、解析 JSON 都不许出现在这个 hook 里
	for (const forbidden of [/\breadFile\s*\(/u, /\breadFileSync\s*\(/u, /JSON\.parse\s*\(/u]) {
		assert.equal(forbidden.test(body), false, `tool_result 里出现了 ${forbidden.source}：热路径必须零 I/O、零解析`);
	}
});

test("补数确认门：hook 不重复注册、compass_gaps 串行、额度预扣在 tool_call", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");

	// ① 每个 hook 名只能注册一次。hookBodies 用 Map.set，同名后者覆盖前者——注册第二个
	// pi.on("tool_call") 会让上面「热路径零写事务」只检查后一段，前一段的写事务被静默放过
	const names = [...source.matchAll(HOOK_HEADER)].map((match) => match[1]);
	assert.equal(names.length, new Set(names).size, `有 hook 被注册了两次：${names.join("、")}。切片器按名字覆盖，重复注册会让热路径断言只检查最后一段`);

	const start = source.indexOf('name: "compass_gaps"');
	assert.ok(start > 0, "找不到 compass_gaps 的注册块——本用例的切片已失效");
	const nextTool = source.indexOf("pi.registerTool({", start);
	const block = nextTool === -1 ? source.slice(start) : source.slice(start, nextTool);

	// ② 弹窗期间别的工具不许跑：uiPromptDepth 是全 runner 共享的计数器，并发弹窗会让
	// 「弹窗未渲染」的能力检测误判；convert 还会删溢写文件，并发两次会互删对方没读的文件
	assert.match(block, /^\t\texecutionMode: "sequential",$/mu, "compass_gaps 必须声明 executionMode: sequential");

	// ③ 弹窗必须带 timeout。宿主对工具执行没有任何超时或强制取消（裸 await execute），
	// 不传 timeout = agent 永久停摆且没有任何兜底。这是硬要求，不是保险
	const selectAt = block.indexOf("await ctx.ui.select(");
	assert.ok(selectAt > 0, "approve 里找不到 ctx.ui.select 调用");
	const selectCall = block.slice(selectAt, block.indexOf(");", selectAt) + 2);
	assert.match(selectCall, /timeout: 60_000/u, "approve 的弹窗必须带 timeout：宿主没有工具超时兜底，不传就是永久停摆");

	const toolCall = hookBodies(source).get("tool_call");
	assert.ok(toolCall, 'index.ts 里找不到 pi.on("tool_call")');
	// ④ 确认门并进那个唯一的 tool_call hook，且排在熔断门**之后**：
	// 熔断是硬边界，拿着确认单也不该越过
	const gateAt = toolCall.indexOf("evaluateMcpGate(");
	const ticketAt = toolCall.indexOf("gapfillTicketGate(");
	assert.ok(ticketAt > 0, "确认门必须并进 tool_call hook，不要另起一个 pi.on");
	assert.ok(ticketAt > gateAt, "确认门必须排在熔断门之后：熔断是硬边界，有确认单也不该越过");

	// ⑤ 缩进即嵌套：compass_gaps 不匹配任何池前缀，它的 action 拦截必须在池名预过滤分支
	// **之外**（3 tab，与 compass_import_csv 那段同级）；确认门则在分支内（4 tab）
	assert.match(toolCall, /^\t{3}if \(event\.toolName === "compass_gaps" && fillMode === "off"\) \{$/mu, "compass_gaps 的 action 拦截要在池名预过滤分支之外，否则永远进不去");
	assert.match(toolCall, /^\t{4}const refusal = gapfillTicketGate\(/mu, "确认门在预过滤分支之内");

	// ⑥ 额度预扣必须发生在 tool_call。宿主同一轮是「先把整批调用的 tool_call 判定跑完，
	// 再 Promise.all 执行」——扣在 tool_result 的话同一批里的调用彼此看不见对方，
	// 运营批的 3 次挡不住一批 6 个调用
	const toolResult = hookBodies(source).get("tool_result");
	assert.ok(toolResult, 'index.ts 里找不到 pi.on("tool_result")');
	assert.equal(/remainingCalls\s*-=/u.test(toolResult), false, "额度预扣不能留在 tool_result：同一批并行调用会全部放行");
	assert.match(toolResult, /if \(!sample\.billable\) refundTicketCall\(/u, "只有不计费的失败才退额度：计费的调用钱已经花了");

	const gateStart = source.indexOf("function gapfillTicketGate(");
	const gateEnd = source.indexOf("function refundTicketCall(");
	assert.ok(gateStart > 0 && gateEnd > gateStart, "抽不到 gapfillTicketGate 的函数体——本用例的切片已失效");
	const gateBody = source.slice(gateStart, gateEnd);
	assert.match(gateBody, /covered\.remainingCalls -= 1;/u, "额度预扣要发生在 tool_call 的门禁函数里");
	// ⑦ 确认单授权的是运营看到的那条链路，不是「这个池随便调」
	assert.match(gateBody, /covered\.tools\.includes\(tool\)/u, "确认单要按工具白名单判，不能只看池名");
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
	assert.equal(domain.length, 18, `DOMAIN_TOOLS 现在是 ${domain.length} 条；增删工具时请同步本用例与 README 工具表`);
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

// 五个写工具的 execute：按「name: "<tool>"」切到下一个 registerTool 块为止。
// 用位置断言而不是 grep 计数——计数是「可以被悄悄删掉一处而不报警的量」
const GAP_NOTE_WRITE_TOOLS = [
	"compass_import_csv",
	"compass_strategy_run",
	"compass_profit_estimate",
	"compass_risk_check",
	"compass_reviews_record",
] as const;

function toolBody(source: string, name: string): string {
	const start = source.indexOf(`name: "${name}"`);
	assert.notEqual(start, -1, `index.ts 里找不到工具 ${name} 的注册块——切片器已失效`);
	const next = source.indexOf("pi.registerTool({", start);
	return source.slice(start, next === -1 ? source.length : next);
}

test("五个写工具的 execute 都产出 gapNote", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	for (const name of GAP_NOTE_WRITE_TOOLS) {
		assert.match(toolBody(source, name), /gapNote/u, `写工具 ${name} 的收口没有产出 gapNote：缺口尾注会在这条链路上静默消失`);
	}
	// compass_market_scan 一次触碰全部市场，逐市场追加会立刻撞满尾注预算：明确不挂
	assert.doesNotMatch(toolBody(source, "compass_market_scan"), /gapNote/u, "compass_market_scan 不该挂 gapNote（批量视图走 compass_gaps list）");
});

// 缺口的匹配键只有 gap_id 与 market_id，而四份运营文档写的都是「gap_id 或 市场名」。
// 不在命令里把市场名解析成 id，就会写进一条永远匹配不上的记录，回执却报「已静音」。
test("/compass-fill mute 把 market_ref 解析成 market_id 后再存", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const commandStart = source.indexOf('pi.registerCommand("compass-fill"');
	assert.notEqual(commandStart, -1, "找不到 /compass-fill 的注册块");
	const commandBody = source.slice(commandStart, source.indexOf("pi.registerCommand(", commandStart + 10));
	const muteStart = commandBody.indexOf('if (action === "mute")');
	assert.notEqual(muteStart, -1, "找不到 mute 分支");
	const muteBody = commandBody.slice(muteStart, commandBody.indexOf('if (action === "unmute")'));
	assert.match(muteBody, /findMarket\(store, target\)/u, "mute 必须把市场名解析成 market_id，否则静音是静默 no-op");
	assert.match(muteBody, /gap\.id === target/u, "gap_id 也要校验存在，不然同样是静默 no-op");
	// 过期条目不写回文件：否则 state.jsonc 会越积越大
	assert.match(commandBody, /pruneMutedGaps\(next\.muted\)/u, "写盘前要剪掉过期静音");
	assert.match(commandBody, /refreshStatus\(ctx, await readStore\(ctx\)\)/u, "改完档位/静音要立刻刷状态栏，别等下一次写事务");
	// 先写盘、成功了才认新状态。反过来的话写失败时内存已经变了而文件没变，
	// status 读内存显示新值、重启才暴露，运营会以为设置生效了（2026-09-04 冒烟实际踩到）
	const persistBody = commandBody.slice(commandBody.indexOf("const persist ="), commandBody.indexOf('if (action === "status")'));
	const writeAt = persistBody.indexOf("writeGapfillState");
	assert.notEqual(writeAt, -1, "persist 里找不到落盘调用——切片已失效");
	for (const assign of ["fillMode = next.mode;", "mutedGaps = muted;"]) {
		const at = persistBody.indexOf(assign);
		assert.notEqual(at, -1, `persist 里找不到 ${assign}`);
		assert.ok(at > writeAt, `${assign} 出现在落盘之前：写失败时内存会与磁盘不一致`);
	}
	// 四个改动分支都必须经 persist(...) 提交，不能有谁绕过去直接赋值
	const strayAssign = commandBody.slice(commandBody.indexOf('if (action === "status")')).match(/^\s*(fillMode|mutedGaps) =/gmu);
	assert.equal(strayAssign, null, `有分支绕过 persist 直接改内存：${strayAssign?.join(" / ")}`);
});

// refreshStatus 与 /compass 的非 TUI 分支必须传同一组 options，
// 否则 /compass-fill off 与静音在其中一条通路上失效，两处口径打架
test("状态栏与 /compass 通知用同一组缺口 options", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	// 按行抓：调用里嵌着 todosFor(store)，用 [^)]* 会在内层括号就截断
	const calls = source.split("\n").filter((line) => line.includes("compactDashboardSummary("));
	assert.equal(calls.length, 2, `compactDashboardSummary 的调用点应恰好两处（refreshStatus 与 /compass 非 TUI 分支），实得 ${calls.length}`);
	const bare = calls.filter((call) => !call.includes("mutedGaps") || !call.includes("gapsEnabled"));
	assert.deepEqual(bare, [], `这些调用没传缺口 options，会绕过 /compass-fill off 与静音：${bare.map((line) => line.trim()).join(" / ")}`);
});

// 斜杠命令不产生 tool result，tool_result 钩子的尾注合并整条链路都不经过。
// /compass-import 是运营最常用的导入入口，也是唯一会产生新缺口的动作——漏了它，
// 缺口提示对「用命令导入」的运营等于不存在（2026-09-04 冒烟实际踩到）。
// ctx.ui.input 的第二参 placeholder 在 TUI 下**根本不渲染**：ExtensionInputComponent 的
// 构造函数收下它就丢（`constructor(title, _placeholder, …)`，new Input() 不带参数），只有
// RPC 才转发。所以任何写进 placeholder 的提示、示例、格式说明，运营都看不见。
// 2026-09-04 实际后果：/compass-import 的市场名示例「yoga mat strap」从未显示，
// 冒烟时把市场名输成了「1」。提示一律进 title。
test("ctx.ui.input 不把提示写在 placeholder 里（TUI 下不渲染）", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const calls = source.split("\n").filter((line) => line.includes("ctx.ui.input("));
	assert.ok(calls.length >= 10, `只找到 ${calls.length} 处 ctx.ui.input 调用，切片可能已失效`);
	// 允许的形状：input("标题") 或 input(`标题`) 或 input(标题, undefined, opts)
	// 显式抓第二个实参再判，别用 `,\s*(?!undefined)`——\s* 会回溯成零宽，
	// lookahead 落在空格上就恒真，对正确代码也报红
	const secondArg = (line: string): string | undefined => /ctx\.ui\.input\((?:"[^"]*"|`[^`]*`)\s*,\s*([^,)]+)/u.exec(line)?.[1]?.trim();
	const withPlaceholder = calls.filter((line) => {
		const arg = secondArg(line);
		return arg !== undefined && arg !== "undefined";
	});
	assert.deepEqual(
		withPlaceholder.map((line) => line.trim()),
		[],
		"这些调用把提示写在了 placeholder（第二参）里，TUI 下运营看不到——把它并进 title",
	);
});

test("/compass-import 命令路径也挂补数缺口尾注", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const start = source.indexOf('pi.registerCommand("compass-import"');
	assert.notEqual(start, -1, "找不到 /compass-import 的注册块");
	const body = source.slice(start, source.indexOf("pi.registerCommand(", start + 10));
	assert.match(body, /gapNoteFor\(imported\.store, imported\.market\.id, imported\.candidate\.id\)/u, "命令路径没有派生缺口尾注");
	assert.match(body, /【补数缺口】/u, "缺口段要用与工具尾注相同的标题");
	// 与工具路径同一份展示预算，别让命令路径自己长出一套上限。
	// 实参里嵌着 gapNoteFor(...)，用 [^)]* 会在内层右括号就截断——这条正则栽过一次
	assert.match(body, /capHistoryLines\([\s\S]*?, 5, 400\)/u, "命令路径的缺口段必须走 5 行 / 400 字的同一预算");
});

test("compass_gaps 与 compass-fill 各自按 PI_LAN_SHARED 二次判定", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	// 纵深两层：工具与命令都不依赖工作区 guard 的单层拦截。
	// 断言必须钉到「真的会拦」的那个分支上——只搜 lanShared 会被 description 里的三元表达式满足
	assert.match(
		toolBody(source, "compass_gaps"),
		/if \(lanShared && action !== "list" && action !== "plan"\)/u,
		"compass_gaps 的 execute 必须自己判一次受限模式，且是白名单（只放行 list/plan）",
	);
	const commandStart = source.indexOf('pi.registerCommand("compass-fill"');
	assert.notEqual(commandStart, -1, "找不到 /compass-fill 的注册块");
	const commandBody = source.slice(commandStart, source.indexOf("pi.registerCommand(", commandStart + 10));
	const handlerBody = commandBody.slice(commandBody.indexOf("handler:"));
	assert.match(handlerBody, /if \(lanShared\) \{/u, "/compass-fill 的 handler 必须自锁：扩展命令不经 guard，光在 description 里写不算");
	assert.match(handlerBody, /局域网受限会话固定 off/u, "受限分支必须给出明确回执");
	assert.match(source, /const lanShared = process\.env\.PI_LAN_SHARED === "1";/u, "受限判据必须与 guard 同源");
	// 命令 handler 会落盘档位，必须注册在所有 pi.on 之前——否则会被 hookBodies 切进某个热路径 hook
	const firstHook = source.search(/^\tpi\.on\("/mu);
	assert.ok(commandStart < firstHook, "/compass-fill 必须注册在所有 pi.on(...) 之前（它的 handler 带写事务标记）");
});

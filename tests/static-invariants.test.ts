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
	// 三期起进程内子代理调用也视同写事务标记：它花钱、走网络、可能等上两分钟，
	// 出现在热路径 hook 里的后果比一次落盘更糟。目前 index.ts 无命中，这是前瞻性负向全称。
	{ label: "modelRegistry.complete(", pattern: /\bmodelRegistry\s*\.\s*complete\s*\(/u },
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
	assert.match(toolResult, /if \(deducted !== undefined && sample\?\.billable !== true\) refundTicketCall\(deducted\);/u, "只有 tool_call 预扣过且这次不计费的调用才退额度：计费的调用钱已经花了；没有 sample 的结果（init_failed）也要退");

	const gateStart = source.indexOf("function gapfillTicketGate(");
	const gateEnd = source.indexOf("function refundTicketCall(");
	assert.ok(gateStart > 0 && gateEnd > gateStart, "抽不到 gapfillTicketGate 的函数体——本用例的切片已失效");
	const gateBody = source.slice(gateStart, gateEnd);
	assert.match(gateBody, /covered\.remainingCalls -= 1;/u, "额度预扣要发生在 tool_call 的门禁函数里");
	// ⑦ 确认单授权的是运营看到的那条链路，不是「这个池随便调」
	assert.match(gateBody, /covered\.tools\.includes\(tool\)/u, "确认单要按工具白名单判，不能只看池名");
});

// 熔断门的在途预占。与上一条用例守的是同一个宿主事实（同一轮先把整批 tool_call 判定
// 跑完，再 Promise.all 执行），但守的是**另一道门**：确认单额度靠 deductedTicketCalls
// 预扣，熔断门靠 inflightMcpCalls 预占，两条各写各的，删掉哪一条都会让同批 k 个调用
// 在触限前全部放行——Sorftime 按次计费，多出来的是真钱。
test("熔断门在途预占：并进 pendingCallCounts、登记在两道门之后、释放在 tool_result 最前", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");

	// ⓐ 熔断门读的是 pendingCallCounts()，所以在途预占必须并进这个函数——只加一个 Map
	// 而不并进来，等于没预占。先切到函数体再匹配：只搜标识符会被别处的引用蒙混过关
	const countsStart = source.indexOf("function pendingCallCounts(");
	const countsEnd = source.indexOf("function drainPendingUsage(");
	assert.ok(countsStart > 0 && countsEnd > countsStart, "抽不到 pendingCallCounts 的函数体——本用例的切片已失效");
	assert.match(source.slice(countsStart, countsEnd), /inflightMcpCalls/u, "pendingCallCounts 必须把在途预占并进来：熔断门只读这一个数字");

	// ⓑ 登记点在 tool_call，且排在**两道门都放行之后**。被拦的调用走 kind:"immediate"，
	// 根本不产生 tool_result——登记在门之前就没人释放，池会被永久性地提前熔断
	const toolCall = hookBodies(source).get("tool_call");
	assert.ok(toolCall, 'index.ts 里找不到 pi.on("tool_call")');
	const gateAt = toolCall.indexOf("evaluateMcpGate(");
	const ticketAt = toolCall.indexOf("gapfillTicketGate(");
	const inflightAt = toolCall.indexOf("inflightMcpCalls.set(");
	// 锚点必须是确认门的**早退语句**而不是它的调用点：锚在 `gapfillTicketGate(` 上时，
	// 把登记块塞进 `const refusal = …` 与 `if (refusal) return` 这两行之间照样绿，
	// 而那恰好就是本断言声称要挡的泄漏
	const refusalReturnAt = toolCall.indexOf("if (refusal) return { block: true, reason: refusal };");
	assert.ok(inflightAt > 0, "在途预占必须登记在 tool_call hook 里：tool_result 太晚，同一批的调用彼此看不见");
	assert.ok(gateAt > 0 && gateAt < ticketAt, "熔断门仍要排在确认门之前");
	assert.ok(refusalReturnAt > ticketAt, "确认门的早退语句找不到了（或跑到调用点前面去了）——本用例的切片已失效");
	assert.ok(refusalReturnAt < inflightAt, "在途预占要登记在两道门的**早退之后**：被拦的调用走 kind:\"immediate\"、没有 tool_result，登记了没人释放");
	assert.match(toolCall, /^\t{4}if \(refusal\) return \{ block: true, reason: refusal \};$/mu, "确认门的早退必须留在登记之前（缩进层级一并钉住：预过滤分支内 4 tab）");

	// ⓑ' 泄漏兜底：中断（ESC）与后加载扩展的 block 都不产生 tool_result，条目会永久滞留在
	// 工厂闭包里（不随会话销毁）。每轮开始清一次是唯一的清空点，且必须排在该 hook 的早退守卫之前
	const beforeAgent = hookBodies(source).get("before_agent_start");
	assert.ok(beforeAgent, 'index.ts 里找不到 pi.on("before_agent_start")');
	const clearAt = beforeAgent.indexOf("inflightMcpCalls.clear()");
	const guardAt = beforeAgent.indexOf("if (!historyBriefEnabled");
	assert.ok(clearAt > 0, "每轮开始必须清空在途预占：被中断的调用不回 tool_result，不清就是永久幽灵计数");
	assert.ok(guardAt > 0, "before_agent_start 的早退守卫找不到了——本用例的切片已失效");
	assert.ok(clearAt < guardAt, "清空要排在 before_agent_start 的早退守卫之前：历史速览关掉时那道守卫会直接 return，清空就永远跑不到");

	// ⓒ 释放点在 tool_result，且排在计量之前。漏释放比漏计量更难查：pendingCallCounts
	// 会永久虚高，表现是「明明没调几次却说熔断了」，而且 /reload 前不会自愈
	const toolResult = hookBodies(source).get("tool_result");
	assert.ok(toolResult, 'index.ts 里找不到 pi.on("tool_result")');
	const releaseAt = toolResult.indexOf("inflightMcpCalls.delete(event.toolCallId)");
	const classifyAt = toolResult.indexOf("classifyMcpToolResult(");
	assert.ok(releaseAt > 0, "在途预占必须在 tool_result 里释放");
	assert.ok(classifyAt > 0, "找不到计量分类调用——本用例的切片已失效");
	assert.ok(releaseAt < classifyAt, "释放要排在计量之前：计量那段自带 catch，排在它后面会被一次分类异常带着跳过，预占就此泄漏");
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
	assert.equal(domain.length, 19, `DOMAIN_TOOLS 现在是 ${domain.length} 条；增删工具时请同步本用例与 README 工具表`);
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
	assert.match(body, /capHistoryLines\([\s\S]*?, HISTORY_NOTE_LIMITS\.gap\.maxLines, HISTORY_NOTE_LIMITS\.gap\.maxChars\)/u, "命令路径的缺口段必须读 HISTORY_NOTE_LIMITS.gap，与工具路径同一预算");
});

test("工具尾注的展示预算只在 HISTORY_NOTE_LIMITS 定义一次（M2）", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const history = await readFile(join(repoRoot, "history.ts"), "utf8");
	// history.ts：renderHistoryNote 的初切上限读常量，别再手写 8 / 1600
	const noteStart = history.indexOf("export function renderHistoryNote(");
	assert.notEqual(noteStart, -1, "找不到 renderHistoryNote");
	const noteBody = history.slice(noteStart, history.indexOf("\n}", noteStart));
	assert.match(noteBody, /capHistoryLines\(lines, HISTORY_NOTE_LIMITS\.note\.maxLines, HISTORY_NOTE_LIMITS\.note\.maxChars\)/u, "renderHistoryNote 必须读 HISTORY_NOTE_LIMITS.note");
	// index.ts tool_result：缺口份额与合并后的硬预算都读常量
	const body = hookBodies(source).get("tool_result");
	assert.ok(body, "找不到 tool_result 片段");
	assert.match(body, /capHistoryLines\(rawGap, HISTORY_NOTE_LIMITS\.gap\.maxLines, HISTORY_NOTE_LIMITS\.gap\.maxChars\)/u, "tool_result 的缺口段必须读 HISTORY_NOTE_LIMITS.gap");
	assert.match(
		body,
		/capHistoryLines\(rawHistory, Math\.max\(0, HISTORY_NOTE_LIMITS\.footer\.maxLines - gapNote\.length\), Math\.max\(0, HISTORY_NOTE_LIMITS\.footer\.maxChars - gapChars\)\)/u,
		"tool_result 的历史对照段必须按 HISTORY_NOTE_LIMITS.footer 扣掉缺口已用额度",
	);
	// 负向全称：index.ts 里任何 capHistoryLines 调用都不得再手写数字上限。按行抓，实参里嵌套调用也不会截断
	const handwritten = source.split("\n").filter((line) => line.includes("capHistoryLines(") && /,\s*\d[\d_]*\s*,\s*\d[\d_]*\s*\)/u.test(line));
	assert.deepEqual(handwritten.map((line) => line.trim()), [], "index.ts 的 capHistoryLines 调用不得手写数字，一律读 HISTORY_NOTE_LIMITS");
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

// —— 2026-09-05 真实冒烟暴露的两处展示层缺陷（A 档链路第一次在真实 TUI 里跑到底时发现）——
test("convert 的下一步指令给完整时间戳的 captured_at，不给纯日期", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = toolBody(source, "compass_gaps");
	const start = body.indexOf('if (action === "convert")');
	const end = body.indexOf('if (action === "plan")', start);
	assert.ok(start > 0 && end > start, "抽不到 convert 分支——切片已失效");
	const convert = body.slice(start, end);
	assert.match(convert, /const capturedAt = capturedAtForBatch\(entries\);/u, "capturedAt 必须来自这批载荷的接收时刻（完整 ISO）");
	assert.match(convert, /const capturedDate = capturedAt\.slice\(0, 10\);/u, "文件名仍只带日期，但要从同一个时间戳派生");
	assert.match(convert, /captured_at=\$\{capturedAt\}/u, "下一步指令必须写完整时间戳");
	assert.doesNotMatch(convert, /captured_at=\$\{capturedDate\}/u, "纯日期会被导入侧归一到 UTC 零点，同一 UTC 日早些时候的快照会压过这批花钱补来的数据");
	assert.doesNotMatch(convert, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/u, "不要再在 convert 里自己取「当天」");
});

test("compass_import_csv 与 /compass-import 露出快照级告警（含「早于现有最新快照」），不只露解析告警", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const tool = toolBody(source, "compass_import_csv");
	assert.match(tool, /warnings=\$\{imported\.snapshot\.warnings\.join\("；"\) \|\| "无"\}/u, "工具正文的 warnings= 要取 snapshot.warnings");
	assert.match(tool, /lines: imported\.snapshot\.warnings,/u, "details.lines 要取 snapshot.warnings（follower 与 TUI 渲染读它）");
	assert.doesNotMatch(tool, /imported\.parsed\.warnings/u, "parsed.warnings 只有解析告警，会把「早于最新快照」这条吞掉");
	const commandStart = source.indexOf('pi.registerCommand("compass-import"');
	assert.notEqual(commandStart, -1, "找不到 /compass-import 的注册块");
	const command = source.slice(commandStart, source.indexOf("pi.registerCommand(", commandStart + 10));
	assert.match(command, /\.\.\.imported\.snapshot\.warnings\.map\(\(warning\) => `警告：\$\{warning\}`\),/u, "斜杠命令的 notify 也要带快照级告警");
});

test("tool_result 不缓存失败调用的返回：那是 adapter 的报错文本，不是载荷", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = hookBodies(source).get("tool_result");
	assert.ok(body, "找不到 tool_result 片段");
	assert.match(body, /if \(sample && event\.isError !== true\) mcpPayloads\.remember\(sample, event\);/u, "失败调用（call_failed / aborted / tool_error）不得进载荷缓存，否则 convert 会拿到非 JSON 文本");
	// 退额度不受这个条件影响：它在缓存之后、同一个 try 里，按 tool_call 的预扣记录判
	assert.match(body, /const deducted = deductedTicketCalls\.get\(event\.toolCallId\);/u);
	assert.match(body, /if \(deducted !== undefined && sample\?\.billable !== true\) refundTicketCall\(deducted\);/u);
});

test("确认门：不花钱的网关形态不预扣、convert 只收确认单批的工具的返回", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const gateStart = source.indexOf("function gapfillTicketGate(");
	const gateEnd = source.indexOf("function refundTicketCall(");
	assert.ok(gateStart > 0 && gateEnd > gateStart, "抽不到 gapfillTicketGate 的函数体——切片已失效");
	const gate = source.slice(gateStart, gateEnd);
	// describe / search / 列工具不发请求也不花钱；预扣了没人退（那种结果没有 server），一次 mcp({describe}) 就白吃一个额度
	assert.match(gate, /if \(call\.toolName === "mcp" && !isGatewayCall\(call\.input\)\) return undefined;/u, "非调用形态的网关请求必须在预扣与 strict 拦截之前放行");
	assert.match(gate, /deductedTicketCalls\.set\(call\.toolCallId, covered\.server\);/u, "预扣要按 toolCallId 记账，tool_result 才退得回来");
	const helperStart = source.indexOf("function isGatewayCall(");
	assert.ok(helperStart > 0, "找不到 isGatewayCall");
	const helper = source.slice(helperStart, gateStart);
	assert.match(helper, /"describe" in input/u);
	assert.match(helper, /"search" in input/u);

	const body = toolBody(source, "compass_gaps");
	const start = body.indexOf('if (action === "convert")');
	const end = body.indexOf('if (action === "plan")', start);
	assert.ok(start > 0 && end > start, "抽不到 convert 分支——切片已失效");
	const convert = body.slice(start, end);
	// 窗口内同一 server 别的调用（keyword_list 之类）返回体同样是带 keyword 列的 data[]，不按工具名过滤就混进快照
	assert.match(convert, /mcpPayloads\.since\(ticket\.server, ticket\.issuedAt\)\.filter\(\(entry\) => ticket\.tools\.includes\(entry\.tool\)\)/u, "convert 只收确认单批的工具的返回");
});

// —— 审计 G5 的配套钉子：熔断门放行「不发请求的网关形态」之后，approve 的熔断预检就不能再用
// 「有 server 无 tool」的合成形态发问——那正是被豁免的形状，预检会被自己的豁免打成永远放行，
// 运营拿到一张注定中途熔断的确认单，前几次真钱照花。这条链路零行为级覆盖（测试不 import
// index.ts），只能钉源码；锚的是**发问的那一行**（产生后果的语句本身），不是 evaluateMcpGate
// 这个标识符或它的判定来源。
test("compass_gaps approve 的熔断预检必须按真调用形态发问（G5）", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = toolBody(source, "compass_gaps");
	const start = body.indexOf('if (action === "approve")');
	const end = body.indexOf('if (action === "convert")', start);
	assert.ok(start > 0 && end > start, "抽不到 approve 分支——切片已失效");
	const approve = body.slice(start, end);
	// 按行抓而不是 `[^)]*`：实参里有嵌套的对象字面量与调用，字符类会在内层右括号截断造成假红
	const asks = approve.split("\n").filter((line) => line.includes("evaluateMcpGate("));
	assert.notEqual(asks.length, 0, "approve 分支里找不到熔断预检——切片或调用写法已变");
	// 负向全称断言：不带 tool 的发问一条都不许有
	assert.deepEqual(
		asks.filter((line) => !/\btool:/u.test(line)),
		[],
		"预检必须带 tool（这批的第一步真工具名），否则会被「不发请求的网关形态放行」这条豁免打成永远放行",
	);
	// 光钉「发问的形状」不够：保留发问行逐字不动、只把后果改成恒不成立（`if (blocked && !skip) throw`），
	// 预检就被彻底架空而全量照样绿——交付评审实测过这一形态。所以后果行也要一起钉：
	// 位置断言必须覆盖「产生后果的那一行」，这是上一轮（在途预占锚在调用点）栽过的同一课。
	assert.match(
		approve,
		/^\t+if \(blocked\) throw new /mu,
		"预检问出来的结论必须无条件抛出：只留发问、把 throw 加上额外条件等于预检形同虚设",
	);
});

// —— D-1 缺陷组 ②：毛利 Gate 阈值不得在三处以字面量比较（2026-09-05）——
// 负向全称断言：命中行数必须为 0，而不是「≥N」。写完后把 economics.ts 那处临时改回 `< 0.4` 跑一遍确认真红。
test("毛利 Gate 阈值不得在 economics / service / index 里以字面量比较（D-1 缺陷组 ②）", async () => {
	const offenders: string[] = [];
	for (const file of ["economics.ts", "service.ts", "index.ts"]) {
		const source = await readFile(join(repoRoot, file), "utf8");
		source.split("\n").forEach((line, index) => {
			if (/grossMargin\s*[<>]=?\s*0\.4\d*\b/u.test(line)) offenders.push(`${file}:${index + 1}`);
		});
	}
	assert.deepEqual(offenders, [], "毛利 Gate 阈值只能来自 DEFAULT_GATE_THRESHOLDS / gateThresholds(store)");
	// 先切到 estimateProfit 的签名行再钉默认参数（只搜标识符会被 CPC 行的同名引用假绿）
	const economics = await readFile(join(repoRoot, "economics.ts"), "utf8");
	const signature = economics.split("\n").find((line) => line.startsWith("export function estimateProfit("));
	assert.ok(signature, "economics.ts 里找不到 export function estimateProfit(");
	assert.match(signature, /thresholds: ProfitGateThresholds = DEFAULT_GATE_THRESHOLDS\)/u, "estimateProfit 的默认阈值必须是 defaults.ts 的 DEFAULT_GATE_THRESHOLDS，不能是字面量");
	// 工具层接线钉位置（评审变异核对：把 estimateProfit(input, thresholds) 改回单参，全量测试与 tsc 都不会红）
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = toolBody(source, "compass_profit_estimate");
	assert.match(body, /const thresholds = gateThresholds\(store\);/u, "compass_profit_estimate 必须从最新默认策略读阈值");
	assert.match(body, /estimateProfit\(input, thresholds\)/u, "compass_profit_estimate 必须把策略阈值传给 estimateProfit");
	assert.match(body, /status: result\.warnings\.length === 0 \? "success" : "warning"/u, "status 只看 warnings 是否为空（②-2 记录的行为变化）");
});

// —— D-1 缺陷组 ①：compass_history outcomes header 的四桶字段（2026-09-05）——
// 四条统计展示链路里只有这条没有行为测试；评审变异核对：删掉 waitlist_anchored 全量仍绿。
test("compass_history action=outcomes 的 header 带 comparable / strategy_only / waitlist_anchored 三个四桶字段（D-1 缺陷组 ①）", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = toolBody(source, "compass_history");
	const headerLine = body.split("\n").find((line) => line.includes("const header = `checks=${stats.total}"));
	assert.ok(headerLine, "compass_history 里找不到 outcomes 的 header 模板行——切片已失效");
	for (const field of ["comparable=${stats.comparable}", "strategy_only=${stats.strategyOnly}", "waitlist_anchored=${stats.waitlistAnchored}", "rated_markets=${stats.ratedMarkets}"]) {
		assert.ok(headerLine.includes(` | ${field}`), `header 缺 ${field}`);
	}
});

// —— 三期 compass_dispatch：进程内零工具子代理的十条静态钉子（2026-09-06）——
// 用例名统一以 `compass_dispatch：` 开头，任务书 Proof 表按前缀选行。每条写完都把被钉代码改回
// 原样跑过一遍，确认真的变红（根 CLAUDE.md「源码切片断言」那条教训）。

test("compass_dispatch：execute 首行受限自拒", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = toolBody(source, "compass_dispatch");
	// 只搜 lanShared 会被 description 里的措辞满足——钉到真的会拦的那个分支上，连拒绝文案一起钉
	assert.match(body, /if \(lanShared\) throw new Error\(/u, "compass_dispatch 的 execute 必须自己判一次受限模式（纵深第二层，不依赖工作区 guard）");
	assert.match(body, /局域网受限会话不可派发子代理/u, "受限拒绝必须给出明确文案");
	// 「首行」是承重的，不只是好看：把这行挪到 runDispatch 之后，材料已经读进内存、已经发往
	// 模型供应商、模型也已计费，才拒绝就毫无意义。所以钉它在 execute 体里**先于任何 await**
	// （2026-09-06 交付评审核出：原断言只查出现过，挪到最后照样绿）
	const execAt = body.indexOf("async execute(");
	assert.notEqual(execAt, -1, "抽不到 compass_dispatch 的 execute 签名");
	const execBody = body.slice(execAt);
	const lanAt = execBody.indexOf("if (lanShared) throw new Error(");
	const firstAwait = execBody.indexOf("await ");
	assert.ok(lanAt > 0, "execute 体里找不到受限自拒");
	assert.ok(firstAwait > 0, "execute 体里找不到任何 await——切片已失效");
	assert.ok(lanAt < firstAwait, "受限自拒必须排在 execute 的任何 await 之前：晚一步材料就已经读进内存了");
});

test("compass_dispatch：注册在所有 pi.on 之前", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const registerAt = source.indexOf('name: "compass_dispatch"');
	assert.notEqual(registerAt, -1, "index.ts 里找不到 compass_dispatch 的注册块");
	const firstHook = source.search(/^\tpi\.on\("/mu);
	assert.ok(registerAt < firstHook, "compass_dispatch 必须注册在所有 pi.on(...) 之前——否则 hookBodies 会把它整块算进某个 hook 片段，下面两条钉子同时失效");
});

test("compass_dispatch：材料路径白名单复核在派发之前", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = toolBody(source, "compass_dispatch");
	// resolveInputPath 只保证「在项目根内」，.env 与受限会话的凭据副本都在项目根内。
	// 复核必须排在 runDispatch 之前，晚一步就等于已经把文件读进内存发出去了
	// 判据本身在 store.ts 的 resolveMaterialPath 里，有真行为测试守着（tests/integration.test.ts
	// 「材料路径白名单」）。这里只钉接线：工具**必须走那个方法**而不是宽一层的 resolveInputPath。
	// 早先这条钉的是「repo.materialsDir 出现在 runDispatch 之前」，把判据掏空照样绿
	const guardAt = body.indexOf("repo.resolveMaterialPath(params.material)");
	const dispatchAt = body.indexOf("runDispatch(");
	assert.notEqual(guardAt, -1, "material 参数必须经 resolveMaterialPath 复核，不能只用 resolveInputPath");
	assert.notEqual(dispatchAt, -1, "compass_dispatch 里找不到 runDispatch( 调用——切片已失效");
	assert.ok(guardAt < dispatchAt, "白名单复核必须排在 runDispatch 之前");
	assert.equal(/resolveInputPath\(params\.material\)/u.test(body), false, "不得绕过 resolveMaterialPath 直接用 resolveInputPath 取材料");
	assert.match(body, /const store = await readStore\(ctx\)/u, "派发只读 store：readStoreFlushingUsage 在有未落盘计量时会真开一次写事务");
});

test("compass_dispatch：dispatch.ts 的 Context 构造块键集只有 systemPrompt 与 messages", async () => {
	const source = await readFile(join(repoRoot, "dispatch.ts"), "utf8");
	// 抓构造点而不是调用行：Context 被提成变量时，按调用行抓会恒真（评审变异核对过）
	const blocks = [...source.matchAll(/(?:const|let)\s+\w*[Cc]ontext\w*\s*(?::\s*\w+)?\s*=\s*\{([\s\S]*?)\n\t*\};/gu)];
	assert.ok(blocks.length > 0, "dispatch.ts 里抓不到任何 Context 构造块——正则已失效，本条断言等于没有");
	for (const block of blocks) {
		const keys = [...block[1].matchAll(/^\t+(\w+):/gmu)].map((match) => match[1]);
		assert.deepEqual([...keys].sort(), ["messages", "systemPrompt"], `传给 complete 的 Context 只能有 systemPrompt 与 messages，实得：${keys.join(" / ")}`);
	}
});

test("compass_dispatch：dispatch.ts 无子进程入口", async () => {
	const source = await readFile(join(repoRoot, "dispatch.ts"), "utf8");
	// child_process 那条是承重项：它同时盖住 node: 前缀、无前缀、require 与动态 import，
	// 也盖住 namespace 导入后的 cp.exec(）。不得删、不得降级成只认 node:child_process。
	// 下面几条一律带 (?<![.\w]) 边界——裸 exec( 会被 RegExp.prototype.exec 误伤（csv.ts 与 strategy.ts 都在用）
	const forbidden: Array<{ label: string; pattern: RegExp }> = [
		{ label: "child_process", pattern: /child_process/u },
		{ label: "spawn(", pattern: /(?<![.\w])spawn\s*\(/u },
		{ label: "spawnSync(", pattern: /(?<![.\w])spawnSync\s*\(/u },
		{ label: "exec(", pattern: /(?<![.\w])exec\s*\(/u },
		{ label: "execFile(", pattern: /(?<![.\w])execFile\s*\(/u },
		{ label: "execFileSync(", pattern: /(?<![.\w])execFileSync\s*\(/u },
		{ label: "execSync(", pattern: /(?<![.\w])execSync\s*\(/u },
	];
	for (const item of forbidden) {
		assert.equal(item.pattern.test(source), false, `dispatch.ts 出现子进程入口 ${item.label}：进程内子代理不得起子进程`);
	}
});

test("compass_dispatch：热路径 hook 不出现派发调用", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const bodies = hookBodies(source);
	// 只禁调用与 import，不禁文案——guardReason 里点名 compass_dispatch 是要给运营看的，
	// 所以标识符必须紧跟 `(` 才算命中，字符串字面量 "compass_dispatch") 不会被判。
	//
	// 两处坑都踩过：写成 /\bdispatch\w*\(/ 时 runDispatch( 里的 Dispatch 前面没有词边界，整条放过；
	// 改成「前面至少一个标识符字符」之后，**以小写 dispatch 开头**的 dispatchRegistry( /
	// dispatchFactsFor( 又全部漏网（2026-09-06 交付评审核出）。所以前缀写成可选。
	const pattern = /[A-Za-z0-9_$]*[Dd]ispatch[A-Za-z0-9_$]*\s*\(|from "\.\/dispatch\.(?:ts|js)"|modelRegistry/u;
	// 自证：正则对真正的违规写法必须命中，对文案必须不命中。四条违规写法一条都不能漏
	for (const violation of ["await runDispatch({ registry }, input);", "dispatchRegistry(ctx)", "dispatchFactsFor(store, ref)", "resetDispatchCounters()"]) {
		assert.equal(pattern.test(violation), true, `正则必须能抓到 ${violation}`);
	}
	assert.equal(pattern.test('renderCallLabel("compass_dispatch")'), false, "正则不该把工具名文案判成调用");
	assert.equal(pattern.test("差评材料只能交给 compass_dispatch（agent=review-clusterer）"), false, "guardReason 的中文文案不该被判成调用");
	for (const name of HOT_PATH_HOOKS) {
		const body = bodies.get(name);
		assert.ok(body, `index.ts 里找不到 pi.on("${name}")——切片正则或 hook 注册点已变`);
		assert.equal(pattern.test(body), false, `热路径 hook ${name} 出现派发调用：进程内子代理只能从工具 execute 发起`);
	}
});

test("compass_dispatch：session_start 清零派发计数", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = hookBodies(source).get("session_start");
	assert.ok(body, 'index.ts 里找不到 pi.on("session_start")——切片器已失效');
	assert.ok(body.length > 120, `session_start 切出的片段只有 ${body.length} 字符，切片正则很可能已失效`);
	// /reload 会以 reason "reload" 重发 session_start，所以这一行就是「会话上限每会话重置」的全部接线；
	// 删掉它，40 次上限会变成跨会话累积拒绝，而且不会有任何测试变红
	assert.match(body, /resetDispatchCounters\(\)/u, "session_start 必须清零派发计数");
});

test("compass_dispatch：dispatch.ts 不值导入 pi 包", async () => {
	const source = await readFile(join(repoRoot, "dispatch.ts"), "utf8");
	// pi 系列包在 compass 是 devDependencies，装到用户机器上根本不存在；
	// 运行期 import 会让整个扩展加载失败，而 tsc 在本机是绿的（IDE 有那些包）
	const offenders = source
		.split("\n")
		.filter((line) => /from "@earendil-works\//u.test(line))
		.filter((line) => !line.trimStart().startsWith("import type"));
	assert.deepEqual(offenders, [], "dispatch.ts 对 pi 包只能 import type");
});

test("compass_dispatch：materials 目录进了读守卫且 guardReason 点名", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const start = source.indexOf("function pathIsHistoryStore");
	const end = source.indexOf("function bashReadsHistoryStore");
	assert.ok(start !== -1 && end > start, "index.ts 里切不出 pathIsHistoryStore——切片已失效");
	const body = source.slice(start, end);
	assert.match(body, /const materialsRoot = resolve\(compassRoot, "materials"\)/u, "差评材料目录必须进读守卫");
	const returnLine = body.split("\n").find((line) => line.trimStart().startsWith("return absolute === storePath"));
	assert.ok(returnLine, "pathIsHistoryStore 的 return 行找不到了");
	assert.match(returnLine, /withinMaterials/u, "materials 判据必须真的参与 return——只声明不用等于没拦");
	assert.match(source.slice(0, start), /差评材料只能交给 compass_dispatch/u, "guardReason 必须点名 compass_dispatch，且声明在 pathIsHistoryStore 之前（早于第一个 pi.on）");
});

test("compass_dispatch：hints 只在结果侧拼接", async () => {
	const dispatchSource = await readFile(join(repoRoot, "dispatch.ts"), "utf8");
	// owner 拍板：内部口径不进 prompt。运行器连读都不该读到它
	assert.equal(/loadGapHints|hints\.json/u.test(dispatchSource), false, "dispatch.ts 不得接触 hints：内部口径不进 prompt");
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = toolBody(source, "compass_dispatch");
	const hintsAt = body.indexOf("loadGapHints(");
	const dispatchAt = body.indexOf("runDispatch(");
	assert.notEqual(hintsAt, -1, "compass_dispatch 必须在结果下方本地拼接 hints 的 how");
	assert.ok(hintsAt > dispatchAt, "hints 只能在 runDispatch 返回之后读——早于它就有被传进 prompt 的可能");
});

// —— 三期差评材料链的两条静态钉子（2026-09-06）——
// 用例名同以 `reviews 链：` 开头，与 gaps-convert.test.ts 那十条区分在文件而不在名字。

test("reviews 链：convert 的 material 分支不出现 writeImportCsv 或 compass_import_csv", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = toolBody(source, "compass_gaps");
	const start = body.indexOf('if (action === "convert")');
	const end = body.indexOf('if (action === "plan")', start);
	assert.ok(start > 0 && end > start, "抽不到 convert 分支——切片已失效");
	const convert = body.slice(start, end);
	const materialStart = convert.indexOf('if (ticket.kind === "material")');
	assert.notEqual(materialStart, -1, "convert 里找不到 material 分支");
	// 边界取快照分支的首行而不是 `convertSorftimePayloads(`：后者的第一次出现是那行 `let result:`
	// 的类型标注，切过去会把快照分支的第一行也算进 material 片段，负向断言随即假红
	const snapshotStart = convert.indexOf("let result:", materialStart);
	assert.ok(snapshotStart > materialStart, "material 分支必须早返回，排在快照分支之前");
	const material = convert.slice(materialStart, snapshotStart);
	// 材料不是要导入的 CSV：走导入入口就等于把差评原文塞进市场快照链路
	assert.equal(/writeImportCsv|compass_import_csv|convertSorftimePayloads/u.test(material), false, "material 分支不得触碰 CSV 导入链路");
	assert.match(material, /materializeReviewPayloads\(/u, "material 分支必须走材料转换");
	// 早返回会绕过快照分支末尾的清理，两行必须在分支内重写一遍——否则确认单与载荷缓存永远留着
	assert.match(material, /mcpPayloads\.forget\(/u, "material 分支要自己清载荷缓存");
	assert.match(material, /gapfillTicket = undefined;/u, "material 分支要自己清确认单");
	assert.match(material, /capturedAt/u, "材料的 captured_at 用完整时间戳");
});

test("reviews 链：approve 的 asins 带字面量 maxItems 5 且运行期复核在映射表读入之后弹窗之前", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = toolBody(source, "compass_gaps");
	// schema 在同步工厂体内求值，读不到运行期才载入的映射表——上限只能是字面量
	const asinsLine = body.split("\n").find((line) => line.includes("asins: Type.Optional(Type.Array("));
	assert.ok(asinsLine, "compass_gaps 的参数表里找不到 asins");
	assert.match(asinsLine, /minItems: 1, maxItems: 5/u, "asins 的上限必须是字面量 5");
	const approveStart = body.indexOf('if (action === "approve")');
	const approveEnd = body.indexOf('if (action === "convert")', approveStart);
	assert.ok(approveStart > 0 && approveEnd > approveStart, "抽不到 approve 分支——切片已失效");
	const approve = body.slice(approveStart, approveEnd);
	const mapAt = approve.indexOf("await loadSorftimeFieldMap(ctx)");
	const checkAt = approve.indexOf("asinsPerTicketMax");
	const promptAt = approve.indexOf("await ctx.ui.select(");
	assert.ok(mapAt > 0 && checkAt > 0 && promptAt > 0, "approve 分支里找不到映射表读入 / 上限复核 / 弹窗三处锚点");
	assert.ok(checkAt > mapAt, "上限复核要在映射表读入之后");
	// 放到弹窗之后就成了「钱花完才发现超限」，而点数要不回来
	assert.ok(checkAt < promptAt, "上限复核必须在弹窗与扣次数之前");
});

test("reviews 链：strict 档按确认单的 ASIN 与固定参数复核，且拒绝发生在扣额度之前", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const gateStart = source.indexOf("function gapfillTicketGate(");
	const gateEnd = source.indexOf("function refundTicketCall(");
	assert.ok(gateStart > 0 && gateEnd > gateStart, "抽不到 gapfillTicketGate 的函数体——切片已失效");
	const gate = source.slice(gateStart, gateEnd);
	assert.match(gate, /covered\.kind === "material"/u, "差评单要按 kind 走自己的复核分支");
	assert.match(gate, /covered\.asins\.includes\(asin\)/u, "确认单是逐 ASIN 批准的，只能抓批准过的那几个");
	assert.match(gate, /covered\.fixedParams/u, "固定参数从确认单复核——门禁是同步函数，读不到映射表");
	// 两个字段必须从同一个参数对象读：跨对象拼会在网关形态下把合规调用误拦
	assert.match(gate, /const params = requestParamsOf\(call\.input\);/u, "asin 与固定参数要从同一个参数对象取");
	// 拒绝必须早于预扣。写到 strict 块之外会变成「拒绝了还扣一次额度」，
	// 而被拒的调用不会产生 tool_result，那笔预扣永远退不回来
	const asinCheckAt = gate.indexOf("covered.asins.includes(asin)");
	const deductAt = gate.indexOf("covered.remainingCalls -= 1;");
	assert.ok(asinCheckAt > 0 && deductAt > asinCheckAt, "ASIN 复核必须排在额度预扣之前");
});

test("Web 错误分级按类型判定：asDomainError 里没有领域文案正则", async () => {
	const source = await readFile(join(repoRoot, "web/server.ts"), "utf8");
	// 先切到函数体再匹配：整文件搜会被上方那段注释误伤，是「假绿/假红」家族的老坑
	const start = source.indexOf("function asDomainError");
	assert.ok(start > 0, "web/server.ts 里找不到 asDomainError——本用例的切片锚点已失效");
	const end = source.indexOf("\n}", start);
	assert.ok(end > start, "asDomainError 的函数体切不出来——收尾的行首右括号找不到");
	const body = source.slice(start, end);
	assert.ok(body.length > 200, `asDomainError 切出的片段只有 ${body.length} 字符，切片锚点很可能已失效`);

	// 分类信息必须落在类型上：函数体里出现中文实体文案就说明又在猜措辞，
	// 改一个字状态码就错，同一概念换个措辞立刻判错
	assert.doesNotMatch(body, /未找到|尚无/u, "asDomainError 不得按中文错误文案分级：404/400 的依据应是 NotFoundError / ValidationError");
	assert.match(body, /error instanceof NotFoundError/u, "asDomainError 必须按类型认出「实体不存在」");
	assert.match(body, /error instanceof ValidationError/u, "asDomainError 必须按类型认出「入参不合法」");

	// 顺序承重：领域错误分支要排在 errno 兜底之前，
	// 否则哪天领域错误类被加上 code 字段就会被 500 那条抢走
	const notFoundAt = body.indexOf("NotFoundError");
	const errnoAt = body.indexOf("ErrnoException");
	assert.ok(errnoAt > 0, "找不到 errno 兜底分支——本用例的切片已失效");
	assert.ok(notFoundAt < errnoAt, "领域错误分支必须排在 errno 兜底之前：带 code 字段的领域错误会被误判成 500");
});

// —— 1688 参考成本链（compass-1688-cost-reference，2026-09-07）——
// 四条切片钉子，每条写完都把被钉的那行改坏跑过一次确认真红（根 CLAUDE.md「源码切片断言」教训）。
// 用例名统一含「参考成本」，任务书 Proof 表按它选行。

function costReferenceConvertSlice(source: string): string {
	const body = toolBody(source, "compass_gaps");
	const start = body.indexOf('if (ticket.kind === "cost_reference")');
	const end = body.indexOf("let result: Awaited<ReturnType<typeof convertSorftimePayloads>>;", start);
	assert.ok(start > 0 && end > start, "抽不到 convert 里的参考成本分支——切片已失效");
	return body.slice(start, end);
}

test("参考成本 ①：convert 的同款确认与最终确认弹窗都在写事务之前，事务里不弹窗", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const slice = costReferenceConvertSlice(source);
	const lastSelect = slice.lastIndexOf("await ctx.ui.select(");
	const mutate = slice.indexOf("await mutateStore(");
	assert.ok(lastSelect > 0, "参考成本分支里找不到 ctx.ui.select");
	assert.ok(mutate > 0, "参考成本分支里找不到 mutateStore");
	assert.ok(lastSelect < mutate, "所有弹窗必须在 mutateStore 之前：写事务里等运营按键会把 store 锁住几分钟");
	assert.equal(slice.indexOf("await ctx.ui.select(", mutate), -1, "mutateStore 之后不得再弹窗");
});

test("参考成本 ②：同款确认循环的上界是 COST_REFERENCE_MAX_PROMPTS，不是手写数字", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const slice = costReferenceConvertSlice(source);
	const loopStart = slice.indexOf("for (const row of candidates) {");
	const loopEnd = slice.indexOf("const computation = computeCostReference(", loopStart);
	assert.ok(loopStart > 0 && loopEnd > loopStart, "抽不到同款确认循环——切片已失效");
	const loop = slice.slice(loopStart, loopEnd);
	assert.match(loop, /if \(accepted\.length >= COST_REFERENCE_SAMPLE_SIZE \|\| prompted >= COST_REFERENCE_MAX_PROMPTS\) break;/u, "循环上界必须读常量：纳满 5 条或弹到上限就停");
	assert.match(loop, /timeout: 60_000/u, "逐条确认同样要带 timeout：宿主没有工具超时兜底");
});

test("参考成本 ③：strict 档固定参数用 String() 比对，且参考成本单按关键词复核", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const gateStart = source.indexOf("function gapfillTicketGate(");
	const gateEnd = source.indexOf("function refundTicketCall(");
	assert.ok(gateStart > 0 && gateEnd > gateStart, "抽不到 gapfillTicketGate 的函数体——切片已失效");
	const gate = source.slice(gateStart, gateEnd);
	// 门禁里有**两处**固定参数比对（差评分支、参考成本分支），各自切片各自钉：只在整个函数体里搜一次
	// String() 会被差评分支单独满足，参考成本分支退化成裸比对照样绿（2026-09-07 verifier 核出）
	const materialStart = gate.indexOf('if (covered.kind === "material")');
	const costStart = gate.indexOf('if (covered.kind === "cost_reference")');
	assert.ok(materialStart > 0 && costStart > materialStart, "差评单与参考成本单的复核分支都得在门禁里，且差评分支在前——切片已失效");
	const material = gate.slice(materialStart, costStart);
	const cost = gate.slice(costStart);
	// 差评单的 review_type 是字符串、参考成本单的 page 在 schema 里是整数：不 String() 化就会把合规的 page=1 当成不符
	assert.match(material, /if \(String\(params\[key\]\) !== String\(expected\)\)/u, "差评单固定参数比对必须两边都 String()");
	assert.match(cost, /requestParamsOf\(call\.input, "search_name"\)/u, "参考成本单按 search_name 取参数对象，与差评单按 asin 同口径");
	assert.match(cost, /if \(params\[key\] !== undefined && String\(params\[key\]\) !== String\(expected\)\)/u, "参考成本单：page 漏传按第 1 页放行，传了就两边 String() 比对");
	assert.doesNotMatch(gate, /params\[key\] !== expected\)/u, "裸比对会把整数 page=1 判成与 \"1\" 不符——两个分支都不许");
});

test("参考成本 ⑤：写回克隆在事务内复核币种，且溢写清理只发生在落幕路径", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const slice = costReferenceConvertSlice(source);
	// 币种：参考成本按确认循环**开始时**那条测算的币种换算，克隆前必须复核事务内取到的还是同一种币，
	// 否则 12 分钟里换过币种的市场会被写进一条两种币混用的测算（2026-09-09 交付评审核出）
	const clone = slice.slice(slice.indexOf("const latest = latestProfitEstimate(store, ticket.marketId);"));
	assert.ok(clone.length > 0, "抽不到写回克隆段——切片已失效");
	const guardAt = clone.indexOf("latest.input.currency !== currency");
	const recordAt = clone.indexOf("recordProfitEstimate(");
	assert.ok(guardAt > 0 && recordAt > guardAt, "克隆写回之前必须先比对币种");
	// 清理：解析阶段只归档（deferCleanup），unlink 推迟到写库成功 / 判空结果之后；
	// 中断路径承诺「可重新 convert 继续」，提前清掉溢写文件会让重跑抛裸 ENOENT
	assert.match(slice, /deferCleanup: true/u, "参考成本链解析时必须延迟清理");
	assert.match(slice, /await parsed\.cleanup\?\.\(\)/u, "落幕路径要真的把清理执行掉");
	// 切片要从 `if (choice === undefined) {` 起——从「同款确认中断」那句文案起会把插在它**前面**的
	// 清理调用漏在切片外，改坏了也不红（写这条时真踩了一次，正是根 CLAUDE.md 那条假绿家族）
	const interruptStart = slice.indexOf("if (choice === undefined) {");
	const interruptEnd = slice.indexOf("if (choice === STOP_OPTION)");
	assert.ok(interruptStart > 0 && interruptEnd > interruptStart, "抽不到同款确认的中断早退分支——切片已失效");
	assert.doesNotMatch(slice.slice(interruptStart, interruptEnd), /cleanup/u, "同款确认中断的早退路径不得清理溢写文件：那正是重跑要读回的东西");
	const finalCancel = slice.slice(slice.indexOf("if (finalChoice !== WRITE_AND_UPDATE"), slice.indexOf("const actor = actorName();"));
	assert.doesNotMatch(finalCancel, /cleanup/u, "最终弹窗取消 / 超时同样不清理：确认单还在，运营可以重跑");
});

test("参考成本 ④：approve 在 origin 缺省时排除参考成本链，既有快照链的 approve 不受新缺口影响", async () => {
	const source = await readFile(join(repoRoot, "index.ts"), "utf8");
	const body = toolBody(source, "compass_gaps");
	const start = body.indexOf('if (action === "approve")');
	const end = body.indexOf('if (action === "convert")', start);
	assert.ok(start > 0 && end > start, "抽不到 approve 分支——切片已失效");
	const approve = body.slice(start, end);
	assert.match(
		approve,
		/const confirmGaps = filtered\.filter\(\(gap\) => gap\.autoTier === "A_confirm" && \(params\.origin !== undefined \|\| gap\.origin !== "purchase_cost_source"\)\);/u,
		"选链规则：任何做过手填测算的市场都会同时挂着快照链与参考成本链，不在 origin 缺省时排除后者，「A 档产物唯一」检查会把运营照旧只写 market_ref 的 approve 一律拒绝",
	);
});

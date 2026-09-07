import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { DEFAULT_BUDGET_POOLS } from "../defaults.ts";
import { budgetStatus, classifyMcpToolResult, configureBudget, ensureDefaults, evaluateMcpGate, listWorkbenchTodos, mcpCallTargetServers, recordMcpUsage } from "../service.ts";
import { CompassRepository, createEmptyStore } from "../store.ts";
import type { CompassStore, CostEvent } from "../types.ts";
import { budgetData, overviewData } from "../web/data.ts";

// pi-mcp-adapter 2.27.0 实测的 tool_result details 形态（direct 工具无 mode 字段，mcp 代理
// mode==="call"）。direct 的失败分支只带 server（`...guardedMcpDetails()` 不含 tool），
// proxy 的失败分支带 `...callIdentity` 即 server+tool——把两种形态钉死，adapter 升级改字段时先红。
const ADAPTER_DETAILS = {
	directSuccess: { server: "sorftime", tool: "ProductResearch" },
	directToolError: { error: "tool_error", server: "sorftime" },
	directCallFailed: { error: "call_failed", server: "sorftime" },
	directAborted: { error: "aborted", server: "sorftime" },
	directServerUnavailable: { error: "server_unavailable", server: "sorftime" },
	proxySuccess: { mode: "call", server: "sorftime", tool: "ProductResearch" },
	proxyToolError: { mode: "call", error: "tool_error", server: "sorftime", tool: "ProductResearch" },
	proxyCallFailedTimeout: { mode: "call", error: "call_failed", server: "sorftime", tool: "ProductResearch", message: "MCP error -32001: Request timed out" },
	proxyAborted: { mode: "call", error: "aborted", server: "sorftime", tool: "ProductResearch", message: "MCP request aborted" },
	proxyAuthRequired: { mode: "call", error: "auth_required", server: "sorftime", tool: "ProductResearch", autoAuthAttempted: true },
	proxyConnectFailed: { mode: "call", error: "connect_failed", server: "sorftime", tool: "ProductResearch", message: "fetch failed" },
	proxyServerBackoff: { mode: "call", error: "server_backoff", server: "sorftime", tool: "ProductResearch" },
	proxyServerDisabled: { mode: "call", error: "server_disabled", server: "sorftime", tool: "ProductResearch", message: "disabled" },
	proxyApprovalDenied: { mode: "call", error: "approval_denied", server: "sorftime", tool: "ProductResearch" },
	proxyToolNotFound: { mode: "call", error: "tool_not_found_after_reconnect", server: "sorftime", requestedTool: "P", suggestions: [] },
	// 超大返回的三档形态（pi-mcp-adapter 的 mcp-output-guard）。二期的载荷缓存按这三档取值，
	// 这里先把它们钉进计量口径：无论载荷多大、被搬到哪里，计费判定只看 error。
	// ① 整个 CallToolResult ≤16 KiB：mcpResult 就是原对象
	proxySuccessInlineResult: { mode: "call", server: "sorftime", tool: "category_keywords", mcpResult: { content: [{ type: "text", text: "{}" }], isError: false } },
	// ② >16 KiB 但正文 ≤50 KiB 且 ≤2000 行：mcpResult 被换成摘要，正文仍然是完整的
	proxySuccessSummarizedResult: {
		mode: "call",
		server: "sorftime",
		tool: "category_keywords",
		mcpResult: { omitted: true, reason: "result too large", isError: false, contentBlocks: 1, rawResultBytes: 20_480, fullResultPath: "/tmp/pi-mcp-output-a/mcp-result-1.txt" },
	},
	// ③ 正文 >50 KiB 或 >2000 行：正文也被截断溢写，两条链各留一个文件
	proxySuccessTruncatedOutput: {
		mode: "call",
		server: "sorftime",
		tool: "category_report",
		mcpResult: { omitted: true, reason: "result too large", isError: false, contentBlocks: 1, rawResultBytes: 81_920, fullResultPath: "/tmp/pi-mcp-output-a/mcp-result-1.txt" },
		outputGuard: { truncated: true, originalBytes: 78_632, returnedBytes: 2_048, fullOutputPath: "/tmp/pi-mcp-output-b/output-1.txt" },
	},
} as const;

test("ensureDefaults adds the sorftime metering pool exactly once", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const sorftime = store.budgetPools.find((pool) => pool.source === "sorftime");
	assert.ok(sorftime, "sorftime 预算池应随默认池创建");
	assert.equal(sorftime.tier, "A");
	assert.equal(sorftime.monthlyLimitCny, 0);
	assert.equal(sorftime.enabled, true);
	assert.equal(sorftime.costPerCallCny, undefined);
	assert.equal(sorftime.monthlyCallLimit, undefined);
	const before = store.budgetPools.length;
	ensureDefaults(store, "tester");
	assert.equal(store.budgetPools.length, before);
});

test("legacy stores without a sorftime pool gain it via ensureDefaults", () => {
	const store = createEmptyStore();
	for (const pool of DEFAULT_BUDGET_POOLS) {
		if (pool.source !== "sorftime") store.budgetPools.push({ ...pool });
	}
	const changed = ensureDefaults(store, "tester");
	assert.equal(changed, true);
	assert.equal(store.budgetPools.filter((pool) => pool.source === "sorftime").length, 1);
});

test("metering fields on pools and cost events survive a store round-trip", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-metering-roundtrip-"));
	try {
		const repo = new CompassRepository(root);
		await repo.update((store) => {
			store.budgetPools.push({ source: "sorftime", tier: "A", monthlyLimitCny: 0, enabled: true, costPerCallCny: 0.5, monthlyCallLimit: 200 });
			store.budgetPools.push({ source: "keepa", tier: "A", monthlyLimitCny: 400, enabled: true, costPerCallCny: 0 });
			store.costEvents.push({
				id: "cost_meter_1",
				source: "sorftime",
				amountCny: 1,
				kind: "mcp_call",
				tool: "ProductResearch",
				calls: 2,
				createdAt: "2026-08-01T00:00:00.000Z",
				actor: "compass-meter",
			});
		});
		const loaded = await repo.load();
		const sorftime = loaded.budgetPools.find((pool) => pool.source === "sorftime");
		assert.equal(sorftime?.costPerCallCny, 0.5);
		assert.equal(sorftime?.monthlyCallLimit, 200);
		const keepa = loaded.budgetPools.find((pool) => pool.source === "keepa");
		assert.equal(keepa?.costPerCallCny, 0);
		assert.equal(keepa?.monthlyCallLimit, undefined);
		const event = loaded.costEvents[0];
		assert.equal(event.kind, "mcp_call");
		assert.equal(event.tool, "ProductResearch");
		assert.equal(event.calls, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("corrupted metering fields are rejected with path-aware diagnostics", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-metering-corrupt-"));
	try {
		const repo = new CompassRepository(root);
		const meterEvent = {
			id: "cost_meter_bad",
			source: "sorftime",
			amountCny: 0,
			createdAt: "2026-08-01T00:00:00.000Z",
			actor: "compass-meter",
		};
		await assert.rejects(
			repo.update((store) => {
				store.budgetPools.push({ source: "sorftime", tier: "A", monthlyLimitCny: 0, enabled: true, costPerCallCny: -1 });
			}),
			/budgetPools\[0\]\.costPerCallCny/,
		);
		await assert.rejects(
			repo.update((store) => {
				store.budgetPools.push({ source: "sorftime", tier: "A", monthlyLimitCny: 0, enabled: true, monthlyCallLimit: 0 });
			}),
			/budgetPools\[0\]\.monthlyCallLimit/,
		);
		await assert.rejects(
			repo.update((store) => {
				store.costEvents.push({ ...meterEvent, kind: "manual" as unknown as "mcp_call" });
			}),
			/costEvents\[0\]\.kind/,
		);
		await assert.rejects(
			repo.update((store) => {
				store.costEvents.push({ ...meterEvent, kind: "mcp_call", calls: 0 });
			}),
			/costEvents\[0\]\.calls/,
		);
		await assert.rejects(
			repo.update((store) => {
				store.costEvents.push({ ...meterEvent, kind: "mcp_call", calls: 1.5 });
			}),
			/costEvents\[0\]\.calls/,
		);
		assert.equal((await repo.load()).costEvents.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("recordMcpUsage merges by server+tool, prices calls, and skips invalid entries", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	configureBudget(store, { source: "sorftime", costPerCallCny: 0.5 });
	const events = recordMcpUsage(store, [
		{ server: "sorftime", tool: "ProductResearch", calls: 1 },
		{ server: "sorftime", tool: "ProductResearch", calls: 2 },
		{ server: "sorftime", tool: "  ", calls: 1 },
		{ server: "unknown-server", tool: "X", calls: 3 },
		{ server: "sorftime", tool: "Bad", calls: 0 },
		{ server: "sorftime", tool: "Bad", calls: 1.5 },
	], "compass-meter");
	assert.equal(events.length, 2);
	const research = events.find((event) => event.tool === "ProductResearch");
	assert.equal(research?.calls, 3);
	assert.equal(research?.amountCny, 1.5);
	assert.equal(research?.kind, "mcp_call");
	assert.equal(events.find((event) => event.tool === "unknown")?.calls, 1);
	assert.equal(store.costEvents.length, 2);
	const keepaEvents = recordMcpUsage(store, [{ server: "keepa", tool: "product", calls: 4 }], "compass-meter");
	assert.equal(keepaEvents[0].amountCny, 0);
	assert.equal(keepaEvents[0].calls, 4);
});

test("budgetStatus derives call counts, thresholds, and pending merges", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	configureBudget(store, { source: "sorftime", costPerCallCny: 0.5, monthlyCallLimit: 10 });
	const meterEvent = (id: string, calls: number | undefined, createdAt: string): CostEvent => ({
		id,
		source: "sorftime",
		amountCny: 0.5 * (calls ?? 1),
		kind: "mcp_call",
		tool: "T",
		...(calls === undefined ? {} : { calls }),
		createdAt,
		actor: "meter",
	});
	store.costEvents.push(meterEvent("c1", 7, "2026-08-02T00:00:00.000Z"));
	store.costEvents.push(meterEvent("c2", undefined, "2026-08-03T00:00:00.000Z"));
	store.costEvents.push(meterEvent("c3", 5, "2026-07-30T00:00:00.000Z"));
	store.costEvents.push({ id: "c4", source: "sorftime", amountCny: 2, createdAt: "2026-08-04T00:00:00.000Z", actor: "ops" });
	let sorftime = budgetStatus(store, "2026-08").find((pool) => pool.source === "sorftime");
	assert.equal(sorftime?.callCount, 8);
	assert.equal(sorftime?.spentCny, 6);
	assert.equal(sorftime?.state, "warning");
	assert.equal(sorftime?.callUtilization, 0.8);
	sorftime = budgetStatus(store, "2026-08", { sorftime: 2 }).find((pool) => pool.source === "sorftime");
	assert.equal(sorftime?.callCount, 10);
	assert.equal(sorftime?.spentCny, 7);
	assert.equal(sorftime?.state, "fused");
	assert.equal(budgetStatus(store, "2026-08").find((pool) => pool.source === "manual_csv")?.state, "free");
	configureBudget(store, { source: "sorftime", monthlyLimitCny: 5, monthlyCallLimit: 100 });
	sorftime = budgetStatus(store, "2026-08").find((pool) => pool.source === "sorftime");
	assert.equal(sorftime?.state, "fused");
});

test("configureBudget sets and clears metering fields with validation", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const pool = configureBudget(store, { source: "sorftime", costPerCallCny: 0.8, monthlyCallLimit: 100 });
	assert.equal(pool.costPerCallCny, 0.8);
	assert.equal(pool.monthlyCallLimit, 100);
	const updated = configureBudget(store, { source: "sorftime", note: "备注" });
	assert.equal(updated.costPerCallCny, 0.8);
	assert.equal(updated.monthlyCallLimit, 100);
	const cleared = configureBudget(store, { source: "sorftime", monthlyCallLimit: 0 });
	assert.equal("monthlyCallLimit" in cleared, false);
	assert.throws(() => configureBudget(store, { source: "sorftime", costPerCallCny: -1 }), /costPerCallCny/);
	assert.throws(() => configureBudget(store, { source: "sorftime", costPerCallCny: Number.NaN }), /costPerCallCny/);
	assert.throws(() => configureBudget(store, { source: "sorftime", monthlyCallLimit: 2.5 }), /monthlyCallLimit/);
	// source 带空白归一到既有池，不产生计量/拦截永不命中的幽灵池
	const trimmed = configureBudget(store, { source: " sorftime ", monthlyCallLimit: 50 });
	assert.equal(trimmed.source, "sorftime");
	assert.equal(store.budgetPools.filter((pool) => pool.source.trim() === "sorftime").length, 1);
	assert.throws(() => configureBudget(store, { source: "   " }), /source 不能为空/);
});

test("classifyMcpToolResult 按拒绝名单计费：请求发出去了就算钱（G1）", () => {
	// 成功：direct 与 proxy 两种形态都要归一成同一个样本
	assert.deepEqual(classifyMcpToolResult("sorftime_ProductResearch", ADAPTER_DETAILS.directSuccess), {
		server: "sorftime",
		tool: "ProductResearch",
		billable: true,
	});
	assert.deepEqual(classifyMcpToolResult("mcp", ADAPTER_DETAILS.proxySuccess), {
		server: "sorftime",
		tool: "ProductResearch",
		billable: true,
	});

	// 计费：请求已经发到 Sorftime，点数照扣。call_failed 覆盖 30 秒超时——这恰恰是最贵的一类，
	// 从前按白名单判成不计费，超时越多配额漏得越多，熔断反而永远不触发。
	for (const [name, details] of [
		["directToolError", ADAPTER_DETAILS.directToolError],
		["directCallFailed", ADAPTER_DETAILS.directCallFailed],
		["directAborted", ADAPTER_DETAILS.directAborted],
		["proxyToolError", ADAPTER_DETAILS.proxyToolError],
		["proxyCallFailedTimeout", ADAPTER_DETAILS.proxyCallFailedTimeout],
		["proxyAborted", ADAPTER_DETAILS.proxyAborted],
	] as const) {
		const toolName = "mode" in details ? "mcp" : "sorftime_ProductResearch";
		assert.equal(classifyMcpToolResult(toolName, details)?.billable, true, `${name} 应计费`);
	}
	// 拒绝名单之外的未知取值也计费（宁多勿漏：多计让熔断提前，少计让熔断滞后）
	assert.equal(
		classifyMcpToolResult("mcp", { mode: "call", error: "url_elicitation_required", server: "sorftime", tool: "P" })?.billable,
		true,
	);
	assert.equal(classifyMcpToolResult("mcp", { mode: "call", error: "adapter_2_99_新错误码", server: "sorftime", tool: "P" })?.billable, true);

	// 不计费：这些分支都在 client.callTool 发出请求之前就返回了
	for (const [name, details] of [
		["directServerUnavailable", ADAPTER_DETAILS.directServerUnavailable],
		["proxyAuthRequired", ADAPTER_DETAILS.proxyAuthRequired],
		["proxyConnectFailed", ADAPTER_DETAILS.proxyConnectFailed],
		["proxyServerBackoff", ADAPTER_DETAILS.proxyServerBackoff],
		["proxyServerDisabled", ADAPTER_DETAILS.proxyServerDisabled],
		["proxyApprovalDenied", ADAPTER_DETAILS.proxyApprovalDenied],
		["proxyToolNotFound", ADAPTER_DETAILS.proxyToolNotFound],
	] as const) {
		const toolName = "mode" in details ? "mcp" : "sorftime_ProductResearch";
		assert.equal(classifyMcpToolResult(toolName, details)?.billable, false, `${name} 不该计费`);
	}

	// 与 recordMcpUsage 的池名口径一致，避免 pending 键与落账键分裂
	assert.equal(classifyMcpToolResult("sorftime_ProductResearch", { server: " sorftime ", tool: "P" })?.server, "sorftime");
	// 与 MCP 计量无关的调用
	assert.equal(classifyMcpToolResult("mcp", { mode: "search", server: "sorftime" }), undefined);
	assert.equal(classifyMcpToolResult("mcpScript", { mode: "script" }), undefined);
	assert.equal(classifyMcpToolResult("mcp", { mode: "call" }), undefined);
	assert.equal(classifyMcpToolResult("compass_budget", { server: "sorftime" }), undefined);
	assert.equal(classifyMcpToolResult("read", undefined), undefined);
	assert.equal(classifyMcpToolResult("sorftime_doc", { server: "sorftime", resourceUri: "res://doc" })?.tool, "res://doc");
});

// 审计 G3：direct 工具的失败分支（tool_error / call_failed / aborted）在 details 里**不带 tool**，
// 只有成功分支带（pi-mcp-adapter 2.27.0 的 guardedMcpDetails 只产 mcpResult / outputGuard）。
// 后果不是「钱算错了」——金额与次数只读 calls / amountCny——而是 recordMcpUsage 的
// `server\u0000tool` 合并键把同一批里不同工具的失败撞成一条「unknown × N」，工具维度事后不可恢复。
test("classifyMcpToolResult：direct 失败结果按工具名前缀归因，不落 unknown 桶（G3）", () => {
	for (const [name, details] of [
		["directToolError", ADAPTER_DETAILS.directToolError],
		["directCallFailed", ADAPTER_DETAILS.directCallFailed],
		["directAborted", ADAPTER_DETAILS.directAborted],
		// 不计费的失败同样要归因：tool 与 billable 是正交的两个维度
		["directServerUnavailable", ADAPTER_DETAILS.directServerUnavailable],
	] as const) {
		assert.equal(classifyMcpToolResult("sorftime_ProductResearch", details)?.tool, "ProductResearch", `${name} 应按工具名前缀归因`);
	}
	// 归因只改 tool，不得顺手动了计费判定（拒绝名单仍是唯一口径）
	assert.equal(classifyMcpToolResult("sorftime_ProductResearch", ADAPTER_DETAILS.directServerUnavailable)?.billable, false);
	assert.equal(classifyMcpToolResult("sorftime_ProductResearch", ADAPTER_DETAILS.directToolError)?.billable, true);

	// 回退顺序不许改：details.tool → details.resourceUri → 工具名前缀 → "unknown"
	assert.equal(classifyMcpToolResult("sorftime_doc", { server: "sorftime", tool: "P", resourceUri: "res://doc" })?.tool, "P");
	assert.equal(classifyMcpToolResult("sorftime_doc", { server: "sorftime", resourceUri: "res://doc" })?.tool, "res://doc");

	// 边界：池名自带下划线时按 server 的长度截，不能按第一个下划线切
	assert.equal(classifyMcpToolResult("my_mcp_ProductResearch", { error: "tool_error", server: "my_mcp" })?.tool, "ProductResearch");
	// 边界：工具名恰等于池名——没有前缀可截，不猜
	assert.equal(classifyMcpToolResult("sorftime", { error: "tool_error", server: "sorftime" })?.tool, "unknown");
	// 边界：截完是空串必须回落 "unknown"。载荷缓存没有 recordMcpUsage 的 `|| "unknown"` 兜底，
	// 留下一条 tool:"" 的条目会让 convert 的跳过文案指不出是谁
	assert.equal(classifyMcpToolResult("sorftime_", { error: "tool_error", server: "sorftime" })?.tool, "unknown");
	// 边界：前缀与 details.server 不符（宿主把 toolPrefix 配成 none / short / 自定义）→ 降级回 unknown
	assert.equal(classifyMcpToolResult("other_Tool", { error: "tool_error", server: "sorftime" })?.tool, "unknown");
	// 边界：网关形态的工具名恒为 "mcp"，截不出任何东西（网关的 call 分支本来就带 tool）
	assert.equal(classifyMcpToolResult("mcp", { mode: "call", error: "tool_error", server: "sorftime" })?.tool, "unknown");

	// 后果级：同一批里两个不同工具各失败一次，必须落成两条事件，而不是合并键撞号后的一条「unknown × 2」
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	const first = classifyMcpToolResult("sorftime_category_report", ADAPTER_DETAILS.directCallFailed);
	const second = classifyMcpToolResult("sorftime_keyword_list", ADAPTER_DETAILS.directToolError);
	assert.ok(first && second, "两条 direct 失败都应被识别为 MCP 样本");
	const events = recordMcpUsage(store, [
		{ server: first.server, tool: first.tool, calls: 1 },
		{ server: second.server, tool: second.tool, calls: 1 },
	], "compass-meter");
	assert.deepEqual(events.map((event) => event.tool).sort(), ["category_report", "keyword_list"]);
});

test("evaluateMcpGate blocks only fused metered pools and names the exit path", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	assert.equal(evaluateMcpGate(store, { toolName: "sorftime_ProductResearch" }, { sorftime: 999 }), undefined);
	configureBudget(store, { source: "sorftime", monthlyCallLimit: 5 });
	assert.equal(evaluateMcpGate(store, { toolName: "sorftime_ProductResearch" }, { sorftime: 4 }), undefined);
	const blocked = evaluateMcpGate(store, { toolName: "sorftime_ProductResearch" }, { sorftime: 5 });
	assert.ok(blocked);
	assert.equal(blocked.server, "sorftime");
	assert.match(blocked.reason, /本月 5 次 \/ 限 5 次/);
	assert.match(blocked.reason, /monthly_call_limit/);
	// 审计 G8：熔断文案必须写明重置时刻，不能只说「次月自动恢复」而不定义时区
	assert.match(blocked.reason, /UTC 次月自动恢复（北京时间次月 1 日 08:00 清零）/);
	assert.ok(evaluateMcpGate(store, { toolName: "mcp", input: { server: "sorftime", tool: "X" } }, { sorftime: 5 }));
	assert.ok(evaluateMcpGate(store, { toolName: "mcp", input: { tool: "sorftime_ProductResearch" } }, { sorftime: 5 }));
	assert.ok(evaluateMcpGate(store, { toolName: "mcpScript", input: { code: "await tools.sorftime_ProductResearch({})" } }, { sorftime: 5 }));
	// 脚本同时含多个池名：任一熔断即拦截，不受池序 first-match 影响
	const multi = evaluateMcpGate(store, { toolName: "mcpScript", input: { code: "// sellersprite baseline\nawait tools.sorftime_ProductResearch({})" } }, { sorftime: 5 });
	assert.equal(multi?.server, "sorftime");
	assert.equal(evaluateMcpGate(store, { toolName: "mcp", input: { tool: "keepa_product" } }, { sorftime: 5 }), undefined);
	assert.equal(evaluateMcpGate(store, { toolName: "read", input: {} }, { sorftime: 5 }), undefined);
});

test("evaluateMcpGate：池被禁用时无条件拦截，不看上限也不看 fused（G4）", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	// 默认 sorftime 池：启用中、没配上限 → 放行
	assert.equal(evaluateMcpGate(store, { toolName: "sorftime_ProductResearch" }, { sorftime: 0 }), undefined);

	// 禁用后必须拦——「禁用」在手册里的定义就是「当前不允许使用」，recordCost 也拒绝禁用池，
	// 拦截面要同口径。从前 enabled 的判断排在 `state !== "fused"` 之后，于是「禁用但没熔断」
	// 的池整个漏过去了，同事可以照常烧 Sorftime 次数。
	configureBudget(store, { source: "sorftime", enabled: false });
	const blocked = evaluateMcpGate(store, { toolName: "sorftime_ProductResearch" }, { sorftime: 0 });
	assert.ok(blocked, "禁用池必须拦截");
	assert.equal(blocked.server, "sorftime");
	assert.match(blocked.reason, /已禁用/);
	// 拦截理由要给出可照做的恢复路径
	assert.match(blocked.reason, /compass_budget configure source=sorftime enabled=true/);

	// 三种调用形态都要覆盖到，不能只拦直连工具
	assert.ok(evaluateMcpGate(store, { toolName: "mcp", input: { server: "sorftime", tool: "X" } }, { sorftime: 0 }));
	assert.ok(evaluateMcpGate(store, { toolName: "mcpScript", input: { code: "await tools.sorftime_ProductResearch({})" } }, { sorftime: 0 }));

	// 重新启用后恢复放行
	configureBudget(store, { source: "sorftime", enabled: true });
	assert.equal(evaluateMcpGate(store, { toolName: "sorftime_ProductResearch" }, { sorftime: 0 }), undefined);
});

test("evaluateMcpGate：禁用优先于熔断，理由说的是禁用而不是次数用尽（G4）", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	configureBudget(store, { source: "sorftime", monthlyCallLimit: 5, enabled: false });
	const blocked = evaluateMcpGate(store, { toolName: "sorftime_ProductResearch" }, { sorftime: 99 });
	assert.ok(blocked);
	// 两个条件同时成立时，运营看到的应该是「你自己关掉了」而不是「配额用完了」——
	// 后者会把人引去抬额度，而正确动作是重新启用。
	assert.match(blocked.reason, /已禁用/);
	assert.doesNotMatch(blocked.reason, /monthly_call_limit/);
});

// 审计 G5：熔断后连「列出这个源有哪些工具」都被拦。列工具 / describe / search / instructions /
// connect / auth-* 都不向服务端发 tools/call，因而不花钱——计量侧早就是同一条界线
// （classifyMcpToolResult 对 mode !== "call" 返回 undefined），熔断门必须与它对齐。
test("evaluateMcpGate：熔断只拦真调用，不发请求的网关形态放行（G5）", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	configureBudget(store, { source: "sorftime", monthlyCallLimit: 5 });
	const fused = { sorftime: 5 };
	// 前提：这个池确实已经熔断（下面的放行不能是「压根没熔断」造成的假绿）
	assert.ok(evaluateMcpGate(store, { toolName: "sorftime_ProductResearch" }, fused), "前提不成立：池没有熔断");

	// 放行侧：白名单里的非调用形态
	for (const [name, input] of [
		["列工具", { server: "sorftime" }],
		["describe", { server: "sorftime", describe: "sorftime_ProductResearch" }],
		["search", { server: "sorftime", search: "keyword" }],
		["search 带修饰参数", { server: "sorftime", search: "keyword", regex: true, includeSchemas: false, limit: 5, offset: 0 }],
		["instructions", { server: "sorftime", instructions: "sorftime" }],
		["connect", { server: "sorftime", connect: "sorftime" }],
		["auth-start", { server: "sorftime", action: "auth-start" }],
		["auth-complete", { server: "sorftime", action: "auth-complete" }],
		["ui-messages", { server: "sorftime", action: "ui-messages" }],
	] as const) {
		assert.equal(evaluateMcpGate(store, { toolName: "mcp", input }, fused), undefined, `${name} 不发请求、不花钱，熔断后应放行`);
	}

	// 反向对照：真调用在熔断后照样拦。这几条不是缺陷，是护栏——放宽豁免时它们必须先红
	for (const [name, call] of [
		["网关规范形态", { toolName: "mcp", input: { server: "sorftime", tool: "ProductResearch" } }],
		["网关不带 server", { toolName: "mcp", input: { tool: "sorftime_ProductResearch" } }],
		["直连工具", { toolName: "sorftime_ProductResearch" }],
		["mcpScript", { toolName: "mcpScript", input: { code: "await tools.sorftime_ProductResearch({})" } }],
		// 判据是白名单：名单外的一切一律当调用照拦。「参数套进 args 里」的兼容形态会被宿主
		// 展开后真发请求；action 的未知取值与未来新增的键同理——判不准就拦，代价只是少放行
		// 一次免费请求，而放错要花真钱
		["参数套进 args", { toolName: "mcp", input: { server: "sorftime", args: { keyword: "x" } } }],
		["action 取值不在名单里", { toolName: "mcp", input: { server: "sorftime", action: "adapter_2_99_新动作" } }],
		["名单外的新键", { toolName: "mcp", input: { server: "sorftime", newGatewayKey: 1 } }],
	] as const) {
		assert.ok(evaluateMcpGate(store, call, fused), `${name} 是（或可能是）真调用，熔断后必须拦`);
	}

	// 豁免只覆盖熔断，不覆盖禁用：`enabled=false` 的语义是「当前不允许使用这个源」，与花不花钱无关，
	// 三处同口径（recordCost / compass_data_route / evaluateMcpGate）
	configureBudget(store, { source: "sorftime", enabled: false });
	const disabled = evaluateMcpGate(store, { toolName: "mcp", input: { server: "sorftime" } }, { sorftime: 0 });
	assert.ok(disabled, "池被禁用时连列工具都不放行");
	assert.match(disabled.reason, /已禁用/);
});

// 审计 N-AUD-4：网关参数被套进 `args` 里的兼容形态。pi-mcp-adapter 2.27.0 会把它们展开成真调用
// （index.ts:912-931 的展开条件 + :994 的 `if (dispatchParams.tool)` → executeCall），返回的
// details.mode === "call" 事后照常计费；而归池此前只看**顶层** server / tool，解析成空数组，于是
// 熔断门 / 补数确认单预扣 / 在途预占三处共用的第一句 `if (!servers.length) return undefined`
// 把它整体放行——钱花了、门没拦。归池口径必须与 adapter 的「展开 + 分派」逐条对齐：
// 只有会落到 executeCall 的形态才归池，其余一律保持今天的行为（宁可少归也不误归）。
test("mcpCallTargetServers：顶层既无 server 也无 tool、网关参数全套进 args 时仍要归池，三道门不得整体绕过（N-AUD-4）", () => {
	const store = createEmptyStore();
	ensureDefaults(store, "tester");
	configureBudget(store, { source: "sorftime", monthlyCallLimit: 5 });
	const fused = { sorftime: 5 };
	// 前提：这个池确实已经熔断（下面「必须拦」的断言不能是「压根没熔断」造成的假绿）
	assert.ok(evaluateMcpGate(store, { toolName: "sorftime_ProductResearch" }, fused), "前提不成立：池没有熔断");

	// ①② 宿主会展开成 executeCall 的形态：必须归到该池，且熔断后真被拦
	const expandedToCall: Array<[string, Record<string, unknown>]> = [
		["对象形态", { args: { tool: "sorftime_ProductResearch" } }],
		["对象形态带实参", { args: { tool: "sorftime_ProductResearch", args: { keyword: "x" } } }],
		// 内层 server 就是 executeCall 的 serverOverride：内层 tool 可以完全没有池前缀，
		// 只看 tool 前缀会漏掉这一形态
		["内层 server 定归属、内层 tool 无前缀", { args: { server: "sorftime", tool: "ProductResearch" } }],
		// ② args 是 JSON 字符串：adapter 的 parseArgs 先 JSON.parse 再照常展开
		["顶层 args 是 JSON 字符串", { args: '{"tool":"sorftime_ProductResearch","args":{"keyword":"x"}}' }],
		["内层 args 是 JSON 字符串", { args: { tool: "sorftime_ProductResearch", args: '{"keyword":"x"}' } }],
		// action 的**未知**取值不短路 tool：adapter 那三个 === 全不命中，直落 tool 分支。
		// 写成「内层有 action 就当不是调用」会漏掉这条真付费形态（漏拦方向，最危险）
		["action 是未知取值", { args: { tool: "sorftime_ProductResearch", action: "adapter_2_99_新动作" } }],
		// limit / offset / regex / includeSchemas 不在 adapter 的 hasGatewayMode 七键里，
		// 顶层带着它们照样展开
		["顶层带 limit 仍会展开", { limit: 5, args: { tool: "sorftime_ProductResearch" } }],
		// 内层 server 是**空串**时 serverOverride 落空，adapter 回退到工具名前缀档、照样发请求。
		// 这条钉住 `typeof server === "string" && server` 里的真值那一半：删掉它会 return ""，
		// 归成一个不存在的池 ⇒ evaluateMcpGate 的 budgets.find 找不到 ⇒ 真调用被放行（漏拦真钱）
		["内层 server 是空串、靠 tool 前缀归池", { args: { server: "", tool: "sorftime_ProductResearch" } }],
		// adapter 的 findToolByName（tool-metadata.ts:158-159）把传入名与元数据名**两侧**都
		// `replace(/-/g, "_")` 后全等比对，所以短横线写法打向同一个服务端工具、一样花钱。
		// 归池只认下划线的话，这两条与 N-AUD-4 同因同后果：三门全绕
		["顶层 tool 用短横线", { tool: "sorftime-ProductResearch" }],
		["内层 tool 用短横线", { args: { tool: "sorftime-ProductResearch", args: { keyword: "x" } } }],
	];
	for (const [name, input] of expandedToCall) {
		assert.deepEqual(mcpCallTargetServers(store, { toolName: "mcp", input }), ["sorftime"], `${name}：宿主会展开成真调用，必须归到 sorftime 池`);
		assert.ok(evaluateMcpGate(store, { toolName: "mcp", input }, fused), `${name}：是真调用，熔断后必须拦`);
	}

	// ③ 反向对照·不得误归。这些形态要么 adapter 根本不展开、要么展开后落到不发请求的分支、
	// 要么直接 throw——归了池就一定被熔断拦掉一个免费请求：`args` 被刻意排除在 G5 的
	// MCP_NON_CALL_GATEWAY_KEYS 之外，嵌套侧一旦归池，没有任何东西替它放行
	const notCalls: Array<[string, Record<string, unknown>]> = [
		// adapter 展开只做一次，没有循环：内层只有 args 键 ⇒ 抛「Gateway params were nested inside args」
		["双层嵌套", { args: { args: { tool: "sorftime_ProductResearch" } } }],
		["内层没有任何网关键", { args: {} }],
		["顶层 args 是空串", { args: "" }],
		["顶层 args 不是 JSON", { args: "not json" }],
		["顶层 args 是数组", { args: [{ tool: "sorftime_ProductResearch" }] }],
		// JSON.parse("null") 回 null 而 `typeof null === "object"`：少了 `!parsed` 这道判断
		// 就会拿 null 当内层对象往下走并抛 TypeError，被 tool_call 钩子最外层的 catch 静默吞掉，
		// 三道门整体放行——正是 N-AUD-4 本身的故障形状
		["顶层 args 是 JSON null 串", { args: "null" }],
		// validateNestedGatewayParams：七个网关键必须是字符串，否则 adapter 抛错、请求发不出去
		["内层 tool 不是字符串", { args: { tool: 123 } }],
		// 内层 server 也必须是字符串。这条形态的内层 tool 前缀本来命中得了 sorftime——
		// 只有类型镜像挡得住它，删掉那道判断就会误归一个 adapter 当场抛错的形态
		["内层 server 不是字符串", { args: { server: 123, tool: "sorftime_ProductResearch" } }],
		// `if (dispatchParams.tool)` 是**真值**判定：空串一路滑到 executeStatus，不发请求
		["内层 tool 是空串", { args: { tool: "" } }],
		// 带内层 server 时空串 tool 才钉得住真值判定：不带 server 的空串会被工具名前缀匹配
		// 顺手挡掉，那条挡的是别的东西。adapter 这时落 executeList，不发请求
		["内层 tool 是空串但带内层 server", { args: { server: "sorftime", tool: "" } }],
		// 展开后落到不发请求的分支（describe / search / connect / instructions / 列工具）
		["内层 describe", { args: { describe: "sorftime_ProductResearch" } }],
		["内层 search", { args: { search: "keyword" } }],
		["内层 search 带 server", { args: { search: "keyword", server: "sorftime" } }],
		["内层 connect", { args: { connect: "sorftime" } }],
		["内层 instructions", { args: { instructions: "sorftime" } }],
		["内层只有 server（列工具）", { args: { server: "sorftime" } }],
		// 这三个 action 的分派**排在** `if (dispatchParams.tool)` 之前，带着 tool 也到不了 executeCall
		["内层 action=ui-messages 且带 tool", { args: { action: "ui-messages", tool: "sorftime_ProductResearch" } }],
		["内层 action=auth-start 且带 tool", { args: { action: "auth-start", server: "sorftime", tool: "sorftime_ProductResearch" } }],
		["内层 action=auth-complete 且带 tool", { args: { action: "auth-complete", server: "sorftime", tool: "sorftime_ProductResearch" } }],
		// hasGatewayMode 的判据是 `!== undefined` 而不是真值：顶层出现空串照样算「已进网关模式」，
		// adapter 不展开 args，最终落 executeStatus。按真值判断的实现会在这里误归并误拦
		["顶层 server 是空串", { server: "", args: { tool: "sorftime_ProductResearch" } }],
		["顶层 tool 是空串", { tool: "", args: { tool: "sorftime_ProductResearch" } }],
		["顶层 describe 是空串", { describe: "", args: { tool: "sorftime_ProductResearch" } }],
		// 不存在的池：与顶层 `{tool:"keepa_product"}` 遇到未建池时同口径，不得误归到任何池
		["内层 tool 不属于任何池", { args: { tool: "nosuchpool_x" } }],
	];
	for (const [name, input] of notCalls) {
		assert.deepEqual(mcpCallTargetServers(store, { toolName: "mcp", input }), [], `${name}：不会向服务端发 tools/call，不得归池`);
		assert.equal(evaluateMcpGate(store, { toolName: "mcp", input }, fused), undefined, `${name}：熔断后仍须放行，否则免费请求也被拦`);
	}

	// ③ 反向对照·别的池不得被 sorftime 的熔断牵连；内层 server 指向未建池时与顶层同口径原样返回
	assert.deepEqual(mcpCallTargetServers(store, { toolName: "mcp", input: { args: { tool: "keepa_product" } } }), ["keepa"]);
	assert.equal(evaluateMcpGate(store, { toolName: "mcp", input: { args: { tool: "keepa_product" } } }, fused), undefined, "keepa 没有熔断，不该被 sorftime 的熔断牵连");
	assert.deepEqual(mcpCallTargetServers(store, { toolName: "mcp", input: { args: { server: "nosuchpool", tool: "x" } } }), ["nosuchpool"]);
	assert.equal(evaluateMcpGate(store, { toolName: "mcp", input: { args: { server: "nosuchpool", tool: "x" } } }, fused), undefined, "不是预算池就没有可熔断的东西");

	// ④ 反向对照·顶层既有形态逐字不变。嵌套解析只在顶层两条路径都落空之后才跑，
	// 既有 17 处 evaluateMcpGate 调用与 G5 白名单都不许被带偏
	assert.deepEqual(mcpCallTargetServers(store, { toolName: "mcp", input: { server: "sorftime", tool: "ProductResearch" } }), ["sorftime"]);
	assert.deepEqual(mcpCallTargetServers(store, { toolName: "mcp", input: { tool: "sorftime_ProductResearch" } }), ["sorftime"]);
	// 顶层 server 优先且不展开：args 里写的是别的池也归顶层那个
	assert.deepEqual(mcpCallTargetServers(store, { toolName: "mcp", input: { server: "sorftime", args: { tool: "keepa_product" } } }), ["sorftime"]);
	assert.deepEqual(mcpCallTargetServers(store, { toolName: "sorftime_ProductResearch" }), ["sorftime"]);
	assert.deepEqual(mcpCallTargetServers(store, { toolName: "mcpScript", input: { code: "await tools.sorftime_ProductResearch({})" } }), ["sorftime"]);
	assert.deepEqual(mcpCallTargetServers(store, { toolName: "read", input: {} }), []);
	assert.ok(evaluateMcpGate(store, { toolName: "mcp", input: { server: "sorftime", tool: "ProductResearch" } }, fused), "顶层规范形态仍须被拦");
	assert.ok(evaluateMcpGate(store, { toolName: "mcp", input: { server: "sorftime", args: { tool: "keepa_product" } } }, fused), "顶层带 server 的既有形态仍须被拦");
	// G5 的放行白名单不受影响：顶层「列工具」照旧放行
	assert.equal(evaluateMcpGate(store, { toolName: "mcp", input: { server: "sorftime" } }, fused), undefined, "顶层列工具不发请求，熔断后仍放行");
});

test("non-finite monthlyLimitCny is rejected before it can poison the store", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-limit-nan-"));
	try {
		const repo = new CompassRepository(root);
		await assert.rejects(
			repo.update((store) => {
				store.budgetPools.push({ source: "x", tier: "A", monthlyLimitCny: Number.NaN, enabled: true });
			}),
			/budgetPools\[0\]/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("budgetStatus output is identical across a store round-trip (spec 7.2)", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-status-roundtrip-"));
	try {
		const repo = new CompassRepository(root);
		const { store } = await repo.update((data) => {
			ensureDefaults(data, "tester");
			configureBudget(data, { source: "sorftime", costPerCallCny: 0.5, monthlyCallLimit: 100 });
			recordMcpUsage(data, [{ server: "sorftime", tool: "ProductResearch", calls: 3 }], "compass-meter");
		});
		const month = store.costEvents[0].createdAt.slice(0, 7);
		const before = budgetStatus(store, month);
		const after = budgetStatus(await repo.load(), month);
		assert.deepEqual(after, before);
		const sorftime = after.find((pool) => pool.source === "sorftime");
		assert.equal(sorftime?.callCount, 3);
		assert.equal(sorftime?.spentCny, 1.5);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// —— 审计 G8 回归 ——
// 并新增一行：import { budgetData, overviewData } from "../web/data.ts";

// —— 审计 G8 回归 ——
// 预算「本月」= UTC 月：budgetStatus / 熔断拦截 / 待办 / Web 总览 / Web 预算页五个面必须同刻翻月。
// 故意把进程时区设成 UTC+8 再冻结时钟——任何一处改用本地时间（getMonth / 本地日拼月）
// 都会在 07:59 与 08:00 这对时刻上露馅。已实测：把月前缀换成本地日历后本用例必红
// （callCount 2→1、month "2026-08"→"2026-09"、熔断被误解除）。
test("预算「本月」按 UTC 月结算，北京时间 1 日 08:00 整才翻月（审计 G8）", () => {
	const originalTz = process.env.TZ;
	process.env.TZ = "Asia/Shanghai";
	try {
		const meter = (id: string, createdAt: string): CostEvent => ({
			id, source: "sorftime", amountCny: 1, kind: "mcp_call", tool: "T", calls: 1, createdAt, actor: "meter",
		});
		const build = (): CompassStore => {
			const store = createEmptyStore("2026-08-01T00:00:00.000Z");
			ensureDefaults(store, "tester");
			configureBudget(store, { source: "sorftime", costPerCallCny: 1, monthlyCallLimit: 2 });
			// 三条计量事件都落在北京时间 2026-09-01 当天，但分属 UTC 的 8 月与 9 月
			store.costEvents.push(meter("c-aug-1", "2026-08-31T23:59:00.000Z")); // 北京 09-01 07:59
			store.costEvents.push(meter("c-aug-2", "2026-08-31T23:59:30.000Z")); // 北京 09-01 07:59
			store.costEvents.push(meter("c-sep-1", "2026-09-01T00:01:00.000Z")); // 北京 09-01 08:01
			return store;
		};

		// 北京 09-01 07:59：本地日历已翻月，UTC 仍是 8 月 → 8 月两次调用打满配额并熔断
		mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-31T23:59:59.000Z") });
		assert.equal(new Date().getHours(), 7, "夹具前提：本地时区必须是 UTC+8");
		assert.equal(new Date().getDate(), 1, "夹具前提：本地日历已翻到 9 月 1 日");
		let store = build();
		let pool = budgetStatus(store).find((item) => item.source === "sorftime");
		assert.equal(pool?.callCount, 2, "07:59 仍按 UTC 8 月统计");
		assert.equal(pool?.state, "fused");
		assert.equal(budgetData(store).month, "2026-08");
		assert.deepEqual(budgetData(store).events.map((event) => event.id), ["c-aug-2", "c-aug-1"]);
		assert.equal(overviewData(store).budgetMonth, "2026-08");
		assert.equal(overviewData(store).kpi.fusedPools, 1);
		assert.ok(listWorkbenchTodos(store).some((todo) => todo.kind === "budget_fused"));
		assert.ok(evaluateMcpGate(store, { toolName: "sorftime_ProductResearch" }), "熔断期间必须拦截");

		// 北京 09-01 08:00 整 = UTC 9 月初：额度立刻清零、熔断解除，五个面同刻翻月
		mock.timers.setTime(Date.parse("2026-09-01T00:00:00.000Z"));
		assert.equal(new Date().getHours(), 8, "夹具前提：UTC 月初正是北京时间 1 日 08:00");
		store = build();
		pool = budgetStatus(store).find((item) => item.source === "sorftime");
		assert.equal(pool?.callCount, 1, "翻月后只剩 UTC 9 月那一次");
		assert.equal(pool?.state, "ok");
		assert.equal(budgetData(store).month, "2026-09");
		assert.deepEqual(budgetData(store).events.map((event) => event.id), ["c-sep-1"]);
		assert.equal(overviewData(store).budgetMonth, "2026-09");
		assert.equal(overviewData(store).kpi.fusedPools, 0);
		assert.deepEqual(listWorkbenchTodos(store).filter((todo) => todo.kind.startsWith("budget_")), []);
		assert.equal(evaluateMcpGate(store, { toolName: "sorftime_ProductResearch" }), undefined, "翻月后必须放行");
	} finally {
		mock.timers.reset();
		if (originalTz === undefined) delete process.env.TZ;
		else process.env.TZ = originalTz;
	}
});

test("超大返回的三档形态照常计费：计费只看 error，不看载荷被搬到哪里（G1）", () => {
	// 二期的载荷缓存要从 mcpResult / outputGuard 里取值，这里先钉住计量侧不受影响：
	// 摘要与溢写都是 adapter 在 callTool **成功返回之后**做的搬运，钱早就花了。
	for (const [name, details] of [
		["inlineResult", ADAPTER_DETAILS.proxySuccessInlineResult],
		["summarizedResult", ADAPTER_DETAILS.proxySuccessSummarizedResult],
		["truncatedOutput", ADAPTER_DETAILS.proxySuccessTruncatedOutput],
	] as const) {
		const sample = classifyMcpToolResult("mcp", details);
		assert.equal(sample?.billable, true, `${name} 应计费`);
		assert.equal(sample?.server, "sorftime", `${name} 的池名要归一到 sorftime`);
		assert.equal(sample?.tool, details.tool, `${name} 的工具名要取 details.tool`);
	}
});

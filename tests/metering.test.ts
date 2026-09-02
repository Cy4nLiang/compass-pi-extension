import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { DEFAULT_BUDGET_POOLS } from "../defaults.ts";
import { budgetStatus, classifyMcpToolResult, configureBudget, ensureDefaults, evaluateMcpGate, listWorkbenchTodos, recordMcpUsage } from "../service.ts";
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

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_BUDGET_POOLS } from "../defaults.ts";
import { budgetStatus, classifyMcpToolResult, configureBudget, ensureDefaults, evaluateMcpGate, recordMcpUsage } from "../service.ts";
import { CompassRepository, createEmptyStore } from "../store.ts";
import type { CostEvent } from "../types.ts";

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

test("classifyMcpToolResult applies the reached-the-server billing whitelist", () => {
	assert.deepEqual(
		classifyMcpToolResult("sorftime_ProductResearch", { server: "sorftime", tool: "ProductResearch" }),
		{ server: "sorftime", tool: "ProductResearch", billable: true },
	);
	assert.equal(classifyMcpToolResult("sorftime_ProductResearch", { server: "sorftime", error: "tool_error" })?.billable, true);
	assert.deepEqual(
		classifyMcpToolResult("mcp", { mode: "call", server: "sorftime", tool: "ProductResearch" }),
		{ server: "sorftime", tool: "ProductResearch", billable: true },
	);
	assert.equal(classifyMcpToolResult("mcp", { mode: "call", error: "auth_required", server: "sorftime", tool: "P" })?.billable, false);
	assert.equal(classifyMcpToolResult("sorftime_ProductResearch", { error: "server_unavailable", server: "sorftime" })?.billable, false);
	assert.equal(classifyMcpToolResult("sorftime_ProductResearch", { server: "sorftime", error: "aborted" })?.billable, false);
	assert.equal(classifyMcpToolResult("sorftime_ProductResearch", { server: " sorftime ", tool: "P" })?.server, "sorftime");
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
	assert.ok(evaluateMcpGate(store, { toolName: "mcp", input: { server: "sorftime", tool: "X" } }, { sorftime: 5 }));
	assert.ok(evaluateMcpGate(store, { toolName: "mcp", input: { tool: "sorftime_ProductResearch" } }, { sorftime: 5 }));
	assert.ok(evaluateMcpGate(store, { toolName: "mcpScript", input: { code: "await tools.sorftime_ProductResearch({})" } }, { sorftime: 5 }));
	// 脚本同时含多个池名：任一熔断即拦截，不受池序 first-match 影响
	const multi = evaluateMcpGate(store, { toolName: "mcpScript", input: { code: "// sellersprite baseline\nawait tools.sorftime_ProductResearch({})" } }, { sorftime: 5 });
	assert.equal(multi?.server, "sorftime");
	assert.equal(evaluateMcpGate(store, { toolName: "mcp", input: { tool: "keepa_product" } }, { sorftime: 5 }), undefined);
	assert.equal(evaluateMcpGate(store, { toolName: "read", input: {} }, { sorftime: 5 }), undefined);
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

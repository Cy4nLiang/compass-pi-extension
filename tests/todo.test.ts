import assert from "node:assert/strict";
import test from "node:test";
import { configureBudget, ensureDefaults, listWorkbenchTodos, recordMcpUsage } from "../service.ts";
import { createEmptyStore } from "../store.ts";
import { deriveTodos, type DeriveTodosInput, type TodoBudgetPool } from "../todo.ts";
import type { Candidate, CandidateStage, CompassStore, MetricMap } from "../types.ts";

const NOW = "2026-08-26T00:00:00.000Z";

function baseStore(): CompassStore {
	return createEmptyStore("2026-08-01T00:00:00.000Z");
}

function addMarket(store: CompassStore, id: string, name: string): void {
	store.markets.push({ id, name, keywords: [], createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" });
}

function addCandidate(store: CompassStore, id: string, marketId: string, stage: CandidateStage, extra: Partial<Candidate> = {}): Candidate {
	const candidate: Candidate = { id, marketId, stage, tags: [], createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", ...extra };
	store.candidates.push(candidate);
	return candidate;
}

function addSnapshot(store: CompassStore, id: string, marketId: string, capturedAt: string, metrics: MetricMap = {}, source = "sellersprite"): void {
	store.snapshots.push({ id, marketId, source, capturedAt, importedAt: capturedAt, rowCount: 0, listings: [], keywords: [], metrics, warnings: [] });
}

function derive(store: CompassStore, overrides: Partial<DeriveTodosInput> = {}) {
	return deriveTodos({ store, budgets: [], retroDue: [], deepResearchMetrics: [], divergentMarkets: [], now: NOW, ...overrides });
}

test("empty store yields no todos", () => {
	assert.deepEqual(derive(baseStore()), []);
});

test("budget pools map to fused P1 and warning P4 todos", () => {
	const budgets: TodoBudgetPool[] = [
		{ source: "sorftime", state: "fused", spentCny: 10, monthlyLimitCny: 0, callCount: 200, monthlyCallLimit: 200 },
		{ source: "keepa", state: "warning", spentCny: 350, monthlyLimitCny: 400, callCount: 0 },
		{ source: "sp_api", state: "free", spentCny: 0, monthlyLimitCny: 0, callCount: 0 },
		{ source: "sellersprite", state: "ok", spentCny: 10, monthlyLimitCny: 500, callCount: 0 },
	];
	const todos = derive(baseStore(), { budgets });
	assert.equal(todos.length, 2);
	assert.equal(todos[0].kind, "budget_fused");
	assert.equal(todos[0].priority, 1);
	assert.equal(todos[0].source, "sorftime");
	assert.match(todos[0].reason, /200\/200 次/);
	assert.equal(todos[1].kind, "budget_warning");
	assert.equal(todos[1].priority, 4);
});

test("challenged retro without follow-up surfaces as P1 and clears after action", () => {
	const store = baseStore();
	addMarket(store, "m1", "market one");
	const candidate = addCandidate(store, "cand1", "m1", "testing", { updatedAt: "2026-08-10T00:00:00.000Z" });
	store.outcomeChecks.push({
		id: "chk1",
		marketId: "m1",
		candidateId: "cand1",
		baselineSnapshotId: "s0",
		evidenceSnapshotId: "s1",
		deltas: [],
		verdict: "challenged",
		verdictReason: "qrd 显著恶化",
		elapsedDays: 30,
		createdAt: "2026-08-15T00:00:00.000Z",
		actor: "t",
	});
	let todos = derive(store);
	assert.equal(todos.length, 1);
	assert.equal(todos[0].kind, "retro_challenged");
	assert.equal(todos[0].priority, 1);
	assert.equal(todos[0].marketName, "market one");
	assert.equal(todos[0].candidateId, candidate.id);
	const log = (id: string, type: "strategy" | "decision" | "import", createdAt: string) => ({
		id, marketId: "m1", type, conclusion: "c", reason: "r", actor: "t", createdAt,
	});
	// 例行 CSV 导入（type=import）不是处置动作 → 待办保留
	store.decisionLog.push(log("d1", "import", "2026-08-16T00:00:00.000Z"));
	assert.equal(derive(store).filter((todo) => todo.kind === "retro_challenged").length, 1);
	// 最终决策留痕（decideCandidate 写入 type=decision）→ 视为已处置
	store.decisionLog.push(log("d2", "decision", "2026-08-17T00:00:00.000Z"));
	assert.equal(derive(store).filter((todo) => todo.kind === "retro_challenged").length, 0);
	// 更晚的 validated 复盘覆盖 challenged → 不再是最新结论，同样消失
	store.decisionLog.length = 0;
	store.outcomeChecks.push({ ...store.outcomeChecks[0], id: "chk2", verdict: "validated", verdictReason: "ok", createdAt: "2026-08-17T00:00:00.000Z" });
	assert.equal(derive(store).filter((todo) => todo.kind === "retro_challenged").length, 0);
});

test("gate review todos exclude archived and retro-stage candidates", () => {
	const store = baseStore();
	addMarket(store, "m1", "alpha");
	addMarket(store, "m2", "beta");
	addMarket(store, "m3", "gamma");
	addCandidate(store, "c1", "m1", "screen", { gateOutcome: "review", gateReason: "缺 cr3 数据" });
	addCandidate(store, "c2", "m2", "archived", { gateOutcome: "review" });
	addCandidate(store, "c3", "m3", "review", { gateOutcome: "review" });
	const gate = derive(store).filter((todo) => todo.kind === "gate_review");
	assert.equal(gate.length, 1);
	assert.equal(gate[0].candidateId, "c1");
	assert.equal(gate[0].priority, 2);
	assert.equal(gate[0].reason, "缺 cr3 数据");
});

test("decision-stage candidates without a decision surface as P2", () => {
	const store = baseStore();
	addMarket(store, "m1", "alpha");
	addMarket(store, "m2", "beta");
	addCandidate(store, "c1", "m1", "decision");
	addCandidate(store, "c2", "m2", "decision", { decisionStatus: "go" });
	const pending = derive(store).filter((todo) => todo.kind === "decision_pending");
	assert.equal(pending.length, 1);
	assert.equal(pending[0].candidateId, "c1");
	assert.match(pending[0].suggestedAction, /compass_pool decide/);
});

test("deep research candidates missing hard metrics surface as P3", () => {
	const store = baseStore();
	addMarket(store, "m1", "alpha");
	addCandidate(store, "c1", "m1", "deep_research");
	let todos = derive(store, { deepResearchMetrics: [{ marketId: "m1", metrics: {} }] });
	const item = todos.find((todo) => todo.kind === "deep_missing_data");
	assert.ok(item);
	assert.equal(item.priority, 3);
	assert.match(item.reason, /主词CPC/);
	const full: MetricMap = Object.fromEntries(
		["main_cpc", "gross_margin", "cpc_ratio", "waist_rating_median"].map((name) => [name, { value: 1, source: "t", capturedAt: NOW, confidence: 0.8 }]),
	);
	todos = derive(store, { deepResearchMetrics: [{ marketId: "m1", metrics: full }] });
	assert.equal(todos.filter((todo) => todo.kind === "deep_missing_data").length, 0);
});

test("risk checklist gaps surface for risk/decision stages only", () => {
	const store = baseStore();
	addMarket(store, "m1", "alpha");
	addCandidate(store, "c1", "m1", "risk");
	assert.equal(derive(store).find((todo) => todo.kind === "risk_missing")?.reason, "风险清单未做");
	store.riskRecords.push({
		id: "r1", marketId: "m1", certStatus: "pass", ipRiskLevel: "pass", seasonFlag: "clear",
		policyFlag: "clear", logisticsRisk: "pass", overall: "review", evidence: [],
		createdAt: "2026-08-10T00:00:00.000Z", actor: "t",
	});
	assert.match(derive(store).find((todo) => todo.kind === "risk_missing")?.reason ?? "", /review/);
	store.riskRecords.push({
		id: "r2", marketId: "m1", certStatus: "pass", ipRiskLevel: "pass", seasonFlag: "clear",
		policyFlag: "clear", logisticsRisk: "pass", overall: "pass",
		evidence: [{ category: "cert", url: "https://example.gov/doc", checkedAt: NOW }],
		createdAt: "2026-08-11T00:00:00.000Z", actor: "t",
	});
	assert.equal(derive(store).filter((todo) => todo.kind === "risk_missing").length, 0);
	// 粗筛阶段不要求风险清单
	const early = baseStore();
	addMarket(early, "m2", "beta");
	addCandidate(early, "c2", "m2", "screen");
	assert.equal(derive(early).filter((todo) => todo.kind === "risk_missing").length, 0);
});

test("retro due items map to P4 and escalate only past 30 overdue days", () => {
	const store = baseStore();
	addMarket(store, "m1", "alpha");
	const item = (overdueDays: number) => ({
		group: "go" as const,
		marketId: "m1",
		candidateId: "c1",
		marketName: "alpha",
		dueAt: "2026-07-01T00:00:00.000Z",
		overdueDays,
		reason: "go 品 30 天里程碑",
		suggestedAction: "录入实绩",
	});
	assert.equal(derive(store, { retroDue: [item(10)] })[0].priority, 4);
	assert.equal(derive(store, { retroDue: [item(30)] })[0].priority, 4);
	const escalated = derive(store, { retroDue: [item(31)] })[0];
	assert.equal(escalated.priority, 3);
	assert.equal(escalated.basePriority, 4);
	assert.equal(escalated.dueAt, "2026-07-01T00:00:00.000Z");
	// 升级只走 1 级：极端逾期仍为 P3（P1 封顶钳位经公开 API 不可达，此为间接覆盖）
	assert.equal(derive(store, { retroDue: [item(1000)] })[0].priority, 3);
});

test("stale snapshots and quiet leads surface as P5", () => {
	const store = baseStore();
	addMarket(store, "m1", "alpha");
	addMarket(store, "m2", "beta");
	addMarket(store, "m3", "gamma");
	addMarket(store, "m4", "delta");
	addCandidate(store, "c1", "m1", "screen");
	addSnapshot(store, "s1", "m1", "2026-07-01T00:00:00.000Z");
	addCandidate(store, "c2", "m2", "screen");
	addSnapshot(store, "s2", "m2", "2026-08-20T00:00:00.000Z");
	addCandidate(store, "c3", "m3", "lead", { createdAt: "2026-08-10T00:00:00.000Z" });
	addCandidate(store, "c4", "m4", "lead", { createdAt: "2026-08-25T00:00:00.000Z" });
	const stale = derive(store).filter((todo) => todo.kind === "snapshot_stale");
	assert.equal(stale.length, 2);
	assert.ok(stale.some((todo) => todo.marketId === "m1" && /56 天/.test(todo.reason)));
	assert.ok(stale.some((todo) => todo.marketId === "m3" && /首个/.test(todo.suggestedAction)));
});

test("metric divergence todos only cover active-candidate markets", () => {
	const store = baseStore();
	addMarket(store, "m1", "alpha");
	addMarket(store, "m2", "beta");
	addCandidate(store, "c1", "m1", "screen");
	addCandidate(store, "c2", "m2", "archived");
	const divergentMarkets = [
		{ marketId: "m1", metrics: ["cr3", "amz_share"] },
		{ marketId: "m2", metrics: ["cr3"] },
	];
	const todos = derive(store, { divergentMarkets }).filter((todo) => todo.kind === "metric_divergence");
	assert.equal(todos.length, 1);
	assert.equal(todos[0].marketId, "m1");
	assert.match(todos[0].reason, /cr3、amz_share/);
});

test("archived candidates produce no todos at all", () => {
	const store = baseStore();
	addMarket(store, "m1", "alpha");
	addCandidate(store, "c1", "m1", "archived", { gateOutcome: "review" });
	addSnapshot(store, "s1", "m1", "2026-06-01T00:00:00.000Z");
	assert.deepEqual(derive(store), []);
});

test("todos sort by priority then overdue days and one candidate can carry several kinds", () => {
	const store = baseStore();
	addMarket(store, "m1", "alpha");
	addCandidate(store, "c1", "m1", "screen", { gateOutcome: "review", gateReason: "复核" });
	addSnapshot(store, "s1", "m1", "2026-06-01T00:00:00.000Z");
	const budgets: TodoBudgetPool[] = [{ source: "sorftime", state: "fused", spentCny: 0, monthlyLimitCny: 0, callCount: 5, monthlyCallLimit: 5 }];
	const retroDue = [
		{ group: "review" as const, marketId: "m1", candidateId: "c1", marketName: "alpha", dueAt: "2026-08-20T00:00:00.000Z", overdueDays: 6, reason: "r", suggestedAction: "a" },
		{ group: "go" as const, marketId: "m1", candidateId: "c1", marketName: "alpha", dueAt: "2026-08-10T00:00:00.000Z", overdueDays: 16, reason: "r", suggestedAction: "a" },
	];
	const todos = derive(store, { budgets, retroDue });
	assert.deepEqual(todos.map((todo) => todo.kind), ["budget_fused", "gate_review", "retro_due", "retro_due", "snapshot_stale"]);
	// 同优先级内逾期天数降序
	assert.equal(todos[2].overdueDays, 16);
	assert.equal(todos[3].overdueDays, 6);
	// 同一候选同时出现在多类待办
	assert.equal(todos.filter((todo) => todo.candidateId === "c1").length, 4);
});

test("listWorkbenchTodos wires budgets, retro due, deep metrics, and divergences", () => {
	const store = baseStore();
	ensureDefaults(store, "tester");
	addMarket(store, "m1", "alpha");
	addCandidate(store, "c1", "m1", "deep_research");
	addSnapshot(store, "s1", "m1", "2026-08-20T00:00:00.000Z", {
		category_monthly_sales: { value: 200, source: "sellersprite", capturedAt: NOW, confidence: 0.8 },
	});
	addSnapshot(store, "s2", "m1", "2026-08-19T00:00:00.000Z", {
		category_monthly_sales: { value: 100, source: "sorftime", capturedAt: NOW, confidence: 0.8 },
	}, "sorftime");
	configureBudget(store, { source: "sorftime", monthlyCallLimit: 2 });
	recordMcpUsage(store, [{ server: "sorftime", tool: "CategoryResearch", calls: 2 }], "compass-meter");
	// 固定事件月份，避免依赖真实时钟
	store.costEvents[store.costEvents.length - 1].createdAt = "2026-08-25T00:00:00.000Z";
	const todos = listWorkbenchTodos(store, NOW);
	assert.ok(todos.some((todo) => todo.kind === "budget_fused" && todo.source === "sorftime"));
	assert.ok(todos.some((todo) => todo.kind === "deep_missing_data" && todo.marketId === "m1"));
	assert.ok(todos.some((todo) => todo.kind === "metric_divergence" && todo.marketId === "m1"));
	for (let index = 1; index < todos.length; index++) {
		assert.ok(todos[index - 1].priority <= todos[index].priority);
	}
});

test("a store with all ten todo conditions hits every kind via listWorkbenchTodos (spec §2)", () => {
	const store = baseStore();
	ensureDefaults(store, "tester");
	// budget_fused：sorftime 次数配额打满；budget_warning：keepa 金额到 87.5%
	configureBudget(store, { source: "sorftime", monthlyCallLimit: 1 });
	recordMcpUsage(store, [{ server: "sorftime", tool: "T", calls: 1 }], "compass-meter");
	store.costEvents[store.costEvents.length - 1].createdAt = "2026-08-20T00:00:00.000Z";
	store.costEvents.push({ id: "ce_keepa", source: "keepa", amountCny: 350, createdAt: "2026-08-20T00:00:00.000Z", actor: "ops" });
	// retro_challenged：testing 候选的最新复盘被证伪且无处置留痕
	addMarket(store, "m1", "challenged market");
	addCandidate(store, "c1", "m1", "testing");
	store.outcomeChecks.push({
		id: "chk1", marketId: "m1", candidateId: "c1", baselineSnapshotId: "s0", evidenceSnapshotId: "sx",
		deltas: [], verdict: "challenged", verdictReason: "qrd 恶化", elapsedDays: 30,
		createdAt: "2026-08-15T00:00:00.000Z", actor: "t",
	});
	// gate_review / decision_pending / risk_missing / deep_missing_data
	addMarket(store, "m2", "review market");
	addCandidate(store, "c2", "m2", "screen", { gateOutcome: "review", gateReason: "缺 cr3" });
	addMarket(store, "m3", "decision market");
	addCandidate(store, "c3", "m3", "decision");
	addMarket(store, "m4", "risk market");
	addCandidate(store, "c4", "m4", "risk");
	addMarket(store, "m5", "deep market");
	addCandidate(store, "c5", "m5", "deep_research");
	addSnapshot(store, "s5", "m5", "2026-08-20T00:00:00.000Z");
	// retro_due：review 阶段停留 40 天且无 OutcomeCheck（retro_review_days=30 → 逾期 10 天）
	addMarket(store, "m6", "retro market");
	addCandidate(store, "c6", "m6", "review", { updatedAt: "2026-07-17T00:00:00.000Z" });
	// snapshot_stale / metric_divergence
	addMarket(store, "m7", "stale market");
	addCandidate(store, "c7", "m7", "screen");
	addSnapshot(store, "s7", "m7", "2026-07-01T00:00:00.000Z");
	addMarket(store, "m8", "divergent market");
	addCandidate(store, "c8", "m8", "screen");
	addSnapshot(store, "s8a", "m8", "2026-08-20T00:00:00.000Z", { category_monthly_sales: { value: 200, source: "sellersprite", capturedAt: NOW, confidence: 0.8 } });
	addSnapshot(store, "s8b", "m8", "2026-08-19T00:00:00.000Z", { category_monthly_sales: { value: 100, source: "sorftime", capturedAt: NOW, confidence: 0.8 } }, "sorftime");

	const todos = listWorkbenchTodos(store, NOW);
	const byKind = new Map(todos.map((todo) => [todo.kind, todo]));
	const expected: Array<[string, number]> = [
		["budget_fused", 1],
		["retro_challenged", 1],
		["gate_review", 2],
		["decision_pending", 2],
		["deep_missing_data", 3],
		["risk_missing", 3],
		["retro_due", 4],
		["budget_warning", 4],
		["snapshot_stale", 5],
		["metric_divergence", 5],
	];
	for (const [kind, priority] of expected) {
		const todo = byKind.get(kind as (typeof todos)[number]["kind"]);
		assert.ok(todo, `缺少 ${kind} 待办`);
		assert.equal(todo.priority, priority, `${kind} 优先级应为 P${priority}`);
	}
	const retro = byKind.get("retro_due");
	assert.equal(retro?.marketId, "m6");
	assert.equal(retro?.overdueDays, 10);
	for (let index = 1; index < todos.length; index++) {
		assert.ok(todos[index - 1].priority <= todos[index].priority);
	}
});

test("free-text reasons are flattened to a single line before display surfaces", () => {
	const store = baseStore();
	addMarket(store, "m1", "alpha");
	addCandidate(store, "c1", "m1", "screen", { gateOutcome: "review", gateReason: "第一行\n\t第二行" });
	const todo = derive(store).find((item) => item.kind === "gate_review");
	assert.equal(todo?.reason, "第一行 第二行");
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { estimateProfit, normalizeProfitInput } from "../economics.ts";
import {
	completeTodoResolution,
	ensureDefaults,
	listWorkbenchTodos,
	recordProfitEstimate,
	reopenTodoResolution,
	submitTodoResolution,
	verifyTodoResolution,
} from "../service.ts";
import { CompassRepository, createEmptyStore } from "../store.ts";
import { divergenceWatermarks, stageEntryTimes } from "../todo.ts";
import type { CompassStore, MetricEvidence, MetricMap, TodoResolution, TodoResolutionAttempt } from "../types.ts";

// 待办人工处理闭环的数据层守护：store 校验（五状态硬不变式 / 唯一性 / kind 白名单 / 证据形状）
// 与集合迁移回填。状态机编排的用例在 Task 3 追加到本文件。

const T0 = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-02T00:00:00.000Z";
const WATERMARK = "2026-07-30T00:00:00.000Z";

function attempt(overrides: Partial<TodoResolutionAttempt> = {}): TodoResolutionAttempt {
	return {
		submittedAt: T0,
		submittedBy: "ops",
		note: "已对照三个来源核定基准口径，以 sellersprite 为准",
		evidence: [{ ref: "https://example.com/compare", note: "多源对照表" }],
		...overrides,
	};
}

function passedAttempt(overrides: Partial<TodoResolutionAttempt> = {}): TodoResolutionAttempt {
	return attempt({ verdict: "pass", verdictReason: "口径选择与理由明确", verifiedAt: T1, verifiedBy: "compass-agent", ...overrides });
}

function rejectedAttempt(overrides: Partial<TodoResolutionAttempt> = {}): TodoResolutionAttempt {
	return attempt({ verdict: "reject", verdictReason: "未说明以哪个来源为准", verifiedAt: T1, verifiedBy: "compass-agent", ...overrides });
}

function resolution(overrides: Partial<TodoResolution> = {}): TodoResolution {
	return {
		id: "tdr_default",
		todoId: "todo_metric_divergence_m1",
		kind: "metric_divergence",
		titleSnapshot: "多源指标偏差 >30%",
		status: "submitted",
		attempts: [attempt()],
		reopens: [],
		createdAt: T0,
		updatedAt: T0,
		...overrides,
	};
}

function resolvedResolution(overrides: Partial<TodoResolution> = {}): TodoResolution {
	return resolution({
		status: "resolved",
		attempts: [passedAttempt()],
		resolvedAt: T1,
		resolvedBy: "compass-web",
		basis: { snapshotWatermark: WATERMARK },
		updatedAt: T1,
		...overrides,
	});
}

// 故意构造非法记录：绕过类型约束，验证 assertStore 而不是编译器
function corrupt(overrides: Record<string, unknown>, base: TodoResolution = resolution()): unknown {
	return { ...base, ...overrides };
}

async function withRepo(run: (repo: CompassRepository) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "compass-todo-resolution-"));
	try {
		await run(new CompassRepository(root));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function writeRawStore(repo: CompassRepository, todoResolutions: unknown): Promise<void> {
	const raw = createEmptyStore(T0) as unknown as Record<string, unknown>;
	raw.todoResolutions = todoResolutions;
	await mkdir(dirname(repo.storePath), { recursive: true });
	await writeFile(repo.storePath, JSON.stringify(raw), "utf8");
}

test("createEmptyStore 初始化空的处理记录集合", () => {
	assert.deepEqual(createEmptyStore(T0).todoResolutions, []);
});

test("ensureDefaults 为旧 store 回填 todoResolutions", () => {
	const store = createEmptyStore(T0);
	ensureDefaults(store, "tester");
	delete store.todoResolutions;
	assert.equal(ensureDefaults(store, "tester"), true);
	assert.deepEqual(store.todoResolutions, []);
	// 回填后不应再报「有变更」，否则每次读库都会触发无谓写盘
	assert.equal(ensureDefaults(store, "tester"), false);
});

test("五种处理状态的合法记录通过 store 校验并原样往返", async () => {
	await withRepo(async (repo) => {
		const records: TodoResolution[] = [
			resolution({ id: "tdr_1", todoId: "todo_metric_divergence_m1", marketId: "m1", candidateId: "c1" }),
			resolution({
				id: "tdr_2",
				todoId: "todo_budget_warning_keepa",
				kind: "budget_warning",
				source: "keepa",
				titleSnapshot: "预算 80% 告警：keepa",
				status: "rejected",
				attempts: [attempt(), rejectedAttempt()],
			}),
			resolution({
				id: "tdr_3",
				todoId: "todo_budget_fused_sorftime",
				kind: "budget_fused",
				source: "sorftime",
				titleSnapshot: "预算熔断：sorftime",
				status: "verified",
				attempts: [passedAttempt()],
			}),
			resolvedResolution({
				id: "tdr_4",
				todoId: "todo_deep_missing_data_c2",
				kind: "deep_missing_data",
				marketId: "m2",
				candidateId: "c2",
				titleSnapshot: "深研数据待人工确认",
				basis: { stageEnteredAt: T0 },
			}),
			resolution({
				id: "tdr_5",
				todoId: "todo_metric_divergence_m3",
				marketId: "m3",
				status: "reopened",
				attempts: [passedAttempt()],
				reopens: [{ reopenedAt: T1, reopenedBy: "ops", reason: "口径选错，拉回重新确认" }],
			}),
		];
		await writeRawStore(repo, records);
		const loaded = await repo.load();
		assert.deepEqual(loaded.todoResolutions, records);
	});
});

test("非法处理记录被 assertStore 按 path 精确拒绝", async () => {
	const cases: Array<{ name: string; records: unknown; pattern: RegExp }> = [
		{ name: "集合非数组", records: {}, pattern: /todoResolutions 损坏/ },
		{ name: "记录非对象", records: [null], pattern: /todoResolutions\[0\] 损坏/ },
		{ name: "标题快照为空", records: [corrupt({ titleSnapshot: "" })], pattern: /todoResolutions\[0\]\.titleSnapshot 损坏/ },
		{ name: "kind 非闭环四类", records: [corrupt({ kind: "gate_review" })], pattern: /todoResolutions\[0\]\.kind 损坏/ },
		{ name: "kind 越界", records: [corrupt({ kind: "nonsense" })], pattern: /todoResolutions\[0\]\.kind 损坏/ },
		{ name: "status 越界", records: [corrupt({ status: "done" })], pattern: /todoResolutions\[0\]\.status 损坏/ },
		{
			name: "todoId 集合内重复",
			records: [resolution({ id: "tdr_a" }), resolution({ id: "tdr_b" })],
			pattern: /todoResolutions\[1\]\.todoId 重复/,
		},
		{ name: "attempts 为空", records: [corrupt({ attempts: [] })], pattern: /todoResolutions\[0\]\.attempts 必须非空/ },
		{ name: "处理说明全空白", records: [corrupt({ attempts: [attempt({ note: "   " })] })], pattern: /todoResolutions\[0\]\.attempts\[0\]\.note 必须非空/ },
		{
			name: "证据 ref 空串",
			records: [corrupt({ attempts: [attempt({ evidence: [{ ref: "" }] })] })],
			pattern: /todoResolutions\[0\]\.attempts\[0\]\.evidence\[0\]\.ref 必须非空/,
		},
		{
			name: "证据 ref 全空白",
			records: [corrupt({ attempts: [attempt({ evidence: [{ ref: " \t " }] })] })],
			pattern: /todoResolutions\[0\]\.attempts\[0\]\.evidence\[0\]\.ref 必须非空/,
		},
		{
			name: "verdict 越界",
			records: [corrupt({ status: "verified", attempts: [attempt({ verdict: "maybe" as unknown as "pass", verdictReason: "x", verifiedAt: T1, verifiedBy: "a" })] })],
			pattern: /todoResolutions\[0\]\.attempts\[0\]\.verdict 损坏/,
		},
		{
			name: "验证理由全空白",
			records: [corrupt({ status: "verified", attempts: [passedAttempt({ verdictReason: "  " })] })],
			pattern: /todoResolutions\[0\]\.attempts\[0\]\.verdictReason 必须非空/,
		},
		{
			name: "验证缺 actor 留痕",
			records: [corrupt({ status: "verified", attempts: [passedAttempt({ verifiedBy: "" })] })],
			pattern: /todoResolutions\[0\]\.attempts\[0\]\.verifiedBy 损坏/,
		},
		{
			name: "有验证留痕却无 verdict",
			records: [corrupt({ attempts: [attempt({ verifiedAt: T1, verifiedBy: "compass-agent" })] })],
			pattern: /todoResolutions\[0\]\.attempts\[0\] 有验证留痕但缺 verdict/,
		},
		{
			name: "submitted 却已有验证结论",
			records: [corrupt({ status: "submitted", attempts: [passedAttempt()] })],
			pattern: /todoResolutions\[0\] 的状态 submitted 与末轮验证结论不一致/,
		},
		{
			name: "rejected 末轮却是通过",
			records: [corrupt({ status: "rejected", attempts: [passedAttempt()] })],
			pattern: /todoResolutions\[0\] 的状态 rejected 与末轮验证结论不一致/,
		},
		{
			name: "verified 末轮无结论",
			records: [corrupt({ status: "verified" })],
			pattern: /todoResolutions\[0\] 的状态 verified 与末轮验证结论不一致/,
		},
		{
			name: "verified 末轮是驳回",
			records: [corrupt({ status: "verified", attempts: [rejectedAttempt()] })],
			pattern: /todoResolutions\[0\] 的状态 verified 与末轮验证结论不一致/,
		},
		{
			name: "resolved 末轮未通过验证",
			records: [corrupt({ attempts: [rejectedAttempt()] }, resolvedResolution())],
			pattern: /todoResolutions\[0\] 的状态 resolved 与末轮验证结论不一致/,
		},
		{
			name: "resolved 缺勾选留痕",
			records: [corrupt({ resolvedBy: undefined }, resolvedResolution())],
			pattern: /todoResolutions\[0\] 的 resolved 状态缺少勾选留痕/,
		},
		{
			name: "resolved 缺水位锚点",
			records: [corrupt({ basis: undefined }, resolvedResolution())],
			pattern: /todoResolutions\[0\] 的 resolved 状态缺少水位锚点 snapshotWatermark/,
		},
		{
			name: "resolved 水位锚点张冠李戴",
			records: [corrupt({ kind: "deep_missing_data", basis: { month: "2026-08" } }, resolvedResolution())],
			pattern: /todoResolutions\[0\] 的 resolved 状态缺少水位锚点 stageEnteredAt/,
		},
		{
			name: "basis 字段类型错误",
			records: [corrupt({ basis: { snapshotWatermark: 20260730 } }, resolvedResolution())],
			pattern: /todoResolutions\[0\]\.basis\.snapshotWatermark 损坏/,
		},
		{
			name: "reopened 无重开留痕",
			records: [corrupt({ status: "reopened", attempts: [passedAttempt()] })],
			pattern: /todoResolutions\[0\] 的 reopened 状态缺少重开留痕/,
		},
		{
			name: "重开理由全空白",
			records: [corrupt({ status: "reopened", attempts: [passedAttempt()], reopens: [{ reopenedAt: T1, reopenedBy: "ops", reason: "  " }] })],
			pattern: /todoResolutions\[0\]\.reopens\[0\]\.reason 必须非空/,
		},
	];

	await withRepo(async (repo) => {
		for (const item of cases) {
			await writeRawStore(repo, item.records);
			await assert.rejects(repo.load(), item.pattern, item.name);
		}
	});
});

// ---------------------------------------------------------------------------
// service 状态机：submit / verify / complete / reopen（Task 3）
// ---------------------------------------------------------------------------

const NOW = "2026-08-26T00:00:00.000Z";
const DIVERGENCE_TODO = "todo_metric_divergence_m1";
const BUDGET_TODO = "todo_budget_warning_keepa";
const DEEP_TODO = "todo_deep_missing_data_c2";

function metric(value: number, source = "sellersprite"): MetricEvidence {
	return { value, source, capturedAt: "2026-08-20T00:00:00.000Z", confidence: 0.8 };
}

function addSnapshot(store: CompassStore, id: string, marketId: string, source: string, capturedAt: string, metrics: MetricMap): void {
	store.snapshots.push({ id, marketId, source, capturedAt, importedAt: capturedAt, rowCount: 0, listings: [], keywords: [], metrics, warnings: [] });
}

// 同时含三类活跃闭环待办：多源偏差(m1) / 预算 80% 告警(keepa) / 深研缺硬指标(c2)
function machineStore(): CompassStore {
	const store = createEmptyStore(T0);
	store.markets.push({ id: "m1", name: "偏差市场", keywords: [], createdAt: T0, updatedAt: T0 });
	store.candidates.push({ id: "c1", marketId: "m1", stage: "screen", tags: [], createdAt: T0, updatedAt: T0 });
	addSnapshot(store, "s1", "m1", "sellersprite", "2026-08-20T00:00:00.000Z", { cr3: metric(0.9) });
	addSnapshot(store, "s2", "m1", "sorftime", "2026-08-19T00:00:00.000Z", { cr3: metric(0.5, "sorftime") });
	store.budgetPools.push({ source: "keepa", tier: "B", monthlyLimitCny: 400, enabled: true });
	store.costEvents.push({ id: "ce1", source: "keepa", amountCny: 350, createdAt: "2026-08-20T00:00:00.000Z", actor: "ops" });
	store.markets.push({ id: "m2", name: "深研市场", keywords: [], createdAt: T0, updatedAt: T0 });
	store.candidates.push({ id: "c2", marketId: "m2", stage: "deep_research", tags: [], createdAt: T0, updatedAt: T0 });
	store.decisionLog.push({ id: "d1", candidateId: "c2", marketId: "m2", type: "stage_move", conclusion: "screen → deep_research", reason: "粗筛通过", actor: "tester", createdAt: "2026-08-10T00:00:00.000Z" });
	addSnapshot(store, "s3", "m2", "sellersprite", "2026-08-22T00:00:00.000Z", { main_cpc: metric(0.8), waist_rating_median: metric(4.2) });
	return store;
}

// 补齐深研硬门槛②：该市场的具体利润测算（同时供给 gross_margin / cpc_ratio 两项指标）
function addProfitEstimate(store: CompassStore, marketId: string): void {
	const input = normalizeProfitInput({ marketId, salePrice: 25.99, purchaseCost: 3.5, firstMileCost: 0.9, referralRate: 0.15, fbaFee: 5.2, cvr: 0.12, cpc: 0.85 });
	recordProfitEstimate(store, input, estimateProfit(input), "tester");
}

function activeTodo(store: CompassStore, todoId: string) {
	return listWorkbenchTodos(store, NOW).find((todo) => todo.id === todoId);
}

function submitDivergence(store: CompassStore, note = "对照三个来源后以 sellersprite 为准：样本量更大且口径与 Gate 一致"): TodoResolution {
	return submitTodoResolution(store, { todoRef: DIVERGENCE_TODO, note, evidence: [{ ref: "https://example.com/compare", note: "多源对照表" }] }, "compass-web", NOW);
}

test("提交→验证→勾选走完后条目离开活跃清单，basis 按 kind 落对应水位", async () => {
	const store = machineStore();
	addProfitEstimate(store, "m2");
	const decisionLogBefore = store.decisionLog.length;

	// 偏差类：水位 = 参与比较快照集合指纹
	const submitted = submitDivergence(store);
	assert.equal(submitted.status, "submitted");
	assert.equal(submitted.kind, "metric_divergence");
	assert.equal(submitted.titleSnapshot, "多源指标偏差 >30%");
	assert.equal(submitted.marketId, "m1");
	assert.equal(submitted.attempts.length, 1);
	assert.equal(submitted.attempts[0].submittedBy, "compass-web");
	assert.equal(submitted.attempts[0].evidence[0].ref, "https://example.com/compare");
	assert.equal(activeTodo(store, DIVERGENCE_TODO)?.resolution?.status, "submitted");

	const verified = verifyTodoResolution(store, { todoRef: DIVERGENCE_TODO, verdict: "pass", reason: "口径选择与理由明确" }, "compass-agent", NOW);
	assert.equal(verified.status, "verified");
	assert.equal(verified.attempts[0].verdict, "pass");
	assert.equal(verified.attempts[0].verifiedBy, "compass-agent");
	assert.equal(activeTodo(store, DIVERGENCE_TODO)?.resolution?.status, "verified");

	const resolved = completeTodoResolution(store, { todoRef: DIVERGENCE_TODO }, "compass-web", NOW);
	assert.equal(resolved.status, "resolved");
	assert.equal(resolved.resolvedBy, "compass-web");
	assert.equal(resolved.resolvedAt, NOW);
	assert.equal(resolved.basis?.snapshotWatermark, divergenceWatermarks(store).get("m1"));
	assert.equal(activeTodo(store, DIVERGENCE_TODO), undefined, "已勾选条目应从活跃清单抑制");

	// 预算类：水位 = 勾选时的 UTC 月份
	submitTodoResolution(store, { todoRef: BUDGET_TODO, note: "核对用量后决定本月收紧补数，不提额" }, "compass-web", NOW);
	verifyTodoResolution(store, { todoRef: BUDGET_TODO, verdict: "pass", reason: "给出用量结论与后续动作" }, "compass-agent", NOW);
	const budget = completeTodoResolution(store, { todoRef: BUDGET_TODO }, "compass-web", NOW);
	assert.equal(budget.basis?.month, "2026-08");
	assert.equal(budget.source, "keepa");
	assert.equal(activeTodo(store, BUDGET_TODO), undefined);

	// 深研类：水位 = 本次进入 deep_research 的时间（与派生层同源）
	submitTodoResolution(store, { todoRef: DEEP_TODO, note: "已向两家供应商就 SKU-A 询价，成本构成见附件，利润测算已录入" }, "compass-web", NOW);
	verifyTodoResolution(store, { todoRef: DEEP_TODO, verdict: "pass", reason: "说明含供应商、SKU 与成本构成，利润测算齐备" }, "compass-agent", NOW);
	const deep = completeTodoResolution(store, { todoRef: DEEP_TODO }, "compass-web", NOW);
	assert.equal(deep.basis?.stageEnteredAt, stageEntryTimes(store, "deep_research").get("c2"));
	assert.equal(deep.basis?.stageEnteredAt, "2026-08-10T00:00:00.000Z");
	assert.equal(activeTodo(store, DEEP_TODO), undefined);

	// 四个动作全程不写 decisionLog（回滚安全：旧版对 type 严格白名单）
	assert.equal(store.decisionLog.length, decisionLogBefore);
	// service 产出的记录必须能通过 store 硬不变式落盘
	await withRepo(async (repo) => {
		await repo.save(store);
		const loaded = await repo.load();
		assert.equal(loaded.todoResolutions?.length, 3);
	});
});

test("驳回后可重新提交追加轮次，勾选后可重开回到活跃清单", () => {
	const store = machineStore();
	submitDivergence(store);
	const rejected = verifyTodoResolution(store, { todoRef: DIVERGENCE_TODO, verdict: "reject", reason: "未说明以哪个来源为准" }, "compass-agent", NOW);
	assert.equal(rejected.status, "rejected");
	assert.equal(rejected.attempts[0].verdict, "reject");
	assert.equal(activeTodo(store, DIVERGENCE_TODO)?.resolution?.verdictReason, "未说明以哪个来源为准");

	const resubmitted = submitDivergence(store, "补充：以 sellersprite 为准，因其采集口径与 Gate 阈值一致");
	assert.equal(resubmitted.status, "submitted");
	assert.equal(resubmitted.attempts.length, 2, "重提追加新轮次，历史轮次保留");
	assert.equal(resubmitted.attempts[0].verdict, "reject");
	assert.equal(resubmitted.attempts[1].verdict, undefined);

	verifyTodoResolution(store, { todoRef: DIVERGENCE_TODO, verdict: "pass", reason: "口径明确" }, "compass-agent", NOW);
	completeTodoResolution(store, { todoRef: DIVERGENCE_TODO }, "compass-web", NOW);
	const reopened = reopenTodoResolution(store, { todoRef: DIVERGENCE_TODO, reason: "勾错了，实际未与运营对齐" }, "ops", NOW);
	assert.equal(reopened.status, "reopened");
	assert.equal(reopened.reopens.length, 1);
	assert.equal(reopened.reopens[0].reopenedBy, "ops");
	assert.equal(reopened.attempts.length, 2, "重开保留全部历史轮次");
	assert.equal(activeTodo(store, DIVERGENCE_TODO)?.resolution?.status, "reopened", "重开后条目回到活跃清单");

	const third = submitDivergence(store, "与运营对齐后重新提交：以 sellersprite 为准");
	assert.equal(third.attempts.length, 3);
	assert.equal(third.status, "submitted");
});

test("状态机非法迁移与入参校验逐一抛中文错误", () => {
	const store = machineStore();
	// 待办不存在 / 非闭环类
	assert.throws(() => submitTodoResolution(store, { todoRef: "todo_metric_divergence_不存在", note: "x" }, "ops", NOW), /不存在或已消失/);
	store.candidates.push({ id: "c3", marketId: "m1", stage: "screen", tags: [], gateOutcome: "review", gateReason: "复核", createdAt: T0, updatedAt: T0 });
	assert.throws(() => submitTodoResolution(store, { todoRef: "todo_gate_review_c3", note: "已复核" }, "ops", NOW), /自动消失/);
	// 说明为空 / 全空白 / 证据 ref 空白
	assert.throws(() => submitTodoResolution(store, { todoRef: DIVERGENCE_TODO, note: "   " }, "ops", NOW), /处理说明/);
	assert.throws(() => submitTodoResolution(store, { todoRef: DIVERGENCE_TODO, note: "说明", evidence: [{ ref: "  " }] }, "ops", NOW), /证据/);
	// 尚无记录时不能验证 / 勾选 / 重开
	assert.throws(() => verifyTodoResolution(store, { todoRef: DIVERGENCE_TODO, verdict: "pass", reason: "r" }, "agent", NOW), /尚无处理记录/);
	assert.throws(() => completeTodoResolution(store, { todoRef: DIVERGENCE_TODO }, "ops", NOW), /尚无处理记录/);
	assert.throws(() => reopenTodoResolution(store, { todoRef: DIVERGENCE_TODO, reason: "r" }, "ops", NOW), /尚无处理记录/);

	submitDivergence(store);
	// submitted 态：不可重复提交 / 不可勾选 / 不可重开；验证理由不得为空
	assert.throws(() => submitDivergence(store), /待验证/);
	assert.throws(() => completeTodoResolution(store, { todoRef: DIVERGENCE_TODO }, "ops", NOW), /验证通过/);
	assert.throws(() => reopenTodoResolution(store, { todoRef: DIVERGENCE_TODO, reason: "r" }, "ops", NOW), /已处理/);
	assert.throws(() => verifyTodoResolution(store, { todoRef: DIVERGENCE_TODO, verdict: "reject", reason: " " }, "agent", NOW), /理由/);

	verifyTodoResolution(store, { todoRef: DIVERGENCE_TODO, verdict: "pass", reason: "口径明确" }, "agent", NOW);
	// verified 态：不可重复验证 / 不可重提 / 不可重开
	assert.throws(() => verifyTodoResolution(store, { todoRef: DIVERGENCE_TODO, verdict: "pass", reason: "再来一次" }, "agent", NOW), /待验证/);
	assert.throws(() => submitDivergence(store), /验证通过/);
	assert.throws(() => reopenTodoResolution(store, { todoRef: DIVERGENCE_TODO, reason: "r" }, "ops", NOW), /已处理/);

	completeTodoResolution(store, { todoRef: DIVERGENCE_TODO }, "ops", NOW);
	// resolved 态：不可重复勾选 / 不可直接重提（须先重开）/ 重开理由必填
	assert.throws(() => completeTodoResolution(store, { todoRef: DIVERGENCE_TODO }, "ops", NOW), /已勾选/);
	assert.throws(() => submitDivergence(store), /重开/);
	assert.throws(() => verifyTodoResolution(store, { todoRef: DIVERGENCE_TODO, verdict: "pass", reason: "r" }, "agent", NOW), /待验证/);
	assert.throws(() => reopenTodoResolution(store, { todoRef: DIVERGENCE_TODO, reason: "  " }, "ops", NOW), /理由/);

	reopenTodoResolution(store, { todoRef: DIVERGENCE_TODO, reason: "拉回重新处理" }, "ops", NOW);
	// reopened 态：不可再次重开 / 不可勾选，只能重新提交
	assert.throws(() => reopenTodoResolution(store, { todoRef: DIVERGENCE_TODO, reason: "再来" }, "ops", NOW), /已处理/);
	assert.throws(() => completeTodoResolution(store, { todoRef: DIVERGENCE_TODO }, "ops", NOW), /验证通过/);
	assert.equal(submitDivergence(store).attempts.length, 2);
});

test("未经验证通过的勾选被服务端拒绝且 store 无任何变更（防前端绕过）", () => {
	const store = machineStore();
	submitDivergence(store);
	const before = structuredClone(store.todoResolutions);
	assert.throws(() => completeTodoResolution(store, { todoRef: DIVERGENCE_TODO }, "compass-web", NOW), /须先经 agent 验证通过/);
	assert.deepEqual(store.todoResolutions, before, "被拒的勾选不得留下任何写入");
	assert.equal(activeTodo(store, DIVERGENCE_TODO)?.resolution?.status, "submitted");
});

test("深研硬门槛：缺指标或缺利润测算时 verify pass 被拒并列出缺项", () => {
	const store = machineStore();
	const submitDeep = () => submitTodoResolution(store, { todoRef: DEEP_TODO, note: "已向供应商就 SKU-A 询价" }, "compass-web", NOW);
	const pass = () => verifyTodoResolution(store, { todoRef: DEEP_TODO, verdict: "pass", reason: "材料齐备" }, "compass-agent", NOW);
	submitDeep();

	// ① 四项硬指标缺 gross_margin / cpc_ratio（无利润测算）→ 同时缺②
	assert.throws(pass, (error: Error) => {
		assert.match(error.message, /毛利率/);
		assert.match(error.message, /CPC承受度/);
		assert.match(error.message, /缺利润测算记录/);
		return true;
	});
	assert.equal(store.todoResolutions?.[0].status, "submitted", "硬门槛不过时不得落库");

	// ② 指标齐但仍无该市场利润测算：手工补齐两项指标以隔离出「缺利润测算」单一缺项
	store.snapshots[2].metrics.gross_margin = metric(0.45);
	store.snapshots[2].metrics.cpc_ratio = metric(0.5);
	assert.throws(pass, (error: Error) => {
		assert.match(error.message, /缺利润测算记录/);
		assert.doesNotMatch(error.message, /毛利率/);
		return true;
	});

	// ③ 全齐 → 通过
	addProfitEstimate(store, "m2");
	assert.equal(pass().status, "verified");

	// 硬门槛只拦 pass：驳回任何时候都能落
	const other = machineStore();
	submitTodoResolution(other, { todoRef: DEEP_TODO, note: "只写了一句话" }, "compass-web", NOW);
	assert.equal(verifyTodoResolution(other, { todoRef: DEEP_TODO, verdict: "reject", reason: "未含供应商与成本构成" }, "compass-agent", NOW).status, "rejected");
});

test("水位锚点无法确定时拒绝勾选，不写出违反硬不变式的记录", () => {
	const store = machineStore();
	submitTodoResolution(store, { todoRef: DEEP_TODO, note: "调研说明" }, "compass-web", NOW);
	addProfitEstimate(store, "m2");
	store.snapshots[2].metrics.gross_margin = metric(0.45);
	store.snapshots[2].metrics.cpc_ratio = metric(0.5);
	verifyTodoResolution(store, { todoRef: DEEP_TODO, verdict: "pass", reason: "材料齐备" }, "compass-agent", NOW);
	// 记录悬空（候选已不可达）→ 阶段周期锚无从计算
	const record = store.todoResolutions?.[0];
	if (record) record.candidateId = "已消失的候选";
	assert.throws(() => completeTodoResolution(store, { todoRef: DEEP_TODO }, "compass-web", NOW), /水位/);
	assert.equal(store.todoResolutions?.[0].status, "verified");
});

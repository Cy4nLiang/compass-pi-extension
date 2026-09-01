import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CompassRepository, createEmptyStore } from "../store.ts";
import { DECISION_LOG_TYPES, SNAPSHOT_SOURCES, type DecisionLog } from "../types.ts";

const here = dirname(fileURLToPath(import.meta.url));

// 收敛前 decisionLog.type 白名单在 types 联合、assertStore、compass_history 参数三处手抄；
// 收敛后唯一真相源是 DECISION_LOG_TYPES，本文件守住「取值集合不许漂移」与「service 只写白名单内取值」。
const FROZEN_DECISION_LOG_TYPES = ["lead", "import", "strategy", "stage_move", "decision", "risk", "profit", "review", "retro"];

async function sourceOf(file: string): Promise<string> {
	return readFile(join(here, "..", file), "utf8");
}

// 从 service.ts 里抽出每个 appendDecision(...) 调用实际写入的 type 字面量。
// 找不到字面量（比如改成了变量）也算失败：白名单必须能被静态核对。
function decisionTypesWrittenBy(source: string): string[] {
	const calls = [...source.matchAll(/appendDecision\(store, \{([\s\S]*?)^\t*\}\);/gm)];
	assert.ok(calls.length > 0, "service.ts 里没有找到任何 appendDecision 调用，抽取规则已失效");
	return calls.map((call, index) => {
		const matched = call[1].match(/^\t+type: "([^"]*)",$/m);
		assert.ok(matched, `service.ts 第 ${index + 1} 个 appendDecision 调用没有字面量 type，无法静态核对白名单`);
		return matched[1];
	});
}

function logWithType(type: string): DecisionLog {
	return {
		id: `dec_${type}`,
		marketId: "m1",
		type: type as DecisionLog["type"],
		conclusion: `写入 ${type}`,
		reason: "回归用例",
		actor: "tester",
		createdAt: "2026-08-01T00:00:00.000Z",
	};
}

test("DECISION_LOG_TYPES 是冻结集合：逐字不许漂移（M43 回滚红线）", () => {
	// 新增取值会让**回滚后**的旧版 assertStore 打不开 store——那是不可恢复的数据事故。
	// 要给决策日志加维度只能加可选字段（trigger / strategyRunId 就是这么加的）。
	assert.deepEqual([...DECISION_LOG_TYPES], FROZEN_DECISION_LOG_TYPES);
});

test("三处手抄的白名单收敛到同一个常量（M89）", async () => {
	const [types, store, index] = await Promise.all([sourceOf("types.ts"), sourceOf("store.ts"), sourceOf("index.ts")]);
	// 字面量数组只许在 types.ts 的常量定义处出现一次；store.ts / index.ts 必须引用常量
	const literal = /\["lead", "import", "strategy", "stage_move", "decision", "risk", "profit", "review", "retro"\]/;
	assert.match(types, literal, "types.ts 应保留唯一的字面量定义");
	assert.doesNotMatch(store, literal, "store.ts 不该再手抄白名单，应引用 DECISION_LOG_TYPES");
	assert.doesNotMatch(index, literal, "index.ts 不该再手抄白名单，应引用 DECISION_LOG_TYPES");
	assert.match(store, /DECISION_LOG_TYPES/, "store.ts 的 assertStore 应引用常量");
});

test("service.ts 写入的每个 decisionLog.type 都在白名单里（M89）", async () => {
	const written = decisionTypesWrittenBy(await sourceOf("service.ts"));
	const allowed = new Set<string>(DECISION_LOG_TYPES);
	for (const type of written) {
		assert.ok(allowed.has(type), `service.ts 写入了白名单外的 decisionLog.type: ${type}`);
	}
	// 抽取规则本身要有意义：至少覆盖到几个真实取值，否则正则失效也会「全绿」
	assert.ok(new Set(written).size >= 3, `只抽到 ${new Set(written).size} 种 type，抽取规则可能已失效`);
});

test("assertStore 接受白名单内全部取值、拒绝白名单外取值（M43）", async () => {
	const root = await mkdtemp(join(tmpdir(), "decision-log-types-"));
	try {
		const roundtrip = async (log: DecisionLog): Promise<boolean> => {
			const dir = join(root, log.id);
			await mkdir(join(dir, ".pi", "compass"), { recursive: true });
			const store = createEmptyStore();
			store.decisionLog.push(log);
			await writeFile(join(dir, ".pi", "compass", "store.json"), JSON.stringify(store), "utf8");
			try {
				await new CompassRepository(dir).load();
				return true;
			} catch {
				return false;
			}
		};

		for (const type of DECISION_LOG_TYPES) {
			assert.equal(await roundtrip(logWithType(type)), true, `白名单内的 ${type} 应能读出来`);
		}
		// 这几个都是很容易被顺手加进来的取值，必须继续被拒
		for (const type of ["retro_challenged", "outcome", "note", "todo", "budget", ""]) {
			assert.equal(await roundtrip(logWithType(type)), false, `白名单外的 ${type} 必须被拒`);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("SNAPSHOT_SOURCES 同样只有一处字面量定义（M89）", async () => {
	const [types, store] = await Promise.all([sourceOf("types.ts"), sourceOf("store.ts")]);
	assert.deepEqual([...SNAPSHOT_SOURCES], ["auto", "sellersprite", "sorftime", "keepa", "compass_browser", "manual_csv", "generic_csv"]);
	assert.match(types, /export const SNAPSHOT_SOURCES = \[/, "types.ts 应保留唯一的字面量定义");
	assert.doesNotMatch(store, /"sellersprite", "sorftime", "keepa"/, "store.ts 不该再手抄快照来源白名单");
});

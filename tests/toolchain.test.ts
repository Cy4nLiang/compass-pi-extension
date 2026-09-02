import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const LINT_FLAGS = ["noUnusedLocals", "noUnusedParameters", "noImplicitReturns", "noFallthroughCasesInSwitch", "noImplicitOverride"] as const;

async function readJson(file: string): Promise<Record<string, any>> {
	// tsconfig.json 带注释，不能直接 JSON.parse
	const raw = await readFile(join(here, "..", file), "utf8");
	return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));
}

test("六个 tsc 严格开关都开着（M123）", async () => {
	const tsconfig = await readJson("tsconfig.json");
	const options = tsconfig.compilerOptions ?? {};
	for (const flag of LINT_FLAGS) {
		assert.equal(options[flag], true, `tsconfig.json 的 ${flag} 应为 true`);
	}
	// allowUnreachableCode 是反向开关：false 才是「不许有到不了的代码」
	assert.equal(options.allowUnreachableCode, false, "allowUnreachableCode 应显式设为 false");
});

test("测试有单条超时上限，卡住的用例不会把 CI 挂到无穷（M122）", async () => {
	const pkg = await readJson("package.json");
	const script = pkg.scripts?.test ?? "";
	// node:test 默认 --test-timeout 是 Infinity：一个忘了 resolve 的 Promise 能让 CI 跑到
	// 平台上限才被杀，日志里还看不出是哪条用例。
	const matched = script.match(/--test-timeout[= ](\d+)/);
	assert.ok(matched, `npm test 缺少 --test-timeout：${script}`);
	const timeoutMs = Number(matched[1]);
	assert.ok(timeoutMs > 0 && timeoutMs <= 120_000, `--test-timeout=${timeoutMs} 不在合理区间`);
	// 现有最慢的用例（锁竞争类）在秒级，30 秒留了足够余量又不至于挂太久
	assert.ok(timeoutMs >= 10_000, `--test-timeout=${timeoutMs} 太紧，正常的锁用例会被误杀`);
});

test("CI 每个 job 有墙钟上限（M122）", async () => {
	const workflow = await readFile(join(here, "..", ".github/workflows/ci.yml"), "utf8");
	// --test-timeout 只管单条用例；npm install 卡死、runner 网络挂掉这类要靠 job 级上限兜底
	const limits = [...workflow.matchAll(/^\s*timeout-minutes:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
	assert.ok(limits.length > 0, "ci.yml 里没有任何 timeout-minutes");
	// 只数 jobs: 段里的顶层键——on: 下面的 push: / pull_request: 不是 job
	const jobsBlock = workflow.split(/^jobs:\s*$/m)[1] ?? "";
	const jobs = [...jobsBlock.matchAll(/^ {2}[A-Za-z0-9_-]+:\s*$/gm)].map((m) => m[0].trim());
	assert.ok(jobs.length > 0, "ci.yml 里没找到任何 job");
	assert.equal(limits.length, jobs.length, `${jobs.length} 个 job（${jobs.join(" ")}）只有 ${limits.length} 个设了 timeout-minutes`);
	for (const limit of limits) {
		assert.ok(limit > 0 && limit <= 30, `timeout-minutes: ${limit} 不在合理区间`);
	}
});

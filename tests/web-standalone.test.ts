import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const standaloneEntry = join(here, "../web/standalone.ts");

// standalone.ts 是脚本入口（import 即启动服务），只能起子进程看它的启动期输出。
// --port 0 让内核分配空闲端口，测试之间不抢端口；打印"已启动"后立刻杀掉。
async function bootStandalone(cwd: string): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", standaloneEntry, "--port", "0"], {
			cwd,
			env: { ...process.env, COMPASS_ROOT: "" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`standalone.ts 启动超时；stdout=${stdout} stderr=${stderr}`));
		}, 30_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.includes("已启动")) child.kill("SIGKILL");
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", () => {
			clearTimeout(timer);
			resolve({ stdout, stderr });
		});
	});
}

/** 造一个「宿主项目根」：可选地放一份 store.json */
async function makeRoot(withStore: boolean): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "standalone-"));
	if (withStore) {
		await mkdir(join(root, ".pi", "compass"), { recursive: true });
		await writeFile(join(root, ".pi", "compass", "store.json"), JSON.stringify({ version: 1 }), "utf8");
	}
	return root;
}

test("从宿主项目根启动：读到真实 store，不告警（M11）", async () => {
	const root = await makeRoot(true);
	try {
		const { stdout, stderr } = await bootStandalone(root);
		assert.match(stdout, /已启动/u, `启动失败：stdout=${stdout} stderr=${stderr}`);
		assert.doesNotMatch(stderr, /不存在/u, "有 store 时不该告警");
		assert.doesNotMatch(stderr, /Extension 仓库目录/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("宿主根下没有 store：只提示尚未导入，不误报走错目录（M11）", async () => {
	const root = await makeRoot(false);
	try {
		const { stdout, stderr } = await bootStandalone(root);
		assert.match(stdout, /已启动/u, `启动失败：stdout=${stdout} stderr=${stderr}`);
		assert.match(stderr, /不存在/u, "缺 store 要有告警");
		assert.doesNotMatch(stderr, /Extension 仓库目录/u, "普通空目录不该被当成走错目录");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("在 Extension 仓库目录内启动：点破目录走错了（M11）", async () => {
	// 最常见的误启动方式：在 .pi/extensions/<name>/ 里 npm run web，把仓库自己当宿主根，
	// 页面全空却看不出原因。只说「以空数据启动」不足以让人反应过来。
	const base = await mkdtemp(join(tmpdir(), "standalone-ext-"));
	const root = join(base, ".pi", "extensions", "compass");
	try {
		await mkdir(root, { recursive: true });
		const { stdout, stderr } = await bootStandalone(root);
		assert.match(stdout, /已启动/u, `启动失败：stdout=${stdout} stderr=${stderr}`);
		assert.match(stderr, /Extension 仓库目录/u, "应点破当前目录是 Extension 仓库");
		assert.match(stderr, /COMPASS_ROOT/u, "应给出可照做的修复方式");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("只绑回环地址，启动文案不建议端口转发（M48）", async () => {
	const source = await readFile(standaloneEntry, "utf8");
	const server = await readFile(join(here, "../web/server.ts"), "utf8");
	// 工作台无鉴权，绑到 0.0.0.0 等于把经营数据挂到局域网上
	assert.doesNotMatch(`${source}\n${server}`, /"0\.0\.0\.0"|'0\.0\.0\.0'/u, "不得绑 0.0.0.0");
	assert.match(server, /127\.0\.0\.1/u, "服务端应显式绑 127.0.0.1");
	// 「端口转发」允许出现，但每一处都必须是禁止语气——直接禁掉这个词会把安全注释也判红
	for (const [label, text] of [["standalone.ts", source], ["server.ts", server]] as const) {
		for (const line of text.split("\n").filter((l) => /端口转发|port-forward|ngrok/iu.test(l))) {
			assert.match(line, /不可|不要|禁止|绝不|不得/u, `${label} 提到端口转发却不是禁止语气：${line.trim()}`);
		}
	}
});

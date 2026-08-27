// 独立入口：脱离 pi 宿主直接启动罗盘 Web 工作台。
// COMPASS_ROOT（默认当前目录）指定宿主项目根；端口取 --port，否则 COMPASS_WEB_PORT，否则由
// startCompassWebServer 走默认值（4780）。SIGINT/SIGTERM 优雅关闭；store.json 不存在只警告，
// 不阻断启动——空态本身是合法状态（尚未导入过市场）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startCompassWebServer } from "./server.ts";

function parsePort(raw: string | undefined, label: string): number | undefined {
	if (raw === undefined) return undefined;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${label}无效：${raw}`);
	return port;
}

function resolvePort(argv: string[]): number | undefined {
	const flagIndex = argv.indexOf("--port");
	if (flagIndex !== -1) {
		// argv[flagIndex + 1] undefined 意味着 --port 是末位参数、漏填了值——
		// 这应该报错，不能悄悄落到 parsePort(undefined,...) 的"未指定"语义再退到默认端口
		const raw = argv[flagIndex + 1];
		if (raw === undefined) throw new Error("--port 参数缺少值");
		return parsePort(raw, "--port 参数");
	}
	return parsePort(process.env.COMPASS_WEB_PORT, "COMPASS_WEB_PORT 环境变量");
}

async function main(): Promise<void> {
	const projectRoot = process.env.COMPASS_ROOT || process.cwd();
	const storePath = join(projectRoot, ".pi", "compass", "store.json");
	if (!existsSync(storePath)) {
		console.warn(`警告：${storePath} 不存在，罗盘工作台将以空数据启动（尚未导入过任何市场）`);
	}

	const port = resolvePort(process.argv.slice(2));
	const server = await startCompassWebServer({ projectRoot, ...(port !== undefined ? { port } : {}) });
	console.log(`罗盘 Web 工作台已启动：${server.url}`);
	console.log("按 Ctrl+C 停止");

	let shuttingDown = false;
	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log("\n正在关闭…");
		try {
			await server.close();
		} catch (error) {
			console.error(`关闭时出错（忽略并继续退出）：${error instanceof Error ? error.message : String(error)}`);
		}
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error) => {
	console.error(`罗盘 Web 工作台启动失败：${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});

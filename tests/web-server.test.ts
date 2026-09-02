import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarketCsv } from "../csv.ts";
import { ensureDefaults, importMarketAndScreen, verifyTodoResolution } from "../service.ts";
import { CompassRepository } from "../store.ts";
import { startCompassWebServer, type CompassWebServer } from "../web/server.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface Envelope {
	ok: boolean;
	error?: string;
	// data 形状由 web/data.ts 的单测守护，这里只断言 envelope 与少量关键字段
	data?: any;
	meta?: { generatedAt: string; storeUpdatedAt?: string };
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: Envelope; contentType: string }> {
	const response = await fetch(url, init);
	return { status: response.status, body: (await response.json()) as Envelope, contentType: response.headers.get("content-type") ?? "" };
}

async function setupProject(options: { seed?: boolean } = {}): Promise<{ root: string; server: CompassWebServer }> {
	const root = await mkdtemp(join(tmpdir(), "compass-web-"));
	try {
		if (options.seed) {
			const repo = new CompassRepository(root);
			const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
			const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt: "2026-08-24T00:00:00.000Z" });
			await repo.update(async (store) => {
				ensureDefaults(store, "test");
				importMarketAndScreen(store, { marketName: "demo market", parsed, capturedAt: "2026-08-24T00:00:00.000Z", actor: "tester", runScreen: true });
			});
		}
		// 端口 0：由内核分配空闲端口，测试之间不冲突
		const server = await startCompassWebServer({ projectRoot: root, port: 0 });
		return { root, server };
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

async function teardown(root: string, server: CompassWebServer): Promise<void> {
	await server.close();
	await rm(root, { recursive: true, force: true });
}

test("health and overview endpoints answer with the standard envelope", async () => {
	const { root, server } = await setupProject();
	try {
		const health = await getJson(`${server.url}/api/health`);
		assert.equal(health.status, 200);
		assert.equal(health.contentType, "application/json; charset=utf-8");
		assert.equal(health.body.ok, true);

		const { status, body: payload } = await getJson(`${server.url}/api/overview`);
		assert.equal(status, 200);
		assert.equal(payload.ok, true);
		assert.equal(payload.data.summary.markets, 0);
		assert.equal(payload.data.stages.length, 8);
		assert.ok(payload.meta?.generatedAt);
		assert.ok(payload.meta?.storeUpdatedAt);
	} finally {
		await teardown(root, server);
	}
});

test("all read endpoints serve seeded data", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		const paths = ["/api/overview", "/api/todos", "/api/markets", "/api/pool", "/api/budget", "/api/retro"];
		for (const path of paths) {
			const { status, body } = await getJson(`${server.url}${path}`);
			assert.equal(status, 200, `${path} 应返回 200`);
			assert.equal(body.ok, true, `${path} 应返回成功 envelope`);
		}
		const markets = (await getJson(`${server.url}/api/markets`)).body;
		assert.equal(markets.data.total, 1);
		const marketId = markets.data.rows[0].marketId;

		const dossier = (await getJson(`${server.url}/api/markets/${encodeURIComponent(marketId)}`)).body;
		assert.equal(dossier.ok, true);
		assert.equal(dossier.data.market.name, "demo market");
		assert.equal(dossier.data.metricSections.length, 5);

		const pool = (await getJson(`${server.url}/api/pool`)).body;
		const candidateId = pool.data.lanes.flatMap((lane: { items: Array<{ id: string }> }) => lane.items)[0].id;
		const detail = (await getJson(`${server.url}/api/pool/${encodeURIComponent(candidateId)}`)).body;
		assert.equal(detail.ok, true);
		assert.equal(detail.data.candidate.marketName, "demo market");
	} finally {
		await teardown(root, server);
	}
});

test("unknown references answer 404 and unknown api paths answer 404", async () => {
	const { root, server } = await setupProject();
	try {
		const missing = await getJson(`${server.url}/api/markets/no-such-market`);
		assert.equal(missing.status, 404);
		assert.equal(missing.body.ok, false);
		assert.match(missing.body.error ?? "", /未找到市场/);

		const unknown = await getJson(`${server.url}/api/nope`);
		assert.equal(unknown.status, 404);
		assert.equal(unknown.body.ok, false);

		// 候选池一侧的 404 文案要说「候选」，别把排障方向指向市场
		const missingCandidate = await getJson(`${server.url}/api/pool/no-such-candidate`);
		assert.equal(missingCandidate.status, 404);
		assert.match(missingCandidate.body.error ?? "", /未找到候选/);
	} finally {
		await teardown(root, server);
	}
});

function post(url: string, payload: unknown) {
	return getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

test("moving a candidate requires a reason and leaves the store untouched when it is missing", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		const pool = (await getJson(`${server.url}/api/pool`)).body;
		const candidate = pool.data.lanes.flatMap((lane: { items: Array<{ id: string; stage: string }> }) => lane.items)[0];
		const before = await new CompassRepository(root).load();

		for (const payload of [{ candidateRef: candidate.id, stage: "screen" }, { candidateRef: candidate.id, stage: "screen", reason: "   " }]) {
			const { status, body } = await post(`${server.url}/api/pool/move`, payload);
			assert.equal(status, 400, "缺少理由必须被拒绝");
			assert.match(body.error ?? "", /理由不能为空/);
		}
		const after = await new CompassRepository(root).load();
		assert.equal(after.candidates[0].stage, before.candidates[0].stage, "被拒绝的写不得改动 store");
		assert.equal(after.decisionLog.length, before.decisionLog.length);

		const { status, body } = await post(`${server.url}/api/pool/move`, { candidateRef: candidate.id, stage: "screen", reason: "粗筛通过，进入下一阶段" });
		assert.equal(status, 200);
		assert.equal(body.data.candidate.stage, "screen");
		const moved = await new CompassRepository(root).load();
		assert.equal(moved.candidates[0].stage, "screen");
		const latest = moved.decisionLog[moved.decisionLog.length - 1];
		assert.equal(latest.type, "stage_move");
		assert.equal(latest.actor, "compass-web", "Web 写操作必须署名 compass-web");
		assert.equal(latest.reason, "粗筛通过，进入下一阶段");
	} finally {
		await teardown(root, server);
	}
});

test("recording a decision requires a reason and a known status", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		const pool = (await getJson(`${server.url}/api/pool`)).body;
		const candidateId = pool.data.lanes.flatMap((lane: { items: Array<{ id: string }> }) => lane.items)[0].id;

		const before = await new CompassRepository(root).load();
		const noReason = await post(`${server.url}/api/pool/decide`, { candidateRef: candidateId, status: "go" });
		assert.equal(noReason.status, 400);
		const afterReject = await new CompassRepository(root).load();
		assert.equal(afterReject.candidates[0].decisionStatus, before.candidates[0].decisionStatus, "被拒绝的决策不得改动 store");
		assert.equal(afterReject.decisionLog.length, before.decisionLog.length);
		const badStatus = await post(`${server.url}/api/pool/decide`, { candidateRef: candidateId, status: "maybe", reason: "试试" });
		assert.equal(badStatus.status, 400);
		assert.match(badStatus.body.error ?? "", /未知决策状态/);

		const ok = await post(`${server.url}/api/pool/decide`, { candidateRef: candidateId, status: "waitlist", reason: "等 1688 报价确认采购成本" });
		assert.equal(ok.status, 200);
		assert.equal(ok.body.data.candidate.decisionStatus, "waitlist");
		const store = await new CompassRepository(root).load();
		assert.equal(store.candidates[0].decisionStatus, "waitlist");
		assert.equal(store.candidates[0].decisionActor, "compass-web");
	} finally {
		await teardown(root, server);
	}
});

test("import endpoint ingests a project CSV and refuses duplicates", async () => {
	const { root, server } = await setupProject();
	try {
		const importsDir = join(root, "compass-imports");
		await mkdir(importsDir, { recursive: true });
		await copyFile(join(here, "../examples/demo-market.csv"), join(importsDir, "demo.csv"));

		const listed = await getJson(`${server.url}/api/import/files`);
		assert.equal(listed.status, 200);
		assert.equal(listed.body.data.files.length, 1);
		assert.equal(listed.body.data.files[0].path, "compass-imports/demo.csv");

		const imported = await post(`${server.url}/api/import`, { path: "compass-imports/demo.csv", marketName: "web imported market", source: "sellersprite" });
		assert.equal(imported.status, 200);
		assert.equal(imported.body.data.market.name, "web imported market");
		assert.ok(imported.body.data.screenRun, "runScreen 默认开启，应产生粗筛结论");

		const markets = (await getJson(`${server.url}/api/markets`)).body;
		assert.equal(markets.data.total, 1);

		const duplicate = await post(`${server.url}/api/import`, { path: "compass-imports/demo.csv", marketName: "another name" });
		assert.equal(duplicate.status, 400);
		assert.match(duplicate.body.error ?? "", /重复 CSV/);

		const outside = await post(`${server.url}/api/import`, { path: "../outside.csv", marketName: "x" });
		assert.equal(outside.status, 400);
		assert.match(outside.body.error ?? "", /项目目录内/);

		// 路径打错是手输交互的头号失败模式，错误必须是中文而不是 Node 的 ENOENT
		const missingFile = await post(`${server.url}/api/import`, { path: "compass-imports/nope.csv", marketName: "x" });
		assert.equal(missingFile.status, 400);
		assert.match(missingFile.body.error ?? "", /CSV 文件不存在/);

		// 快照不可变：来源必须先过枚举，否则脏值永久留在市场列表
		const badSource = await post(`${server.url}/api/import`, { path: "compass-imports/demo.csv", marketName: "x", source: "随便乱填" });
		assert.equal(badSource.status, 400);
		assert.match(badSource.body.error ?? "", /未知数据来源/);
	} finally {
		await teardown(root, server);
	}
});

test("import files endpoint returns an empty list when the directory is absent", async () => {
	const { root, server } = await setupProject();
	try {
		const { status, body } = await getJson(`${server.url}/api/import/files`);
		assert.equal(status, 200);
		assert.deepEqual(body.data.files, []);
	} finally {
		await teardown(root, server);
	}
});

test("report endpoint writes markdown inside the reports directory", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		const { status, body } = await post(`${server.url}/api/report`, { marketRef: "demo market" });
		assert.equal(status, 200);
		assert.match(body.data.path, /^\.pi\/compass\/reports\/.+\.md$/, "报告必须落在 reports 目录内");
		assert.match(body.data.markdown, /罗盘选品报告/);
		// 报告弹窗的标题栏直接读这四个字段（buildReportOverlayHtml），少一个就是弹窗里一个「—」
		assert.ok(body.data.marketName && body.data.snapshotId, "弹窗标题栏依赖 marketName 与 snapshotId");
		assert.ok(Number.isFinite(body.data.score) && body.data.outcome, "弹窗标题栏依赖 score 与 outcome");
		const written = await readFile(join(root, body.data.path), "utf8");
		assert.equal(written, body.data.markdown);

		const missing = await post(`${server.url}/api/report`, { marketRef: "no-such-market" });
		assert.equal(missing.status, 404);
	} finally {
		await teardown(root, server);
	}
});

test("concurrent writes are serialized and every one of them lands", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		const pool = (await getJson(`${server.url}/api/pool`)).body;
		const candidateId = pool.data.lanes.flatMap((lane: { items: Array<{ id: string }> }) => lane.items)[0].id;
		// 并发提交多次决策：写队列应让它们串行落盘，不丢失也不互相覆盖
		const statuses = ["go", "waitlist", "no_go", "waitlist", "go"] as const;
		const results = await Promise.all(statuses.map((status, index) =>
			post(`${server.url}/api/pool/decide`, { candidateRef: candidateId, status, reason: `并发写 ${index}` })));
		assert.ok(results.every((result) => result.status === 200), "所有并发写都应成功");
		const store = await new CompassRepository(root).load();
		const decisions = store.decisionLog.filter((entry) => entry.type === "decision");
		assert.equal(decisions.length, statuses.length, "每次决策都应留痕，不得丢失");
		assert.ok(decisions.every((entry) => entry.actor === "compass-web"));
		// 入队顺序取决于 body 读完顺序、不可从客户端断言；能断言的是终态与最后一条留痕自洽
		const last = decisions[decisions.length - 1];
		assert.equal(store.candidates[0].decisionStatus, last.decisionStatus, "候选终态必须与最后一条决策留痕一致");
		assert.equal(store.candidates[0].decisionReason, last.reason);
	} finally {
		await teardown(root, server);
	}
});

test("an aborted POST neither crashes the server nor gets logged as a server fault", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		// 运营关页面/取消提交会走到这条路径：不该被当成 500 打整栈
		await new Promise<void>((resolvePromise) => {
			const socket = connect(server.port, "127.0.0.1", () => {
				socket.write("POST /api/pool/move HTTP/1.1\r\nHost: compass\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{\"candidateRef\":");
				setTimeout(() => { socket.destroy(); resolvePromise(); }, 60);
			});
			socket.on("error", () => resolvePromise());
		});
		assert.equal((await getJson(`${server.url}/api/health`)).status, 200, "断开后服务应继续可用");
	} finally {
		await teardown(root, server);
	}
});

test("oversized request bodies and oversized CSV files are refused", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		const huge = await getJson(`${server.url}/api/pool/move`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1_200_000) });
		assert.equal(huge.status, 400);
		assert.match(huge.body.error ?? "", /请求体过大/);

		// resolveInputPath 只限制「项目内」，指向大文件会把它整份读进内存
		const importsDir = join(root, "compass-imports");
		await mkdir(importsDir, { recursive: true });
		await writeFile(join(importsDir, "huge.csv"), "a".repeat(11 * 1_048_576), "utf8");
		const oversized = await post(`${server.url}/api/import`, { path: "compass-imports/huge.csv", marketName: "x" });
		assert.equal(oversized.status, 400);
		assert.match(oversized.body.error ?? "", /CSV 文件过大/);
	} finally {
		await teardown(root, server);
	}
});

test("a failed import leaves no orphan file in the raw archive", async () => {
	const { root, server } = await setupProject();
	try {
		const importsDir = join(root, "compass-imports");
		await mkdir(importsDir, { recursive: true });
		await copyFile(join(here, "../examples/demo-market.csv"), join(importsDir, "demo.csv"));
		await post(`${server.url}/api/import`, { path: "compass-imports/demo.csv", marketName: "first" });
		const afterFirst = await readdir(join(root, ".pi", "compass", "raw"));
		assert.equal(afterFirst.length, 1);

		// 事务内二次查重拒绝的导入必须回收刚写的归档，否则 raw/ 只增不减
		await copyFile(join(here, "../examples/demo-market.csv"), join(importsDir, "same-content.csv"));
		const duplicate = await post(`${server.url}/api/import`, { path: "compass-imports/same-content.csv", marketName: "second" });
		assert.equal(duplicate.status, 400);
		const afterDuplicate = await readdir(join(root, ".pi", "compass", "raw"));
		assert.equal(afterDuplicate.length, 1, "被拒绝的导入不得在 raw/ 留下孤儿归档");
	} finally {
		await teardown(root, server);
	}
});

test("cross-site writes are refused even when they skip the CORS preflight", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		const pool = (await getJson(`${server.url}/api/pool`)).body;
		const candidateId = pool.data.lanes.flatMap((lane: { items: Array<{ id: string }> }) => lane.items)[0].id;
		const payload = JSON.stringify({ candidateRef: candidateId, status: "no_go", reason: "跨站写入" });

		// text/plain 的跨站 POST 不触发预检，服务端必须自己认 Origin
		const crossSite = await getJson(`${server.url}/api/pool/decide`, {
			method: "POST",
			headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://evil.example" },
			body: payload,
		});
		// 415（Content-Type 纵深防御）先于 403 命中，两者都能挡住跨站写入
		assert.ok([403, 415].includes(crossSite.status), `跨站写入必须被拒绝，实际 ${crossSite.status}`);

		// 即便伪造了合法 Content-Type，Origin 判据仍会拦下
		const forgedType = await getJson(`${server.url}/api/pool/decide`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://evil.example" },
			body: payload,
		});
		assert.equal(forgedType.status, 403);
		assert.match(forgedType.body.error ?? "", /跨站请求/);

		const store = await new CompassRepository(root).load();
		assert.notEqual(store.candidates[0].decisionStatus, "no_go", "被拒绝的跨站请求不得落盘");

		// 同源（前端自己发的）与无 Origin（curl/脚本）都应放行
		const sameOrigin = await getJson(`${server.url}/api/pool/decide`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: server.url },
			body: payload,
		});
		assert.equal(sameOrigin.status, 200);
	} finally {
		await teardown(root, server);
	}
});

test("read endpoints refuse forged Host headers so DNS rebinding cannot read business data", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		// 攻击页把自己的域名解析到 127.0.0.1 后浏览器视其为同源；Host 校验是唯一防线
		const forged = await new Promise<string>((resolvePromise, rejectPromise) => {
			const socket = connect(server.port, "127.0.0.1", () => socket.write("GET /api/overview HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"));
			let data = "";
			socket.on("data", (chunk) => { data += chunk.toString(); });
			socket.on("end", () => resolvePromise(data));
			socket.on("error", rejectPromise);
		});
		assert.match(forged.split("\r\n")[0], /403/, "伪造 Host 的读请求必须被拒绝");
		assert.ok(!forged.includes("demo market"), "被拒绝的请求不得泄漏任何经营数据");

		// 正常回环 Host 照常放行
		assert.equal((await getJson(`${server.url}/api/overview`)).status, 200);
	} finally {
		await teardown(root, server);
	}
});

test("binding a non-loopback host is refused at startup", async () => {
	const root = await mkdtemp(join(tmpdir(), "compass-web-"));
	try {
		await assert.rejects(
			startCompassWebServer({ projectRoot: root, host: "0.0.0.0", port: 0 }),
			/只能绑定本机回环地址/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a corrupt store makes write endpoints answer 500 through the domain error path", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		// 写路径不经过 readStore 的 catch：这里守护的是 asDomainError 的 StoreIoError 分支
		await writeFile(join(root, ".pi", "compass", "store.json"), "{ broken", "utf8");
		const { status, body } = await post(`${server.url}/api/pool/decide`, { candidateRef: "any", status: "go", reason: "探测数据损坏时的错误分级" });
		assert.equal(status, 500, "store 损坏必须报服务端故障，不能退化成 400");
		assert.match(body.error ?? "", /读取罗盘数据失败/);
	} finally {
		await teardown(root, server);
	}
});

test("filesystem faults on the write path answer 500, not a client error", async () => {
	const { root, server } = await setupProject({ seed: true });
	const compassDir = join(root, ".pi", "compass");
	try {
		const pool = (await getJson(`${server.url}/api/pool`)).body;
		const candidateId = pool.data.lanes.flatMap((lane: { items: Array<{ id: string }> }) => lane.items)[0].id;
		// 数据目录只读：写操作的第一步（抢锁）就会 EACCES——这是最典型的现场故障
		await chmod(compassDir, 0o500);
		const { status, body } = await post(`${server.url}/api/pool/decide`, { candidateRef: candidateId, status: "go", reason: "磁盘故障探测" });
		assert.equal(status, 500, "文件系统故障是服务端问题，不能报成 400 让运营改输入");
		assert.equal(body.ok, false);
	} finally {
		await chmod(compassDir, 0o700).catch(() => undefined);
		await teardown(root, server);
	}
});

test("malformed request bodies are rejected before touching the store", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		const broken = await getJson(`${server.url}/api/pool/move`, { method: "POST", headers: { "content-type": "application/json" }, body: "{ not json" });
		assert.equal(broken.status, 400);
		assert.match(broken.body.error ?? "", /请求体解析失败/);

		const array = await getJson(`${server.url}/api/pool/move`, { method: "POST", headers: { "content-type": "application/json" }, body: "[1,2]" });
		assert.equal(array.status, 400);

		const badStage = await post(`${server.url}/api/pool/move`, { candidateRef: "x", stage: "nowhere", reason: "r" });
		assert.equal(badStage.status, 400);
		assert.match(badStage.body.error ?? "", /未知阶段/);
	} finally {
		await teardown(root, server);
	}
});

test("static assets are served and directory traversal is refused", async () => {
	const { root, server } = await setupProject();
	try {
		const index = await fetch(`${server.url}/`);
		assert.equal(index.status, 200);
		assert.match(index.headers.get("content-type") ?? "", /text\/html/);
		assert.match(await index.text(), /罗盘 Compass/);

		const css = await fetch(`${server.url}/style.css`);
		assert.equal(css.status, 200);
		assert.match(css.headers.get("content-type") ?? "", /text\/css/);

		const script = await fetch(`${server.url}/app.js`);
		assert.equal(script.status, 200);
		assert.match(script.headers.get("content-type") ?? "", /javascript/);

		// 穿越尝试：编码与未编码两种形态都必须被拒
		for (const path of ["/../store.ts", "/..%2f..%2fstore.ts", "/assets/../../package.json"]) {
			const response = await fetch(`${server.url}${path}`);
			assert.equal(response.status, 404, `${path} 必须被拒绝`);
		}
	} finally {
		await teardown(root, server);
	}
});

test("closing the server frees the port for a new listener and is idempotent", async () => {
	const { root, server } = await setupProject();
	const port = server.port;
	await server.close();
	// 命令与 session_shutdown 钩子都会调 close，重复调用不得 reject
	await server.close();
	let again: CompassWebServer | undefined;
	try {
		again = await startCompassWebServer({ projectRoot: root, port });
		assert.equal(again.port, port);
	} finally {
		await again?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("malformed request targets answer 400 instead of crashing the host process", async () => {
	const { root, server } = await setupProject();
	try {
		// "//" 会让 new URL 同步抛错；若它逃出请求处理链就是 uncaughtException，会终止宿主 pi 会话
		const status = await new Promise<string>((resolvePromise, rejectPromise) => {
			const socket = connect(server.port, "127.0.0.1", () => socket.write("GET // HTTP/1.1\r\nHost: compass\r\n\r\n"));
			socket.setTimeout(3000, () => { socket.destroy(); rejectPromise(new Error("畸形请求无响应")); });
			socket.on("data", (chunk) => { resolvePromise(chunk.toString().split("\r\n")[0]); socket.end(); });
			socket.on("error", rejectPromise);
		});
		assert.match(status, /400/);
		// 进程存活、服务继续可用
		assert.equal((await getJson(`${server.url}/api/health`)).status, 200);
	} finally {
		await teardown(root, server);
	}
});

test("a corrupt store answers 500 rather than masquerading as a client error", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		await writeFile(join(root, ".pi", "compass", "store.json"), "{ not valid json", "utf8");
		const { status, body } = await getJson(`${server.url}/api/overview`);
		assert.equal(status, 500, "store 损坏是服务端故障，不能报成 400 让运营改输入");
		assert.match(body.error ?? "", /读取罗盘数据失败/);
	} finally {
		await teardown(root, server);
	}
});

test("assets are reachable under both /assets/* and root, and pool write paths are not treated as refs", async () => {
	const { root, server } = await setupProject();
	try {
		// app.js 的静态 import 一旦 404，整个模块图加载失败、app.js 一行都不执行，页面会停在
		// index.html 的「正在加载罗盘工作台…」骨架上——不是「报告弹窗坏了」，是整站不可用。
		// 说明符从源码里抽而不是写死清单：将来任何新增 / 改名的前端模块都自动进入守护范围。
		const appSource = await readFile(join(here, "../web/assets/app.js"), "utf8");
		const specifiers = [...appSource.matchAll(/^import[^"']*["']\.\/([^"']+)["']/gm)].map((match) => match[1]);
		assert.ok(specifiers.length > 0, "没能从 app.js 抽出任何相对 import——正则要跟着源码一起改");
		for (const name of ["app.js", ...specifiers]) {
			for (const path of [`/assets/${name}`, `/${name}`]) {
				const response = await fetch(`${server.url}${path}`);
				assert.equal(response.status, 200, `${path} 应可访问`);
				assert.match(response.headers.get("content-type") ?? "", /javascript/);
			}
		}
		// 任务 6 验收标准明确点名：/assets/style.css（不只是根路径 /style.css）必须 200 + 正确 content-type
		for (const path of ["/assets/style.css", "/style.css"]) {
			const response = await fetch(`${server.url}${path}`);
			assert.equal(response.status, 200, `${path} 应可访问`);
			assert.match(response.headers.get("content-type") ?? "", /text\/css/);
		}
		// GET /api/pool/move 不得被当成候选引用去查库（否则报「未找到市场：move」误导排障）
		const move = await getJson(`${server.url}/api/pool/move`);
		assert.equal(move.status, 405);
		assert.match(move.body.error ?? "", /只支持 POST/);
		// 畸形百分号编码返回中文提示而非默认英文 URIError
		const malformed = await getJson(`${server.url}/api/markets/%E0%A4%A`);
		assert.equal(malformed.status, 400);
		assert.match(malformed.body.error ?? "", /编码无效/);
		// 只读端点收到非 GET 也要回 405，而不是含糊的「未知接口」404
		const wrongMethod = await getJson(`${server.url}/api/overview`, { method: "POST" });
		assert.equal(wrongMethod.status, 405);
		assert.match(wrongMethod.body.error ?? "", /只支持 GET/);
	} finally {
		await teardown(root, server);
	}
});

// ⚠️ 本用例当前**只覆盖单来源市场**：setupProject 的夹具全部以 source="sellersprite" 导入，
// 而 metricDivergences 有 `latestBySource.size < 2` 提前退出，所以它走不到会读 sidecar 的那条路径。
// 换句话说 hits===0 在多来源市场上并不成立——那是有意识的取舍，不是这条断言在守护的性质。
// 详见 service.ts 的 installTargetDependentMetrics 注释与 strategy-config-integrity/tasks.md 的
// Deviation 16。要把多来源也钉住，得先决定那条路径该不该改（本次提交只改措辞、不改行为）。
test("read endpoints never touch lazily loaded snapshot detail files", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		// 快照明细（listings/keywords）走 readFileSync，一旦被读端点触碰就会阻塞事件循环
		const repo = new CompassRepository(root);
		const store = await repo.load();
		let hits = 0;
		for (const snapshot of store.snapshots) {
			for (const key of ["listings", "keywords"] as const) {
				const original = Object.getOwnPropertyDescriptor(snapshot, key)?.get;
				if (!original) continue;
				Object.defineProperty(snapshot, key, { enumerable: false, configurable: true, get: () => { hits += 1; return original.call(snapshot); } });
			}
		}
		const markets = (await getJson(`${server.url}/api/markets`)).body;
		const marketId = markets.data.rows[0].marketId;
		for (const path of ["/api/overview", "/api/todos", "/api/markets", "/api/pool", "/api/budget", "/api/retro", `/api/markets/${encodeURIComponent(marketId)}`]) {
			assert.equal((await getJson(`${server.url}${path}`)).status, 200);
		}
		assert.equal(hits, 0, "读端点不应触发快照明细的磁盘加载");
	} finally {
		await teardown(root, server);
	}
});

// 预算 80% 告警是闭环四类里唯一没有代码硬门槛的 kind：端点测试用它，避免依赖深研指标与利润测算
async function seedBudgetWarning(root: string): Promise<string> {
	const month = new Date().toISOString().slice(0, 7);
	await new CompassRepository(root).update((store) => {
		ensureDefaults(store, "test");
		store.costEvents.push({ id: "ce_todo_web", source: "keepa", amountCny: 350, createdAt: `${month}-01T00:00:00.000Z`, actor: "ops" });
	});
	return "todo_budget_warning_keepa";
}

function activeTodoIds(payload: Envelope): string[] {
	const groups = payload.data.groups as Array<{ todos: Array<{ id: string }> }>;
	return groups.flatMap((group) => group.todos).map((todo) => todo.id);
}

test("todo resolution endpoints walk submit → complete → reopen with compass-web attribution", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		const todoId = await seedBudgetWarning(root);
		const initial = (await getJson(`${server.url}/api/todos`)).body;
		assert.ok(activeTodoIds(initial).includes(todoId), "预算告警待办应在活跃清单");

		// 说明为空 / 证据形状非法：400 且不落盘
		const before = await new CompassRepository(root).load();
		const blank = await post(`${server.url}/api/todos/submit`, { todoId, note: "   " });
		assert.equal(blank.status, 400);
		assert.match(blank.body.error ?? "", /处理说明/);
		const badEvidence = await post(`${server.url}/api/todos/submit`, { todoId, note: "已核对用量", evidence: "https://example.com/x" });
		assert.equal(badEvidence.status, 400);
		assert.match(badEvidence.body.error ?? "", /证据/);
		const afterRejects = await new CompassRepository(root).load();
		assert.deepEqual(afterRejects.todoResolutions, before.todoResolutions ?? [], "被拒的提交不得留下记录");

		const submitted = await post(`${server.url}/api/todos/submit`, {
			todoId,
			note: "核对当月用量后决定收紧补数，不提额",
			evidence: [{ ref: "compass-imports/usage.md", note: "用量明细" }],
		});
		assert.equal(submitted.status, 200);
		assert.equal(submitted.body.data.status, "submitted");
		const stored = await new CompassRepository(root).load();
		const record = stored.todoResolutions?.[0];
		assert.equal(record?.todoId, todoId);
		assert.equal(record?.attempts[0].submittedBy, "compass-web", "Web 写操作必须署名 compass-web");
		assert.equal(record?.attempts[0].evidence[0].ref, "compass-imports/usage.md");

		// 未经验证直接勾选：400，且 store 完全没被写过
		const beforeComplete = await new CompassRepository(root).load();
		const early = await post(`${server.url}/api/todos/complete`, { todoId });
		assert.equal(early.status, 400);
		assert.match(early.body.error ?? "", /验证通过/);
		const afterEarly = await new CompassRepository(root).load();
		assert.equal(afterEarly.updatedAt, beforeComplete.updatedAt, "被拒的勾选不得触发写盘");
		assert.equal(afterEarly.todoResolutions?.[0].status, "submitted");

		// Web 侧没有 verify 端点：验证只在 pi 会话由 agent 执行
		assert.equal((await post(`${server.url}/api/todos/verify`, { todoId, verdict: "pass", reason: "x" })).status, 404);
		await new CompassRepository(root).update((store) => {
			verifyTodoResolution(store, { todoRef: todoId, verdict: "pass", reason: "已给出用量结论与后续动作" }, "compass-agent");
		});

		const completed = await post(`${server.url}/api/todos/complete`, { todoId });
		assert.equal(completed.status, 200);
		assert.equal(completed.body.data.status, "resolved");
		const afterComplete = (await getJson(`${server.url}/api/todos`)).body;
		assert.equal(activeTodoIds(afterComplete).includes(todoId), false, "勾选后应离开活跃清单");
		const resolvedRow = afterComplete.data.resolved.find((row: { todoId: string }) => row.todoId === todoId);
		assert.ok(resolvedRow, "勾选后应出现在已处理分区");
		assert.equal(resolvedRow.resolvedBy, "compass-web");
		assert.equal(resolvedRow.verdict, "pass");

		// 重开：理由必填；带理由后回到活跃清单
		assert.equal((await post(`${server.url}/api/todos/reopen`, { todoId })).status, 400);
		const reopened = await post(`${server.url}/api/todos/reopen`, { todoId, reason: "勾错了，实际未处理" });
		assert.equal(reopened.status, 200);
		assert.equal(reopened.body.data.status, "reopened");
		const afterReopen = (await getJson(`${server.url}/api/todos`)).body;
		assert.ok(activeTodoIds(afterReopen).includes(todoId), "重开后应回到活跃清单");
		// 已处理分区只认 status === "resolved"：重开后 resolvedAt 仍在，拿它判定会让条目同时出现在两处
		assert.equal(afterReopen.data.resolved.some((row: { todoId: string }) => row.todoId === todoId), false, "重开后不得留在已处理分区");
		const stillResolved = await new CompassRepository(root).load();
		assert.equal(stillResolved.todoResolutions?.[0].reopens[0].reopenedBy, "compass-web");
	} finally {
		await teardown(root, server);
	}
});

test("todo write endpoints refuse wrong methods and cross-site posts", async () => {
	const { root, server } = await setupProject({ seed: true });
	try {
		const todoId = await seedBudgetWarning(root);
		const payload = JSON.stringify({ todoId, note: "跨站写入", reason: "跨站写入" });
		for (const path of ["/api/todos/submit", "/api/todos/complete", "/api/todos/reopen"]) {
			assert.equal((await getJson(`${server.url}${path}`)).status, 405, `${path} 只允许 POST`);
			const crossSite = await getJson(`${server.url}${path}`, {
				method: "POST",
				headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://evil.example" },
				body: payload,
			});
			assert.ok([403, 415].includes(crossSite.status), `${path} 跨站写入必须被拒绝，实际 ${crossSite.status}`);
			const forgedType = await getJson(`${server.url}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: "https://evil.example" },
				body: payload,
			});
			assert.equal(forgedType.status, 403, `${path} 跨站 Origin 必须被拒绝`);
		}
		const store = await new CompassRepository(root).load();
		assert.deepEqual(store.todoResolutions, [], "被拒绝的跨站请求不得落盘");
	} finally {
		await teardown(root, server);
	}
});

// 写端点防线由源码抽取驱动：路由表是唯一事实来源，新增 /api/ 路径必须自动进入本用例的矩阵。
// ⚠️ 与 M104 同款脆弱点：下面两条正则贴着 web/server.ts 的写法。路由表改形状（例如 WRITE_PATHS
// 改成 Set、或 /api/ 路径改用模板串拼接）时必须同步更新，sanity 断言会先红提醒。
const SERVER_SOURCE_PATH = join(here, "../web/server.ts");
const APP_SOURCE_PATH = join(here, "../web/assets/app.js");

/** 抽 `const WRITE_PATHS = ["...", ...];` 里的字面量 */
function writePathsFromSource(source: string): string[] {
	const block = /const WRITE_PATHS = \[([\s\S]*?)\];/u.exec(source);
	assert.ok(block, "web/server.ts 里找不到 `const WRITE_PATHS = [...];`");
	return [...block[1].matchAll(/"(\/api\/[^"]*)"/gu)].map((match) => match[1]);
}

/** 抽源码里出现的全部 /api/ 双引号字面量（含只读端点、前缀判据与 404 兜底） */
function apiLiteralsFromSource(source: string): string[] {
	return [...new Set([...source.matchAll(/"(\/api\/[^"$]*)"/gu)].map((match) => match[1]))].sort();
}


test("WRITE_PATHS 全部写端点逐条守住三条防线（M101）", async () => {
	const serverSource = await readFile(SERVER_SOURCE_PATH, "utf8");
	const writePaths = writePathsFromSource(serverSource);
	// sanity：抽取规则失效时（路由表改形状）先在这里红，而不是静默变成空矩阵假绿
	assert.ok(writePaths.length >= 7, `只抽到 ${writePaths.length} 个写端点，抽取规则可能已失效`);
	assert.ok(writePaths.includes("/api/import"), "抽取结果里缺 /api/import");

	const { root, server } = await setupProject({ seed: true });
	try {
		// seed 本身带着候选与决策日志，只能比对「跑完这一轮之后有没有多出来」
		const before = await new CompassRepository(root).load();
		const payload = JSON.stringify({ candidateRef: "x", reason: "跨站写入", todoId: "x", note: "跨站写入" });
		for (const path of writePaths) {
			// ① 只允许 POST：GET 必须回 405，不能是含糊的 404
			assert.equal((await getJson(`${server.url}${path}`)).status, 405, `${path} 只允许 POST`);

			// ② 跨站 + text/plain：这是绕过 CORS 预检的经典写法，415 或 403 都算挡住
			const simpleRequest = await getJson(`${server.url}${path}`, {
				method: "POST",
				headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://evil.example" },
				body: payload,
			});
			assert.ok([403, 415].includes(simpleRequest.status), `${path} 跨站简单请求必须被拒绝，实际 ${simpleRequest.status}`);

			// ③ 跨站 + 正确 Content-Type：只剩同源校验能挡，必须是 403
			const crossOrigin = await getJson(`${server.url}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: "https://evil.example" },
				body: payload,
			});
			assert.equal(crossOrigin.status, 403, `${path} 跨站 Origin 必须被拒绝`);

			// ④ 同源 + 错误 Content-Type：必须是 415。②的 `[403, 415]` 或断言在只有 Origin
			// 校验生效时也会通过，Content-Type 这道纵深防御其实一条断言都没盖到——把它从
			// server.ts 删掉，②③ 依然全绿。这一条专门钉死它。
			const wrongType = await getJson(`${server.url}${path}`, {
				method: "POST",
				headers: { "content-type": "text/plain;charset=UTF-8" },
				body: payload,
			});
			assert.equal(wrongType.status, 415, `${path} 非 application/json 必须回 415`);
		}

		// 被拒绝的请求一条都不许落盘
		const after = await new CompassRepository(root).load();
		assert.deepEqual(after.todoResolutions ?? [], before.todoResolutions ?? [], "被拒绝的跨站请求不得写处置记录");
		assert.equal(after.decisionLog.length, before.decisionLog.length, "被拒绝的跨站请求不得写决策日志");
		assert.deepEqual(
			after.candidates.map((c) => [c.id, c.stage]),
			before.candidates.map((c) => [c.id, c.stage]),
			"被拒绝的跨站请求不得改动候选阶段",
		);
	} finally {
		await teardown(root, server);
	}
});

test("前端调用的 /api/ 路径都在服务端路由表里（M101）", async () => {
	const [serverSource, appSource] = await Promise.all([
		readFile(SERVER_SOURCE_PATH, "utf8"),
		readFile(APP_SOURCE_PATH, "utf8"),
	]);
	const served = new Set(apiLiteralsFromSource(serverSource));
	const called = apiLiteralsFromSource(appSource);
	assert.ok(called.length > 0, "前端一个 /api/ 路径都没抽到，抽取规则可能已失效");
	for (const path of called) {
		assert.ok(served.has(path), `前端调用了服务端没有的路径：${path}`);
	}
});

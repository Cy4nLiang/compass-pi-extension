import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performCsvImport } from "../importer.ts";
import { decideCandidate, ensureDefaults, generateMarketReport, moveCandidate } from "../service.ts";
import { CompassRepository, StoreIoError } from "../store.ts";
import { CANDIDATE_STAGES, DECISION_STATUSES, SNAPSHOT_SOURCES, type CandidateStage, type CompassStore, type DecisionStatus } from "../types.ts";
import {
	budgetData,
	marketDossierData,
	marketsData,
	overviewData,
	poolCandidateData,
	poolData,
	retroData,
	todosData,
} from "./data.ts";

// 本地 Web 工作台的 HTTP 层：路由 + envelope + 静态资源。
// 只绑定回环地址、不做鉴权（本机单用户），因此绝不可通过端口转发暴露到 LAN。

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");
const DEFAULT_PORT = 4780;
const DEFAULT_HOST = "127.0.0.1";
// Web 写操作统一署名，便于在 decisionLog 里与 pi 会话、自动计量区分来源
const WEB_ACTOR = "compass-web";
const IMPORTS_DIR_NAME = "compass-imports";
const MAX_BODY_BYTES = 1_000_000;
// 关闭时排空写队列的上限：单个写最长等锁 10 秒，但 session_shutdown 不能被拖太久
const CLOSE_DRAIN_MS = 3_000;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
	".ico": "image/x-icon",
};

export interface CompassWebServerOptions {
	projectRoot: string;
	host?: string;
	port?: number;
}

export interface CompassWebServer {
	url: string;
	port: number;
	close(): Promise<void>;
}

class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload);
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(body);
}

function sendData(response: ServerResponse, store: CompassStore, data: unknown): void {
	sendJson(response, 200, { ok: true, data, meta: { generatedAt: new Date().toISOString(), storeUpdatedAt: store.updatedAt } });
}

function sendError(response: ServerResponse, status: number, message: string): void {
	sendJson(response, status, { ok: false, error: message });
}

// 错误分级靠显式类型而非消息猜测：领域层「引用不存在」在调用点包成 HttpError(404)，
// store 读取失败包成 HttpError(500)；未分类的异常一律按服务端故障（500）处理并留日志
function statusForError(error: unknown): number {
	return error instanceof HttpError ? error.status : 500;
}

// 领域层抛的中文错误绝大多数是「用户给的输入被业务规则拒绝」（400/404）；
// 系统故障由 store.ts 用 StoreIoError 显式标记——按类型判定而非匹配文案，
// 因为底层 fs 错误的措辞由运行时决定，正则白名单必然漏判。
function asDomainError(error: unknown): never {
	if (error instanceof HttpError) throw error;
	if (error instanceof StoreIoError) throw new HttpError(500, error.message);
	// 带 errno code 的一律是文件系统故障（权限、只读挂载、磁盘满）：store.ts 里仍有
	// mkdir/stat/unlink 等零散调用未包成 StoreIoError，这条兜底避免它们被误报成客户端错误
	if (typeof (error as NodeJS.ErrnoException).code === "string") {
		throw new HttpError(500, `罗盘数据读写失败：${error instanceof Error ? error.message : String(error)}`);
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/未找到市场|未找到候选|尚无候选卡|未找到策略|未找到快照/.test(message)) throw new HttpError(404, message);
	throw new HttpError(400, message);
}

// ASSETS_DIR 自身先过 realpath：模块路径含未解析软链时（如 --preserve-symlinks 或把扩展软链进
// .pi/extensions/），未归一化的前缀比对会让所有静态资源误判为越界而整体 404
let assetsRealDir: string | undefined;
async function assetsRoot(): Promise<string> {
	assetsRealDir ??= await realpath(ASSETS_DIR).catch(() => ASSETS_DIR);
	return assetsRealDir;
}

// 请求体读取有上限：本地工具也不该被一个超大 body 拖垮内存
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	let oversized = false;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) {
			// 超限后停止缓存但继续排空：中途中断会让客户端未发完的数据触发连接重置，
			// 400 响应就送不到对面了
			oversized = true;
			continue;
		}
		chunks.push(chunk as Buffer);
	}
	if (oversized) throw new HttpError(400, "请求体过大");
	if (!chunks.length) return {};
	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象");
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new HttpError(400, `请求体解析失败：${error instanceof Error ? error.message : String(error)}`);
	}
}

// 浏览器跨站防护：本服务无鉴权，任何网页都能向 127.0.0.1:4780 发请求。
// 本机任意端口的 Origin 都放行——安全模型是「本机单用户」，而不是隔离本机各应用。
const LOOPBACK_HOST = /^(127(\.\d{1,3}){3}|\[::1\]|localhost\.?)(:\d+)?$/i;

// DNS rebinding 防线：攻击页把自己的域名解析到 127.0.0.1 后，浏览器视其为同源，
// 能读走全量经营数据。所有 /api/ 请求（含只读）都必须校验 Host。
function assertLocalHost(request: IncomingMessage): void {
	const host = request.headers.host;
	if (!host || !LOOPBACK_HOST.test(host)) throw new HttpError(403, "罗盘工作台仅接受来自本机的访问");
}

// 写端点额外挡跨站：Content-Type 为 text/plain 的跨站 POST 不触发预检，
// 靠 Origin 判定；无 Origin（curl/脚本）放行，浏览器的非安全方法必带 Origin。
function assertSameOrigin(request: IncomingMessage): void {
	// 纵深防御：跨站简单请求发不出 application/json（会触发预检，而本服务不返回 CORS 头，
	// 预检必然失败），因此强制该 Content-Type 相当于把写端点挡在预检之外
	const contentType = request.headers["content-type"] ?? "";
	if (!contentType.toLowerCase().startsWith("application/json")) {
		throw new HttpError(415, "写操作的 Content-Type 必须是 application/json");
	}
	const origin = request.headers.origin;
	if (!origin) return;
	let originHost: string;
	try {
		originHost = new URL(origin).host;
	} catch {
		throw new HttpError(403, "请求来源无效");
	}
	if (!LOOPBACK_HOST.test(originHost)) throw new HttpError(403, `拒绝来自 ${origin} 的跨站请求`);
}

function requireString(body: Record<string, unknown>, field: string, label: string): string {
	const value = body[field];
	if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${label}不能为空`);
	return value.trim();
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
	const value = body[field];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function serveAsset(response: ServerResponse, pathname: string): Promise<void> {
	// /assets/* 与根路径平铺两种形态都映射到 web/assets/（spec §5 用 /assets/* 命名空间）
	const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+(assets\/)?/, "");
	const target = resolve(ASSETS_DIR, relativePath);
	// 防目录穿越：解析后必须仍在 assets 目录内
	if (target !== ASSETS_DIR && !target.startsWith(ASSETS_DIR + sep)) {
		sendError(response, 404, "资源不存在");
		return;
	}
	try {
		// realpath 再校验一次：resolve 只做词法归一化，assets 内的符号链接仍可指向目录外
		const root = await assetsRoot();
		const real = await realpath(target);
		if (real !== root && !real.startsWith(root + sep)) {
			sendError(response, 404, "资源不存在");
			return;
		}
		const file = await readFile(target);
		response.writeHead(200, { "content-type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
		response.end(file);
	} catch {
		sendError(response, 404, "资源不存在");
	}
}

export async function startCompassWebServer(options: CompassWebServerOptions): Promise<CompassWebServer> {
	const repo = new CompassRepository(options.projectRoot);
	const host = options.host ?? DEFAULT_HOST;
	const port = options.port ?? DEFAULT_PORT;
	// 绑定非回环地址会让所有请求被 Host 校验拒掉（页面打得开、操作全 403），
	// 而且把内部经营数据暴露到 LAN——启动时就拒绝，不要留半死不活的服务
	if (!LOOPBACK_HOST.test(host) && !LOOPBACK_HOST.test(`${host}:0`)) {
		throw new Error(`罗盘工作台只能绑定本机回环地址，收到：${host}`);
	}

	// 每个请求重新 load：与 pi 进程并发写时始终读到最新快照，且同一请求内数据一致
	async function readStore(): Promise<CompassStore> {
		let store: CompassStore;
		try {
			store = await repo.load();
		} catch (error) {
			// store 损坏/不可读是服务端故障，不能伪装成客户端参数错误让前端提示改输入。
			// store.ts 的错误消息已含路径与原因，这里只补一句可操作的提示
			throw new HttpError(500, `${error instanceof Error ? error.message : String(error)}；请在 pi 中检查罗盘数据文件`);
		}
		// ensureDefaults 在 try 外：它自身的异常不该被贴上「检查数据文件」的误导性提示
		ensureDefaults(store);
		return store;
	}

	// 进程内串行写队列：repo.update 的文件锁只跨进程互斥，同进程的并发写会各自抢锁重试，
	// 排成一列既避免锁竞争，也让写操作的先后顺序可预期
	let writeChain: Promise<unknown> = Promise.resolve();
	function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
		const next = writeChain.then(task, task);
		// 链上只保留时序依赖，不传播失败：一次写失败不该拖垮后续请求
		writeChain = next.then(() => undefined, () => undefined);
		return next;
	}

	function webMutate<T>(mutator: (store: CompassStore) => T): Promise<{ store: CompassStore; result: T }> {
		return enqueueWrite(() => repo.update(async (store) => {
			ensureDefaults(store, WEB_ACTOR);
			return mutator(store);
		}));
	}

	// 路径参数（市场/候选引用）来自 URL，需解码；畸形百分号编码回中文 400 而非默认英文 URIError
	function decodeRef(raw: string, label: string): string {
		try {
			return decodeURIComponent(raw);
		} catch {
			throw new HttpError(400, `${label}编码无效：${raw}`);
		}
	}

	// 只读端点表：先匹配路由再 load store，未命中/未实现的路径不必付全量读盘的代价
	const READ_ROUTES: Array<{ match: (pathname: string) => string | null | undefined; label?: string; build: (store: CompassStore, ref: string) => unknown }> = [
		{ match: (p) => (p === "/api/overview" ? "" : null), build: (store) => overviewData(store) },
		{ match: (p) => (p === "/api/todos" ? "" : null), build: (store) => todosData(store) },
		{ match: (p) => (p === "/api/markets" ? "" : null), build: (store) => marketsData(store) },
		{ match: (p) => (p === "/api/pool" ? "" : null), build: (store) => poolData(store) },
		{ match: (p) => (p === "/api/budget" ? "" : null), build: (store) => budgetData(store) },
		{ match: (p) => (p === "/api/retro" ? "" : null), build: (store) => retroData(store) },
		// ref 只吃单段路径，且不能吞掉 POST-only 的 /api/pool/move|decide
		{ match: (p) => /^\/api\/markets\/([^/]+)$/.exec(p)?.[1], label: "市场引用", build: (store, ref) => marketDossierData(store, ref) },
		{ match: (p) => /^\/api\/pool\/([^/]+)$/.exec(p)?.[1], label: "候选引用", build: (store, ref) => poolCandidateData(store, ref) },
	];

	const WRITE_PATHS = ["/api/pool/move", "/api/pool/decide", "/api/import", "/api/report"];

	// 候选池写端点：阶段流转与终局决策都强制填写理由（服务端兜底，前端也拦一次）
	async function handlePoolWrite(response: ServerResponse, pathname: string, body: Record<string, unknown>): Promise<void> {
		const candidateRef = requireString(body, "candidateRef", "候选引用");
		const reason = requireString(body, "reason", pathname.endsWith("/move") ? "阶段移动理由" : "决策理由");
		if (pathname.endsWith("/move")) {
			const stage = requireString(body, "stage", "目标阶段");
			if (!(CANDIDATE_STAGES as readonly string[]).includes(stage)) throw new HttpError(400, `未知阶段：${stage}`);
			const { store, result } = await webMutate((data) => moveCandidate(data, { candidateRef, stage: stage as CandidateStage, reason, actor: WEB_ACTOR }));
			sendData(response, store, { candidate: { id: result.id, stage: result.stage, stageReason: result.stageReason, updatedAt: result.updatedAt } });
			return;
		}
		const status = requireString(body, "status", "决策状态");
		if (!(DECISION_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, `未知决策状态：${status}`);
		const { store, result } = await webMutate((data) => decideCandidate(data, { candidateRef, status: status as DecisionStatus, reason, actor: WEB_ACTOR }));
		sendData(response, store, { candidate: { id: result.id, decisionStatus: result.decisionStatus, decisionReason: result.decisionReason, decisionAt: result.decisionAt } });
	}

	async function handleImport(response: ServerResponse, body: Record<string, unknown>): Promise<void> {
		const source = optionalString(body, "source");
		// 快照不可变、无修正路径：来源必须先过枚举，脏值会永久污染市场列表与多源校准
		if (source && !(SNAPSHOT_SOURCES as readonly string[]).includes(source)) throw new HttpError(400, `未知数据来源：${source}`);
		if (body.runScreen !== undefined && typeof body.runScreen !== "boolean") throw new HttpError(400, "runScreen 必须是布尔值");
		// capturedAt 同样会进不可变快照与归档文件名：非字符串会被 optionalString 静默换成"现在"
		if (body.capturedAt !== undefined && typeof body.capturedAt !== "string") throw new HttpError(400, "capturedAt 必须是 ISO 时间字符串");
		const outcome = await performCsvImport(
			{ repo, mutate: <T,>(mutator: (store: CompassStore) => T) => webMutate(mutator) },
			{
				path: requireString(body, "path", "CSV 路径"),
				marketName: requireString(body, "marketName", "市场名"),
				source,
				capturedAt: optionalString(body, "capturedAt"),
				actor: WEB_ACTOR,
				runScreen: body.runScreen !== false,
			},
		);
		sendData(response, outcome.store, {
			market: { id: outcome.market.id, name: outcome.market.name },
			snapshot: { id: outcome.snapshot.id, source: outcome.snapshot.source, capturedAt: outcome.snapshot.capturedAt, rowCount: outcome.snapshot.rowCount, warnings: outcome.snapshot.warnings },
			candidate: { id: outcome.candidate.id, stage: outcome.candidate.stage, gateOutcome: outcome.candidate.gateOutcome ?? null, score: outcome.candidate.score ?? null },
			created: outcome.created,
			archivedFile: outcome.archivedFile,
			screenRun: outcome.screenRun ? { id: outcome.screenRun.id, outcome: outcome.screenRun.result.outcome, score: outcome.screenRun.result.score } : null,
		});
	}

	async function handleReport(response: ServerResponse, body: Record<string, unknown>): Promise<void> {
		const marketRef = requireString(body, "marketRef", "市场引用");
		// 报告生成本身只读，但落盘要与其他写操作共用队列，避免与 store 写事务交错
		const { store, report, output } = await enqueueWrite(async () => {
			const current = await repo.load();
			ensureDefaults(current, WEB_ACTOR);
			const generated = generateMarketReport(current, marketRef);
			const target = repo.resolveOutputPath(undefined, `${generated.marketId}-${new Date().toISOString().slice(0, 10)}.md`);
			await repo.writeReport(target, generated.markdown);
			return { store: current, report: generated, output: target };
		});
		sendData(response, store, {
			path: relative(repo.projectRoot, output),
			marketId: report.marketId,
			marketName: report.marketName,
			outcome: report.outcome,
			score: report.score,
			snapshotId: report.snapshotId,
			markdown: report.markdown,
		});
	}

	// 导入向导的文件选择器：只列宿主项目 compass-imports/ 下的 CSV
	async function handleImportFiles(response: ServerResponse): Promise<void> {
		const store = await readStore();
		let dir: string;
		let entries: string[];
		try {
			// 走 resolveInputPath 而非直接拼路径：compass-imports 若是指向项目外的软链，
			// 词法拼接会把项目外的文件名列给前端（导入时才被 canonicalPath 拦下）
			dir = repo.resolveInputPath(IMPORTS_DIR_NAME);
			entries = await readdir(dir);
		} catch {
			// 目录不存在是常态（尚未放过 CSV），返回空列表而非报错
			sendData(response, store, { dir: IMPORTS_DIR_NAME, files: [] });
			return;
		}
		const files = [];
		for (const name of entries.filter((entry) => entry.toLowerCase().endsWith(".csv")).sort()) {
			try {
				const info = await stat(join(dir, name));
				if (info.isFile()) files.push({ name, path: `${IMPORTS_DIR_NAME}/${name}`, size: info.size, mtime: info.mtime.toISOString() });
			} catch {
				// 列目录与 stat 之间文件被移走：跳过该条，不影响其余
			}
		}
		sendData(response, store, { dir: IMPORTS_DIR_NAME, files });
	}

	async function handleApi(request: IncomingMessage, response: ServerResponse, method: string, pathname: string): Promise<void> {
		assertLocalHost(request);
		if (pathname === "/api/health") {
			if (method !== "GET") throw new HttpError(405, `该接口只支持 GET：${pathname}`);
			sendJson(response, 200, { ok: true, data: { status: "ok" }, meta: { generatedAt: new Date().toISOString() } });
			return;
		}
		if (WRITE_PATHS.includes(pathname)) {
			if (method !== "POST") throw new HttpError(405, `该接口只支持 POST：${pathname}`);
			assertSameOrigin(request);
			const body = await readJsonBody(request);
			try {
				if (pathname === "/api/import") return await handleImport(response, body);
				if (pathname === "/api/report") return await handleReport(response, body);
				return await handlePoolWrite(response, pathname, body);
			} catch (error) {
				asDomainError(error);
			}
		}
		if (pathname === "/api/import/files") {
			if (method !== "GET") throw new HttpError(405, `该接口只支持 GET：${pathname}`);
			return handleImportFiles(response);
		}
		for (const route of READ_ROUTES) {
			const ref = route.match(pathname);
			if (ref === null || ref === undefined) continue;
			if (method !== "GET") throw new HttpError(405, `该接口只支持 GET：${pathname}`);
			// 解码先于 load：畸形编码直接回 400，不必先付一次全量读盘
			const decoded = ref ? decodeRef(ref, route.label ?? "引用") : "";
			const store = await readStore();
			try {
				sendData(response, store, route.build(store, decoded));
			} catch (error) {
				asDomainError(error);
			}
			return;
		}
		sendError(response, 404, `未知接口：${pathname}`);
	}

	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		// URL 解析必须在 try 内：畸形 request target（如 "//"）会同步抛 TypeError，
		// 而它发生在 handle() 之前——逃逸出去就是 uncaughtException，会终止宿主 pi 会话。
		// base 用固定占位域名而非 host：IPv6 字面量 host 拼出的 base 本身就是非法 URL。
		let url: URL;
		try {
			url = new URL(request.url ?? "/", "http://compass.invalid");
		} catch {
			sendError(response, 400, "请求路径无效");
			return;
		}
		const method = request.method ?? "GET";
		const handle = async (): Promise<void> => {
			if (url.pathname.startsWith("/api/")) {
				await handleApi(request, response, method, url.pathname);
				return;
			}
			if (method !== "GET") {
				sendError(response, 404, "未知接口");
				return;
			}
			await serveAsset(response, url.pathname);
		};
		handle().catch((error: unknown) => {
			// 客户端中途断开（关页面、取消提交）不是服务端故障：既不打栈也无处写响应。
			// 只认错误码——request.destroyed 在流被正常读完后也会置位，用它会误伤正常的错误响应
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE" || (!response.writable && !response.writableEnded)) {
				response.destroy();
				return;
			}
			const status = statusForError(error);
			// 只有真正的服务端故障才打栈：400/404/405 是正常的契约响应，打栈会淹没真 500
			if (status === 500) console.error(`罗盘 Web 请求失败 ${method} ${url.pathname}：`, error);
			if (response.headersSent) {
				response.end();
				return;
			}
			sendError(response, status, error instanceof Error ? error.message : String(error));
		});
	});

	await new Promise<void>((resolvePromise, rejectPromise) => {
		const onError = (error: NodeJS.ErrnoException): void => {
			rejectPromise(error.code === "EADDRINUSE" ? new Error(`端口 ${port} 已被占用，请换一个端口启动罗盘 Web 工作台`) : error);
		};
		server.once("error", onError);
		server.listen(port, host, () => {
			server.removeListener("error", onError);
			// 启动后仍需常驻 error 监听：否则运行期 socket 错误会变成 uncaughtException 打崩宿主
			server.on("error", (error) => console.error("罗盘 Web 服务错误：", error));
			resolvePromise();
		});
	});

	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;
	// memoize 而非布尔位：并发调用共享同一个 promise，首次失败也能被后续调用者看到
	let closePromise: Promise<void> | undefined;
	return {
		// IPv6 字面量地址在 URL 里必须加方括号
		url: `http://${host.includes(":") ? `[${host}]` : host}:${actualPort}`,
		port: actualPort,
		// 幂等：命令与 session_shutdown 钩子都会调 close，重复调用不得 reject
		close: () => (closePromise ??= (async () => {
			const closed = new Promise<void>((resolvePromise, rejectPromise) => {
				// close() 先行：立即停止 accept，drain 期间不会有新写排进队尾
				server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
			});
			// 再排空写队列：写请求可能在等 store 文件锁（最长 10 秒），直接掐断会让
			// 运营看到网络错误却不知道事务是否已提交。超时兜底，避免拖住宿主退出
			await Promise.race([writeChain, new Promise((r) => setTimeout(r, CLOSE_DRAIN_MS).unref())]).catch(() => undefined);
			const sweep = setInterval(() => server.closeIdleConnections(), 50);
			const deadline = setTimeout(() => server.closeAllConnections(), 500);
			sweep.unref();
			deadline.unref();
			try {
				await closed;
			} finally {
				clearInterval(sweep);
				clearTimeout(deadline);
			}
		})()),
	};
}

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	getMarkdownTheme,
	isToolCallEventType,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DOMAIN_TOOLS, rankTools, searchTerms } from "./catalog.ts";
import { compareSnapshotRecencyDesc, snapshotTtlDays } from "./defaults.ts";
import { estimateProfit, normalizeProfitInput } from "./economics.ts";
import { capHistoryLines, marketMatchesPrompt, renderHistoryBrief, renderSessionLedger, retroReportFileName, type SessionLedgerItem } from "./history.ts";
import { performCsvImport } from "./importer.ts";
import {
	backtestStrategies,
	type BacktestAlignmentSide,
	budgetMonth,
	budgetStatus,
	buildStrategyContext,
	candidateDetail,
	classifyMcpToolResult,
	cloneStrategy,
	completeTodoResolution,
	configureBudget,
	createLead,
	decideCandidate,
	ensureDefaults,
	findTodoResolution,
	evaluateMcpGate,
	findCandidate,
	findDuplicateImport,
	findMarket,
	findStrategyVersion,
	generateRetroReport,
	historyLessons,
	historyOutcomes,
	historySearch,
	historySimilar,
	historyTimeline,
	importContentHash,
	importHistoryNote,
	latestSnapshotIfPresent,
	leadHistoryNote,
	listPoolCandidates,
	listRetroDue,
	listWorkbenchTodos,
	marketAmazonLinks,
	generateMarketReport,
	listStrategies,
	moveCandidate,
	recordCost,
	recordMcpUsage,
	recordProfitEstimate,
	recordReviewAnalysis,
	recordRetroActuals,
	recordRisk,
	reopenTodoResolution,
	resolveProfitCpc,
	retireLesson,
	runStrategy,
	saveLesson,
	submitTodoResolution,
	todoResolutionReviewGuide,
	verifyTodoResolution,
	saveStrategyVersion,
	scanMarkets,
	decisionHistoryNote,
	performRetroCheck,
	strategyHistoryNote,
} from "./service.ts";
import { CompassRepository } from "./store.ts";
import { DEEP_RESEARCH_REQUIRED_FIELDS, todoResolutionBadge } from "./todo.ts";
import { CANDIDATE_STAGES, DECISION_LOG_TYPES, DECISION_STATUSES, GATE_OUTCOMES, POLICY_FLAGS, REVIEW_THEME_CATEGORIES, REVIEW_THEME_FIXABILITIES, RISK_STATUSES, SEASON_FLAGS, SNAPSHOT_SOURCES, STRATEGY_MODES, TODO_KINDS, TODO_RESOLUTION_STATUS_LABELS, TODO_RESOLUTION_STATUSES, type CandidateStage, type CompassStore, type DecisionLog, type DecisionStatus, type OutcomeActuals, type ReviewTheme } from "./types.ts";
import { compactDashboardSummary, CompassDashboard } from "./ui.ts";
import { startCompassWebServer, type CompassWebServer } from "./web/server.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));
const TOOL_DETAILS_KIND = "compass-result";
const METER_ACTOR = "compass-meter";
// compass_todo 验证工作台单次展开的待验证条目上限：每条含说明/证据/审查要点，超出部分显式提示
const WORKBENCH_QUEUE_LIMIT = 20;

interface CompassDetails {
	kind: typeof TOOL_DETAILS_KIND;
	title: string;
	status: "success" | "warning" | "error" | "info";
	summary: string;
	lines?: string[];
	path?: string;
	data?: unknown;
}

interface CompassResultData {
	payload?: unknown;
	historyNote?: string[];
	touch?: {
		marketId?: string;
		candidateId?: string;
		action: string;
		conclusion: string;
		ids?: string[];
	};
}

const HISTORY_INTENT_TERMS = new Set([
	"amazon", "asin", "compass", "罗盘", "亚马逊", "选品", "精铺", "卖家精灵", "西柚", "sorftime",
	"粗筛", "候选池", "市场快照", "利润测算", "复盘", "回测", "错杀", "no_go", "waitlist",
]);

function resultData(input: CompassResultData): CompassResultData {
	return input;
}

function pathIsHistoryStore(cwd: string, rawPath: string): boolean {
	const cleaned = rawPath.replace(/^@/u, "");
	const unresolved = resolve(isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned));
	let absolute = unresolved;
	try {
		absolute = realpathSync(unresolved);
	} catch {
		// Let the built-in tool report missing paths; lexical checks still apply.
	}
	let compassRoot = resolve(cwd, CONFIG_DIR_NAME, "compass");
	try {
		compassRoot = realpathSync(compassRoot);
	} catch {
		// The data directory may not exist yet.
	}
	const storePath = resolve(compassRoot, "store.json");
	const snapshotsRoot = resolve(compassRoot, "snapshots");
	const rel = relative(snapshotsRoot, absolute);
	return absolute === storePath || absolute === snapshotsRoot || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) || absolute === compassRoot;
}

function bashReadsHistoryStore(cwd: string, command: string): boolean {
	if (!/(?:^|[;&|]\s*|\s|\/)(?:cat|less|more|jq|head|tail|grep|rg|sed|awk)\b/u.test(command)) return false;
	const escapedConfig = CONFIG_DIR_NAME.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const pathPattern = new RegExp(`(?:${escapedConfig}|\\.pi)[/\\\\]compass[/\\\\](?:store\\.json|snapshots(?:[/\\\\]|\\b))`, "iu");
	if (pathPattern.test(command)) return true;
	const compassDirectory = new RegExp(`(?:${escapedConfig}|\\.pi)[/\\\\]compass(?:[/\\\\]snapshots)?\\b`, "iu");
	if (compassDirectory.test(command) && /(?:store\.json|snapshots|\.json)\b/iu.test(command)) return true;
	const absoluteStore = resolve(cwd, CONFIG_DIR_NAME, "compass", "store.json");
	const absoluteSnapshots = resolve(cwd, CONFIG_DIR_NAME, "compass", "snapshots");
	return command.includes(absoluteStore) || command.includes(absoluteSnapshots);
}

function actorName(explicit?: string): string {
	return explicit?.trim() || process.env.USER || process.env.USERNAME || "pi-user";
}

function details(input: Omit<CompassDetails, "kind">): CompassDetails {
	return { kind: TOOL_DETAILS_KIND, ...input };
}

function textResult(text: string, toolDetails: CompassDetails) {
	// Reserve room for the tool_result history note while keeping the final result under 45KB / 1500 lines.
	const truncated = truncateHead(text, { maxBytes: 42_000, maxLines: 1_488 });
	const suffix = truncated.truncated
		? toolDetails.path
			? "\n\n[输出已截断；完整内容已保存到结果中的 path。]"
			: "\n\n[输出已截断；请缩小查询范围后重试。]"
		: "";
	return {
		content: [{ type: "text" as const, text: truncated.content + suffix }],
		details: toolDetails,
	};
}

function renderCallLabel(label: string) {
	return (args: Record<string, unknown>, theme: any) => {
		const reference = args.market_ref ?? args.market ?? args.path ?? args.action ?? args.query ?? "";
		return new Text(
			theme.fg("toolTitle", theme.bold(`${label} `)) + theme.fg("muted", String(reference)),
			0,
			0,
		);
	};
}

function renderCompassResult(result: any, options: { expanded: boolean; isPartial?: boolean }, theme: any) {
	if (options.isPartial) return new Text(theme.fg("warning", "罗盘处理中…"), 0, 0);
	const value = result.details as CompassDetails | undefined;
	if (!value || value.kind !== TOOL_DETAILS_KIND) {
		const first = result.content?.[0];
		return new Text(first?.type === "text" ? first.text : "", 0, 0);
	}
	const color = value.status === "success" ? "success" : value.status === "warning" ? "warning" : value.status === "error" ? "error" : "accent";
	let output = `${theme.fg(color, value.status === "success" ? "✓" : value.status === "warning" ? "!" : "•")} ${theme.fg("toolTitle", theme.bold(value.title))}`;
	output += `\n${theme.fg("muted", value.summary)}`;
	if (options.expanded && value.lines?.length) output += `\n${value.lines.map((line) => theme.fg("dim", line)).join("\n")}`;
	if (value.path) output += `\n${theme.fg("accent", value.path)}`;
	return new Text(output, 0, 0);
}

export default function compassExtension(pi: ExtensionAPI): void {
	const repository = (ctx: ExtensionContext) => new CompassRepository(ctx.cwd, CONFIG_DIR_NAME);
	let historyBriefEnabled = true;
	let dueNotified = false;
	const briefedMarkets = new Set<string>();
	const sessionLedger: SessionLedgerItem[] = [];
	// 未落盘的 MCP 计量：server → tool → 次数。热路径 hook 只做内存自增（不变式：hook 零写事务），
	// 在安全点（任意写事务顺带 / 打开工作台 / 查预算与待办 / 正常退出）统一落账
	const pendingUsage = new Map<string, Map<string, number>>();
	// tool_call 拦截的廉价预过滤缓存：避免为每个无关工具调用做 repo.load()
	let cachedPoolSources: string[] = [];
	// 当前会话持有的 Web 工作台句柄：/compass-web 启动、session_shutdown 兜底关闭。
	// 存 Promise 而非 resolve 后的结果——在 startCompassWebServer 尚未 resolve 时赋值，
	// 使 session_shutdown（可能在 quit/reload/new/resume/fork 时于此期间触发）与并发的
	// 第二次 /compass-web 调用都能看到"启动已在进行中"而不是误判为空，等它一起 await，
	// 不会留下一个谁都关不掉的孤儿监听服务
	let webServerPromise: Promise<CompassWebServer> | undefined;

	function rememberPools(store: CompassStore): void {
		cachedPoolSources = store.budgetPools.map((pool) => pool.source);
	}

	function addPendingUsage(server: string, tool: string, calls = 1): void {
		let tools = pendingUsage.get(server);
		if (!tools) {
			tools = new Map();
			pendingUsage.set(server, tools);
		}
		tools.set(tool, (tools.get(tool) ?? 0) + calls);
	}

	function pendingCallCounts(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const [server, tools] of pendingUsage) {
			let total = 0;
			for (const calls of tools.values()) total += calls;
			if (total > 0) counts[server] = total;
		}
		return counts;
	}

	function drainPendingUsage(): Array<{ server: string; tool: string; calls: number }> {
		const drained: Array<{ server: string; tool: string; calls: number }> = [];
		for (const [server, tools] of pendingUsage) {
			for (const [tool, calls] of tools) drained.push({ server, tool, calls });
		}
		pendingUsage.clear();
		return drained;
	}

	function restorePendingUsage(entries: Array<{ server: string; tool: string; calls: number }>): void {
		for (const entry of entries) addPendingUsage(entry.server, entry.tool, entry.calls);
	}

	function rememberTouch(touch: CompassResultData["touch"]): void {
		if (!touch) return;
		sessionLedger.push({ at: new Date().toISOString(), ...touch });
		if (sessionLedger.length > 100) sessionLedger.splice(0, sessionLedger.length - 100);
	}

	function assertTrusted(ctx: ExtensionContext): void {
		if (!ctx.isProjectTrusted()) throw new Error("罗盘拒绝读取未受信任项目的数据配置");
	}

	async function readStore(ctx: ExtensionContext): Promise<CompassStore> {
		assertTrusted(ctx);
		const store = await repository(ctx).load();
		ensureDefaults(store);
		rememberPools(store);
		return store;
	}

	// 安全点统一入口：drain pending 并落账，返回 drained 供调用方在事务失败时还回
	function flushPendingUsage(store: CompassStore): Array<{ server: string; tool: string; calls: number }> {
		if (!pendingUsage.size) return [];
		const drained = drainPendingUsage();
		try {
			recordMcpUsage(store, drained, METER_ACTOR);
		} catch (error) {
			// 还回责任自包含：落账抛错时调用方拿不到 drained，此处即时还回避免本批丢失
			restorePendingUsage(drained);
			throw error;
		}
		return drained;
	}

	async function mutateStore<T>(ctx: ExtensionContext, mutator: (store: CompassStore) => T | Promise<T>): Promise<{ store: CompassStore; result: T }> {
		assertTrusted(ctx);
		const repo = repository(ctx);
		const drained: Array<{ server: string; tool: string; calls: number }> = [];
		let value: { store: CompassStore; result: T };
		try {
			value = await withFileMutationQueue(repo.storePath, () => repo.update(async (store) => {
				ensureDefaults(store);
				// 计量顺带落账：与业务变更同一事务原子写入（安全点之一）
				drained.push(...flushPendingUsage(store));
				return mutator(store);
			}));
		} catch (error) {
			// 事务失败（含业务 mutator 抛错）：计数还回内存，等下个安全点重试。
			// try 只包事务本体：提交成功后的收尾抛错不再误触还回而双计
			if (drained.length) restorePendingUsage(drained);
			throw error;
		}
		rememberPools(value.store);
		refreshStatus(ctx, value.store);
		return value;
	}

	// 查看类表面（预算/待办/工作台）在有未落盘计量时先 flush 再读；flush 失败（锁竞争/磁盘）
	// 降级为纯读，绝不打断查看操作——计数已还回内存，下个安全点重试（spec 4.2.5）
	async function readStoreFlushingUsage(ctx: ExtensionContext): Promise<CompassStore> {
		if (!pendingUsage.size) return readStore(ctx);
		try {
			return (await mutateStore(ctx, () => undefined)).store;
		} catch {
			return readStore(ctx);
		}
	}

	function refreshStatus(ctx: ExtensionContext, store: CompassStore): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus("compass", ctx.ui.theme.fg("accent", `罗盘 ${compactDashboardSummary(store)}`));
		} catch {
			// 状态栏是装饰性派生视图：推导失败跳过刷新，不把已提交的写事务上抛成工具失败
		}
	}

	async function performImport(
		ctx: ExtensionContext,
		input: {
			path: string;
			marketName: string;
			source?: string;
			keywords?: string[];
			capturedAt?: string;
			actor?: string;
			runScreen?: boolean;
		},
	) {
		// 信任检查前置：未受信任项目在读文件/归档之前就拒绝（原实现在查重读 store 时才触发）
		assertTrusted(ctx);
		return performCsvImport(
			{ repo: repository(ctx), mutate: <T,>(mutator: (store: CompassStore) => T) => mutateStore(ctx, mutator) },
			{ ...input, actor: actorName(input.actor) },
		);
	}

	pi.registerTool({
		name: "compass_lead",
		label: "Compass Lead",
		description: "把词根、竞品店铺或榜单灵感建立为市场线索和 lead 候选卡；不要求已有数据快照，后续再用 CSV 或连接器补数。",
		parameters: Type.Object({
			market_name: Type.String({ minLength: 1 }),
			keywords: Type.Optional(Type.Array(Type.String())),
			category: Type.Optional(Type.String()),
			owner: Type.Optional(Type.String()),
			tags: Type.Optional(Type.Array(Type.String())),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const { result, store } = await mutateStore(ctx, (store) => createLead(store, {
				marketName: params.market_name,
				keywords: params.keywords,
				category: params.category,
				owner: params.owner,
				tags: params.tags,
				actor: actorName(params.actor),
			}));
			const summary = `${result.created ? "创建" : "更新"}线索 ${result.market.name} · ${result.market.keywords.length} 个关键词`;
			return textResult(`${summary}\nmarket_id=${result.market.id}\ncandidate_id=${result.candidate.id}\nstage=${result.candidate.stage}`, details({
				title: "市场线索",
				status: "success",
				summary,
				lines: ["下一步：导入 CSV 建立首个市场快照"],
				data: resultData({ historyNote: leadHistoryNote(store, result.market.id), touch: { marketId: result.market.id, candidateId: result.candidate.id, action: "lead", conclusion: summary, ids: [result.candidate.id] } }),
			}));
		},
		renderCall: renderCallLabel("compass_lead"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_import_csv",
		label: "Compass Import CSV",
		description: "导入项目内卖家精灵、Sorftime、Keepa 或通用 CSV，自动识别字段，归档原文件，创建带时间戳的市场快照和候选卡；输出不超过45KB。",
		parameters: Type.Object({
			path: Type.String({ description: "项目内 CSV 路径；可带前导 @" }),
			market_name: Type.String({ minLength: 1, description: "细分市场/关键词族名称" }),
			source: Type.Optional(StringEnum(SNAPSHOT_SOURCES)),
			keywords: Type.Optional(Type.Array(Type.String())),
			captured_at: Type.Optional(Type.String({ description: "采集时间，默认当前时间。口径（批次三的显式契约）：`YYYY-MM-DD` 按 UTC 零点解释；带时区的完整 ISO（如 2026-09-01T10:00:00+08:00）按其时区解释；**`YYYY/MM/DD` 与不带时区的 ISO 按运行机器的本地时区解释**——UTC+8 下 `2026/09/01` 会落到 `2026-08-31T16:00Z`，即前一个 UTC 日，可能导致新导入被判定为旧于已有快照。要跨机器一致请始终用 `YYYY-MM-DD` 或带时区的完整 ISO。取值须落在 [2000-01-01, 当前时间+36 小时] 内。" })),
			run_screen: Type.Optional(Type.Boolean({ description: "导入后运行默认粗筛 Gate；默认 true" })),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `正在解析 ${params.path}…` }], details: details({ title: "CSV 导入", status: "info", summary: "解析并归档原始快照" }) });
			const imported = await performImport(ctx, {
				path: params.path,
				marketName: params.market_name,
				source: params.source,
				keywords: params.keywords,
				capturedAt: params.captured_at,
				runScreen: params.run_screen,
				actor: params.actor,
			});
			const outcome = imported.screenRun?.result.outcome ?? "未运行";
			const summary = `${imported.created ? "创建" : "更新"} ${imported.market.name}：${imported.parsed.listings.length} listings / ${imported.parsed.keywords.length} keywords；粗筛=${outcome}`;
			return textResult(
				`${summary}\nmarket_id=${imported.market.id}\ncandidate_id=${imported.candidate.id}\nsnapshot_id=${imported.snapshot.id}${imported.outcomeCheck ? `\noutcome_check_id=${imported.outcomeCheck.id}\nretro_verdict=${imported.outcomeCheck.verdict}` : ""}\nraw=${imported.archivedFile}\nwarnings=${imported.parsed.warnings.join("；") || "无"}`,
				details({
					title: "CSV 已入库",
					status: imported.screenRun?.result.outcome === "reject" || imported.outcomeCheck?.verdict === "challenged" ? "warning" : "success",
					summary,
					path: imported.archivedFile,
					lines: imported.parsed.warnings,
					data: resultData({
						historyNote: importHistoryNote(imported.store, imported.market.id, imported.snapshot.id, imported.outcomeCheck),
						touch: { marketId: imported.market.id, candidateId: imported.candidate.id, action: "import", conclusion: summary, ids: [imported.snapshot.id, ...(imported.outcomeCheck ? [imported.outcomeCheck.id] : [])] },
					}),
				}),
			);
		},
		renderCall: renderCallLabel("compass_import_csv"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_market_scan",
		label: "Compass Market Scan",
		description: "扫描已导入的本地市场快照，按默认或指定策略做粗筛，并按综合分排序。可过滤 Gate、QRD、新品占比和 CPC 承受度；输出不超过45KB。",
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			strategy_id: Type.Optional(Type.String({ description: "策略 id、名称或 id@vN（写 @vN 锁定历史版本，不写则用最新版）" })),
			outcome: Type.Optional(StringEnum(GATE_OUTCOMES)),
			min_qrd: Type.Optional(Type.Number({ minimum: 0 })),
			min_new_listing_share: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			max_cpc_ratio: Type.Optional(Type.Number({ minimum: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const store = await readStore(ctx);
			const rows = scanMarkets(store, {
				query: params.query,
				strategyRef: params.strategy_id,
				outcome: params.outcome,
				minQrd: params.min_qrd,
				minNewListingShare: params.min_new_listing_share,
				maxCpcRatio: params.max_cpc_ratio,
				limit: params.limit,
			});
			const table = ["market_id | 市场 | Gate | Score | QRD | 新品占比 | 快照年龄", ...rows.map((row) => {
				const qrd = row.qrd ?? "—";
				const newShare = row.snapshot.metrics.new_listing_share_12m?.value;
				return `${row.market.id} | ${row.market.name} | ${row.evaluation.outcome} | ${row.evaluation.score} | ${qrd} | ${typeof newShare === "number" ? `${(newShare * 100).toFixed(1)}%` : "—"} | ${row.ageDays}d`;
			})];
			return textResult(table.join("\n"), details({ title: "市场扫描", status: rows.length ? "success" : "warning", summary: `命中 ${rows.length} 个市场`, lines: table.slice(1, 11), data: rows.map((row) => ({ marketId: row.market.id, outcome: row.evaluation.outcome, score: row.evaluation.score })) }));
		},
		renderCall: renderCallLabel("compass_market_scan"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_market_report",
		label: "Compass Market Report",
		description: "为一个市场生成完整五维 GSE 报告，包含数据来源、时间、置信度、多源偏差、风险、利润与决策回放，并写入项目 .pi/compass/reports；自定义 output_path 也必须位于该目录内且使用 .md；输出不超过45KB。",
		parameters: Type.Object({
			market_ref: Type.String({ description: "market_id 或唯一市场名称" }),
			strategy_id: Type.Optional(Type.String({ description: "策略 id、名称或 id@vN（写 @vN 锁定历史版本，不写则用最新版）" })),
			output_path: Type.Optional(Type.String({ description: ".pi/compass/reports/ 内的 Markdown 输出路径（必须为 .md）" })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const store = await readStore(ctx);
			const report = generateMarketReport(store, params.market_ref, params.strategy_id);
			const repo = repository(ctx);
			const fallback = `${report.marketId}-${new Date().toISOString().slice(0, 10)}.md`;
			const output = repo.resolveOutputPath(params.output_path, fallback);
			await withFileMutationQueue(output, () => repo.writeReport(output, report.markdown));
			const path = relative(ctx.cwd, output);
			return textResult(report.markdown, details({ title: `选品报告 · ${report.marketName}`, status: report.outcome === "pass" ? "success" : "warning", summary: `${report.outcome} · ${report.score.toFixed(1)}分 · ${report.snapshotId}`, path }));
		},
		renderCall: renderCallLabel("compass_market_report"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_profit_estimate",
		label: "Compass Profit Estimate",
		description: "按内置利润模型计算落地成本、毛利率、盈亏平衡 CPC、CPC 承受度、退货损失、TACOS 三情景净利、启动资金与回本周期；关联市场时写入证据链。",
		parameters: Type.Object({
			market_ref: Type.Optional(Type.String()),
			sale_price: Type.Number({ exclusiveMinimum: 0 }),
			purchase_cost: Type.Number({ minimum: 0 }),
			first_mile_cost: Type.Optional(Type.Number({ minimum: 0 })),
			tariff_cost: Type.Optional(Type.Number({ minimum: 0 })),
			referral_rate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			fba_fee: Type.Number({ minimum: 0 }),
			cvr: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			cpc: Type.Optional(Type.Number({ minimum: 0 })),
			return_rate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			return_processing_fee: Type.Optional(Type.Number({ minimum: 0 })),
			residual_value: Type.Optional(Type.Number({ minimum: 0 })),
			daily_units: Type.Optional(Type.Number({ minimum: 0 })),
			stock_days: Type.Optional(Type.Number({ minimum: 0 })),
			test_ad_budget: Type.Optional(Type.Number({ minimum: 0 })),
			one_time_costs: Type.Optional(Type.Number({ minimum: 0 })),
			portfolio_capital: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
			tacos_scenarios: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 1 }), { minItems: 1, maxItems: 8 })),
			currency: Type.Optional(Type.String()),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			let marketId: string | undefined;
			let cpc = params.cpc;
			if (params.market_ref) {
				const store = await readStore(ctx);
				const market = findMarket(store, params.market_ref);
				marketId = market.id;
				cpc = resolveProfitCpc(store, market.id, cpc);
			}
			const input = normalizeProfitInput({
				marketId,
				salePrice: params.sale_price,
				purchaseCost: params.purchase_cost,
				firstMileCost: params.first_mile_cost,
				tariffCost: params.tariff_cost,
				referralRate: params.referral_rate,
				fbaFee: params.fba_fee,
				cvr: params.cvr,
				cpc,
				returnRate: params.return_rate,
				returnProcessingFee: params.return_processing_fee,
				residualValue: params.residual_value,
				dailyUnits: params.daily_units,
				stockDays: params.stock_days,
				testAdBudget: params.test_ad_budget,
				oneTimeCosts: params.one_time_costs,
				portfolioCapital: params.portfolio_capital,
				tacosScenarios: params.tacos_scenarios,
				currency: params.currency,
			});
			const result = estimateProfit(input);
			let estimateId: string | undefined;
			if (marketId) {
				const recorded = await mutateStore(ctx, (store) => recordProfitEstimate(store, input, result, actorName(params.actor)));
				estimateId = recorded.result.id;
			}
			const scenarios = result.netMarginScenarios.map((scenario, index) => `TACOS ${(scenario.tacos * 100).toFixed(0)}% => 净利率 ${(scenario.netMargin * 100).toFixed(1)}%，月净利 ${result.monthlyNetProfitScenarios[index].monthlyNetProfit.toFixed(2)}，回本 ${result.paybackMonthsScenarios[index].paybackMonths ?? "不可"} 月`);
			const summary = `毛利 ${(result.grossMargin * 100).toFixed(1)}% · BE-CPC ${result.breakEvenCpc.toFixed(2)} · CPC承受度 ${result.cpcRatio?.toFixed(2) ?? "缺数据"} · 启动资金 ${result.startupCapital.toFixed(2)}`;
			return textResult([summary, ...scenarios, ...result.warnings.map((warning) => `警告：${warning}`), estimateId ? `estimate_id=${estimateId}` : "未关联市场，未持久化"].join("\n"), details({ title: "利润测算", status: result.grossMargin >= 0.4 && result.cpcRatio !== undefined && result.cpcRatio <= 0.8 ? "success" : "warning", summary, lines: [...scenarios, ...result.warnings] }));
		},
		renderCall: renderCallLabel("compass_profit_estimate"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_strategy_run",
		label: "Compass Strategy Run",
		description: "在指定市场快照上运行版本化 GSE 策略。screen 只跑市场粗筛；full 跑需求、竞争、单位经济、产品力和风险。缺数据一律转复核，不伪装成通过。",
		parameters: Type.Object({
			market_ref: Type.String(),
			strategy_id: Type.Optional(Type.String({ description: "策略 id、名称或 id@vN（写 @vN 锁定历史版本，不写则用最新版）" })),
			mode: Type.Optional(StringEnum(STRATEGY_MODES)),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const { result: run, store } = await mutateStore(ctx, (store) => runStrategy(store, {
				marketRef: params.market_ref,
				strategyRef: params.strategy_id,
				mode: params.mode ?? "full",
				actor: actorName(params.actor),
				// 运营/agent 显式重跑：这条才算对 retro_challenged 的处置动作
				trigger: "manual",
			}));
			const failures = run.result.rules.filter((rule) => rule.status !== "pass");
			const lines = failures.map((rule) => `[${rule.status}] ${rule.stage}/${rule.id}: ${rule.message}`);
			const summary = `${run.result.outcome} · ${run.result.score.toFixed(1)}分 · ${failures.length} 个非通过项`;
			return textResult([`run_id=${run.id}`, summary, ...lines, `missing=${run.result.missingMetrics.join(",") || "无"}`].join("\n"), details({
				title: `策略运行 · ${run.mode}`,
				status: run.result.outcome === "pass" ? "success" : "warning",
				summary,
				lines,
				data: resultData({ payload: run.result, historyNote: strategyHistoryNote(store, run), touch: { marketId: run.marketId, action: "strategy", conclusion: summary, ids: [run.id, run.snapshotId] } }),
			}));
		},
		renderCall: renderCallLabel("compass_strategy_run"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_strategy_manage",
		label: "Compass Strategy Manage",
		description: "管理个性化策略：list 列最新版本，get 读取 YAML，save 将 YAML 保存为不可覆盖的新版本，clone 复制模板。save 的归属由 YAML 的 meta.name 决定（可另传 strategy_id 声明目标策略链，不一致会报错）；只改显示名请改 meta.display_name。表达式由安全 DSL 解释器执行，不使用 eval。",
		parameters: Type.Object({
			action: StringEnum(["list", "get", "save", "clone"] as const),
			strategy_id: Type.Optional(Type.String({ description: "策略 id、名称或 id@vN（写 @vN 锁定历史版本，不写则用最新版）" })),
			yaml: Type.Optional(Type.String()),
			new_name: Type.Optional(Type.String()),
			change_note: Type.Optional(Type.String()),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (params.action === "list") {
				const store = await readStore(ctx);
				const strategies = listStrategies(store);
				const lines = strategies.map((strategy) => `${strategy.id}@v${strategy.version} | ${strategy.name} | ${strategy.createdAt.slice(0, 10)} | ${strategy.actor}`);
				return textResult(lines.join("\n") || "无策略", details({ title: "策略中心", status: "success", summary: `${strategies.length} 个策略`, lines }));
			}
			if (params.action === "get") {
				if (!params.strategy_id) throw new Error("get 需要 strategy_id");
				const strategy = findStrategyVersion(await readStore(ctx), params.strategy_id);
				return textResult(strategy.yaml, details({ title: `${strategy.name}@v${strategy.version}`, status: "success", summary: strategy.changeNote ?? "无版本说明" }));
			}
			if (params.action === "save") {
				if (!params.yaml) throw new Error("save 需要 yaml");
				const { result: strategy } = await mutateStore(ctx, (store) => {
					// 传了 strategy_id 就是「往这条已有链追加版本」：先确认链存在，
					// 再把解析出的 id 交给 saveStrategyVersion 与 meta.name 对账，不一致就报错而不是静默新建
					const expectedId = params.strategy_id ? findStrategyVersion(store, params.strategy_id).id : undefined;
					return saveStrategyVersion(store, { yaml: params.yaml as string, actor: actorName(params.actor), changeNote: params.change_note, expectedId });
				});
				return textResult(`${strategy.id}@v${strategy.version}\n${strategy.yaml}`, details({ title: "策略版本已保存", status: "success", summary: `${strategy.name}@v${strategy.version}` }));
			}
			if (!params.strategy_id || !params.new_name) throw new Error("clone 需要 strategy_id 与 new_name");
			const { result: strategy } = await mutateStore(ctx, (store) => cloneStrategy(store, { sourceRef: params.strategy_id as string, newName: params.new_name as string, actor: actorName(params.actor), changeNote: params.change_note }));
			return textResult(`${strategy.id}@v${strategy.version}\n${strategy.yaml}`, details({ title: "策略已复制", status: "success", summary: `${strategy.name}@v${strategy.version}` }));
		},
		renderCall: renderCallLabel("compass_strategy_manage"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_pool",
		label: "Compass Candidate Pool",
		description: "查看、移动或记录候选卡最终决策（go/waitlist/no_go）。move/decide 都强制填写 reason，并把所有状态变化的快照、策略、决策人和时间写入 decision_log。",
		parameters: Type.Object({
			action: StringEnum(["list", "get", "move", "decide"] as const),
			candidate_ref: Type.Optional(Type.String({ description: "candidate_id、market_id 或唯一市场名" })),
			stage: Type.Optional(StringEnum(CANDIDATE_STAGES)),
			outcome: Type.Optional(StringEnum(GATE_OUTCOMES)),
			decision_status: Type.Optional(StringEnum(DECISION_STATUSES)),
			reason: Type.Optional(Type.String()),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (params.action === "move") {
				if (!params.candidate_ref || !params.stage || !params.reason) throw new Error("move 需要 candidate_ref、stage、reason");
				const { result: candidate, store } = await mutateStore(ctx, (data) => moveCandidate(data, { candidateRef: params.candidate_ref as string, stage: params.stage as CandidateStage, reason: params.reason as string, actor: actorName(params.actor) }));
				const market = store.markets.find((item) => item.id === candidate.marketId);
				const summary = `${market?.name ?? candidate.marketId} → ${candidate.stage}`;
				return textResult(`${candidate.id} | ${market?.name} | stage=${candidate.stage}`, details({ title: "候选已移动", status: "success", summary, lines: [`原因：${params.reason}`], data: resultData({ touch: { marketId: candidate.marketId, candidateId: candidate.id, action: "stage_move", conclusion: summary, ids: [candidate.id] } }) }));
			}
			if (params.action === "decide") {
				if (!params.candidate_ref || !params.decision_status || !params.reason) throw new Error("decide 需要 candidate_ref、decision_status、reason");
				const { result: candidate, store } = await mutateStore(ctx, (data) => decideCandidate(data, {
					candidateRef: params.candidate_ref as string,
					status: params.decision_status as DecisionStatus,
					reason: params.reason as string,
					actor: actorName(params.actor),
				}));
				const market = store.markets.find((item) => item.id === candidate.marketId);
				const summary = `${market?.name ?? candidate.marketId} → ${candidate.decisionStatus}`;
				const decisionId = store.decisionLog.filter((item) => item.candidateId === candidate.id && item.type === "decision").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;
				return textResult(`${candidate.id} | ${market?.name} | decision=${candidate.decisionStatus}`, details({
					title: "最终决策已留痕",
					status: "success",
					summary,
					lines: [`原因：${candidate.decisionReason}`],
					data: resultData({ historyNote: decisionHistoryNote(store, candidate), touch: { marketId: candidate.marketId, candidateId: candidate.id, action: "decision", conclusion: summary, ids: [candidate.id, ...(decisionId ? [decisionId] : [])] } }),
				}));
			}
			const store = await readStore(ctx);
			if (params.action === "get") {
				if (!params.candidate_ref) throw new Error("get 需要 candidate_ref");
				const { candidate, marketName, decisions } = candidateDetail(store, params.candidate_ref);
				// 决策链正文与 Web API 同口径 ≤50 条（newest-first）：无上限的长决策链会把末尾链接行挤出 45KB 截断窗
				const decisionLines = decisions.slice(0, 50).map((decision) => `${decision.createdAt} | ${decision.type} | ${decision.conclusion} | ${decision.actor} | ${decision.reason}`);
				if (decisions.length > 50) decisionLines.push(`（仅显示最近 50 条 / 共 ${decisions.length} 条，完整决策链用 compass_history 查询）`);
				const body = [`${candidate.id} | ${marketName ?? candidate.marketId} | ${candidate.stage} | Gate=${candidate.gateOutcome ?? "—"} | Score=${candidate.score ?? "—"} | Decision=${candidate.decisionStatus ?? "—"}`, `当前阶段原因：${candidate.stageReason ?? "—"}`, `Gate原因：${candidate.gateReason ?? "—"}`, `决策原因：${candidate.decisionReason ?? "—"}`, ...decisionLines];
				// Amazon 实况核对链接（≤3 搜索 + ≤5 竞品）：与 Web 决策页共用 service helper，不自行拼 URL。
				// asin 是不可信 CSV/sidecar 文本（helper 契约：原文透传、sink 侧中和）——折叠空白防内嵌换行断行伪造输出
				const links = marketAmazonLinks(store, candidate.marketId);
				const linkLines = [
					...links.searches.map((item) => `Amazon 搜索：${item.url}`),
					...(links.topListings.length
						? links.topListings.map((row) => `Top竞品：#${row.rank} ${row.asin ? row.asin.replace(/\s+/g, " ") : "—"} ${row.price !== undefined ? `$${row.price.toFixed(2)}` : "$—"} ${row.rating !== undefined ? `★${row.rating.toFixed(1)}` : "★—"} 月销${row.monthlySales ?? "—"} ${row.url ?? "（无链接）"}`)
						: ["（尚无可核对的竞品 listing，无链接）"]),
				];
				// details 预览有界：理由 3 行 + 最近决策 ≤4 行 + 链接 ≤8 行；完整决策链在正文
				return textResult([...body, ...linkLines].join("\n"), details({ title: marketName ?? candidate.id, status: "success", summary: `${candidate.stage} · ${decisions.length} 条决策记录`, lines: [...body.slice(1, 8), ...linkLines] }));
			}
			const items = listPoolCandidates(store, { stage: params.stage, outcome: params.outcome, decisionStatus: params.decision_status });
			const lines = items.map(({ candidate, marketName }) => `${candidate.id} | ${marketName ?? candidate.marketId} | ${candidate.stage} | ${candidate.gateOutcome ?? "—"} | ${candidate.score ?? "—"} | ${candidate.decisionStatus ?? "—"}`);
			return textResult(lines.join("\n") || "候选池为空", details({ title: "候选池", status: "success", summary: `${items.length} 张候选卡`, lines: lines.slice(0, 12) }));
		},
		renderCall: renderCallLabel("compass_pool"),
		renderResult: renderCompassResult,
	});

	const RiskStatusSchema = StringEnum(RISK_STATUSES);
	pi.registerTool({
		name: "compass_risk_check",
		label: "Compass Risk Check",
		description: "记录认证、知识产权、季节性、政策擦边和物流五类风险，以及核验过的官方证据 URL。该工具只留痕，不替代律师或认证机构；不得仅凭模型记忆判绿。",
		parameters: Type.Object({
			market_ref: Type.String(),
			cert_status: RiskStatusSchema,
			ip_risk_level: RiskStatusSchema,
			season_flag: StringEnum(SEASON_FLAGS),
			policy_flag: StringEnum(POLICY_FLAGS),
			logistics_risk: RiskStatusSchema,
			evidence: Type.Optional(Type.Array(Type.Object({
				category: Type.String(),
				url: Type.Optional(Type.String()),
				title: Type.Optional(Type.String()),
				note: Type.Optional(Type.String()),
			}))),
			notes: Type.Optional(Type.String()),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const { result: record } = await mutateStore(ctx, (store) => recordRisk(store, {
				marketRef: params.market_ref,
				certStatus: params.cert_status,
				ipRiskLevel: params.ip_risk_level,
				seasonFlag: params.season_flag,
				policyFlag: params.policy_flag,
				logisticsRisk: params.logistics_risk,
				evidence: params.evidence ?? [],
				notes: params.notes,
				actor: actorName(params.actor),
			}));
			const summary = `总体=${record.overall} · 认证=${record.certStatus} · IP=${record.ipRiskLevel} · 季节=${record.seasonFlag} · 政策=${record.policyFlag} · 物流=${record.logisticsRisk}`;
			return textResult(`${summary}\nrisk_id=${record.id}\nevidence=${record.evidence.map((item) => item.url ?? item.title ?? item.category).join("；") || "无；不可判定为已完成官方核验"}`, details({ title: "风险核查已留痕", status: record.overall === "pass" ? "success" : "warning", summary, lines: record.evidence.map((item) => `${item.category}: ${item.url ?? item.note ?? "无链接"}`) }));
		},
		renderCall: renderCallLabel("compass_risk_check"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_reviews_record",
		label: "Compass Reviews Record",
		description: "保存由 AI/人工完成的 Top 竞品 1–3 星评论聚类：痛点主题、数量、Kano 类别、可改良性、证据原句和建议；同时计算预估星级差。",
		parameters: Type.Object({
			market_ref: Type.String(),
			source_asins: Type.Array(Type.String()),
			review_count: Type.Integer({ minimum: 0 }),
			themes: Type.Array(Type.Object({
				name: Type.String(),
				category: StringEnum(REVIEW_THEME_CATEGORIES),
				count: Type.Integer({ minimum: 0 }),
				share: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
				fixability: StringEnum(REVIEW_THEME_FIXABILITIES),
				evidence: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
				recommendation: Type.Optional(Type.String()),
			}), { minItems: 1 }),
			estimated_rating: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
			waist_rating: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
			notes: Type.Optional(Type.String()),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const { result: analysis } = await mutateStore(ctx, (store) => recordReviewAnalysis(store, {
				marketRef: params.market_ref,
				sourceAsins: params.source_asins,
				reviewCount: params.review_count,
				themes: params.themes as ReviewTheme[],
				estimatedRating: params.estimated_rating,
				waistRating: params.waist_rating,
				notes: params.notes,
				actor: actorName(params.actor),
			}));
			const lines = analysis.themes.sort((a, b) => b.count - a.count).map((theme) => `${theme.name} | ${theme.count} | ${theme.fixability} | ${theme.recommendation ?? "—"}`);
			const summary = `${analysis.reviewCount} 条评论 · ${analysis.themes.length} 个主题 · 星级差 ${analysis.estimatedRatingGap ?? "缺数据"}`;
			return textResult([summary, `analysis_id=${analysis.id}`, ...lines].join("\n"), details({ title: "差评分析已留痕", status: "success", summary, lines }));
		},
		renderCall: renderCallLabel("compass_reviews_record"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_budget",
		label: "Compass Budget",
		description: "预算池操作：status 查看各数据源当月（结算月按 UTC 计，北京时间每月 1 日 08:00 清零）消耗与调用次数/80%告警/100%熔断；record 按市场归因成本；configure 配置来源、档位、月上限，以及 MCP 计量的 cost_per_call_cny（单价，0=只计数）与 monthly_call_limit（月次数上限，0=清除）。",
		parameters: Type.Object({
			action: StringEnum(["status", "record", "configure"] as const),
			source: Type.Optional(Type.String()),
			market_ref: Type.Optional(Type.String()),
			amount_cny: Type.Optional(Type.Number({ minimum: 0 })),
			description: Type.Optional(Type.String()),
			tier: Type.Optional(StringEnum(["A", "B", "C"] as const)),
			monthly_limit_cny: Type.Optional(Type.Number({ minimum: 0 })),
			cost_per_call_cny: Type.Optional(Type.Number({ minimum: 0, description: "MCP 计量单价；0=只计数不折算成本" })),
			monthly_call_limit: Type.Optional(Type.Integer({ minimum: 0, description: "月调用次数上限；0=清除" })),
			enabled: Type.Optional(Type.Boolean()),
			note: Type.Optional(Type.String()),
			force: Type.Optional(Type.Boolean()),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (params.action === "status") {
				// flush 降级路径下用 pending 合并保持数字新鲜（正常路径 pending 已清空，合并为空操作）
				// 结算月显式算一次并回显：UTC 月，避免工具输出的数字与运营脑内的本地月对不上
				const month = budgetMonth();
				const pools = budgetStatus(await readStoreFlushingUsage(ctx), month, pendingCallCounts());
				const lines = pools.map((pool) => `${pool.source} | ${pool.tier} | ¥${pool.spentCny}/¥${pool.monthlyLimitCny || 0} | calls=${pool.callCount}${pool.monthlyCallLimit !== undefined ? `/${pool.monthlyCallLimit}` : ""} | ${pool.state} | ${pool.enabled ? "enabled" : "disabled"}`);
				return textResult(lines.join("\n"), details({ title: "数据预算", status: pools.some((pool) => pool.state === "fused") ? "warning" : "success", summary: `${pools.length} 个预算池 · ${month} (UTC) ¥${pools.reduce((sum, pool) => sum + pool.spentCny, 0).toFixed(2)}`, lines }));
			}
			if (params.action === "record") {
				if (!params.source || params.amount_cny === undefined) throw new Error("record 需要 source 与 amount_cny");
				const { result: event } = await mutateStore(ctx, (store) => recordCost(store, { source: params.source as string, marketRef: params.market_ref, amountCny: params.amount_cny as number, description: params.description, actor: actorName(params.actor), force: params.force }));
				return textResult(`cost_id=${event.id}\n${event.source} ¥${event.amountCny}\nmarket=${event.marketId ?? "未归因"}`, details({ title: "成本已记账", status: "success", summary: `${event.source} · ¥${event.amountCny.toFixed(2)} · ${event.marketId ?? "未归因"}` }));
			}
			if (!params.source) throw new Error("configure 需要 source；新预算池另需 tier 与 monthly_limit_cny");
			const { result: pool } = await mutateStore(ctx, (store) => configureBudget(store, { source: params.source as string, tier: params.tier as "A" | "B" | "C" | undefined, monthlyLimitCny: params.monthly_limit_cny, enabled: params.enabled, note: params.note, costPerCallCny: params.cost_per_call_cny, monthlyCallLimit: params.monthly_call_limit }));
			const meterText = `${pool.costPerCallCny !== undefined ? ` | cost_per_call=¥${pool.costPerCallCny}` : ""}${pool.monthlyCallLimit !== undefined ? ` | call_limit=${pool.monthlyCallLimit}/月` : ""}`;
			return textResult(`${pool.source} | tier=${pool.tier} | limit=¥${pool.monthlyLimitCny}${meterText} | enabled=${pool.enabled}`, details({ title: "预算池已配置", status: "success", summary: `${pool.source} · ${pool.tier}档 · ¥${pool.monthlyLimitCny}/月${meterText}` }));
		},
		renderCall: renderCallLabel("compass_budget"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_todo",
		label: "Compass Todo",
		description: [
			"工作台待办清单与人工处理闭环。",
			"list（默认）：推导需人工干预的事项（预算熔断/复盘 challenged/Gate复核/待决策/补数据/补证据/到期复盘/预算告警/快照过期/多源偏差），P1 最高–P5 最低，逾期超 30 天升 1 级；多数事项解决后自动消失。",
			"闭环四类（metric_divergence / budget_warning / budget_fused / deep_missing_data）没有系统内动作可消除，须走「提交处理结果 → agent 验证 → 勾选已处理」，list 输出附处理状态徽标。",
			"submit：代运营录入处理说明与证据（URL 或项目内文件路径）。verify：**验证是你的活**——用 action=list resolution_status=submitted 拉待验证队列，逐条核对提交材料与 store 实况后给 verdict；判据不满足或证据不足一律 reject，不得为了清单好看而放行。complete：勾选已处理（仅验证通过后可用；若提交后水位已变——新导出 / 新预算月 / 重入深研——或条目已离开活跃清单，服务端会拒绝，出路是重新 submit 走新一轮）。reopen：拉回重新处理，必填理由。",
		].join("\n"),
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["list", "submit", "verify", "complete", "reopen"] as const)),
			priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "只看该优先级" })),
			kind: Type.Optional(StringEnum(TODO_KINDS)),
			market_ref: Type.Optional(Type.String({ description: "market_id 或唯一市场名" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			resolution_status: Type.Optional(StringEnum(TODO_RESOLUTION_STATUSES)),
			todo_id: Type.Optional(Type.String({ description: "待办 id（list 输出第三列）；submit/verify/complete/reopen 必填" })),
			note: Type.Optional(Type.String({ description: "submit：处理说明，写清做了什么、结论与关键数值" })),
			evidence: Type.Optional(Type.Array(Type.Object({
				ref: Type.String({ description: "URL 或项目内文件路径" }),
				note: Type.Optional(Type.String()),
			}), { maxItems: 20 })),
			verdict: Type.Optional(StringEnum(["pass", "reject"] as const)),
			reason: Type.Optional(Type.String({ description: "verify 的结论理由 / reopen 的重开理由，必填非空" })),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const action = params.action ?? "list";
			if (action !== "list") {
				const todoId = params.todo_id?.trim();
				if (!todoId) throw new Error(`compass_todo action=${action} 需要 todo_id（见 list 输出第三列）`);
				const actor = actorName(params.actor);
				if (action === "submit") {
					const { result: record } = await mutateStore(ctx, (store) => submitTodoResolution(store, { todoRef: todoId, note: params.note ?? "", evidence: params.evidence }, actor));
					const summary = `${record.titleSnapshot} · 待验证 · 第 ${record.attempts.length} 轮`;
					return textResult([
						`todo_id=${record.todoId}`,
						`状态：${TODO_RESOLUTION_STATUS_LABELS[record.status]}（第 ${record.attempts.length} 轮，提交人 ${actor}）`,
						`下一步：核对材料与 store 实况后执行 compass_todo action=verify todo_id=${record.todoId} verdict=pass|reject reason=…`,
					].join("\n"), details({ title: "处理结果已提交", status: "success", summary }));
				}
				if (action === "verify") {
					if (params.verdict !== "pass" && params.verdict !== "reject") throw new Error("compass_todo action=verify 需要 verdict=pass 或 reject");
					const verdict = params.verdict;
					const { result: record } = await mutateStore(ctx, (store) => verifyTodoResolution(store, { todoRef: todoId, verdict, reason: params.reason ?? "" }, actor));
					const passed = record.status === "verified";
					const summary = `${record.titleSnapshot} · ${TODO_RESOLUTION_STATUS_LABELS[record.status]}`;
					return textResult([
						`todo_id=${record.todoId}`,
						`验证结论：${verdict === "pass" ? "通过" : "驳回"} · ${record.attempts.at(-1)?.verdictReason ?? ""}`,
						`状态：${TODO_RESOLUTION_STATUS_LABELS[record.status]}`,
						passed
							? `下一步：由运营在 Web 待办页勾选「已处理」，或 compass_todo action=complete todo_id=${record.todoId}`
							: "下一步：请运营按驳回理由补充材料后重新提交（compass_todo action=submit）",
					].join("\n"), details({ title: passed ? "验证通过" : "验证驳回", status: passed ? "success" : "warning", summary }));
				}
				if (action === "complete") {
					const { result: record } = await mutateStore(ctx, (store) => completeTodoResolution(store, { todoRef: todoId }, actor));
					const basis = record.basis ?? {};
					const watermark = basis.month ?? basis.snapshotWatermark ?? basis.stageEnteredAt ?? "—";
					const summary = `${record.titleSnapshot} · 已处理`;
					return textResult([
						`todo_id=${record.todoId}`,
						`状态：已处理（勾选人 ${actor}）`,
						`抑制水位：${watermark}`,
						"该条目已离开活跃清单；出现新事实（新快照/新预算月/深研重入）会自动失效浮出，也可用 action=reopen 主动拉回",
					].join("\n"), details({ title: "已勾选处理", status: "success", summary }));
				}
				const { result: record } = await mutateStore(ctx, (store) => reopenTodoResolution(store, { todoRef: todoId, reason: params.reason ?? "" }, actor));
				const summary = `${record.titleSnapshot} · ${TODO_RESOLUTION_STATUS_LABELS[record.status]}`;
				return textResult([
					`todo_id=${record.todoId}`,
					`状态：${TODO_RESOLUTION_STATUS_LABELS[record.status]}（重开人 ${actor}）`,
					`重开理由：${record.reopens.at(-1)?.reason ?? ""}`,
					"下一步：条目已回到活跃清单，请重新提交处理结果（compass_todo action=submit）",
				].join("\n"), details({ title: "待办已重开", status: "warning", summary }));
			}

			const store = await readStoreFlushingUsage(ctx);
			let todos = listWorkbenchTodos(store);
			if (params.market_ref) {
				const market = findMarket(store, params.market_ref);
				todos = todos.filter((todo) => todo.marketId === market.id);
			}
			if (params.priority !== undefined) todos = todos.filter((todo) => todo.priority === params.priority);
			if (params.kind) todos = todos.filter((todo) => todo.kind === params.kind);
			if (params.resolution_status) todos = todos.filter((todo) => todo.resolution?.status === params.resolution_status);
			const limited = todos.slice(0, params.limit ?? 50);
			const lines = limited.map((todo) => {
				const badge = todoResolutionBadge(todo);
				// 驳回理由必须在工具面可见（R2）：只给「已驳回」三个字，agent 无从指导运营改什么
				const status = badge === undefined
					? "—"
					: todo.resolution?.status === "rejected" && todo.resolution.verdictReason
						? `${badge}（理由：${todo.resolution.verdictReason}）`
						: badge;
				return `P${todo.priority} | ${todo.kind} | ${todo.id} | ${todo.marketName ?? todo.source ?? "—"} | ${todo.title} | ${todo.reason}${todo.overdueDays ? ` | 逾期${todo.overdueDays}天` : ""} | ${status} | 建议：${todo.suggestedAction}`;
			});
			// 验证工作台：待验证条目附提交材料、该 kind 的审查要点与硬门槛预检，供 agent 照单核对。
			// 计数按未截断的全量统计——页内截断不得让页外待验证的提交材料在 agent 面前静默消失
			const pendingAll = todos.filter((todo) => todo.resolution?.status === "submitted");
			const pending = limited.filter((todo) => todo.resolution?.status === "submitted");
			const workbench: string[] = [];
			for (const todo of pending.slice(0, WORKBENCH_QUEUE_LIMIT)) {
				const record = findTodoResolution(store, todo.id);
				const attempt = record?.attempts.at(-1);
				if (!record || !attempt) continue;
				const guide = todoResolutionReviewGuide(store, record);
				const previous = record.attempts.at(-2);
				workbench.push(
					`- ${todo.id} | ${record.titleSnapshot} | ${todo.marketName ?? record.source ?? "—"}`,
					`  提交：${attempt.submittedBy} @${attempt.submittedAt}（第 ${record.attempts.length} 轮）`,
					// 处理说明是自由文本：续行缩进对齐，避免多行说明把工作台的条目块冲散
					`  说明：${attempt.note.replace(/\r?\n/gu, "\n    ")}`,
					`  证据：${attempt.evidence.map((item) => `${item.ref.replace(/\s+/gu, " ")}${item.note ? `（${item.note.replace(/\s+/gu, " ")}）` : ""}`).join("；") || "无"}`,
					`  审查要点：${guide.reviewPoints}`,
					`  硬门槛预检：${guide.unmetGate.length ? `未满足 —— ${guide.unmetGate.join("、")}（不得判 pass）` : "全部满足"}`,
				);
				if (previous?.verdict === "reject") workbench.push(`  上轮驳回：${previous.verdictReason ?? ""}`);
			}
			// 队列有溢出必须明说（同 compass_history 决策链的「仅显示最近 N 条」惯例）：
			// 静默截断会让 agent 以为已核对完全部待验证项
			const hiddenPending = pendingAll.length - Math.min(pending.length, WORKBENCH_QUEUE_LIMIT);
			if (hiddenPending > 0) {
				workbench.push(`（另有 ${hiddenPending} 项待验证未展开：用 action=list resolution_status=submitted，或加 kind= / market_ref= 缩小范围后重看）`);
			}
			const urgent = todos.filter((todo) => todo.priority <= 2).length;
			const summary = todos.length
				? `${todos.length} 项待办 · P1/P2 ${urgent} 项${pendingAll.length ? ` · 待验证 ${pendingAll.length} 项` : ""}`
				: "当前没有需要人工处理的事项";
			const body = [
				lines.join("\n") || summary,
				workbench.length ? ["", "—— 待验证队列（核对后执行 compass_todo action=verify）——", ...workbench].join("\n") : "",
			].filter(Boolean).join("\n");
			return textResult(body, details({
				title: "工作台待办",
				status: urgent ? "warning" : "success",
				summary,
				lines: lines.slice(0, 12),
				data: resultData({ payload: limited }),
			}));
		},
		renderCall: renderCallLabel("compass_todo"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_asin_history",
		label: "Compass ASIN History",
		description: "从本地不可变市场快照中读取一个 ASIN 的价格、星级、评论数、月销和排名历史；不发起网络采集。",
		parameters: Type.Object({ asin: Type.String(), market_ref: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
		async execute(_id, params, _signal, _update, ctx) {
			const store = await readStore(ctx);
			const marketId = params.market_ref ? findMarket(store, params.market_ref).id : undefined;
			const asin = params.asin.toUpperCase();
			const rows = store.snapshots
				.filter((snapshot) => !marketId || snapshot.marketId === marketId)
				.flatMap((snapshot) => snapshot.listings.filter((listing) => listing.asin?.toUpperCase() === asin).map((listing) => ({ snapshot, listing })))
				.sort((a, b) => compareSnapshotRecencyDesc(a.snapshot, b.snapshot))
				.slice(0, params.limit ?? 50);
			const lines = rows.map(({ snapshot, listing }) => `${snapshot.capturedAt} | ${snapshot.source} | rank=${listing.rank} | price=${listing.price ?? "—"} | rating=${listing.rating ?? "—"} | reviews=${listing.reviewCount ?? "—"} | monthly_sales=${listing.monthlySales ?? "—"}`);
			return textResult(lines.join("\n") || `未找到 ${asin}`, details({ title: `ASIN 历史 · ${asin}`, status: rows.length ? "success" : "warning", summary: `${rows.length} 个快照`, lines: lines.slice(0, 12) }));
		},
		renderCall: renderCallLabel("compass_asin_history"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_keyword_metrics",
		label: "Compass Keyword Metrics",
		description: "从本地快照查询关键词的搜索量、建议 CPC 和排名历史；不发起网络采集。",
		parameters: Type.Object({ keyword: Type.String(), market_ref: Type.Optional(Type.String()), exact: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
		async execute(_id, params, _signal, _update, ctx) {
			const store = await readStore(ctx);
			const marketId = params.market_ref ? findMarket(store, params.market_ref).id : undefined;
			const needle = params.keyword.normalize("NFKC").toLocaleLowerCase();
			const rows = store.snapshots
				.filter((snapshot) => !marketId || snapshot.marketId === marketId)
				.flatMap((snapshot) => snapshot.keywords.filter((keyword) => {
					const candidate = keyword.keyword.normalize("NFKC").toLocaleLowerCase();
					return params.exact ? candidate === needle : candidate.includes(needle);
				}).map((keyword) => ({ snapshot, keyword })))
				.sort((a, b) => compareSnapshotRecencyDesc(a.snapshot, b.snapshot))
				.slice(0, params.limit ?? 50);
			const lines = rows.map(({ snapshot, keyword }) => `${snapshot.capturedAt} | ${snapshot.source} | ${keyword.keyword} | volume=${keyword.searchVolume ?? "—"} | cpc=${keyword.cpc ?? "—"} | rank=${keyword.rank ?? "—"}`);
			return textResult(lines.join("\n") || `未找到关键词 ${params.keyword}`, details({ title: `关键词指标 · ${params.keyword}`, status: rows.length ? "success" : "warning", summary: `${rows.length} 条记录`, lines: lines.slice(0, 12) }));
		},
		renderCall: renderCallLabel("compass_keyword_metrics"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_history",
		label: "Compass History",
		description: "统一查询本地历史：timeline 合并快照/策略/决策/复盘，search 检索决策日志，similar 查相似市场，outcomes 看验证统计，lessons 查经验卡；不联网，输出不超过45KB。",
		parameters: Type.Object({
			action: StringEnum(["timeline", "search", "similar", "outcomes", "lessons"] as const),
			market_ref: Type.Optional(Type.String()),
			candidate_ref: Type.Optional(Type.String()),
			asin: Type.Optional(Type.String()),
			query: Type.Optional(Type.String()),
			keywords: Type.Optional(Type.Array(Type.String())),
			category: Type.Optional(Type.String()),
			metric: Type.Optional(Type.String()),
			decision_status: Type.Optional(StringEnum(DECISION_STATUSES)),
			types: Type.Optional(Type.Array(StringEnum(DECISION_LOG_TYPES))),
			actor: Type.Optional(Type.String()),
			since: Type.Optional(Type.String()),
			until: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
			include_retired: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const store = await readStore(ctx);
			if (params.action === "timeline") {
				let marketRef = params.market_ref;
				if (!marketRef && params.asin) {
					const asin = params.asin.toUpperCase();
					const marketIds = [...new Set(store.snapshots.filter((snapshot) => snapshot.listings.some((listing) => listing.asin?.toUpperCase() === asin)).map((snapshot) => snapshot.marketId))];
					if (!marketIds.length) throw new Error(`未找到 ASIN ${asin} 所属市场`);
					if (marketIds.length > 1) throw new Error(`ASIN ${asin} 命中多个市场，请补 market_ref：${marketIds.join("、")}`);
					marketRef = marketIds[0];
				}
				if (!marketRef && !params.candidate_ref) throw new Error("timeline 需要 market_ref、candidate_ref 或 asin");
				const timeline = historyTimeline(store, marketRef ?? params.candidate_ref as string, params.candidate_ref).slice(0, params.limit ?? 200);
				const lines = timeline.map((item) => `${item.at} | ${item.kind} | ${item.id} | ${item.summary}${item.reason ? ` | ${item.reason}` : ""}${item.snapshotId ? ` | snapshot=${item.snapshotId}` : ""}`);
				const marketId = timeline[0]?.marketId;
				return textResult(lines.join("\n") || "时间线为空", details({ title: "历史时间线", status: timeline.length ? "success" : "warning", summary: `${timeline.length} 条合并事件`, lines: lines.slice(0, 12), data: resultData({ payload: timeline, touch: { marketId, action: "history.timeline", conclusion: `查询 ${timeline.length} 条历史` } }) }));
			}
			if (params.action === "search") {
				const rows = historySearch(store, {
					query: params.query,
					types: params.types as DecisionLog["type"][] | undefined,
					decisionStatus: params.decision_status,
					actor: params.actor,
					since: params.since,
					until: params.until,
					limit: params.limit,
				});
				const lines = rows.map((item) => `${item.createdAt} | ${item.id} | ${item.marketId} | ${item.type} | ${item.decisionStatus ?? "—"} | ${item.conclusion} | ${item.actor} | ${item.reason}`);
				return textResult(lines.join("\n") || "未命中历史决策", details({ title: "历史检索", status: rows.length ? "success" : "warning", summary: `${rows.length} 条决策留痕`, lines: lines.slice(0, 12), data: resultData({ payload: rows }) }));
			}
			if (params.action === "similar") {
				if (!params.market_ref && !params.keywords?.length && !params.category && !params.query) throw new Error("similar 需要 market_ref，或 keywords/category/query");
				const rows = historySimilar(store, { marketRef: params.market_ref, name: params.query, keywords: params.keywords, category: params.category, limit: Math.min(params.limit ?? 3, 20) });
				const lines = rows.map((item) => `${item.market.id} | ${item.market.name} | score=${item.score.toFixed(3)} | keyword_jaccard=${item.keywordJaccard.toFixed(3)} | category=${item.categoryMatch} | decision=${item.finalDecision ?? "—"} | verdict=${item.latestVerdict ?? "—"} | reason=${item.decisionReason ?? "—"} | lessons=${item.lessons.map((lesson) => lesson.id).join(",") || "—"}`);
				return textResult(lines.join("\n") || "没有达到 0.35 阈值的相似市场", details({ title: "相似历史市场", status: rows.length ? "success" : "warning", summary: `${rows.length} 个相似市场`, lines, data: resultData({ payload: rows, touch: params.market_ref ? { marketId: findMarket(store, params.market_ref).id, action: "history.similar", conclusion: `命中 ${rows.length} 个相似市场` } : undefined }) }));
			}
			if (params.action === "outcomes") {
				const outcomeMarketRef = params.candidate_ref ? findCandidate(store, params.candidate_ref).marketId : params.market_ref;
				const result = historyOutcomes(store, outcomeMarketRef);
				const stats = result.stats;
				const header = `checks=${stats.total} | rated_markets=${stats.ratedMarkets} | validated=${stats.validated} | challenged=${stats.challenged} | inconclusive=${stats.inconclusive} | validation_rate=${stats.validationRate === null ? "—" : (stats.validationRate * 100).toFixed(1) + "%"} | go_attainment=${stats.goAttainmentRate === null ? "—" : (stats.goAttainmentRate * 100).toFixed(1) + "%"} | no_go_accuracy=${stats.noGoAccuracyRate === null ? "—" : (stats.noGoAccuracyRate * 100).toFixed(1) + "%"} | false_kill=${stats.falseKillRate === null ? "—" : (stats.falseKillRate * 100).toFixed(1) + "%"}（四率按市场去重：每市场只取最新一条可判对照）`;
				const limitedChecks = result.checks.slice(0, params.limit ?? 200);
				const lines = limitedChecks.map((check) => `${check.createdAt} | ${check.id} | ${check.marketId} | decision=${check.decisionStatus ?? "—"} | verdict=${check.verdict} | elapsed=${check.elapsedDays}d | ${check.verdictReason}`);
				return textResult([header, ...lines, ...stats.byStrategy.map((item) => `strategy ${item.strategy} | accuracy=${item.accuracy === null ? "—" : (item.accuracy * 100).toFixed(1) + "%"} | ${item.validated}/${item.challenged}/${item.inconclusive}`)].join("\n"), details({ title: "复盘台账", status: stats.challenged ? "warning" : "success", summary: `${stats.total} 条 · 验证率 ${stats.validationRate === null ? "—" : (stats.validationRate * 100).toFixed(1) + "%"}`, lines: [header, ...lines.slice(0, 10)], data: resultData({ payload: { checks: limitedChecks, stats } }) }));
			}
			const lessons = historyLessons(store, { category: params.category, keywords: params.keywords ?? (params.query ? [params.query] : undefined), metric: params.metric, includeRetired: params.include_retired, limit: params.limit });
			const lines = lessons.map((lesson) => `${lesson.id} | ${lesson.status} | ${lesson.title} | scope=${JSON.stringify(lesson.scope)} | evidence=${lesson.evidence.join(",")} | ${lesson.detail}${lesson.retiredReason ? ` | retired=${lesson.retiredReason}` : ""}`);
			return textResult(lines.join("\n") || "没有匹配的经验卡", details({ title: "经验卡", status: lessons.length ? "success" : "warning", summary: `${lessons.length} 条经验`, lines: lines.slice(0, 12), data: resultData({ payload: lessons }) }));
		},
		renderCall: renderCallLabel("compass_history"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_retro",
		label: "Compass Retro",
		description: "复盘闭环：due 查到期项，check 做快照对照，record_actuals 录 go 品实绩，report 生成复盘报告，backtest 回测策略，save_lesson/retire_lesson 管理有证据经验卡。",
		parameters: Type.Object({
			action: StringEnum(["due", "check", "record_actuals", "report", "backtest", "save_lesson", "retire_lesson"] as const),
			market_ref: Type.Optional(Type.String()),
			candidate_ref: Type.Optional(Type.String()),
			evidence_snapshot_id: Type.Optional(Type.String()),
			actuals: Type.Optional(Type.Object({
				daily_units: Type.Optional(Type.Number({ minimum: 0 })),
				tacos: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
				return_rate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
				net_margin: Type.Optional(Type.Number({ maximum: 1 })),
				note: Type.Optional(Type.String()),
			})),
			strategy_id: Type.Optional(Type.String({ description: "策略 id、名称或 id@vN（写 @vN 锁定历史版本，不写则用最新版）" })),
			baseline_strategy_id: Type.Optional(Type.String({ description: "基线策略 id、名称或 id@vN（写 @vN 锁定历史版本，不写则用最新版）" })),
			lesson: Type.Optional(Type.Object({
				title: Type.String(),
				detail: Type.String(),
				scope: Type.Optional(Type.Object({
					categories: Type.Optional(Type.Array(Type.String())),
					keywords: Type.Optional(Type.Array(Type.String())),
					metrics: Type.Optional(Type.Array(Type.String())),
				})),
				evidence: Type.Array(Type.String(), { minItems: 1 }),
				source_retro: Type.Optional(Type.String()),
			})),
			lesson_ref: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String()),
			output_path: Type.Optional(Type.String()),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (params.action === "due") {
				const rows = listRetroDue(await readStore(ctx));
				const lines = rows.map((item) => `${item.group} | ${item.candidateId} | ${item.marketName} | overdue=${item.overdueDays}d | due=${item.dueAt.slice(0, 10)} | ${item.reason} | 建议=${item.suggestedAction}`);
				return textResult(lines.join("\n") || "当前没有到期复盘对象", details({ title: "待复盘", status: rows.length ? "warning" : "success", summary: `${rows.length} 个到期对象`, lines: lines.slice(0, 15), data: resultData({ payload: rows }) }));
			}
			if (params.action === "check") {
				const { result: check } = await mutateStore(ctx, (store) => performRetroCheck(store, { marketRef: params.market_ref, candidateRef: params.candidate_ref, evidenceSnapshotId: params.evidence_snapshot_id, actor: actorName(params.actor) }));
				const summary = `${check.verdict} · ${check.id} · ${check.elapsedDays}天`;
				return textResult(`${summary}\nmarket=${check.marketId}\nbaseline=${check.baselineSnapshotId}\nevidence=${check.evidenceSnapshotId}\nreason=${check.verdictReason}`, details({ title: "复盘对照已留痕", status: check.verdict === "challenged" ? "warning" : "success", summary, lines: [check.verdictReason], data: resultData({ touch: { marketId: check.marketId, candidateId: check.candidateId, action: "retro.check", conclusion: summary, ids: [check.id] } }) }));
			}
			if (params.action === "record_actuals") {
				if (!params.candidate_ref || !params.actuals) throw new Error("record_actuals 需要 candidate_ref 与 actuals");
				const actuals: OutcomeActuals = { dailyUnits: params.actuals.daily_units, tacos: params.actuals.tacos, returnRate: params.actuals.return_rate, netMargin: params.actuals.net_margin, note: params.actuals.note };
				const { result: check } = await mutateStore(ctx, (store) => recordRetroActuals(store, { candidateRef: params.candidate_ref as string, actuals, actor: actorName(params.actor) }));
				const summary = `${check.verdict} · ${check.id} · 日销${check.actuals?.dailyUnits ?? "—"} · 净利${typeof check.actuals?.netMargin === "number" ? (check.actuals.netMargin * 100).toFixed(1) + "%" : "—"}`;
				return textResult(`${summary}\nreason=${check.verdictReason}`, details({ title: "实绩复盘已留痕", status: check.verdict === "challenged" ? "warning" : "success", summary, lines: [check.verdictReason], data: resultData({ touch: { marketId: check.marketId, candidateId: check.candidateId, action: "retro.actuals", conclusion: summary, ids: [check.id] } }) }));
			}
			if (params.action === "report") {
				const store = await readStore(ctx);
				const repo = repository(ctx);
				const generatedAt = new Date().toISOString();
				// 「上一份复盘报告」必须在写本次之前探，写完再探会探到自己；只读、在写事务之外
				const previousRetroAt = await repo.latestRetroReportAt();
				const output = repo.resolveOutputPath(params.output_path, retroReportFileName(generatedAt));
				const markdown = generateRetroReport(store, generatedAt, { outputPath: relative(ctx.cwd, output), previousRetroAt });
				await withFileMutationQueue(output, () => repo.writeReport(output, markdown));
				const path = relative(ctx.cwd, output);
				return textResult(markdown, details({ title: "罗盘复盘报告", status: store.outcomeChecks.some((check) => check.verdict === "challenged") ? "warning" : "success", summary: `${store.outcomeChecks.length} 条对照 · ${listRetroDue(store).length} 个到期`, path, data: resultData({ payload: { path } }) }));
			}
			if (params.action === "backtest") {
				if (!params.strategy_id) throw new Error("backtest 需要 strategy_id（可用 id@vN）");
				const result = backtestStrategies(await readStore(ctx), params.strategy_id, params.baseline_strategy_id);
				const matrix = Object.entries(result.matrix).sort().map(([flip, count]) => `${flip}=${count}`).join(" | ");
				const lines = result.flips.map((row) => `${row.marketId} | ${row.marketName} | ${row.baselineOutcome}→${row.strategyOutcome} | score ${row.baselineScore}→${row.strategyScore} | ${row.snapshotId}`);
				// 弃权（review）单列，否则“多弃权”的严格策略会白捡分；覆盖告诉运营这个百分比到底用了几条样本
				const alignmentText = (side: BacktestAlignmentSide) => `${side.rate === null ? "—" : (side.rate * 100).toFixed(1) + "%"}（一致 ${side.correct}/已判定 ${side.decided} · 弃权 ${side.abstained} · 覆盖 ${side.decided}/${result.alignment.comparableChecks}${side.coverage === null || side.coverage < 0.5 ? " · 样本不足，别据此调阈值" : ""}）`;
				const header = `${result.baselineStrategy} vs ${result.strategy} | markets=${result.markets} | flips=${result.flips.length} | 可比对照=${result.alignment.comparableChecks} | 基线对齐 ${alignmentText(result.alignment.baseline)} → 新策略对齐 ${alignmentText(result.alignment.strategy)}`;
				const alignmentLines = result.rows.filter((row) => row.checkId).map((row) => `${row.checkId} | ${row.marketName} | ${row.mode} | ${row.baselineOutcome}→${row.strategyOutcome} | ${row.snapshotId}`);
				return textResult([header, matrix, ...lines, ...alignmentLines].join("\n"), details({ title: "策略回测", status: result.flips.length ? "warning" : "success", summary: header, lines: [matrix, ...lines.slice(0, 12), ...alignmentLines.slice(0, 12)], data: resultData({ payload: result }) }));
			}
			if (params.action === "save_lesson") {
				if (!params.lesson) throw new Error("save_lesson 需要 lesson（evidence 必须非空）");
				const { result: lesson } = await mutateStore(ctx, (store) => saveLesson(store, { title: params.lesson!.title, detail: params.lesson!.detail, scope: params.lesson!.scope, evidence: params.lesson!.evidence, sourceRetro: params.lesson!.source_retro, actor: actorName(params.actor) }));
				return textResult(`${lesson.id} | ${lesson.title}\nscope=${JSON.stringify(lesson.scope)}\nevidence=${lesson.evidence.join(",")}`, details({ title: "经验卡已保存", status: "success", summary: `${lesson.id} · ${lesson.title}`, lines: [`evidence: ${lesson.evidence.join("、")}`], data: resultData({ touch: { action: "retro.save_lesson", conclusion: lesson.title, ids: [lesson.id, ...lesson.evidence] } }) }));
			}
			if (!params.lesson_ref || !params.reason) throw new Error("retire_lesson 需要 lesson_ref 与 reason");
			const { result: lesson } = await mutateStore(ctx, (store) => retireLesson(store, { lessonRef: params.lesson_ref as string, reason: params.reason as string, actor: actorName(params.actor) }));
			return textResult(`${lesson.id} | retired | ${lesson.retiredReason}`, details({ title: "经验卡已退役", status: "success", summary: `${lesson.id} · ${lesson.title}`, lines: [`原因：${lesson.retiredReason}`], data: resultData({ touch: { action: "retro.retire_lesson", conclusion: lesson.title, ids: [lesson.id] } }) }));
		},
		renderCall: renderCallLabel("compass_retro"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_data_route",
		label: "Compass Data Route",
		description: "按漏斗阶段检查本地字段与快照新鲜度，并结合预算熔断规划最便宜的数据源。只给路由计划，不自动抓取或登录卖家账号。",
		parameters: Type.Object({
			market_ref: Type.String(),
			stage: StringEnum(["lead", "screen", "deep_research", "risk", "testing"] as const),
			fields: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const store = await readStore(ctx);
			const market = findMarket(store, params.market_ref);
			const defaults: Record<string, string[]> = {
				lead: ["listing_count"],
				screen: ["qualify_rank_depth", "cr3", "amz_share", "new_listing_share_12m"],
				deep_research: [...DEEP_RESEARCH_REQUIRED_FIELDS],
				risk: ["risk_overall", "cert_status", "ip_risk_level", "season_flag", "policy_flag", "logistics_risk"],
				testing: ["daily_units", "tacos", "return_rate"],
			};
			const fields = params.fields?.length ? params.fields : defaults[params.stage];
			const snapshot = latestSnapshotIfPresent(store, market.id);
			if (!snapshot) {
				const plan = ["C档：先从卖家精灵/Sorftime 官方导出 CSV，或使用用户主动触发的 Compass 浏览器伴侣采集首个快照；成本≈¥0"];
				const summary = `尚无快照 · 缺 ${fields.length}/${fields.length} 字段 · 先完成 C 档采集`;
				return textResult([summary, `market=${market.id}`, `missing=${fields.join(",")}`, ...plan].join("\n"), details({ title: "数据源路由", status: "warning", summary, lines: plan }));
			}
			const metrics = buildStrategyContext(store, market.id).context.metrics;
			const age = Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.capturedAt)) / 86_400_000));
			const maxAge = snapshotTtlDays(params.stage);
			const missing = fields.filter((field) => metrics[field]?.value === undefined || metrics[field]?.value === null);
			const stale = age > maxAge;
			const budgets = budgetStatus(store);
			const available = (source: string) => {
				const pool = budgets.find((item) => item.source === source);
				return Boolean(pool?.enabled && pool.state !== "fused");
			};
			const plan: string[] = [];
			if (!stale && missing.length === 0) plan.push(`CACHE：复用 ${snapshot.source} 快照（${age}d，TTL ${maxAge}d）`);
			else if (params.stage === "lead" || params.stage === "screen") plan.push("C档：优先官方导出 CSV / 用户触发的 Compass 浏览器伴侣；成本≈¥0");
			else if (params.stage === "deep_research") {
				if (missing.some((field) => ["main_cpc", "cpc_ratio"].includes(field))) plan.push(available("sellersprite") ? "A档：卖家精灵补关键词/CPC" : "降级：卖家精灵官方 CSV 导出（预算不可用）");
				if (missing.some((field) => ["history", "demand_cv", "season_flag"].includes(field))) plan.push(available("keepa") ? "A档：Keepa 补历史曲线" : "降级：人工历史证据/等待预算恢复");
				if (missing.some((field) => ["gross_margin", "fba_fee"].includes(field))) plan.push("A档：SP-API getMyFeesEstimate（官方、免费）");
			}
			else if (params.stage === "risk") plan.push("官方源优先：USPTO/Google Patents/CPSC/FDA/FCC/EPA；AI 只生成检索式并初筛，证据 URL 必须留痕");
			else plan.push("SP-API 自有订单/广告/退货每日同步；不使用第三方估算替代经营实绩");
			const summary = `${stale ? "快照过期" : "快照新鲜"} · 缺 ${missing.length}/${fields.length} 字段 · ${plan.length} 条路由`;
			return textResult([summary, `market=${market.id}`, `snapshot_age=${age}d / ttl=${maxAge}d`, `missing=${missing.join(",") || "无"}`, ...plan].join("\n"), details({ title: "数据源路由", status: missing.length || stale ? "warning" : "success", summary, lines: plan }));
		},
		renderCall: renderCallLabel("compass_data_route"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_tools",
		label: "Compass Tools",
		description: "搜索并启用罗盘 Amazon US 精铺选品工具。先描述任务（如 CSV导入、利润测算、风险核查、候选池、报告），工具会动态加载相关能力。",
		promptSnippet: "Search and enable Compass Amazon US product-selection tools",
		promptGuidelines: [
			"Use compass_tools before an Amazon US product-selection workflow when the required compass_* tool is not active.",
			"Never present a Compass risk item as green solely from model memory; use official-source evidence and compass_risk_check.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "需要的选品能力或任务" }),
			load_all: Type.Optional(Type.Boolean()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: DOMAIN_TOOLS.length })),
		}),
		async execute(_id, params) {
			const { matches } = rankTools(params.query, { loadAll: params.load_all, limit: params.limit });
			const active = pi.getActiveTools();
			const added = matches.map((item) => item.name).filter((name) => !active.includes(name));
			pi.setActiveTools([...new Set([...active, ...added])]);
			const lines = matches.map((item) => `${item.name}: ${item.description}`);
			return textResult(`${added.length ? `已启用：${added.join(", ")}` : "相关工具已启用"}\n${lines.join("\n")}`, details({ title: "罗盘工具路由", status: "success", summary: `${added.length} 个新工具，${matches.length} 个匹配`, lines }));
		},
		renderCall: renderCallLabel("compass_tools"),
		renderResult: renderCompassResult,
	});

	pi.registerMessageRenderer("compass-history-brief", (message, { expanded, outputPad }, theme) => {
		const content = typeof message.content === "string"
			? message.content
			: message.content.filter((item): item is { type: "text"; text: string } => item.type === "text").map((item) => item.text).join("\n");
		const lines = content.split("\n");
		const visible = expanded ? lines : [...lines.slice(0, 3), ...(lines.length > 3 ? [`… ${lines.length - 3} 行历史（展开查看）`] : [])];
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(visible.map((line, index) => index === 0 ? theme.fg("accent", theme.bold(line)) : theme.fg(index === visible.length - 1 ? "dim" : "customMessageText", line)).join("\n"), 0, 0));
		return box;
	});

	pi.registerEntryRenderer("compass-report", (entry, _options, _theme) => {
		const data = entry.data as { markdown?: string; title?: string };
		return new Markdown(data.markdown ?? `# ${data.title ?? "罗盘报告"}`, 1, 0, getMarkdownTheme());
	});

	pi.registerCommand("compass-help", {
		description: "显示面向运营人员的罗盘使用手册",
		handler: async (_args, ctx) => {
			const manualPath = join(baseDir, "运营使用手册.md");
			const markdown = await readFile(manualPath, "utf8");
			pi.appendEntry("compass-report", { title: "罗盘运营使用手册", markdown, path: manualPath });
			if (ctx.hasUI) ctx.ui.notify("已显示罗盘运营使用手册；日常可先看文档开头的快速指引", "info");
		},
	});

	pi.registerCommand("compass", {
		description: "打开罗盘选品工作台总览",
		handler: async (_args, ctx) => {
			// 打开工作台前先把未落盘计量落账，保证预算/待办页数字新鲜（安全点之一）
			const store = await readStoreFlushingUsage(ctx);
			if (ctx.mode !== "tui") {
				ctx.ui.notify(compactDashboardSummary(store), "info");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const dashboard = new CompassDashboard(store, theme, () => done());
				return {
					render: (width) => dashboard.render(width),
					invalidate: () => dashboard.invalidate(),
					handleInput: (data) => {
						dashboard.handleInput(data);
						tui.requestRender();
					},
				};
			});
		},
	});

	pi.registerCommand("compass-import", {
		description: "交互式导入市场 CSV：/compass-import <项目内路径>",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("/compass-import 需要 TUI 或 RPC UI");
			const path = args.trim() || await ctx.ui.input("CSV 路径", "compass-imports/sellersprite.csv");
			if (!path) return;
			const marketName = await ctx.ui.input("市场/关键词族名称", "yoga mat strap");
			if (!marketName) return;
			const source = await ctx.ui.select("数据来源", [...SNAPSHOT_SOURCES]);
			if (!source) return;
			const imported = await performImport(ctx, { path, marketName, source, runScreen: true });
			rememberTouch({ marketId: imported.market.id, candidateId: imported.candidate.id, action: "import", conclusion: `粗筛=${imported.screenRun?.result.outcome ?? "未运行"}${imported.outcomeCheck ? `；复盘=${imported.outcomeCheck.verdict}` : ""}`, ids: [imported.snapshot.id, ...(imported.outcomeCheck ? [imported.outcomeCheck.id] : [])] });
			ctx.ui.notify(`${imported.market.name} 已导入；粗筛=${imported.screenRun?.result.outcome ?? "未运行"}${imported.outcomeCheck ? `；复盘=${imported.outcomeCheck.verdict} (${imported.outcomeCheck.id})` : ""}`, imported.screenRun?.result.outcome === "reject" || imported.outcomeCheck?.verdict === "challenged" ? "warning" : "info");
		},
	});

	pi.registerCommand("compass-report", {
		description: "生成并在会话中显示五维报告：/compass-report [market_id|市场名]",
		handler: async (args, ctx) => {
			const store = await readStore(ctx);
			let marketRef = args.trim();
			if (!marketRef) {
				if (!ctx.hasUI) throw new Error("请提供 market_id 或市场名称");
				const selected = await ctx.ui.select("选择市场", store.markets.map((market) => `${market.id} · ${market.name}`));
				if (!selected) return;
				marketRef = selected.split(" · ")[0];
			}
			const report = generateMarketReport(store, marketRef);
			const repo = repository(ctx);
			const output = repo.resolveOutputPath(undefined, `${report.marketId}-${new Date().toISOString().slice(0, 10)}.md`);
			await withFileMutationQueue(output, () => repo.writeReport(output, report.markdown));
			pi.appendEntry("compass-report", { title: report.marketName, markdown: report.markdown, path: relative(ctx.cwd, output) });
			rememberTouch({ marketId: report.marketId, action: "market_report", conclusion: `${report.outcome} · ${report.score.toFixed(1)}分`, ids: [report.snapshotId] });
			ctx.ui.notify(`报告已保存：${relative(ctx.cwd, output)}`, "info");
		},
	});

	pi.registerCommand("compass-web", {
		description: "启动本地罗盘 Web 工作台：/compass-web [端口|stop]——无参启动或复用现有服务，数字指定端口，stop 关闭",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "stop") {
				// 同步读取并清空：中间不 await，与其余分支之间不存在交错窗口
				const pending = webServerPromise;
				webServerPromise = undefined;
				if (!pending) {
					ctx.ui.notify("罗盘 Web 工作台当前未运行", "info");
					return;
				}
				try {
					const server = await pending;
					await server.close();
				} catch {
					// 启动本身失败，或关闭失败：都已经没有句柄可管理，忽略即可
				}
				ctx.ui.notify("罗盘 Web 工作台已关闭", "info");
				return;
			}
			let port: number | undefined;
			if (arg) {
				port = Number(arg);
				if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`端口参数无效：${arg}`);
			}
			if (webServerPromise) {
				const server = await webServerPromise;
				const portNote = port !== undefined ? `（端口参数 ${port} 已忽略——服务已在运行，如需切换端口请先 /compass-web stop）` : "";
				ctx.ui.notify(`罗盘 Web 工作台已在运行：${server.url}${portNote}`, "info");
				return;
			}
			if (!ctx.isProjectTrusted()) throw new Error("罗盘拒绝在未受信任项目中启动 Web 工作台");
			webServerPromise = startCompassWebServer({ projectRoot: ctx.cwd, ...(port !== undefined ? { port } : {}) });
			let server: CompassWebServer;
			try {
				server = await webServerPromise;
			} catch (error) {
				webServerPromise = undefined;
				throw error;
			}
			ctx.ui.notify(`罗盘 Web 工作台已启动：${server.url}（仅本机可访问，不要转发到局域网）`, "info");
		},
	});

	pi.registerCommand("compass-strategy", {
		description: "交互式编辑策略 YAML；每次保存自动生成新版本",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("/compass-strategy 需要 TUI 或 RPC UI");
			const store = await readStore(ctx);
			let ref = args.trim();
			if (!ref) {
				const choices = listStrategies(store).map((strategy) => `${strategy.id} · ${strategy.name} · v${strategy.version}`);
				const selected = await ctx.ui.select("选择策略", choices);
				if (!selected) return;
				ref = selected.split(" · ")[0];
			}
			const strategy = findStrategyVersion(store, ref);
			const edited = await ctx.ui.editor(`编辑 ${strategy.name}@v${strategy.version}`, strategy.yaml);
			if (!edited || edited === strategy.yaml) return;
			const note = await ctx.ui.input("版本说明", `基于 v${strategy.version} 调整`);
			const saved = await mutateStore(ctx, (data) => saveStrategyVersion(data, { yaml: edited, actor: actorName(), changeNote: note }));
			ctx.ui.notify(`已保存 ${saved.result.id}@v${saved.result.version}`, "info");
		},
	});

	pi.registerCommand("compass-history-brief", {
		description: "会话级历史注入开关：/compass-history-brief on|off",
		handler: async (args, ctx) => {
			const value = args.trim().toLocaleLowerCase();
			if (value && !["on", "off"].includes(value)) throw new Error("用法：/compass-history-brief on|off");
			if (value) historyBriefEnabled = value === "on";
			if (ctx.hasUI) ctx.ui.notify(`罗盘历史速览：${historyBriefEnabled ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("compass-retro", {
		description: "交互式复盘会：到期列表 → 对照/实绩 → 报告 → 经验卡",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) throw new Error("/compass-retro 需要 TUI 或 RPC UI");
			let due = listRetroDue(await readStore(ctx));
			const createdChecks: string[] = [];
			while (due.length) {
				const choices = [...due.map((item) => `${item.candidateId} · ${item.group} · ${item.marketName} · 逾期${item.overdueDays}天`), "完成本次逐项复盘"];
				const selected = await ctx.ui.select("选择一个到期对象", choices);
				if (!selected || selected === "完成本次逐项复盘") break;
				const candidateId = selected.split(" · ")[0];
				const item = due.find((candidate) => candidate.candidateId === candidateId);
				if (!item) continue;
				try {
					const currentStore = await readStore(ctx);
					const candidate = findCandidate(currentStore, candidateId);
					if (candidate.decisionStatus === "go") {
						const parseOptional = (value: string | undefined): number | undefined => {
							if (value === undefined || !value.trim()) return undefined;
							const parsed = Number(value);
							if (!Number.isFinite(parsed)) throw new Error(`不是有效数字：${value}`);
							return parsed;
						};
						const dailyUnits = parseOptional(await ctx.ui.input("实际日销", "10"));
						const tacos = parseOptional(await ctx.ui.input("TACOS（0–1）", "0.15"));
						const returnRate = parseOptional(await ctx.ui.input("退货率（0–1）", "0.05"));
						const netMargin = parseOptional(await ctx.ui.input("净利率（0–1，可为负）", "0.10"));
						const note = await ctx.ui.input("实绩备注", "以店铺后台为准");
						const { result } = await mutateStore(ctx, (store) => recordRetroActuals(store, { candidateRef: candidateId, actuals: { dailyUnits, tacos, returnRate, netMargin, note }, actor: actorName() }));
						createdChecks.push(result.id);
						rememberTouch({ marketId: result.marketId, candidateId: result.candidateId, action: "retro.actuals", conclusion: `${item.marketName} ${result.verdict}`, ids: [result.id] });
						ctx.ui.notify(`${item.marketName}：${result.verdict} · ${result.id}`, result.verdict === "challenged" ? "warning" : "info");
					} else if (item.reason.includes("抽样回看周期") && !item.reason.includes("新快照")) {
						ctx.ui.notify(`${item.marketName} 需先导入新快照，再执行 check`, "warning");
					} else {
						const { result } = await mutateStore(ctx, (store) => performRetroCheck(store, { candidateRef: candidateId, actor: actorName() }));
						createdChecks.push(result.id);
						rememberTouch({ marketId: result.marketId, candidateId: result.candidateId, action: "retro.check", conclusion: `${item.marketName} ${result.verdict}`, ids: [result.id] });
						ctx.ui.notify(`${item.marketName}：${result.verdict} · ${result.id}`, result.verdict === "challenged" ? "warning" : "info");
					}
				} catch (error) {
					ctx.ui.notify(`复盘失败：${error instanceof Error ? error.message : String(error)}`, "warning");
				}
				due = due.filter((candidate) => candidate.candidateId !== candidateId);
			}
			const store = await readStore(ctx);
			const repo = repository(ctx);
			const generatedAt = new Date().toISOString();
			// 同上：先探上一份，再落本次；下面刷新报告时复用这两个值，
			// 保证「本次沉淀」的时间窗与文件名都锚在同一次生成上
			const previousRetroAt = await repo.latestRetroReportAt();
			const output = repo.resolveOutputPath(undefined, retroReportFileName(generatedAt));
			const outputPath = relative(ctx.cwd, output);
			const reportOptions = { outputPath, previousRetroAt };
			const markdown = generateRetroReport(store, generatedAt, reportOptions);
			await withFileMutationQueue(output, () => repo.writeReport(output, markdown));
			pi.appendEntry("compass-report", { title: "罗盘复盘报告", markdown, path: outputPath });
			ctx.ui.notify(`复盘报告已保存：${outputPath}`, "info");
			const save = await ctx.ui.confirm("沉淀经验", "本次复盘发现的规律是否保存为 lesson？");
			if (!save) return;
			const title = await ctx.ui.input("一句话规律", "");
			if (!title) return;
			const detail = await ctx.ui.editor("为什么，以及下次如何使用", "");
			if (!detail) return;
			const evidenceInput = createdChecks.length ? createdChecks.join(",") : await ctx.ui.input("证据 ID（chk_/dec_/run_，逗号分隔）", "");
			const evidence = (evidenceInput ?? "").split(/[,，\s]+/u).filter(Boolean);
			const categories = (await ctx.ui.input("适用类目（逗号分隔，可空）", "") ?? "").split(/[,，]+/u).map((item) => item.trim()).filter(Boolean);
			const keywords = (await ctx.ui.input("适用关键词（逗号分隔，可空）", "") ?? "").split(/[,，]+/u).map((item) => item.trim()).filter(Boolean);
			const metrics = (await ctx.ui.input("关联指标（逗号分隔，可空）", "") ?? "").split(/[,，]+/u).map((item) => item.trim()).filter(Boolean);
			const { result: lesson, store: lessonStore } = await mutateStore(ctx, (data) => saveLesson(data, { title, detail, scope: { categories, keywords, metrics }, evidence, sourceRetro: outputPath, actor: actorName() }));
			await withFileMutationQueue(output, () => repo.writeReport(output, generateRetroReport(lessonStore, generatedAt, reportOptions)));
			rememberTouch({ action: "retro.save_lesson", conclusion: lesson.title, ids: [lesson.id, ...lesson.evidence] });
			ctx.ui.notify(`已保存经验卡 ${lesson.id}，复盘报告已刷新`, "info");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!historyBriefEnabled || !ctx.isProjectTrusted()) return;
		try {
			const store = await repository(ctx).load();
			ensureDefaults(store);
			const matches = marketMatchesPrompt(store, event.prompt);
			const terms = searchTerms(event.prompt);
			const hasIntent = terms.some((term) => HISTORY_INTENT_TERMS.has(term));
			if (!matches.length && !hasIntent) return;
			const market = matches.find((item) => !briefedMarkets.has(item.id));
			const key = market?.id ?? "$general";
			if (briefedMarkets.has(key)) return;
			const content = renderHistoryBrief(store, { marketId: market?.id, queryKeywords: terms.filter((term) => term.length >= 2), dueCount: listRetroDue(store).length });
			if (content.split("\n").length < 2) return;
			briefedMarkets.add(key);
			return { message: { customType: "compass-history-brief", content, display: true, details: { marketId: market?.id } } };
		} catch {
			return;
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.isProjectTrusted()) return;
		if (!event.toolName.startsWith("compass_")) {
			// MCP 计量：只做内存自增（O(1)、零 I/O），落账在安全点完成；计量绝不影响工具结果
			try {
				const sample = classifyMcpToolResult(event.toolName, event.details);
				if (sample?.billable) addPendingUsage(sample.server, sample.tool);
			} catch {
				return;
			}
			return;
		}
		try {
			const value = event.details as CompassDetails | undefined;
			if (!value || value.kind !== TOOL_DETAILS_KIND) return;
			const data = value.data as CompassResultData | undefined;
			rememberTouch(data?.touch);
			if (!historyBriefEnabled || event.toolName === "compass_market_report" || !data?.historyNote?.length || event.isError) return;
			const note = capHistoryLines(data.historyNote, 7, 650);
			if (!note.length) return;
			const content = [...event.content];
			const textIndex = content.findIndex((item) => item.type === "text");
			if (textIndex < 0) return;
			const text = content[textIndex];
			if (text.type !== "text") return;
			content[textIndex] = { ...text, text: `${text.text}\n\n【历史对照】\n${note.map((line) => `· ${line}`).join("\n")}` };
			return { content, details: { ...value, lines: [...(value.lines ?? []), "【历史对照】", ...note] } };
		} catch {
			return;
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.isProjectTrusted()) return;
		const guardReason = "store 原文过大且快照明细外置（lazy 指针），直接读会污染上下文；请用 compass_history / compass_asin_history / compass_keyword_metrics 查询。";
		try {
			// MCP 熔断拦截：廉价名称预过滤命中后才 repo.load()（只读，不开写事务）；判定失败即放行。
			// 空缓存 = 从未成功读库（ensureDefaults 后池恒非空），兜底 load 一次自愈，避免
			// session_start 失败后 direct 工具的 gate 被粘性旁路
			if (event.toolName === "mcp" || event.toolName === "mcpScript" || cachedPoolSources.length === 0 || cachedPoolSources.some((source) => event.toolName.startsWith(`${source}_`))) {
				const store = await repository(ctx).load();
				ensureDefaults(store);
				rememberPools(store);
				const blocked = evaluateMcpGate(store, { toolName: event.toolName, input: event.input as Record<string, unknown> | undefined }, pendingCallCounts());
				if (blocked) return { block: true, reason: blocked.reason };
			}
			if (isToolCallEventType("read", event) && pathIsHistoryStore(ctx.cwd, event.input.path)) return { block: true, reason: guardReason };
			if (isToolCallEventType("grep", event) && event.input.path && pathIsHistoryStore(ctx.cwd, event.input.path)) return { block: true, reason: guardReason };
			if (isToolCallEventType("bash", event) && bashReadsHistoryStore(ctx.cwd, event.input.command)) return { block: true, reason: guardReason };
			if (event.toolName === "compass_import_csv") {
				const pathValue = event.input.path;
				if (typeof pathValue !== "string") return;
				const repo = repository(ctx);
				const path = repo.resolveInputPath(pathValue);
				const hash = importContentHash(await readFile(path));
				const store = await repo.load();
				const duplicate = findDuplicateImport(store, hash);
				if (duplicate) return { block: true, reason: `重复 CSV：已于 ${duplicate.importedAt} 导入为 ${duplicate.id}；请复用历史快照或导入真正的新数据。` };
			}
			// 未命中任何拦截：显式交还 undefined，语义同「不干预」（pi 的 ExtensionHandler 允许返回 void）
			return undefined;
		} catch {
			return;
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!ctx.isProjectTrusted() || !sessionLedger.length) return;
		try {
			const ledger = renderSessionLedger(sessionLedger);
			event.customInstructions = [event.customInstructions, ledger].filter(Boolean).join("\n\n");
			// 当前宿主不会读取 handler 对 compact customInstructions 的原地修改；把同一台账作为
			// 仅供本次 summarizer 消费的本地 CustomMessage，兼容普通与 split-turn 压缩。
			event.preparation.messagesToSummarize.push({
				role: "custom",
				customType: "compass-session-ledger",
				content: ledger,
				display: false,
				timestamp: Date.now(),
			});
		} catch {
			return;
		}
	});

	pi.on("resources_discover", () => ({
		skillPaths: [join(baseDir, "skills", "compass-selection", "SKILL.md")],
	}));

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.isProjectTrusted()) return;
		briefedMarkets.clear();
		sessionLedger.length = 0;
		dueNotified = false;
		const repo = repository(ctx);
		try {
			await withFileMutationQueue(repo.storePath, async () => {
				const { store } = await repo.update(
					(store) => ensureDefaults(store),
					{ shouldSave: (result) => result },
				);
				rememberPools(store);
				refreshStatus(ctx, store);
				const due = listRetroDue(store);
				if (due.length && ctx.hasUI && !dueNotified) {
					ctx.ui.notify(`${due.length} 个候选复盘逾期，/compass-retro 查看`, "info");
					dueNotified = true;
				}
			});
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`罗盘启动初始化失败：${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		const initial = pi.getActiveTools().filter((name) => !DOMAIN_TOOLS.includes(name as (typeof DOMAIN_TOOLS)[number]));
		pi.setActiveTools([...new Set([...initial, "compass_tools"])]);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// 会话结束时兜底关闭 Web 工作台；用户忘记 /compass-web stop 也不留孤儿进程句柄。
		// 同步读取并清空 webServerPromise（中间不 await）：即使这次 shutdown 恰好发生在
		// /compass-web 的 startCompassWebServer 还没 resolve 时，也会等它一起完成再关闭，
		// 而不是看到 undefined 就什么都不做、让新起的服务器脱离清理路径
		const pending = webServerPromise;
		webServerPromise = undefined;
		if (pending) {
			try {
				const server = await pending;
				await server.close();
			} catch {
				// 进程即将退出，尽力关闭即可，不阻塞其余关停逻辑
			}
		}
		// 尽力落盘剩余计量（与 session_start 的写入同为生命周期事件，不在热路径 hook 禁写范围）
		if (ctx.isProjectTrusted() && pendingUsage.size) {
			let drained: Array<{ server: string; tool: string; calls: number }> = [];
			try {
				const repo = repository(ctx);
				// drain 在事务回调内执行：经队列串行，能带上在途失败事务刚还回的计数；无 drained 不落盘
				await withFileMutationQueue(repo.storePath, () => repo.update((store) => {
					ensureDefaults(store);
					drained = flushPendingUsage(store);
					return drained.length > 0;
				}, { shouldSave: (result) => result }));
			} catch {
				// 进程即将退出：还回内存仅为语义完整，丢失量以本批为上限（spec 已注明局限）
				restorePendingUsage(drained);
			}
		}
		if (ctx.hasUI) ctx.ui.setStatus("compass", undefined);
	});
}

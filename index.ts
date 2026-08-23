import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	getMarkdownTheme,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { decodeCsvBuffer, parseMarketCsv } from "./csv.ts";
import { estimateProfit, normalizeProfitInput } from "./economics.ts";
import {
	budgetStatus,
	buildStrategyContext,
	cloneStrategy,
	configureBudget,
	createLead,
	ensureDefaults,
	findCandidate,
	findMarket,
	importMarketAndScreen,
	latestStrategy,
	mainCpcForMarket,
	generateMarketReport,
	listStrategies,
	moveCandidate,
	recordCost,
	recordProfitEstimate,
	recordReviewAnalysis,
	recordRisk,
	runStrategy,
	saveStrategyVersion,
	scanMarkets,
} from "./service.ts";
import { CompassRepository } from "./store.ts";
import { CANDIDATE_STAGES, type CandidateStage, type CompassStore, type ReviewTheme } from "./types.ts";
import { compactDashboardSummary, CompassDashboard } from "./ui.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));
const TOOL_DETAILS_KIND = "compass-result";

interface CompassDetails {
	kind: typeof TOOL_DETAILS_KIND;
	title: string;
	status: "success" | "warning" | "error" | "info";
	summary: string;
	lines?: string[];
	path?: string;
	data?: unknown;
}

const DOMAIN_TOOLS = [
	"compass_lead",
	"compass_import_csv",
	"compass_market_scan",
	"compass_market_report",
	"compass_profit_estimate",
	"compass_strategy_run",
	"compass_strategy_manage",
	"compass_pool",
	"compass_risk_check",
	"compass_reviews_record",
	"compass_budget",
	"compass_asin_history",
	"compass_keyword_metrics",
	"compass_data_route",
] as const;

const TOOL_CATALOG: Array<{ name: (typeof DOMAIN_TOOLS)[number]; keywords: string; description: string }> = [
	{ name: "compass_lead", keywords: "lead clue keyword root 线索 灵感 词根 市场 创建", description: "把词根、竞品或榜单灵感建立为线索和候选卡" },
	{ name: "compass_import_csv", keywords: "import csv 导入 卖家精灵 西柚 sorftime 快照 市场", description: "导入卖家精灵/Sorftime/通用 CSV，生成不可变市场快照" },
	{ name: "compass_market_scan", keywords: "scan search market 市场 扫描 粗筛 筛选 qrd 新品", description: "扫描本地市场库并按 Gate、QRD、新品占比筛选" },
	{ name: "compass_market_report", keywords: "report 报告 五维 证据 evidence 决策", description: "生成带证据链的五维选品报告" },
	{ name: "compass_profit_estimate", keywords: "profit economics 利润 毛利 cpc fba 回本 资金", description: "计算毛利、BE-CPC、三情景净利和启动资金" },
	{ name: "compass_strategy_run", keywords: "strategy run gate score gse 策略 执行 评分", description: "运行版本化 GSE 策略" },
	{ name: "compass_strategy_manage", keywords: "strategy yaml edit clone 策略 编辑 复制 版本", description: "列出、读取、保存、复制策略 YAML" },
	{ name: "compass_pool", keywords: "pool kanban candidate stage 候选池 看板 移动 阶段", description: "管理候选池（七个工作阶段 + archived 归档）并强制记录移动原因" },
	{ name: "compass_risk_check", keywords: "risk patent trademark cert policy 风险 专利 商标 认证 擦边 季节", description: "记录五类风险清单与官方证据链接" },
	{ name: "compass_reviews_record", keywords: "review pain kano 差评 评论 痛点 聚类 产品力", description: "保存差评主题、可改良性和预估星级差" },
	{ name: "compass_budget", keywords: "budget cost quota source 预算 成本 配额 数据源 熔断", description: "查看、配置预算池并按市场记账" },
	{ name: "compass_asin_history", keywords: "asin history bsr price 历史 价格 评论", description: "读取同一 ASIN 跨快照历史" },
	{ name: "compass_keyword_metrics", keywords: "keyword search volume cpc 关键词 搜索量", description: "读取关键词跨快照指标" },
	{ name: "compass_data_route", keywords: "route source freshness cost 数据 路由 新鲜度 补数", description: "按阶段、字段、新鲜度和预算规划数据源" },
];

function actorName(explicit?: string): string {
	return explicit?.trim() || process.env.USER || process.env.USERNAME || "pi-user";
}

function normalizeCapturedAt(value?: string): string {
	if (!value) return new Date().toISOString();
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error(`captured_at 无效：${value}；请使用合法的 ISO 时间`);
	return date.toISOString();
}

function details(input: Omit<CompassDetails, "kind">): CompassDetails {
	return { kind: TOOL_DETAILS_KIND, ...input };
}

function searchTerms(query: string): string[] {
	const chunks = query.normalize("NFKC").toLocaleLowerCase().match(/[A-Za-z0-9_]+|[\u4e00-\u9fff]+/gu) ?? [];
	const terms = new Set<string>();
	for (const chunk of chunks) {
		terms.add(chunk);
		if (/^[\u4e00-\u9fff]+$/u.test(chunk)) {
			for (let index = 0; index < chunk.length - 1; index++) terms.add(chunk.slice(index, index + 2));
		}
	}
	return [...terms];
}

function textResult(text: string, toolDetails: CompassDetails) {
	const truncated = truncateHead(text, { maxBytes: 45_000, maxLines: 1_500 });
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

	function assertTrusted(ctx: ExtensionContext): void {
		if (!ctx.isProjectTrusted()) throw new Error("罗盘拒绝读取未受信任项目的数据配置");
	}

	async function readStore(ctx: ExtensionContext): Promise<CompassStore> {
		assertTrusted(ctx);
		const store = await repository(ctx).load();
		ensureDefaults(store);
		return store;
	}

	async function mutateStore<T>(ctx: ExtensionContext, mutator: (store: CompassStore) => T | Promise<T>): Promise<{ store: CompassStore; result: T }> {
		assertTrusted(ctx);
		const repo = repository(ctx);
		const value = await withFileMutationQueue(repo.storePath, () => repo.update(async (store) => {
			ensureDefaults(store);
			return mutator(store);
		}));
		refreshStatus(ctx, value.store);
		return value;
	}

	function refreshStatus(ctx: ExtensionContext, store: CompassStore): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("compass", ctx.ui.theme.fg("accent", `罗盘 ${compactDashboardSummary(store)}`));
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
		const repo = repository(ctx);
		const path = repo.resolveInputPath(input.path);
		const buffer = await readFile(path);
		const capturedAt = normalizeCapturedAt(input.capturedAt);
		const parsed = parseMarketCsv(decodeCsvBuffer(buffer), { source: input.source, capturedAt });
		const archivedFile = await repo.archiveRaw(basename(path), buffer, capturedAt);
		const fileHash = createHash("sha256").update(buffer).digest("hex");
		const actor = actorName(input.actor);
		const { result, store } = await mutateStore(ctx, (data) => importMarketAndScreen(data, {
			marketName: input.marketName,
			keywords: input.keywords,
			parsed,
			capturedAt,
			fileName: relative(ctx.cwd, path),
			archivedFile,
			fileHash,
			actor,
			runScreen: input.runScreen,
		}));
		return { ...result, store, parsed, archivedFile };
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
			const { result } = await mutateStore(ctx, (store) => createLead(store, {
				marketName: params.market_name,
				keywords: params.keywords,
				category: params.category,
				owner: params.owner,
				tags: params.tags,
				actor: actorName(params.actor),
			}));
			const summary = `${result.created ? "创建" : "更新"}线索 ${result.market.name} · ${result.market.keywords.length} 个关键词`;
			return textResult(`${summary}\nmarket_id=${result.market.id}\ncandidate_id=${result.candidate.id}\nstage=${result.candidate.stage}`, details({ title: "市场线索", status: "success", summary, lines: [`下一步：导入 CSV 建立首个市场快照`] }));
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
			source: Type.Optional(StringEnum(["auto", "sellersprite", "sorftime", "keepa", "compass_browser", "manual_csv", "generic_csv"] as const)),
			keywords: Type.Optional(Type.Array(Type.String())),
			captured_at: Type.Optional(Type.String({ description: "ISO 时间；默认当前时间" })),
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
				`${summary}\nmarket_id=${imported.market.id}\ncandidate_id=${imported.candidate.id}\nsnapshot_id=${imported.snapshot.id}\nraw=${imported.archivedFile}\nwarnings=${imported.parsed.warnings.join("；") || "无"}`,
				details({ title: "CSV 已入库", status: imported.screenRun?.result.outcome === "reject" ? "warning" : "success", summary, path: imported.archivedFile, lines: imported.parsed.warnings }),
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
			strategy_id: Type.Optional(Type.String()),
			outcome: Type.Optional(StringEnum(["pass", "review", "reject"] as const)),
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
				const qrd = row.snapshot.metrics.qualify_rank_depth?.value ?? "—";
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
			strategy_id: Type.Optional(Type.String()),
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
				const mainCpc = mainCpcForMarket(store, market.id);
				if (cpc === undefined && mainCpc !== undefined) cpc = mainCpc;
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
			strategy_id: Type.Optional(Type.String()),
			mode: Type.Optional(StringEnum(["screen", "full"] as const)),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const { result: run } = await mutateStore(ctx, (store) => runStrategy(store, {
				marketRef: params.market_ref,
				strategyRef: params.strategy_id,
				mode: params.mode ?? "full",
				actor: actorName(params.actor),
			}));
			const failures = run.result.rules.filter((rule) => rule.status !== "pass");
			const lines = failures.map((rule) => `[${rule.status}] ${rule.stage}/${rule.id}: ${rule.message}`);
			const summary = `${run.result.outcome} · ${run.result.score.toFixed(1)}分 · ${failures.length} 个非通过项`;
			return textResult([`run_id=${run.id}`, summary, ...lines, `missing=${run.result.missingMetrics.join(",") || "无"}`].join("\n"), details({ title: `策略运行 · ${run.mode}`, status: run.result.outcome === "pass" ? "success" : "warning", summary, lines, data: run.result }));
		},
		renderCall: renderCallLabel("compass_strategy_run"),
		renderResult: renderCompassResult,
	});

	pi.registerTool({
		name: "compass_strategy_manage",
		label: "Compass Strategy Manage",
		description: "管理个性化策略：list 列最新版本，get 读取 YAML，save 将 YAML 保存为不可覆盖的新版本，clone 复制模板。表达式由安全 DSL 解释器执行，不使用 eval。",
		parameters: Type.Object({
			action: StringEnum(["list", "get", "save", "clone"] as const),
			strategy_id: Type.Optional(Type.String()),
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
				const strategy = latestStrategy(await readStore(ctx), params.strategy_id);
				return textResult(strategy.yaml, details({ title: `${strategy.name}@v${strategy.version}`, status: "success", summary: strategy.changeNote ?? "无版本说明" }));
			}
			if (params.action === "save") {
				if (!params.yaml) throw new Error("save 需要 yaml");
				const { result: strategy } = await mutateStore(ctx, (store) => saveStrategyVersion(store, { yaml: params.yaml as string, actor: actorName(params.actor), changeNote: params.change_note }));
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
		description: "查看或移动候选卡（七个工作阶段 + archived 归档）。move 强制填写 reason，并把快照、策略、决策人和时间写入 decision_log。",
		parameters: Type.Object({
			action: StringEnum(["list", "get", "move"] as const),
			candidate_ref: Type.Optional(Type.String({ description: "candidate_id、market_id 或唯一市场名" })),
			stage: Type.Optional(StringEnum(CANDIDATE_STAGES)),
			outcome: Type.Optional(StringEnum(["pass", "review", "reject"] as const)),
			reason: Type.Optional(Type.String()),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (params.action === "move") {
				if (!params.candidate_ref || !params.stage || !params.reason) throw new Error("move 需要 candidate_ref、stage、reason");
				const { result: candidate, store } = await mutateStore(ctx, (data) => moveCandidate(data, { candidateRef: params.candidate_ref as string, stage: params.stage as CandidateStage, reason: params.reason as string, actor: actorName(params.actor) }));
				const market = store.markets.find((item) => item.id === candidate.marketId);
				return textResult(`${candidate.id} | ${market?.name} | stage=${candidate.stage}`, details({ title: "候选已移动", status: "success", summary: `${market?.name ?? candidate.marketId} → ${candidate.stage}`, lines: [`原因：${params.reason}`] }));
			}
			const store = await readStore(ctx);
			if (params.action === "get") {
				if (!params.candidate_ref) throw new Error("get 需要 candidate_ref");
				const candidate = findCandidate(store, params.candidate_ref);
				const market = store.markets.find((item) => item.id === candidate.marketId);
				const decisions = store.decisionLog.filter((item) => item.candidateId === candidate.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
				const output = [`${candidate.id} | ${market?.name} | ${candidate.stage} | Gate=${candidate.gateOutcome ?? "—"} | Score=${candidate.score ?? "—"}`, ...decisions.map((decision) => `${decision.createdAt} | ${decision.type} | ${decision.conclusion} | ${decision.actor} | ${decision.reason}`)];
				return textResult(output.join("\n"), details({ title: market?.name ?? candidate.id, status: "success", summary: `${candidate.stage} · ${decisions.length} 条决策记录`, lines: output.slice(1, 11) }));
			}
			const candidates = store.candidates.filter((candidate) => (!params.stage || candidate.stage === params.stage) && (!params.outcome || candidate.gateOutcome === params.outcome));
			const lines = candidates.map((candidate) => {
				const market = store.markets.find((item) => item.id === candidate.marketId);
				return `${candidate.id} | ${market?.name ?? candidate.marketId} | ${candidate.stage} | ${candidate.gateOutcome ?? "—"} | ${candidate.score ?? "—"}`;
			});
			return textResult(lines.join("\n") || "候选池为空", details({ title: "候选池", status: "success", summary: `${candidates.length} 张候选卡`, lines: lines.slice(0, 12) }));
		},
		renderCall: renderCallLabel("compass_pool"),
		renderResult: renderCompassResult,
	});

	const RiskStatusSchema = StringEnum(["pass", "review", "red", "unknown"] as const);
	pi.registerTool({
		name: "compass_risk_check",
		label: "Compass Risk Check",
		description: "记录认证、知识产权、季节性、政策擦边和物流五类风险，以及核验过的官方证据 URL。该工具只留痕，不替代律师或认证机构；不得仅凭模型记忆判绿。",
		parameters: Type.Object({
			market_ref: Type.String(),
			cert_status: RiskStatusSchema,
			ip_risk_level: RiskStatusSchema,
			season_flag: StringEnum(["clear", "strong", "review", "unknown"] as const),
			policy_flag: StringEnum(["clear", "review", "red", "unknown"] as const),
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
				category: StringEnum(["quality", "size", "damage", "expectation", "usability", "other"] as const),
				count: Type.Integer({ minimum: 0 }),
				share: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
				fixability: StringEnum(["factory", "packaging", "copy", "none", "unknown"] as const),
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
		description: "预算池操作：status 查看各数据源当月消耗/80%告警/100%熔断；record 按市场归因成本；configure 配置来源、档位与月上限。",
		parameters: Type.Object({
			action: StringEnum(["status", "record", "configure"] as const),
			source: Type.Optional(Type.String()),
			market_ref: Type.Optional(Type.String()),
			amount_cny: Type.Optional(Type.Number({ minimum: 0 })),
			description: Type.Optional(Type.String()),
			tier: Type.Optional(StringEnum(["A", "B", "C"] as const)),
			monthly_limit_cny: Type.Optional(Type.Number({ minimum: 0 })),
			enabled: Type.Optional(Type.Boolean()),
			note: Type.Optional(Type.String()),
			force: Type.Optional(Type.Boolean()),
			actor: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (params.action === "status") {
				const pools = budgetStatus(await readStore(ctx));
				const lines = pools.map((pool) => `${pool.source} | ${pool.tier} | ¥${pool.spentCny}/¥${pool.monthlyLimitCny || 0} | ${pool.state} | ${pool.enabled ? "enabled" : "disabled"}`);
				return textResult(lines.join("\n"), details({ title: "数据预算", status: pools.some((pool) => pool.state === "fused") ? "warning" : "success", summary: `${pools.length} 个预算池 · 本月 ¥${pools.reduce((sum, pool) => sum + pool.spentCny, 0).toFixed(2)}`, lines }));
			}
			if (params.action === "record") {
				if (!params.source || params.amount_cny === undefined) throw new Error("record 需要 source 与 amount_cny");
				const { result: event } = await mutateStore(ctx, (store) => recordCost(store, { source: params.source as string, marketRef: params.market_ref, amountCny: params.amount_cny as number, description: params.description, actor: actorName(params.actor), force: params.force }));
				return textResult(`cost_id=${event.id}\n${event.source} ¥${event.amountCny}\nmarket=${event.marketId ?? "未归因"}`, details({ title: "成本已记账", status: "success", summary: `${event.source} · ¥${event.amountCny.toFixed(2)} · ${event.marketId ?? "未归因"}` }));
			}
			if (!params.source) throw new Error("configure 需要 source；新预算池另需 tier 与 monthly_limit_cny");
			const { result: pool } = await mutateStore(ctx, (store) => configureBudget(store, { source: params.source as string, tier: params.tier as "A" | "B" | "C" | undefined, monthlyLimitCny: params.monthly_limit_cny, enabled: params.enabled, note: params.note }));
			return textResult(`${pool.source} | tier=${pool.tier} | limit=¥${pool.monthlyLimitCny} | enabled=${pool.enabled}`, details({ title: "预算池已配置", status: "success", summary: `${pool.source} · ${pool.tier}档 · ¥${pool.monthlyLimitCny}/月` }));
		},
		renderCall: renderCallLabel("compass_budget"),
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
				.sort((a, b) => b.snapshot.capturedAt.localeCompare(a.snapshot.capturedAt))
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
				.sort((a, b) => b.snapshot.capturedAt.localeCompare(a.snapshot.capturedAt))
				.slice(0, params.limit ?? 50);
			const lines = rows.map(({ snapshot, keyword }) => `${snapshot.capturedAt} | ${snapshot.source} | ${keyword.keyword} | volume=${keyword.searchVolume ?? "—"} | cpc=${keyword.cpc ?? "—"} | rank=${keyword.rank ?? "—"}`);
			return textResult(lines.join("\n") || `未找到关键词 ${params.keyword}`, details({ title: `关键词指标 · ${params.keyword}`, status: rows.length ? "success" : "warning", summary: `${rows.length} 条记录`, lines: lines.slice(0, 12) }));
		},
		renderCall: renderCallLabel("compass_keyword_metrics"),
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
				deep_research: ["gross_margin", "cpc_ratio", "waist_rating_median", "main_cpc"],
				risk: ["risk_overall", "cert_status", "ip_risk_level", "season_flag", "policy_flag", "logistics_risk"],
				testing: ["daily_units", "tacos", "return_rate"],
			};
			const fields = params.fields?.length ? params.fields : defaults[params.stage];
			const snapshot = store.snapshots
				.filter((item) => item.marketId === market.id)
				.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
			if (!snapshot) {
				const plan = ["C档：先从卖家精灵/Sorftime 官方导出 CSV，或使用用户主动触发的 Compass 浏览器伴侣采集首个快照；成本≈¥0"];
				const summary = `尚无快照 · 缺 ${fields.length}/${fields.length} 字段 · 先完成 C 档采集`;
				return textResult([summary, `market=${market.id}`, `missing=${fields.join(",")}`, ...plan].join("\n"), details({ title: "数据源路由", status: "warning", summary, lines: plan }));
			}
			const metrics = buildStrategyContext(store, market.id).context.metrics;
			const age = Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.capturedAt)) / 86_400_000));
			const maxAge = params.stage === "lead" || params.stage === "screen" ? 30 : params.stage === "testing" ? 1 : 7;
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
			const terms = searchTerms(params.query);
			let matches = TOOL_CATALOG.map((item) => ({
				...item,
				score: terms.reduce((score, term) => score + (`${item.name} ${item.keywords} ${item.description}`.toLocaleLowerCase().includes(term) ? 1 : 0), 0),
			})).filter((item) => params.load_all || item.score > 0).sort((a, b) => b.score - a.score);
			if (!matches.length) matches = TOOL_CATALOG.filter((item) => ["compass_lead", "compass_import_csv", "compass_market_scan", "compass_market_report", "compass_strategy_run"].includes(item.name)).map((item) => ({ ...item, score: 0 }));
			matches = matches.slice(0, params.load_all ? DOMAIN_TOOLS.length : params.limit ?? 5);
			const active = pi.getActiveTools();
			const added = matches.map((item) => item.name).filter((name) => !active.includes(name));
			pi.setActiveTools([...new Set([...active, ...added])]);
			const lines = matches.map((item) => `${item.name}: ${item.description}`);
			return textResult(`${added.length ? `已启用：${added.join(", ")}` : "相关工具已启用"}\n${lines.join("\n")}`, details({ title: "罗盘工具路由", status: "success", summary: `${added.length} 个新工具，${matches.length} 个匹配`, lines }));
		},
		renderCall: renderCallLabel("compass_tools"),
		renderResult: renderCompassResult,
	});

	pi.registerEntryRenderer("compass-report", (entry, options, _theme) => {
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
			const store = await readStore(ctx);
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
			const source = await ctx.ui.select("数据来源", ["auto", "sellersprite", "sorftime", "keepa", "compass_browser", "manual_csv", "generic_csv"]);
			if (!source) return;
			const imported = await performImport(ctx, { path, marketName, source, runScreen: true });
			ctx.ui.notify(`${imported.market.name} 已导入；粗筛=${imported.screenRun?.result.outcome ?? "未运行"}`, imported.screenRun?.result.outcome === "reject" ? "warning" : "info");
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
			ctx.ui.notify(`报告已保存：${relative(ctx.cwd, output)}`, "info");
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
			const strategy = latestStrategy(store, ref);
			const edited = await ctx.ui.editor(`编辑 ${strategy.name}@v${strategy.version}`, strategy.yaml);
			if (!edited || edited === strategy.yaml) return;
			const note = await ctx.ui.input("版本说明", `基于 v${strategy.version} 调整`);
			const saved = await mutateStore(ctx, (data) => saveStrategyVersion(data, { yaml: edited, actor: actorName(), changeNote: note }));
			ctx.ui.notify(`已保存 ${saved.result.id}@v${saved.result.version}`, "info");
		},
	});

	pi.on("resources_discover", () => ({
		skillPaths: [join(baseDir, "skills", "compass-selection", "SKILL.md")],
	}));

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.isProjectTrusted()) return;
		const repo = repository(ctx);
		try {
			await withFileMutationQueue(repo.storePath, async () => {
				const { store } = await repo.update(
					(store) => ensureDefaults(store),
					{ shouldSave: (result) => result },
				);
				refreshStatus(ctx, store);
			});
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`罗盘启动初始化失败：${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		const initial = pi.getActiveTools().filter((name) => !DOMAIN_TOOLS.includes(name as (typeof DOMAIN_TOOLS)[number]));
		pi.setActiveTools([...new Set([...initial, "compass_tools"])]);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("compass", undefined);
	});
}

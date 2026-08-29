// 罗盘 Compass Web UI — 纯 JS 单页应用：hash 路由 + fetch 封装 + 八个视图
// （总览/待办/市场/市场档案/候选池/预算/复盘/导入向导）。
// 纯 JS、无框架、无构建步骤（仓库零新增运行时依赖的约定延伸到前端）。

// 唯一的跨文件依赖：报告弹窗要在浏览器里把 Markdown 渲染成 HTML。
// 拆出去是为了让它能被 tests/web-markdown.test.ts 直接 import（app.js 本身满是 DOM 操作、
// 在 node 里 import 会直接抛错），渲染器又正好是这套前端里唯一有注入风险的纯函数。
import { renderMarkdown } from "./markdown.js";

const TABS = [
	{ id: "overview", label: "总览", hash: "#/overview" },
	{ id: "todos", label: "待办", hash: "#/todos" },
	{ id: "markets", label: "市场", hash: "#/markets" },
	{ id: "pool", label: "候选池", hash: "#/pool" },
	{ id: "budget", label: "预算", hash: "#/budget" },
	{ id: "retro", label: "复盘", hash: "#/retro" },
];

const GATE_LABELS = { pass: "PASS", review: "REVIEW", reject: "REJECT" };
const GATE_TONES = { pass: "tone-success", review: "tone-warning", reject: "tone-error" };
const DECISION_LABELS = { go: "上", waitlist: "观望", no_go: "不做" };
const DECISION_TONES = { go: "tone-success", waitlist: "tone-warning", no_go: "tone-error" };
const BUDGET_STATE_LABELS = { ok: "正常", warning: "80%告警", fused: "熔断", free: "免费" };
const BUDGET_STATE_TONES = { ok: "tone-success", warning: "tone-warning", fused: "tone-error", free: "tone-success" };

// 总览页各面板是「预览」——展示前 N 条，其余引导去对应 tab 看全量
const TODO_PREVIEW_PER_GROUP = 2;
const BUDGET_PREVIEW_LIMIT = 6;

// 待办 kind → 中文标签（对照 todo.ts 派生的十种 kind）
const TODO_KIND_LABELS = {
	budget_fused: "预算熔断",
	budget_warning: "预算预警",
	retro_challenged: "复盘被挑战",
	gate_review: "Gate 待复核",
	decision_pending: "决策悬置",
	deep_missing_data: "深研缺数据",
	risk_missing: "风险未核",
	snapshot_stale: "快照过期",
	retro_due: "复盘到期",
	metric_divergence: "指标分歧",
};

// 待办 kind → 最相关的站内页面（suggestedAction 本身是给 pi 命令行的指令文本，
// 不是可点击的一步到位操作；这里只负责把人带到能处理这件事的地方）
function todoKindRoute(todo) {
	switch (todo.kind) {
		case "budget_fused":
		case "budget_warning":
			return "#/budget";
		case "retro_challenged":
		case "retro_due":
			return "#/retro";
		case "gate_review":
		case "decision_pending":
			return "#/pool";
		case "snapshot_stale":
			return "#/import";
		default:
			return todo.marketId ? `#/market/${encodeURIComponent(todo.marketId)}` : "#/markets";
	}
}

const TODO_KIND_BUTTON_LABELS = {
	budget_fused: "查看预算",
	budget_warning: "查看预算",
	retro_challenged: "查看复盘",
	retro_due: "查看复盘",
	gate_review: "打开候选池",
	decision_pending: "记录决策",
	deep_missing_data: "查看市场档案",
	risk_missing: "补充证据链接",
	metric_divergence: "查看市场档案",
	snapshot_stale: "重新导入 CSV",
};

const TODO_GROUP_EMPTY_TEXT = {
	1: "当前没有紧急阻塞事项——预算熔断、复盘 challenged 会出现在这里",
	2: "当前没有漏斗阻塞事项",
	3: "当前没有需要补数据或补证据的事项",
	4: "没有到期复盘或预算 80% 告警",
	5: "当前没有需要保鲜或优化的事项",
};

const MARKET_TABLE_COLUMNS = "1fr 64px 56px 56px 56px 64px 68px 68px 110px 52px";
const MARKET_GATE_CHIPS = [
	{ key: "pass", label: "pass" },
	{ key: "review", label: "review" },
	{ key: "reject", label: "reject" },
];
const MARKET_FRESHNESS_CHIPS = [
	{ key: "deep_fresh", label: "≤7d" },
	{ key: "screen_only", label: "8–30d" },
	{ key: "stale", label: ">30d" },
	{ key: "missing", label: "无快照" },
];

// ── 图标（内联 SVG，禁止 emoji/dingbat 字符——沿用设计画布的红线） ──────────

const ICON_LOGO = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="flex:0 0 auto;">
	<circle cx="12" cy="12" r="9.5" stroke="#e2a33e" stroke-width="1.5"></circle>
	<path d="M15.5 8.5 L13.2 13.2 L8.5 15.5 L10.8 10.8 Z" fill="#e2a33e"></path>
	<circle cx="12" cy="12" r="1.2" fill="#0e1216"></circle>
</svg>`;

const ICON_SEARCH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="#8b98a5" stroke-width="2"></circle><path d="M16.5 16.5 L21 21" stroke="#8b98a5" stroke-width="2" stroke-linecap="round"></path></svg>`;

const ICON_UPLOAD = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 16 V4 M7 9 L12 4 L17 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path><path d="M4 20 H20" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>`;

const ICON_CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 12.5 L9.5 18 L20 6.5" stroke="#4cc38a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;

const ICON_CHEVRON_DOWN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M7 10 L12 15 L17 10" stroke="#8b98a5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;

const ICON_PLUS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5 V19 M5 12 H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>`;

const ICON_BACK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 5 L8 12 L15 19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;

// ── 工具函数 ──────────────────────────────────────────────────────

function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

// 全站唯一一处 matchMedia：目录跳转的平滑滚动是这套 UI 里唯一的动效，用户关了动效就别硬滚。
// 每次现查而不缓存——系统偏好可以在页面开着的时候改
function prefersReducedMotion() {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function formatCny(amount) {
	const n = Number(amount) || 0;
	return Number.isInteger(n) ? `¥${n}` : `¥${n.toFixed(2)}`;
}

// 本月数据成本（摘要条 / KPI 卡）固定两位小数；预算面板的额度是整数配置，交给 formatCny 省小数
function formatMoney(amount) {
	return `¥${(Number(amount) || 0).toFixed(2)}`;
}

function formatPercent(rate, digits = 0) {
	if (rate === null || rate === undefined || Number.isNaN(rate)) return "—";
	return `${(rate * 100).toFixed(digits)}%`;
}

function formatDateTime(iso) {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateShort(iso) {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 导入向导「采集日期」默认值：取本地日历日期，不能用 toISOString().slice(0,10)——
// 那是 UTC 日期，UTC+8 用户在本地 00:00–08:00 之间会看到「昨天」
function todayLocalDate() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 成功 envelope 解包 data；失败抛出带中文消息的 Error，调用方统一渲染错误面板
async function fetchApi(path, init) {
	let response;
	try {
		response = await fetch(path, init);
	} catch {
		throw new Error("无法连接罗盘 Web 服务，请确认它仍在运行");
	}
	let body;
	try {
		body = await response.json();
	} catch {
		throw new Error(`服务返回了无法解析的响应（状态 ${response.status}）`);
	}
	if (!body || body.ok !== true) throw new Error(body?.error || `请求失败（状态 ${response.status}）`);
	return body.data;
}

// ── 外壳（仅启动时渲染一次） ──────────────────────────────────────

function renderShell() {
	const app = document.getElementById("app");
	app.innerHTML = `
		<div class="app-shell">
			<div class="topbar">
				<div class="topbar-brand">
					${ICON_LOGO}
					<div class="topbar-brand-text">
						<span class="topbar-title">罗盘 COMPASS</span>
						<span class="topbar-subtitle">Amazon US 精铺选品工作台</span>
					</div>
				</div>
				<div class="tabs" id="tabs"></div>
				<div class="topbar-actions">
					<div class="search-box is-disabled" title="搜索即将上线">
						${ICON_SEARCH}
						<span>搜索市场、候选、决策…</span>
						<span class="kbd">⌘K</span>
					</div>
					<a class="btn btn-accent" href="#/import">${ICON_UPLOAD}导入 CSV</a>
				</div>
			</div>
			<div class="summary-bar" id="summary-bar"></div>
			<div class="content" id="content"><div class="loading">加载中…</div></div>
			<div class="footer-bar" id="footer-bar"></div>
		</div>
	`;
	document.getElementById("tabs").innerHTML = TABS.map((tab) => `<a class="tab" id="tab-${tab.id}" href="${tab.hash}">${escapeHtml(tab.label)}<span class="tab-count" id="tab-count-${tab.id}" hidden></span></a>`).join("");
}

function setActiveTab(tabId) {
	for (const tab of TABS) {
		const el = document.getElementById(`tab-${tab.id}`);
		if (el) el.classList.toggle("is-active", tab.id === tabId);
	}
}

function setTodoTabCount(count) {
	const el = document.getElementById("tab-count-todos");
	if (!el) return;
	if (count > 0) {
		el.hidden = false;
		el.textContent = String(count);
	} else {
		el.hidden = true;
	}
}

// ── 摘要条 / 底栏（全局，每次导航都刷新） ────────────────────────────

function renderSummaryBar(summary) {
	const el = document.getElementById("summary-bar");
	const parts = [
		[summary.markets, "市场"],
		[summary.activeCandidates, "活跃候选"],
		[summary.gateReview, "待复核", summary.gateReview > 0 ? "tone-warning" : ""],
		[summary.gateReject, "否决", summary.gateReject > 0 ? "tone-error" : ""],
		[summary.retroDue, "待复盘"],
	];
	const segs = parts.map(([value, label, tone]) => `<span class="${tone || "val"}">${value}</span><span>${label}</span><span class="sep">·</span>`);
	const todoLabel = summary.todoP1 > 0 ? `待办（P1 ${summary.todoP1}）` : "待办";
	segs.push(`<span class="val">${summary.todoTotal}</span><span>${escapeHtml(todoLabel)}</span><span class="sep">·</span>`);
	segs.push(`<span>验证率 ${formatPercent(summary.validationRate)}</span><span class="sep">·</span>`);
	segs.push(`<span>本月 <span class="tone-success">${formatMoney(summary.monthSpentCny)}</span></span>`);
	el.innerHTML = `${segs.join("")}<span class="trailing">store 更新于 ${formatDateTime(summary.storeUpdatedAt)} · 数据实时读取</span>`;
	setTodoTabCount(summary.todoTotal);
}

function renderSummaryBarError(message) {
	document.getElementById("summary-bar").innerHTML = `<span class="tone-error">${escapeHtml(message)}</span>`;
	document.getElementById("footer-bar").innerHTML = "";
}

function renderFooterBar(overview) {
	const el = document.getElementById("footer-bar");
	const retro = overview.retro;
	el.innerHTML = `
		<div>${escapeHtml(overview.gateDefaultsLine)}</div>
		<div class="mono">复盘：OutcomeCheck ${retro.checks} · 验证率 ${formatPercent(retro.validationRate)} · active lessons ${retro.activeLessons}</div>
	`;
}

// ── 总览页 ──────────────────────────────────────────────────────

function stageBreakdownText(stages) {
	const active = stages
		.filter((s) => s.stage !== "archived" && s.stage !== "review" && s.count > 0)
		.sort((a, b) => b.count - a.count);
	if (!active.length) return "暂无活跃候选";
	return active.map((s) => `${s.count} ${s.label}`).join(" · ");
}

function renderKpiGrid(data) {
	const staleTone = data.kpi.staleMarkets30d > 0 ? "tone-warning" : "tone-success";
	return `
		<div class="kpi-grid">
			<div class="kpi-card">
				<div class="kpi-label">市场档案</div>
				<div class="kpi-value">${data.summary.markets}</div>
				<div class="kpi-sub ${staleTone}">${data.kpi.staleMarkets30d} 个快照已超 30 天</div>
			</div>
			<div class="kpi-card">
				<div class="kpi-label">活跃候选</div>
				<div class="kpi-value">${data.summary.activeCandidates}</div>
				<div class="kpi-sub">${escapeHtml(stageBreakdownText(data.stages))}</div>
			</div>
			<div class="kpi-card">
				<div class="kpi-label">Gate 结果</div>
				<div class="kpi-value kpi-value-inline">
					<span class="tone-success">通过 ${data.kpi.gate.pass}</span>
					<span class="tone-warning">复核 ${data.kpi.gate.review}</span>
					<span class="tone-error">否决 ${data.kpi.gate.reject}</span>
				</div>
				<div class="kpi-sub">缺数据一律计入复核，不伪装通过</div>
			</div>
			<div class="kpi-card">
				<div class="kpi-label">本月数据成本</div>
				<div class="kpi-value tone-success">${formatMoney(data.summary.monthSpentCny)}</div>
				<div class="kpi-sub">熔断 ${data.kpi.fusedPools} 池 · 归因率 ${formatPercent(data.kpi.attributionRate)}</div>
			</div>
		</div>
	`;
}

function renderPipeline(data) {
	const cells = data.stages.map((s) => `
		<a class="pipeline-stage ${s.count > 0 ? "has-items" : ""}" href="#/pool">
			<div class="pipeline-count">${s.count}</div>
			<div class="pipeline-label">${escapeHtml(s.label)}${s.stage === "archived" ? " · 否决保留" : ""}</div>
		</a>
	`).join("");
	return `
		<div class="panel pipeline-panel">
			<div class="panel-header">
				<div class="panel-title">阶段流水线 <span class="tone-muted" style="font-weight:400;">七个工作阶段 + 归档</span></div>
				<div class="panel-hint">点击任一阶段进入候选池筛选</div>
			</div>
			<div class="pipeline-grid">${cells}</div>
		</div>
	`;
}

function todoSubject(todo) {
	return todo.marketName || todo.source || "—";
}

function todoLineText(todo) {
	const subject = todoSubject(todo);
	let line = `${subject} · ${todo.title} · ${todo.reason}`;
	if (todo.overdueDays) line += ` · 逾期${todo.overdueDays}天`;
	return line;
}

function renderTodoPreviewPanel(todosResult) {
	const nonEmpty = todosResult.groups.filter((g) => g.todos.length > 0);
	let body;
	if (!nonEmpty.length) {
		body = `<div class="empty-state">${ICON_CHECK}当前没有需要人工处理的事项</div>`;
	} else {
		body = nonEmpty.map((group) => {
			const shown = group.todos.slice(0, TODO_PREVIEW_PER_GROUP);
			const items = shown.map((todo) => `
				<div class="todo-item p${group.priority}">
					<div class="todo-title">${escapeHtml(todoLineText(todo))}</div>
					<div class="todo-action">→ ${escapeHtml(todo.suggestedAction)}</div>
				</div>
			`).join("");
			const overflow = group.todos.length > shown.length ? `<div class="overflow-hint">… 另有 ${group.todos.length - shown.length} 条</div>` : "";
			return `
				<div>
					<div class="todo-group-label p${group.priority}">${escapeHtml(group.label)} (${group.todos.length})</div>
					<div class="todo-items">${items}${overflow}</div>
				</div>
			`;
		}).join("");
	}
	return `
		<div class="panel col-panel">
			<div class="panel-header">
				<div class="panel-title">待办清单 <span class="count">${todosResult.total}</span></div>
				<div class="panel-hint">自动推导 · 解决即消失</div>
			</div>
			<div class="col-panel-body scroll-x">${body}</div>
			<div class="panel-footnote"><a href="#/todos">查看全部待办 →</a></div>
		</div>
	`;
}

function renderMarketRadarPanel(data) {
	const rows = data.radar.map((row) => {
		const gate = row.gateOutcome ? `<span class="mono ${GATE_TONES[row.gateOutcome] || ""}" style="font-size:11px;">${GATE_LABELS[row.gateOutcome] || row.gateOutcome}</span>` : `<span class="cell-dim">—</span>`;
		const score = row.score !== null ? `<span class="mono tone-accent">${row.score.toFixed(1)}</span>` : `<span class="cell-dim">—</span>`;
		const snapshot = row.snapshotAgeDays !== null ? `${row.snapshotAgeDays}d · ${escapeHtml(row.source || "")}` : escapeHtml(row.freshnessLabel);
		return `
			<a class="data-table-row" href="#/market/${encodeURIComponent(row.marketId)}" style="grid-template-columns: 1fr 64px 56px 96px;">
				<div class="cell-truncate">${escapeHtml(row.name)}</div>
				<div>${gate}</div>
				<div class="cell-right">${score}</div>
				<div class="cell-right cell-muted" style="font-size:11px;">${snapshot}</div>
			</a>
		`;
	}).join("");
	const more = data.summary.markets > data.radar.length ? `<div class="overflow-hint"><a href="#/markets">查看全部 ${data.summary.markets} 个市场 →</a></div>` : "";
	return `
		<div class="panel col-panel">
			<div class="panel-header">
				<div class="panel-title">市场雷达 <span class="mono cell-muted">${data.summary.markets}</span></div>
				<div class="panel-hint">按更新时间 · 点行进入市场档案</div>
			</div>
			<div class="data-table scroll-x">
				<div class="data-table-row data-table-head" style="grid-template-columns: 1fr 64px 56px 96px;">
					<div>市场</div><div>Gate</div><div class="cell-right">Score</div><div class="cell-right">快照 / 来源</div>
				</div>
				${rows || `<div class="empty-state is-neutral">尚无市场，导入 CSV 开始</div>`}
			</div>
			<div class="panel-footnote">Score 为同批分位数排序值，不跨批比较 · veto 命中时高分仍否决${more}</div>
		</div>
	`;
}

function renderBudgetPanel(data) {
	const shown = data.budget.slice(0, BUDGET_PREVIEW_LIMIT);
	const rows = shown.map((pool) => {
		const disabledCls = pool.enabled === false ? "is-disabled" : "";
		const usage = pool.monthlyLimitCny > 0 ? `${formatCny(pool.spentCny)} / ${formatCny(pool.monthlyLimitCny)}` : `免费${pool.callCount ? ` · ${pool.callCount} 次` : ""}`;
		const ratio = budgetRatio(pool);
		const fillTone = budgetFillTone(pool.state);
		return `
			<div class="budget-row ${disabledCls}">
				<div class="budget-row-head">
					<span>${escapeHtml(pool.source)} <span class="cell-dim" style="font-size:10px;">${escapeHtml(pool.tier)}${pool.enabled === false ? " · 禁用" : ""}</span></span>
					<span class="mono cell-muted">${usage}</span>
				</div>
				<div class="meter ${disabledCls ? "is-disabled" : ""}">${ratio > 0 ? `<div class="meter-fill ${fillTone}" style="width:${ratio}%;"></div>` : ""}</div>
			</div>
		`;
	}).join("");
	const more = data.budget.length > shown.length ? `<div class="overflow-hint"><a href="#/budget">查看全部 ${data.budget.length} 个数据源 →</a></div>` : "";
	return `
		<div class="panel col-panel">
			<div class="panel-header">
				<div class="panel-title">数据源预算 · 当月</div>
				<div class="panel-hint">80% 告警 · 100% 熔断</div>
			</div>
			<div class="col-panel-body scroll-x">
				<div class="budget-list">${rows || `<div class="empty-state is-neutral">尚未配置数据源</div>`}</div>
				${more}
			</div>
			<div class="panel-footnote">熔断为硬拦截：达 100% 后付费 MCP 调用被直接阻断</div>
		</div>
	`;
}

function renderPanelError(title, message) {
	return `
		<div class="panel col-panel">
			<div class="panel-header"><div class="panel-title">${escapeHtml(title)}</div></div>
			<div class="col-panel-body"><div class="error-panel">加载失败：${escapeHtml(message)}</div></div>
		</div>
	`;
}

// KPI/流水线/市场雷达/预算面板都依赖 overview，它失败则整页失败；
// 待办面板是独立请求，失败时只降级这一块——用 allSettled 保留并发、不让两者互相拖累
async function renderOverview(content, isCurrent) {
	const [overviewResult, todosResult] = await Promise.allSettled([fetchApi("/api/overview"), fetchApi("/api/todos")]);
	if (!isCurrent()) return;

	if (overviewResult.status === "rejected") {
		renderSummaryBarError(overviewResult.reason.message);
		content.innerHTML = `<div class="error-panel">加载总览失败：${escapeHtml(overviewResult.reason.message)}</div>`;
		return;
	}
	const overview = overviewResult.value;
	renderSummaryBar(overview.summary);
	renderFooterBar(overview);
	const todoPanel = todosResult.status === "fulfilled" ? renderTodoPreviewPanel(todosResult.value) : renderPanelError("待办清单", todosResult.reason.message);
	content.innerHTML = `
		${renderKpiGrid(overview)}
		${renderPipeline(overview)}
		<div class="three-col-grid">
			${todoPanel}
			${renderMarketRadarPanel(overview)}
			${renderBudgetPanel(overview)}
		</div>
	`;
}

// 非总览页也要刷新摘要条/底栏，但不需要依赖它渲染主内容——内部自己吞错误，
// 调用方 fire-and-forget 即可（不 await，不会产生 unhandled rejection）
async function refreshGlobalChrome(isCurrent) {
	try {
		const overview = await fetchApi("/api/overview");
		if (!isCurrent()) return;
		renderSummaryBar(overview.summary);
		renderFooterBar(overview);
	} catch (error) {
		if (isCurrent()) renderSummaryBarError(error.message);
	}
}

// ── 待办页 ──────────────────────────────────────────────────────

// 处理状态 → 徽标配色；徽标文案由后端 statusBadge 给出（与 TUI / compass_todo 同一口径）
const TODO_RESOLUTION_TONES = {
	submitted: "tone-warning",
	rejected: "tone-error",
	verified: "tone-success",
	reopened: "tone-warning",
	resolved: "tone-muted",
};

function todoBadgeTone(todo) {
	if (!todo.resolution) return "tone-muted";
	if (todo.resolution.lapsed) return "tone-warning";
	return TODO_RESOLUTION_TONES[todo.resolution.status] || "tone-muted";
}

// 行内提示：谁该动、下一步做什么。验证只能在 pi 会话完成（浏览器端没有 agent）
function todoResolutionHint(todo) {
	const resolution = todo.resolution;
	if (!resolution) return "在系统外处理完后，提交处理说明与证据；agent 验证通过后才能勾选已处理";
	if (resolution.lapsed) return "勾选后出现了新事实（新快照 / 新预算月 / 深研重入），条目重新浮出：重开后重新提交";
	if (resolution.status === "submitted") return `已提交，等待 pi 会话中的 agent 验证：compass_todo action=verify todo_id=${todo.id}`;
	if (resolution.status === "rejected") return `验证驳回：${resolution.verdictReason || "未留理由"}；按理由补充材料后重新提交`;
	if (resolution.status === "verified") return "agent 已验证通过，可勾选已处理";
	if (resolution.status === "reopened") return "已重开，请重新提交处理结果";
	return "";
}

function buildTodoEvidenceRowHtml() {
	return `
		<div class="drawer-form-row todo-evidence-row">
			<input type="text" class="field-input" data-evidence-ref placeholder="URL 或项目内文件路径">
			<input type="text" class="field-input todo-evidence-note" data-evidence-note placeholder="备注（可选）">
			<button type="button" class="btn btn-outline todo-evidence-drop" data-todo-action="remove-evidence" title="删除该条证据">×</button>
		</div>
	`;
}

function buildTodoSubmitFormHtml() {
	return `
		<form class="drawer-form todo-form" data-todo-form="submit" hidden>
			<div class="drawer-form-label">提交处理结果</div>
			<textarea class="field-textarea" data-todo-note placeholder="必填：做了什么、结论是什么、关键数值"></textarea>
			<div class="drawer-form-label" style="margin-top:10px;">证据（可选，0..n 条）</div>
			<div data-evidence-list>${buildTodoEvidenceRowHtml()}</div>
			<div class="drawer-form-row" style="margin-top:10px;">
				<button type="button" class="btn btn-outline" data-todo-action="add-evidence">+ 再加一条证据</button>
				<button type="submit" class="btn btn-accent-fill" style="flex:1 1 auto; justify-content:center;">提交，等待 agent 验证</button>
			</div>
			<div class="drawer-form-hint">证据填 URL 或项目内文件路径（服务端只做文本留痕，不读取内容）；提交后回 pi 会话让 agent 验证</div>
			<div class="drawer-form-error" data-todo-error hidden></div>
		</form>
	`;
}

function buildTodoReopenFormHtml() {
	return `
		<form class="drawer-form todo-form" data-todo-form="reopen" hidden>
			<div class="drawer-form-label">重开待办</div>
			<input type="text" class="field-input" data-todo-reason placeholder="必填：为什么要拉回重新处理">
			<div class="drawer-form-row" style="margin-top:10px;">
				<button type="submit" class="btn btn-accent-fill" style="flex:1 1 auto; justify-content:center;">确认重开</button>
			</div>
			<div class="drawer-form-hint">重开后条目回到活跃清单，历史提交与验证记录全部保留</div>
			<div class="drawer-form-error" data-todo-error hidden></div>
		</form>
	`;
}

function buildTodoActionsHtml(todo) {
	const status = todo.resolution ? todo.resolution.status : null;
	const lapsed = Boolean(todo.resolution && todo.resolution.lapsed);
	if (lapsed) return `<button type="button" class="btn btn-outline todo-row-btn" data-todo-action="toggle-reopen">重开</button>`;
	// 待验证：只给徽标，不给任何操作入口——球在 agent 那边
	if (status === "submitted") return "";
	if (status === "verified") {
		return `
			<button type="button" class="btn btn-outline todo-row-btn" data-todo-action="ask-complete">勾选已处理</button>
			<span class="todo-confirm" data-todo-confirm hidden>
				<button type="button" class="btn btn-accent-fill todo-row-btn" data-todo-action="complete">确认勾选</button>
				<button type="button" class="btn btn-outline todo-row-btn" data-todo-action="cancel-complete">取消</button>
			</span>
		`;
	}
	return `<button type="button" class="btn btn-outline todo-row-btn" data-todo-action="toggle-submit">提交处理结果</button>`;
}

function renderTodoRow(todo) {
	const kindLabel = TODO_KIND_LABELS[todo.kind] || todo.kind;
	const buttonLabel = TODO_KIND_BUTTON_LABELS[todo.kind] || "查看详情";
	const subject = todoSubject(todo);
	const overdue = todo.overdueDays
		? `<span class="mono todo-row-overdue ${todo.overdueDays > 30 ? "tone-error" : "tone-warning"}">逾期${todo.overdueDays}天</span>`
		: "";
	const inner = `
			<span class="tag-pill">${escapeHtml(kindLabel)}</span>
			<span class="todo-row-subject">${escapeHtml(subject)}</span>
			<span class="todo-row-reason">${escapeHtml(todo.title)} · ${escapeHtml(todo.reason)}</span>
			${overdue}`;
	// 非闭环六类：整行仍是一个跳转链接，行为与改造前完全一致
	if (!todo.resolvable) {
		return `
		<a class="todo-row p${todo.priority}" href="${todoKindRoute(todo)}">${inner}
			<span class="btn btn-outline todo-row-btn">${escapeHtml(buttonLabel)}</span>
		</a>
	`;
	}
	// 闭环四类：链接区 + 操作区分离（按钮不能嵌在 <a> 内），行下挂状态提示与行内表单
	const status = todo.resolution ? todo.resolution.status : null;
	const lapsed = Boolean(todo.resolution && todo.resolution.lapsed);
	const canSubmit = !status || status === "rejected" || status === "reopened";
	return `
		<div class="todo-closable" data-todo-id="${escapeHtml(todo.id)}">
			<div class="todo-row todo-row-closable p${todo.priority}">
				<a class="todo-row-link" href="${todoKindRoute(todo)}">${inner}</a>
				<span class="tag-pill todo-badge ${todoBadgeTone(todo)}">${escapeHtml(todo.statusBadge || "未处理")}</span>
				${buildTodoActionsHtml(todo)}
			</div>
			<div class="todo-row-panel">
				<div class="todo-row-hint ${status === "rejected" ? "tone-error" : ""}">${escapeHtml(todoResolutionHint(todo))}</div>
				<div class="drawer-form-error" data-todo-row-error hidden></div>
				${canSubmit && !lapsed ? buildTodoSubmitFormHtml() : ""}
				${lapsed ? buildTodoReopenFormHtml() : ""}
			</div>
		</div>
	`;
}

function renderTodoGroupPanel(group) {
	const body = group.todos.length
		? `<div class="todo-row-list">${group.todos.map(renderTodoRow).join("")}</div>`
		: `<div class="empty-state">${ICON_CHECK}${escapeHtml(TODO_GROUP_EMPTY_TEXT[group.priority] || "")}</div>`;
	return `
		<div class="panel todo-group-panel" data-priority="${group.priority}">
			<div class="todo-group-label p${group.priority}">${escapeHtml(group.label)} <span class="mono">(${group.todos.length})</span></div>
			${body}
		</div>
	`;
}

function todoActorLine(label, at, actor) {
	if (!at) return "";
	// 复用既有 formatDateTime：记录里的时间戳是 UTC（service 的 nowIso），直接切片会让 UTC+8 少 8 小时
	return `<span class="todo-done-stamp"><span class="cell-muted">${escapeHtml(label)}</span> <span class="mono">${escapeHtml(formatDateTime(at))}</span> · ${escapeHtml(actor || "—")}</span>`;
}

function renderResolvedRow(row) {
	const evidence = row.evidence.length
		? row.evidence.map((item) => `<li>${escapeHtml(item.ref)}${item.note ? ` <span class="cell-muted">（${escapeHtml(item.note)}）</span>` : ""}</li>`).join("")
		: `<li class="cell-muted">无证据条目</li>`;
	const verdict = row.verdict === "pass" ? "验证通过" : row.verdict === "reject" ? "验证驳回" : "无验证结论";
	return `
		<div class="todo-closable todo-done-item" data-todo-id="${escapeHtml(row.todoId)}">
			<div class="todo-done-head">
				<span class="tag-pill">${escapeHtml(TODO_KIND_LABELS[row.kind] || row.kind)}</span>
				<span class="todo-row-subject">${escapeHtml(row.marketName || row.source || "—")}</span>
				<span class="todo-row-reason">${escapeHtml(row.titleSnapshot)}</span>
				${row.lapsed ? `<span class="tag-pill todo-badge tone-warning">已失效浮出</span>` : ""}
				<button type="button" class="btn btn-outline todo-row-btn" data-todo-action="toggle-reopen">重开</button>
			</div>
			<div class="todo-done-body">
				<div class="todo-done-note">${escapeHtml(row.note || "（无处理说明）")}</div>
				<ul class="todo-done-evidence">${evidence}</ul>
				<div class="todo-done-verdict ${row.verdict === "pass" ? "tone-success" : "tone-error"}">${escapeHtml(verdict)}${row.verdictReason ? `：${escapeHtml(row.verdictReason)}` : ""}</div>
				<div class="todo-done-stamps">
					${todoActorLine("提交", row.submittedAt, row.submittedBy)}
					${todoActorLine("验证", row.verifiedAt, row.verifiedBy)}
					${todoActorLine("勾选", row.resolvedAt, row.resolvedBy)}
					${row.attemptCount > 1 ? `<span class="todo-done-stamp cell-muted">共 ${row.attemptCount} 轮提交</span>` : ""}
					${row.reopenCount ? `<span class="todo-done-stamp cell-muted">曾重开 ${row.reopenCount} 次</span>` : ""}
				</div>
			</div>
			<div class="todo-row-panel">${buildTodoReopenFormHtml()}</div>
		</div>
	`;
}

function buildResolvedPanelHtml(rows) {
	const body = rows.length
		? `<div class="todo-row-list">${rows.map(renderResolvedRow).join("")}</div>`
		: `<div class="empty-state">${ICON_CHECK}还没有已处理的待办</div>`;
	return `
		<div class="panel todo-group-panel" data-priority="resolved" hidden>
			<div class="todo-group-label">已处理 <span class="mono">(${rows.length})</span></div>
			${body}
		</div>
	`;
}

function buildTodosHtml(data) {
	const chips = [
		{ key: "all", label: "全部", count: data.total },
		...data.groups.map((g) => ({ key: String(g.priority), label: `P${g.priority}`, count: g.todos.length })),
		{ key: "resolved", label: "已处理", count: data.resolved.length },
	];
	const chipsHtml = chips.map((c) => `<button type="button" class="chip todo-filter-chip ${c.key === "all" ? "is-active" : ""}" data-priority="${c.key}">${escapeHtml(c.label)} <span class="mono">×${c.count}</span></button>`).join("");
	const pendingVerify = data.groups.flatMap((g) => g.todos).filter((todo) => todo.resolution && todo.resolution.status === "submitted").length;
	return `
		<div class="filter-toolbar">
			<div class="filter-toolbar-title">
				<span style="font-size:14px; font-weight:600;">待办清单 <span class="mono tone-accent">${data.total}</span>${pendingVerify ? ` <span class="mono tone-warning">待验证 ${pendingVerify}</span>` : ""}</span>
				<span class="panel-hint">多数事项解决即消失；闭环四类需提交 → agent 验证 → 勾选已处理</span>
			</div>
			<div class="chip-row" id="todo-filter-chips">
				${chipsHtml}
				<div class="dropdown-placeholder" title="即将上线">类型：全部${ICON_CHEVRON_DOWN}</div>
				<div class="dropdown-placeholder" title="即将上线">市场：全部${ICON_CHEVRON_DOWN}</div>
			</div>
		</div>
		<div class="todo-group-list" id="todo-group-list">${data.groups.map(renderTodoGroupPanel).join("")}${buildResolvedPanelHtml(data.resolved)}</div>
	`;
}

function bindTodoFilterChips(content) {
	const chipsEl = content.querySelector("#todo-filter-chips");
	const listEl = content.querySelector("#todo-group-list");
	if (!chipsEl || !listEl) return;
	chipsEl.addEventListener("click", (event) => {
		const chip = event.target.closest(".todo-filter-chip");
		if (!chip) return;
		for (const el of chipsEl.querySelectorAll(".todo-filter-chip")) el.classList.toggle("is-active", el === chip);
		const priority = chip.dataset.priority;
		for (const panel of listEl.querySelectorAll(".todo-group-panel")) {
			// 「已处理」是独立分区：选它时只显示它，选其他时它始终隐藏
			panel.hidden = panel.dataset.priority === "resolved" ? priority !== "resolved" : priority === "resolved" || (priority !== "all" && panel.dataset.priority !== priority);
		}
	});
}

// 写操作统一收口（同 submitPoolWrite 模式）：错误原样展示后端中文文案，成功交给调用方决定刷新
async function submitTodoWrite(path, payload, errorEl, busyEl) {
	errorEl.hidden = true;
	busyEl.disabled = true;
	try {
		await fetchApi(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
		return true;
	} catch (error) {
		errorEl.textContent = error.message;
		errorEl.hidden = false;
		return false;
	} finally {
		busyEl.disabled = false;
	}
}

function bindTodoResolutionActions(content, refresh) {
	const listEl = content.querySelector("#todo-group-list");
	if (!listEl) return;
	const formOf = (item, kind) => item.querySelector(`[data-todo-form="${kind}"]`);

	listEl.addEventListener("click", async (event) => {
		const trigger = event.target.closest("[data-todo-action]");
		if (!trigger) return;
		const item = trigger.closest(".todo-closable");
		if (!item) return;
		const action = trigger.dataset.todoAction;
		const todoId = item.dataset.todoId;
		if (action === "toggle-submit" || action === "toggle-reopen") {
			const form = formOf(item, action === "toggle-submit" ? "submit" : "reopen");
			if (form) form.hidden = !form.hidden;
			return;
		}
		if (action === "add-evidence") {
			const list = item.querySelector("[data-evidence-list]");
			if (list) list.insertAdjacentHTML("beforeend", buildTodoEvidenceRowHtml());
			return;
		}
		if (action === "remove-evidence") {
			const row = trigger.closest(".todo-evidence-row");
			const list = item.querySelector("[data-evidence-list]");
			// 至少留一行空表单，避免删光后没有可填入口
			if (row && list && list.querySelectorAll(".todo-evidence-row").length > 1) row.remove();
			else if (row) for (const input of row.querySelectorAll("input")) input.value = "";
			return;
		}
		if (action === "ask-complete" || action === "cancel-complete") {
			const confirmEl = item.querySelector("[data-todo-confirm]");
			const askBtn = item.querySelector('[data-todo-action="ask-complete"]');
			if (confirmEl) confirmEl.hidden = action !== "ask-complete";
			if (askBtn) askBtn.hidden = action === "ask-complete";
			return;
		}
		if (action === "complete") {
			// 后端中文错误落进行内 error 区（同表单惯例），不弹原生对话框
			const ok = await submitTodoWrite("/api/todos/complete", { todoId }, item.querySelector("[data-todo-row-error]"), trigger);
			if (ok) refresh();
		}
	});

	listEl.addEventListener("submit", async (event) => {
		const form = event.target.closest(".todo-form");
		if (!form) return;
		event.preventDefault();
		const item = form.closest(".todo-closable");
		const todoId = item.dataset.todoId;
		const errorEl = form.querySelector("[data-todo-error]");
		const submitBtn = form.querySelector('button[type="submit"]');
		if (form.dataset.todoForm === "reopen") {
			const reason = form.querySelector("[data-todo-reason]").value.trim();
			if (!reason) {
				errorEl.textContent = "必填：请填写重开理由";
				errorEl.hidden = false;
				return;
			}
			if (await submitTodoWrite("/api/todos/reopen", { todoId, reason }, errorEl, submitBtn)) refresh();
			return;
		}
		const note = form.querySelector("[data-todo-note]").value.trim();
		if (!note) {
			errorEl.textContent = "必填：请填写处理说明（做了什么、结论、关键数值）";
			errorEl.hidden = false;
			return;
		}
		const evidence = [];
		for (const row of form.querySelectorAll(".todo-evidence-row")) {
			const ref = row.querySelector("[data-evidence-ref]").value.trim();
			if (!ref) continue;
			const note = row.querySelector("[data-evidence-note]").value.trim();
			evidence.push(note ? { ref, note } : { ref });
		}
		if (await submitTodoWrite("/api/todos/submit", { todoId, note, evidence }, errorEl, submitBtn)) refresh();
	});
}

async function renderTodos(content, isCurrent) {
	refreshGlobalChrome(isCurrent);
	let data;
	try {
		data = await fetchApi("/api/todos");
	} catch (error) {
		if (!isCurrent()) return;
		content.innerHTML = `<div class="error-panel">加载待办失败：${escapeHtml(error.message)}</div>`;
		return;
	}
	if (!isCurrent()) return;
	content.innerHTML = buildTodosHtml(data);
	bindTodoFilterChips(content);
	bindTodoResolutionActions(content, () => renderTodos(content, isCurrent));
}

// ── 市场页 ──────────────────────────────────────────────────────

function marketQrdClass(row) {
	if (row.qrd !== null && row.qrd < 20) return "tone-warning";
	return row.stage === "archived" ? "cell-dim" : "cell-muted";
}

function marketShareClass(row) {
	if (row.newListingShare !== null && row.newListingShare < 0.15) return "tone-warning";
	return row.stage === "archived" ? "cell-dim" : "cell-muted";
}

function renderMarketTableRow(row) {
	const archived = row.stage === "archived";
	const gate = row.gateOutcome ? `<span class="mono ${GATE_TONES[row.gateOutcome] || ""}" style="font-size:11px;">${GATE_LABELS[row.gateOutcome] || row.gateOutcome}</span>` : `<span class="cell-dim">—</span>`;
	const score = row.score !== null ? `<span class="mono ${archived ? "cell-muted" : "tone-accent"}">${row.score.toFixed(1)}</span>` : `<span class="cell-dim">—</span>`;
	const decision = row.decisionStatus ? `<span class="${DECISION_TONES[row.decisionStatus] || ""}">${DECISION_LABELS[row.decisionStatus] || row.decisionStatus}</span>` : `<span class="cell-dim">—</span>`;
	const qrd = row.qrd !== null ? `<span class="mono ${marketQrdClass(row)}">${row.qrd}</span>` : `<span class="mono cell-dim">—</span>`;
	const share = row.newListingShare !== null ? `<span class="mono ${marketShareClass(row)}">${formatPercent(row.newListingShare, 1)}</span>` : `<span class="mono cell-dim">—</span>`;
	const cpc = row.mainCpc !== null ? `<span class="mono ${archived ? "cell-muted" : ""}">$${row.mainCpc.toFixed(2)}</span>` : `<span class="mono cell-dim">—</span>`;
	const snapshot = row.snapshotAgeDays !== null
		? `<span class="${row.snapshotAgeDays > 30 ? "tone-warning" : "cell-muted"}">${row.snapshotAgeDays}d · ${escapeHtml(row.source || "")}</span>`
		: `<span class="cell-dim">${escapeHtml(row.freshnessLabel)}</span>`;
	return `
		<a class="data-table-row" href="#/market/${encodeURIComponent(row.marketId)}" style="grid-template-columns: ${MARKET_TABLE_COLUMNS};">
			<div class="cell-truncate ${archived ? "cell-dim" : ""}">${escapeHtml(row.name)}</div>
			<div>${gate}</div>
			<div class="cell-right">${score}</div>
			<div class="${archived ? "cell-dim" : "cell-muted"}">${escapeHtml(row.stageLabel || "—")}</div>
			<div>${decision}</div>
			<div class="cell-right">${qrd}</div>
			<div class="cell-right">${share}</div>
			<div class="cell-right">${cpc}</div>
			<div class="cell-right" style="font-size:11px;">${snapshot}</div>
			<div class="cell-right mono ${archived ? "cell-dim" : "cell-muted"}" style="font-size:11px;">${formatDateShort(row.updatedAt)}</div>
		</a>
	`;
}

function buildMarketsHtml(data) {
	const gateChips = [
		`<button type="button" class="chip market-gate-chip is-active" data-gate="all">全部 <span class="mono">×${data.total}</span></button>`,
		...MARKET_GATE_CHIPS.map((c) => `<button type="button" class="chip market-gate-chip" data-gate="${c.key}">${escapeHtml(c.label)} <span class="mono">×${data.gateCounts[c.key] || 0}</span></button>`),
	].join("");
	const freshnessChips = MARKET_FRESHNESS_CHIPS.map((c) => `<button type="button" class="chip market-freshness-chip" data-freshness="${c.key}">${escapeHtml(c.label)} <span class="mono">×${data.freshnessCounts[c.key] || 0}</span></button>`).join("");
	return `
		<div class="filter-toolbar">
			<div class="filter-toolbar-title"><span style="font-size:14px; font-weight:600;">市场雷达 <span class="mono tone-accent">${data.total}</span></span></div>
			<div class="chip-row"><span class="panel-hint">Gate</span>${gateChips}</div>
			<div class="chip-row"><span class="panel-hint">快照</span>${freshnessChips}</div>
			<div style="margin-left:auto; display:flex; align-items:center; gap:12px;">
				<div class="search-box is-disabled" style="width:240px;" title="搜索即将上线">${ICON_SEARCH}<span>搜索市场…</span></div>
				<div class="btn btn-outline btn-disabled" title="线索创建即将上线，可在 pi 中使用 compass_lead">${ICON_PLUS}记录线索</div>
			</div>
		</div>
		<div class="panel market-table-panel">
			<div class="data-table-row data-table-head" style="grid-template-columns: ${MARKET_TABLE_COLUMNS};">
				<div>市场</div><div>Gate</div><div class="cell-right">Score</div><div>阶段</div><div>决策</div>
				<div class="cell-right">QRD(300)</div><div class="cell-right">新品占比</div><div class="cell-right">主词CPC</div>
				<div class="cell-right">快照 / 来源</div><div class="cell-right">更新</div>
			</div>
			<div class="market-table-rows" id="market-table-rows"></div>
			<div class="panel-footnote" id="market-table-footnote"></div>
		</div>
	`;
}

function bindMarketFilters(content, data) {
	const rowsEl = content.querySelector("#market-table-rows");
	const footnoteEl = content.querySelector("#market-table-footnote");
	const state = { gate: "all", freshness: null };
	const rerender = () => {
		let filtered = data.rows;
		if (state.gate !== "all") filtered = filtered.filter((r) => r.gateOutcome === state.gate);
		if (state.freshness) filtered = filtered.filter((r) => r.freshness === state.freshness);
		const emptyText = data.total === 0 ? "尚无市场，导入 CSV 开始" : "没有符合筛选条件的市场";
		rowsEl.innerHTML = filtered.map(renderMarketTableRow).join("") || `<div class="empty-state is-neutral">${emptyText}</div>`;
		footnoteEl.textContent = `显示 ${filtered.length} / ${data.total} · Score 为同批分位数排序值，不跨批比较 · veto 命中时高分仍否决`;
	};
	rerender();
	for (const chip of content.querySelectorAll(".market-gate-chip")) {
		chip.addEventListener("click", () => {
			for (const el of content.querySelectorAll(".market-gate-chip")) el.classList.toggle("is-active", el === chip);
			state.gate = chip.dataset.gate;
			rerender();
		});
	}
	for (const chip of content.querySelectorAll(".market-freshness-chip")) {
		chip.addEventListener("click", () => {
			const wasActive = chip.classList.contains("is-active");
			for (const el of content.querySelectorAll(".market-freshness-chip")) el.classList.remove("is-active");
			state.freshness = wasActive ? null : chip.dataset.freshness;
			if (!wasActive) chip.classList.add("is-active");
			rerender();
		});
	}
}

async function renderMarkets(content, isCurrent) {
	refreshGlobalChrome(isCurrent);
	let data;
	try {
		data = await fetchApi("/api/markets");
	} catch (error) {
		if (!isCurrent()) return;
		content.innerHTML = `<div class="error-panel">加载市场列表失败：${escapeHtml(error.message)}</div>`;
		return;
	}
	if (!isCurrent()) return;
	content.innerHTML = buildMarketsHtml(data);
	bindMarketFilters(content, data);
}

// ── 预算页 ──────────────────────────────────────────────────────

function budgetUsageText(pool) {
	return pool.monthlyLimitCny > 0 ? `${formatCny(pool.spentCny)} / ${formatCny(pool.monthlyLimitCny)}` : `${formatCny(pool.spentCny)} / 免费`;
}

function budgetCallsText(pool) {
	return pool.monthlyCallLimit !== undefined && pool.monthlyCallLimit !== null ? `${pool.callCount}/${pool.monthlyCallLimit} 次` : `${pool.callCount} 次`;
}

function budgetRatio(pool) {
	if (pool.monthlyLimitCny > 0) return Math.min(100, (pool.spentCny / pool.monthlyLimitCny) * 100);
	if (pool.monthlyCallLimit) return Math.min(100, (pool.callCount / pool.monthlyCallLimit) * 100);
	return 0;
}

function budgetFillTone(state) {
	return state === "fused" ? "tone-error-fill" : state === "warning" ? "tone-warning-fill" : "";
}

function renderBudgetTableRow(pool) {
	const disabled = pool.enabled === false;
	const dimCls = disabled ? "cell-dim" : "cell-muted";
	const fillTone = budgetFillTone(pool.state);
	const ratio = budgetRatio(pool);
	// 禁用时用量状态无意义（不管有没有超额都不会真的调用），单独显示「禁用」而不是
	// 「正常 · 禁用」这种矛盾拼接——这里 disabled 优先于 state 派生的用量结论
	const stateLabel = disabled ? "禁用" : BUDGET_STATE_LABELS[pool.state] || pool.state;
	const statePill = disabled ? "pill-muted" : pool.state === "fused" ? "pill-error" : pool.state === "warning" ? "pill-warning" : "pill-success";
	return `
		<div class="data-table-row budget-table-row ${disabled ? "is-disabled" : ""}" style="grid-template-columns: minmax(0,1fr) 44px 120px 150px 64px 64px;">
			<div style="min-width:0;">
				<div class="cell-truncate ${disabled ? "cell-dim" : ""}">${escapeHtml(pool.source)}</div>
				${pool.note ? `<div class="cell-dim" style="font-size:10px; margin-top:2px;">${escapeHtml(pool.note)}</div>` : ""}
			</div>
			<div class="mono ${dimCls}" style="font-size:11px;">${escapeHtml(pool.tier)}</div>
			<div class="cell-right mono ${dimCls}">${budgetUsageText(pool)}</div>
			<div><div class="meter ${disabled ? "is-disabled" : ""}">${ratio > 0 ? `<div class="meter-fill ${fillTone}" style="width:${ratio}%;"></div>` : ""}</div></div>
			<div class="cell-right mono ${dimCls}">${budgetCallsText(pool)}</div>
			<div><span class="badge-pill ${statePill}">${escapeHtml(stateLabel)}</span></div>
		</div>
	`;
}

function buildBudgetHtml(data) {
	const eventsHtml = data.events.map((event) => `
		<div class="cost-event-card">
			<div class="cost-event-head">
				<span class="mono cell-muted">${formatDateShort(event.createdAt)}</span>
				<span class="cost-event-source">${escapeHtml(event.source)}</span>
				<span class="mono tone-success" style="margin-left:auto;">${formatMoney(event.amountCny)}</span>
			</div>
			${event.description ? `<div class="cost-event-desc">${escapeHtml(event.description)}</div>` : ""}
			<div class="cost-event-actor"><span class="tag-pill mono" style="font-size:10px;">${escapeHtml(event.actor)}</span></div>
		</div>
	`).join("");
	return `
		<div class="filter-toolbar">
			<div class="filter-toolbar-title"><span style="font-size:15px; font-weight:700;">数据源与预算</span><span class="cell-dim">·</span><span class="mono cell-muted">${escapeHtml(data.month)}</span></div>
			<div style="display:flex; gap:10px;">
				<div class="btn btn-outline btn-disabled" title="记账功能即将上线，可在 pi 中使用 compass_budget record">记一笔成本</div>
				<div class="btn btn-outline btn-disabled" title="配置功能即将上线，可在 pi 中使用 compass_budget configure">配置数据源</div>
			</div>
		</div>
		<div style="display:grid; grid-template-columns: 8fr 4fr; gap:14px; flex:1 1 auto; min-height:0;">
			<div class="panel budget-table-panel">
				<div class="panel-header">
					<div class="panel-title">数据源预算池 <span class="mono cell-muted">${data.pools.length}</span></div>
					<div class="panel-hint">80% 告警 · 100% 熔断</div>
				</div>
				<div class="budget-full-table scroll-x">
					<div class="data-table-row data-table-head" style="grid-template-columns: minmax(0,1fr) 44px 120px 150px 64px 64px;">
						<div>数据源</div><div>档位</div><div class="cell-right">已用 / 上限</div><div>用量</div><div class="cell-right">调用</div><div>状态</div>
					</div>
					${data.pools.map(renderBudgetTableRow).join("") || `<div class="empty-state is-neutral">尚未配置数据源</div>`}
				</div>
				<div class="budget-totals">
					累计成本 <span class="mono tone-success">${formatMoney(data.totals.totalCostCny)}</span>
					<span class="cell-dim">·</span> 可归因到市场 <span class="mono tone-success">${formatMoney(data.totals.attributedCny)}</span>
					<span class="cell-dim">·</span> 归因率 <span class="mono">${formatPercent(data.totals.attributionRate)}</span>
				</div>
			</div>
			<div class="col-flow">
				<div class="panel col-panel" style="flex:1 1 auto;">
					<div class="panel-header"><div class="panel-title">成本事件流</div><div class="panel-hint">本月 <span class="mono">${data.events.length}</span> 条</div></div>
					<div class="col-panel-body scroll-x">
						${eventsHtml}
						${data.events.length === 0 ? `<div class="cost-event-empty">本月暂无手工记账；MCP 调用自动计量，安全点落账</div>` : ""}
					</div>
				</div>
				<div class="panel">
					<div class="panel-title">规则</div>
					<div class="rule-list">
						<div class="rule-row"><span class="rule-dot" style="background:var(--c-warning);"></span><span>80% 用量 → 告警</span></div>
						<div class="rule-row"><span class="rule-dot" style="background:var(--c-error);"></span><span>100% 用量 → 熔断，硬拦截付费 MCP 调用</span></div>
						<div class="rule-row"><span class="rule-dot" style="background:var(--c-text-muted);"></span><span class="cell-muted">成本事件可归因到市场，进入市场档案的累计成本</span></div>
					</div>
				</div>
			</div>
		</div>
	`;
}

async function renderBudget(content, isCurrent) {
	refreshGlobalChrome(isCurrent);
	let data;
	try {
		data = await fetchApi("/api/budget");
	} catch (error) {
		if (!isCurrent()) return;
		content.innerHTML = `<div class="error-panel">加载预算失败：${escapeHtml(error.message)}</div>`;
		return;
	}
	if (!isCurrent()) return;
	content.innerHTML = buildBudgetHtml(data);
}

// ── 复盘页 ──────────────────────────────────────────────────────

function buildRetroHtml(data) {
	const s = data.stats;
	const dueHtml = data.due.length
		? data.due.map((item) => `
			<div class="due-item">
				<a href="#/market/${encodeURIComponent(item.marketId)}" class="due-item-market">${escapeHtml(item.marketName || item.marketId)}</a>
				<span class="cell-dim">·</span>
				<span class="mono tone-warning">${escapeHtml(item.group)}</span>
				<span class="cell-dim">·</span>
				<span class="mono ${item.overdueDays > 30 ? "tone-error" : "tone-warning"}">逾期 ${item.overdueDays} 天</span>
			</div>
			<div class="todo-action" style="padding-bottom:8px; border-bottom:1px solid var(--c-divider);">${escapeHtml(item.reason)} → ${escapeHtml(item.suggestedAction)}</div>
		`).join("")
		: `<div class="empty-state">${ICON_CHECK}当前没有逾期复盘对象</div>`;

	const checksHtml = data.recentChecks.length
		? data.recentChecks.map((check) => {
			const verdictTone = check.verdict === "validated" ? "tone-success" : check.verdict === "challenged" ? "tone-error" : "cell-muted";
			return `
				<div class="retro-check">
					<div class="retro-check-row">
						<span class="mono ${verdictTone}">${escapeHtml(check.verdict)}</span>
						<span class="cell-dim">·</span>
						<span class="cell-truncate">${escapeHtml(check.marketName || check.marketId)}</span>
						<span class="cell-dim">·</span>
						<span class="mono cell-dim" style="font-size:11px;">${escapeHtml(check.id)}</span>
						<span class="cell-dim">·</span>
						<span class="mono cell-dim" style="font-size:11px;">${formatDateShort(check.createdAt)}</span>
					</div>
					${check.verdictReason ? `<div class="retro-check-reason">${escapeHtml(check.verdictReason)}</div>` : ""}
				</div>
			`;
		}).join("")
		: `<div class="empty-note">尚无复盘对照——候选进入复盘周期后在此对照基线快照与实绩；verdict 只能是 validated / challenged / inconclusive，证据不足不得伪装 validated。</div>`;

	const lessonsHtml = data.lessons.length
		? data.lessons.map((lesson) => `
			<div class="lesson-row">
				<div class="lesson-title">${escapeHtml(lesson.title)}</div>
				<div class="lesson-detail">${escapeHtml(lesson.detail)}</div>
			</div>
		`).join("")
		: `<div class="empty-note">尚无经验卡——在复盘会中沉淀；必须挂 chk_ / dec_ / run_ 证据，过时经验退役不删除。</div>`;

	return `
		<div class="filter-toolbar">
			<div class="filter-toolbar-title"><span style="font-size:13px; font-weight:600;">复盘闭环 <span class="cell-muted">·</span> <span class="mono tone-accent">${data.due.length}</span> <span class="cell-muted">到期</span></span></div>
			<div class="btn btn-accent-fill btn-disabled" title="复盘会向导即将上线，可在 pi 中使用 /compass-retro">开始复盘会</div>
		</div>
		<div class="kpi-grid">
			<div class="kpi-card">
				<div class="kpi-label">OutcomeCheck</div>
				<div class="kpi-value">${s.checks}</div>
				<div class="kpi-sub">基线快照 vs 实绩的对照记录</div>
			</div>
			<div class="kpi-card">
				<div class="kpi-label">verdict 分布</div>
				<div class="kpi-value kpi-value-inline">
					<span class="tone-success">validated ${s.validated}</span>
					<span class="tone-error">challenged ${s.challenged}</span>
					<span class="cell-muted">inconclusive ${s.inconclusive}</span>
				</div>
				<div class="kpi-sub">证据不足只能记 inconclusive</div>
			</div>
			<div class="kpi-card">
				<div class="kpi-label">active lessons</div>
				<div class="kpi-value">${s.activeLessons}</div>
				<div class="kpi-sub">过时经验退役，不删除</div>
			</div>
			<div class="kpi-card">
				<div class="kpi-label">验证率</div>
				<div class="kpi-value ${s.validationRate === null ? "cell-muted" : ""}">${formatPercent(s.validationRate)}</div>
				<div class="kpi-sub">validated ÷ (validated+challenged)，排除 inconclusive</div>
			</div>
		</div>
		<div style="display:grid; grid-template-columns: 1fr 1fr; gap:14px; flex:1 1 auto; min-height:0;">
			<div class="panel col-panel">
				<div class="panel-header"><div class="panel-title">到期队列</div><div class="panel-hint">逾期对象自动进入待办 P4</div></div>
				<div class="col-panel-body scroll-x">${dueHtml}</div>
				<div class="panel-footnote">周期：go 30 天 · testing 60 天 · waitlist 45 天 · no_go 90 天抽样 · review 30 天；逾期出现在待办 P4</div>
			</div>
			<div class="col-flow">
				<div class="panel col-flow-item">
					<div class="panel-title">最近对照</div>
					<div style="margin-top:10px;">${checksHtml}</div>
				</div>
				<div class="panel col-flow-item">
					<div class="panel-title">经验卡 Lessons</div>
					<div style="margin-top:10px;">${lessonsHtml}</div>
				</div>
				<div class="panel col-flow-item" style="display:flex; flex-direction:column;">
					<div class="panel-title">策略回测</div>
					<div class="empty-note" style="margin-top:10px;">调阈值前先回测：对比 精铺·日均10单 @v1 与草稿版本的 flip 矩阵与 alignment 变化（回测不落库）。</div>
					<div style="margin-top:12px;">
						<div class="btn btn-outline btn-disabled" title="回测功能即将上线，可在 pi 中使用 compass_retro backtest">运行回测</div>
					</div>
				</div>
			</div>
		</div>
	`;
}

async function renderRetro(content, isCurrent) {
	refreshGlobalChrome(isCurrent);
	let data;
	try {
		data = await fetchApi("/api/retro");
	} catch (error) {
		if (!isCurrent()) return;
		content.innerHTML = `<div class="error-panel">加载复盘数据失败：${escapeHtml(error.message)}</div>`;
		return;
	}
	if (!isCurrent()) return;
	content.innerHTML = buildRetroHtml(data);
}

// ── 市场档案页 ──────────────────────────────────────────────────────

const CONFIDENCE_TONES = { 高: "tone-success", 中: "tone-warning", 低: "tone-error", 缺失: "tone-muted" };

function toneToPillClass(tone) {
	if (tone === "tone-success") return "pill-success";
	if (tone === "tone-warning") return "pill-warning";
	if (tone === "tone-error") return "pill-error";
	return "pill-muted";
}

function confidenceDotsIcon(tier) {
	const color = tier === "高" ? "#4cc38a" : tier === "中" ? "#e5b567" : tier === "低" ? "#e5534b" : "#3a4653";
	const filled = tier === "高" ? 3 : tier === "中" ? 2 : tier === "低" ? 1 : 0;
	const dot = (cx, on) => (on
		? `<circle cx="${cx}" cy="4" r="3" fill="${color}"></circle>`
		: `<circle cx="${cx}" cy="4" r="2.5" fill="none" stroke="${color}" stroke-width="1"></circle>`);
	return `<svg width="21" height="8" viewBox="0 0 21 8">${dot(4, filled >= 1)}${dot(11, filled >= 2)}${dot(18, filled >= 3)}</svg>`;
}

const ICON_GATE_REVIEW = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9.5 9 a2.5 2.5 0 1 1 4 2 c-1 0.8 -1.5 1.4 -1.5 2.5" stroke="#e5b567" stroke-width="2" stroke-linecap="round"></path><circle cx="12" cy="17.5" r="1.3" fill="#e5b567"></circle></svg>`;
const ICON_GATE_REJECT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6 L18 18 M18 6 L6 18" stroke="#e5534b" stroke-width="2" stroke-linecap="round"></path></svg>`;

function gateIconFor(outcome) {
	if (outcome === "pass") return ICON_CHECK;
	if (outcome === "review") return ICON_GATE_REVIEW;
	return ICON_GATE_REJECT;
}

// 规则 status 有六种（pass/review/fail/veto/missing/error），但对候选而言只有三种视觉后果：
// 通过、待人工复核、未通过——fail/veto/missing/error 都归入"未通过"统一用否决视觉呈现
function ruleStatusTone(status) {
	if (status === "pass") return "tone-success";
	if (status === "review") return "tone-warning";
	return "tone-error";
}

function ruleStatusIcon(status) {
	if (status === "pass") return ICON_CHECK;
	if (status === "review") return ICON_GATE_REVIEW;
	return ICON_GATE_REJECT;
}

// 人工 vs 自动 actor：compass-web（本站写操作）与 pi-*/strategy-*（pi 会话内自动化产出的
// actor，如 pi-mcp-sorftime、pi-selection、pi-screen-assumption-*）判定为系统，
// 其余（OS 用户名，pi 默认 actor 取 $USER/$USERNAME）判定为人工——参见 index.ts actorName()。
// "pi-user" 是该函数取不到系统用户名时的兜底值，代表的仍是一次人工发起的交互式 pi 会话
// （调用点均紧邻 ctx.ui.select/input 等强制人机交互），需要在 pi- 前缀匹配前排除，否则会
// 被误判为自动化。这里是前端独立维护的字符串启发式，与 index.ts 的 actor 命名约定没有
// 编译期/运行期强绑定——未来若新增自动化 actor 前缀而忘记同步，后果仅是徽标颜色/文案误判
// （不影响数据正确性），不在此文件能自动发现。
function actorIsSystem(actor) {
	if (actor === "pi-user") return false;
	return actor === "compass-web" || /^(pi-|strategy-|system$)/.test(actor);
}

function actorBadgeHtml(actor) {
	const cls = actorIsSystem(actor) ? "actor-badge is-system" : "actor-badge is-human";
	return `<span class="${cls}">${escapeHtml(actor)}</span>`;
}

function buildBreadcrumbHtml(data) {
	return `
		<div class="breadcrumb-row">
			<div class="breadcrumb">
				<a href="#/markets" class="breadcrumb-back" title="返回市场列表">${ICON_BACK}</a>
				<span class="cell-muted">市场</span>
				<span class="cell-dim">/</span>
				<span class="breadcrumb-current cell-truncate">${escapeHtml(data.market.name)}</span>
			</div>
			<div class="breadcrumb-actions">
				<div class="btn btn-outline btn-disabled" title="策略执行即将上线，可在 pi 中使用 compass_strategy_run">跑策略</div>
				<div class="btn btn-outline btn-disabled" title="风险记录即将上线，可在 pi 中使用 compass_risk_check">记录风险</div>
				<button type="button" class="btn btn-accent-fill" id="dossier-report-btn">生成五维报告</button>
			</div>
		</div>
	`;
}

function buildDossierHeaderHtml(data) {
	const c = data.candidate;
	const s = data.snapshot;
	const e = data.evaluation;
	const badges = [];
	if (e) {
		badges.push(`<span class="badge-pill ${toneToPillClass(GATE_TONES[e.outcome])}" style="display:inline-flex; align-items:center; gap:4px;">${gateIconFor(e.outcome)}Gate <span class="mono">${escapeHtml(e.outcome.toUpperCase())}</span></span>`);
		badges.push(`Score <span class="mono" style="font-size:15px; font-weight:600;">${e.score.toFixed(1)}</span>`);
	}
	if (c) {
		badges.push(`<span class="badge-pill pill-accent">阶段 ${escapeHtml(c.stageLabel)}</span>`);
		if (c.decisionStatus) badges.push(`<span class="badge-pill ${toneToPillClass(DECISION_TONES[c.decisionStatus])}">决策 ${escapeHtml(DECISION_LABELS[c.decisionStatus] || c.decisionStatus)}</span>`);
	}
	const metaParts = [];
	if (s) {
		metaParts.push(`快照 ${escapeHtml(s.id)}`, escapeHtml(s.source || "—"), `采集 ${escapeHtml(s.capturedAt.slice(0, 10))}`, `${s.ageDays}d（${escapeHtml(s.freshnessLabel)}）`);
	} else {
		metaParts.push("尚无快照");
	}
	if (e && e.source === "run" && e.strategyRef) metaParts.push(`策略 ${escapeHtml(e.strategyRef)}`);
	if (data.market.category) metaParts.push(`类目 ${escapeHtml(data.market.category)}`);
	return `
		<div class="dossier-header">
			<div class="dossier-title cell-truncate">${escapeHtml(data.market.name)}</div>
			<div class="dossier-badges">${badges.join(`<span class="cell-dim">·</span>`)}</div>
			<div class="dossier-meta mono cell-dim">${metaParts.join(" · ")}</div>
		</div>
	`;
}

function buildScorePanelHtml(data) {
	if (!data.evaluation) {
		return `<div class="panel"><div class="panel-title">五维评分</div><div class="empty-note" style="margin-top:10px;">尚无评估——需要市场快照后才能计算 Gate 与五维分</div></div>`;
	}
	const rows = data.evaluation.dimensionScores.map((d) => {
		const score = d.score;
		const pct = score === null ? 0 : Math.max(0, Math.min(100, score));
		const fillTone = score === null ? "" : score >= 75 ? "tone-success-fill" : "tone-warning-fill";
		return `
			<div class="score-row">
				<div class="score-label">${escapeHtml(d.label)}</div>
				<div class="score-track"><div class="score-fill ${fillTone}" style="width:${pct}%;"></div></div>
				<div class="score-value mono cell-right">${score === null ? "—" : score.toFixed(1)}</div>
			</div>
		`;
	}).join("");
	return `
		<div class="panel">
			<div class="panel-title">五维评分</div>
			<div class="score-rows">${rows}</div>
		</div>
	`;
}

// 同一指标不同数据源最新值相对差异 >30% 才会出现（metricDivergences 的阈值），
// 多数市场为空——待办里的 metric_divergence 条目会把用户导到这里核实取值口径，
// 空时不占面板位置，不是每个市场都要展示的常驻区块
function buildDivergencesPanelHtml(data) {
	if (!data.divergences.length) return "";
	const rows = data.divergences.map((d) => {
		const valuesText = d.values.map((v) => `${escapeHtml(v.source)} ${v.value}（${escapeHtml(v.capturedAt.slice(5, 10))}）`).join(" vs ");
		return `
			<div class="divergence-row">
				<span class="divergence-metric">${escapeHtml(d.label)}</span>
				<span class="mono tone-warning">±${(d.divergence * 100).toFixed(0)}%</span>
				<span class="cell-muted" style="font-size:11px;">${valuesText}</span>
			</div>
		`;
	}).join("");
	return `
		<div class="panel">
			<div class="panel-title">多源分歧 <span class="mono cell-muted">${data.divergences.length}</span></div>
			<div class="divergence-list">${rows}</div>
			<div class="panel-footnote">同一指标不同来源相对差异 &gt;30% 时列出，供人工核实取值口径</div>
		</div>
	`;
}

function buildEvidenceSectionHtml(section, index) {
	const rows = section.rows.map((row) => {
		const valueTone = row.value === null ? "tone-warning" : "";
		const confTone = CONFIDENCE_TONES[row.confidenceTier] || "tone-muted";
		const sourceText = row.source ? `${escapeHtml(row.source)} · ${escapeHtml(row.capturedAt ? row.capturedAt.slice(5, 10) : "")}` : "—";
		return `
			<div class="evidence-row">
				<div class="cell-truncate">${escapeHtml(row.label)}</div>
				<div class="cell-right mono ${valueTone}">${escapeHtml(row.display)}</div>
				<div class="cell-muted" style="font-size:11px;">${sourceText}</div>
				<div class="evidence-confidence ${confTone}">${row.confidence !== null ? confidenceDotsIcon(row.confidenceTier) : ""}<span>${escapeHtml(row.confidenceTier)}${row.confidence !== null ? ` ${row.confidence.toFixed(2)}` : ""}</span></div>
			</div>
		`;
	}).join("");
	return `
		<div class="evidence-section" data-dimension="${index}">
			<div class="evidence-section-title">${escapeHtml(section.title)} <span class="cell-muted" style="font-weight:400;">${escapeHtml(section.question)}</span></div>
			${rows}
		</div>
	`;
}

function buildEvidencePanelHtml(data) {
	if (!data.snapshot || !data.metricSections.length) {
		return `<div class="panel col-panel" style="flex:1 1 auto;"><div class="panel-title">证据 · MetricEvidence</div><div class="empty-note" style="margin-top:10px;">暂无证据数据——需要市场快照后才能展示 MetricEvidence</div></div>`;
	}
	const chips = [`<button type="button" class="chip dossier-dimension-chip is-active" data-dimension="all">全部</button>`]
		.concat(data.metricSections.map((s, i) => `<button type="button" class="chip dossier-dimension-chip" data-dimension="${i}">${escapeHtml(s.title.split(" ")[0])}</button>`))
		.join("");
	const sections = data.metricSections.map((s, i) => buildEvidenceSectionHtml(s, i)).join("");
	return `
		<div class="panel col-panel evidence-panel" style="flex:1 1 auto;">
			<div class="panel-header">
				<div class="panel-title">证据 · MetricEvidence</div>
				<div class="chip-row" id="dossier-dimension-chips">${chips}</div>
			</div>
			<div class="evidence-table-head">
				<div>指标</div><div class="cell-right">值</div><div>来源 · 采集</div><div>置信度</div>
			</div>
			<div class="col-panel-body scroll-x" id="dossier-evidence-body">${sections}</div>
			<div class="panel-footnote">缺失指标显示为「缺」并使 Gate 结论降为复核——绝不把缺数据伪装成通过</div>
		</div>
	`;
}

function buildGateRulesPanelHtml(data) {
	const e = data.evaluation;
	const strategyNote = e && e.source === "run" && e.strategyRef ? ` <span class="cell-muted" style="font-weight:400;">· ${escapeHtml(e.strategyRef)}</span>` : "";
	if (!e || !e.rules.length) {
		return `<div class="panel"><div class="panel-title">Gate 规则</div><div class="empty-note" style="margin-top:10px;">尚未绑定 Gate 策略或暂无评估结果</div></div>`;
	}
	const rows = e.rules.map((rule) => `
		<div class="gate-rule-row">
			${ruleStatusIcon(rule.status)}
			<span class="gate-rule-label cell-truncate ${ruleStatusTone(rule.status)}">${escapeHtml(rule.label)}</span>
			<span class="mono cell-right ${ruleStatusTone(rule.status)}" style="font-size:11px;">${escapeHtml(rule.message || "—")}</span>
		</div>
	`).join("");
	return `
		<div class="panel">
			<div class="panel-title">Gate 规则${strategyNote}</div>
			<div class="gate-rule-list">${rows}</div>
			${e.missingMetrics.length ? `<div class="panel-footnote mono">缺失指标：${e.missingMetrics.map(escapeHtml).join(" · ")}</div>` : ""}
		</div>
	`;
}

function decisionTimelineItemHtml(d) {
	const titleTone = d.decisionStatus ? DECISION_TONES[d.decisionStatus] || "" : "";
	return `
		<div class="decision-item">
			<div class="decision-item-row">
				<span class="mono cell-dim" style="font-size:11px;">${formatDateShort(d.createdAt)}</span>
				<span class="decision-item-title ${titleTone}">${escapeHtml(d.conclusion)}</span>
				${actorBadgeHtml(d.actor)}
			</div>
			${d.reason ? `<div class="decision-item-reason">${escapeHtml(d.reason)}</div>` : ""}
		</div>
	`;
}

function buildDecisionTimelinePanelHtml(data) {
	const body = data.decisionLog.length
		? `<div class="decision-timeline">${data.decisionLog.map(decisionTimelineItemHtml).join("")}</div>`
		: `<div class="empty-note">暂无决策记录</div>`;
	return `
		<div class="panel col-panel" style="flex:1 1 auto;">
			<div class="panel-title">决策回放</div>
			<div class="col-panel-body scroll-x">${body}</div>
		</div>
	`;
}

// 报告固定九章（对齐 report.ts 的 ## 小节顺序）：这里是生成前的目录预告，
// 生成后弹窗左侧的小目录才是从真实 Markdown 里抽出来的
const REPORT_CHAPTERS = ["决策摘要 GSE", "五维证据", "单位经济情景", "痛点与改良", "风险核查", "多源校准", "决策回放", "下一步", "历史与复盘"];

function buildReportPanelHtml() {
	const chapters = REPORT_CHAPTERS.map((label, index) => `<span class="report-chapter"><span class="mono report-chapter-no">${index + 1}</span> ${escapeHtml(label)}</span>`).join("");
	return `
		<div class="panel">
			<div class="panel-title">五维报告 · 九章</div>
			<div class="report-chapters">${chapters}</div>
			<div class="report-result" id="dossier-report-body">
				<span class="report-result-path mono">尚未生成——点右上角「生成五维报告」</span>
			</div>
		</div>
	`;
}

function buildMarketDossierHtml(data) {
	return `
		${buildBreadcrumbHtml(data)}
		${buildDossierHeaderHtml(data)}
		<div class="dossier-grid">
			<div class="col-flow">
				${buildScorePanelHtml(data)}
				${buildDivergencesPanelHtml(data)}
				${buildEvidencePanelHtml(data)}
			</div>
			<div class="col-flow">
				${buildGateRulesPanelHtml(data)}
				${buildDecisionTimelinePanelHtml(data)}
				${buildReportPanelHtml()}
			</div>
		</div>
	`;
}

function bindDossierDimensionFilter(content) {
	const chipsEl = content.querySelector("#dossier-dimension-chips");
	const bodyEl = content.querySelector("#dossier-evidence-body");
	if (!chipsEl || !bodyEl) return;
	chipsEl.addEventListener("click", (event) => {
		const chip = event.target.closest(".dossier-dimension-chip");
		if (!chip) return;
		for (const el of chipsEl.querySelectorAll(".dossier-dimension-chip")) el.classList.toggle("is-active", el === chip);
		const dim = chip.dataset.dimension;
		for (const section of bodyEl.querySelectorAll(".evidence-section")) section.hidden = dim !== "all" && section.dataset.dimension !== dim;
	});
}

// ── 五维报告弹窗：落盘仍是 .md，看的是浏览器里实时渲染出来的 HTML ────────
//
// 弹窗挂在 <body> 而不是 #content：市场档案页任何一次重渲染都会整体替换 #content，
// 挂在里面的弹窗会连同正文一起消失。它也刻意不是一个 hash 路由——报告正文只存在于
// 这次 POST 返回的内存里，做成路由后刷新地址栏会得到一个空壳弹窗。
// 同一时刻只允许一个，模块级句柄同时承担「关掉旧的」与「解绑全局监听」两件事。
let reportOverlay = null;

function closeReportOverlay() {
	if (!reportOverlay) return;
	const { element, onKeydown, onHashChange, previouslyFocused } = reportOverlay;
	document.removeEventListener("keydown", onKeydown);
	window.removeEventListener("hashchange", onHashChange);
	element.remove();
	reportOverlay = null;
	// isConnected 守卫不能省：onHashChange 触发的关闭意味着页面已经重渲染过一轮，
	// 原触发按钮此刻是脱离文档的孤儿节点，focus() 它不报错，但焦点会静默掉回 <body>。
	// preventScroll：弹窗期间背景是能滚的，不加会在关闭瞬间把页面拽回按钮所在位置
	if (previouslyFocused?.isConnected && typeof previouslyFocused.focus === "function") previouslyFocused.focus({ preventScroll: true });
}

function reportTocHtml(toc) {
	if (!toc.length) return "";
	// 目录项用 button 而不是 <a href="#...">：改 location.hash 会触发 hashchange，
	// 被路由当成一次导航——页面跳走、弹窗被自己的 onHashChange 关掉
	// title 补的是被 text-overflow: ellipsis 截掉的那部分，给鼠标用户看。<button> 有文本内容时
	// 可访问名取的是文本内容、title 只在没有别的名字时才兜底，所以加了不会盖掉读屏读到的名字
	const links = toc.map((item) => `<button type="button" class="report-toc-link is-level${item.level}" data-target="${escapeHtml(item.id)}" title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</button>`).join("");
	return `<nav class="report-toc">${links}</nav>`;
}

function buildReportOverlayHtml(result, rendered) {
	const meta = [
		`Gate ${GATE_LABELS[result.outcome] ?? result.outcome ?? "—"}`,
		`综合分 ${Number.isFinite(result.score) ? result.score.toFixed(1) : "—"}`,
		`快照 ${result.snapshotId ?? "—"}`,
	].join(" · ");
	return `
		<div class="report-focus-guard" tabindex="0" data-report-guard="start"></div>
		<div class="report-modal" role="dialog" aria-modal="true" aria-labelledby="report-modal-title">
			<div class="report-modal-header">
				<div class="report-modal-heading">
					<div class="report-modal-title cell-truncate" id="report-modal-title">五维报告 · ${escapeHtml(result.marketName)}</div>
					<div class="report-modal-meta mono cell-truncate">${escapeHtml(meta)} · 已存 ${escapeHtml(result.path)}</div>
				</div>
				<div class="report-modal-actions">
					<button type="button" class="btn btn-outline" data-report-action="source">Markdown 源码</button>
					<button type="button" class="btn btn-outline" data-report-action="copy">复制 Markdown</button>
					<button type="button" class="drawer-close" data-report-action="close" title="关闭（Esc）">${ICON_CLOSE}</button>
				</div>
			</div>
			<div class="report-modal-body">
				${reportTocHtml(rendered.toc)}
				<article class="report-doc" id="report-doc" tabindex="0" role="region" aria-label="报告正文">${rendered.html || `<div class="empty-note">报告内容为空——请回 pi 会话用 compass_report 复核。</div>`}</article>
				<pre class="report-source" id="report-source" tabindex="0" role="region" aria-label="Markdown 源码" hidden>${escapeHtml(result.markdown)}</pre>
			</div>
		</div>
		<div class="report-focus-guard" tabindex="0" data-report-guard="end"></div>
	`;
}

function openReportOverlay(result, trigger) {
	closeReportOverlay();
	// 触发按钮显式传进来，不靠 document.activeElement 猜：生成那条路径上，点击处理器在
	// await 之前就把按钮 disabled 了，浏览器随即把焦点退回 <body>，等 POST 回来再读
	// activeElement 只会读到 body，关闭弹窗时焦点就还不回去了。兜底才读 activeElement，
	// 且要排在 closeReportOverlay() 之后——弹窗顶弹窗时，上一个弹窗刚把焦点还给最初那个按钮
	const previouslyFocused = trigger?.isConnected ? trigger : document.activeElement;
	const element = document.createElement("div");
	element.className = "report-overlay";
	element.innerHTML = buildReportOverlayHtml(result, renderMarkdown(result.markdown));
	// 用来取「环的两端」和把跑出去的焦点拽回来。弹窗里每一个 Tab 停留点现在要么是
	// button / a[href]，要么带显式 tabindex（#report-doc、#report-source、.md-table-wrap），
	// 所以这份名单和原生 Tab 序列一一对应——这是 markdown.js 给每张表补 tabindex 换来的。
	// 在那之前宽表只在 Chrome 里隐式可聚焦、没有 tabindex 属性、任何选择器都枚举不到，名单必然漏项。
	// 名单里点名 .md-table-wrap 而不是写 [tabindex]：两个 .report-focus-guard 也带 tabindex="0"，
	// 被枚举进来 items[0] 就成了起始哨兵，弹过去又触发它自己的 focusin——两个哨兵无限互弹。
	// 每次按 Tab 现算而不是开弹窗时算一次：切到「Markdown 源码」视图会把 nav.report-toc 与
	// #report-doc 设 hidden，藏起来的目录按钮、正文链接与正文里的表格此刻必须退出名单；
	// 条目数也随报告而变
	const focusables = () => [...element.querySelectorAll("button, a[href], #report-doc, #report-source, .md-table-wrap")].filter((el) => !el.closest("[hidden]"));
	const onKeydown = (event) => {
		if (event.key === "Escape") {
			closeReportOverlay();
			return;
		}
		if (event.key !== "Tab") return;
		// 焦点还在弹窗里就一概放行原生 Tab，边界由首尾哨兵接管。别在这里按名单判首尾：
		// 焦点仍可能停在名单外的元素上（将来往正文里塞进新的隐式可聚焦元素就会），
		// 那时若强行弹回名单端点，环会被截成两个互不相通的圈——正文后半段正向再也走不到，
		// 反向则在末几项里打转
		if (element.contains(document.activeElement)) return;
		const items = focusables();
		if (!items.length) return;
		event.preventDefault();
		(event.shiftKey ? items[items.length - 1] : items[0]).focus();
	};
	const onHashChange = () => closeReportOverlay();
	reportOverlay = { element, onKeydown, onHashChange, previouslyFocused };
	document.body.appendChild(element);
	// 原生 Tab 走到弹窗边界时会先落到哨兵上，这里再把它弹回另一端。这样环绕不依赖
	// 「弹窗里有哪些可聚焦元素」这份名单的完整性，往正文里塞新东西不用改这段。
	// 从前记在这里的单向缺口（窄窗下 DOM 末尾的 .md-table-wrap 正向走得到、反向走不到）
	// 已经关掉：markdown.js 给每张表都补了 tabindex="0" + role/aria-label，它现在既在原生
	// 序列里、也在 focusables() 里，两端取值与原生序列一致。当初不补是因为它没有 tabindex 时
	// 只有 Chrome 会自动让它可聚焦，Firefox / Safari 里对它 focus() 是空操作、焦点会卡死在
	// 哨兵上——补 tabindex 正是为了消掉这个跨浏览器分歧，别把它删回去
	element.addEventListener("focusin", (event) => {
		const guard = event.target.dataset?.reportGuard;
		if (!guard) return;
		const items = focusables();
		if (!items.length) return;
		(guard === "start" ? items[items.length - 1] : items[0]).focus();
	});
	// 焦点必须立刻挪进弹窗：留在背后的「生成五维报告」按钮上，用户随手一个回车就会再生成
	// 一次报告、把当天那份 .md 覆盖掉。落点是正文而不是关闭按钮——这是个用来读长报告的弹窗，
	// 焦点停在按钮上时空格会被当成点击直接关掉，方向键 / PageDown 滚的则是遮罩背后的页面
	element.querySelector("#report-doc").focus();
	document.addEventListener("keydown", onKeydown);
	window.addEventListener("hashchange", onHashChange);
	// 只有「按下」和「松开」都落在遮罩本身（弹窗以外的暗区）才关闭，两端各记一次。
	// click 的 target 是 mousedown 与 mouseup 的最近公共祖先，所以它一个人分辨不出方向：
	// 正文里按住拖选、把光标甩出弹窗再松手，target 是遮罩；反过来从暗区起手拖进正文里松手，
	// target 同样是遮罩。只判 click、或只判 click 加 mousedown，都会在其中一个方向上误关——
	// 报告在选到一半时突然消失、选区一起没
	let pressedOnBackdrop = false;
	let releasedOnBackdrop = false;
	element.addEventListener("mousedown", (event) => {
		pressedOnBackdrop = event.target === element;
	});
	element.addEventListener("mouseup", (event) => {
		releasedOnBackdrop = event.target === element;
	});
	element.addEventListener("click", () => {
		// 键盘触发的 click（Enter / 空格）没有 mousedown / mouseup，两个标志都是 false，天然不误触
		if (pressedOnBackdrop && releasedOnBackdrop) closeReportOverlay();
		pressedOnBackdrop = false;
		releasedOnBackdrop = false;
	});

	const doc = element.querySelector("#report-doc");
	const source = element.querySelector("#report-source");
	const toc = element.querySelector(".report-toc");
	const sourceBtn = element.querySelector('[data-report-action="source"]');
	const copyBtn = element.querySelector('[data-report-action="copy"]');
	element.querySelector('[data-report-action="close"]').addEventListener("click", closeReportOverlay);

	sourceBtn.addEventListener("click", () => {
		const showSource = source.hidden;
		source.hidden = !showSource;
		doc.hidden = showSource;
		if (toc) toc.hidden = showSource;
		sourceBtn.textContent = showSource ? "渲染视图" : "Markdown 源码";
		// 焦点可能正停在刚被 hidden 的目录按钮或正文上，浏览器会把它静默丢回 <body>；
		// 主动送进新露出的那块，键盘与读屏都能接着往下读。
		// 这次 focus() 同时兼任状态播报——两块面板各有 role="region" + aria-label，读屏会念出
		// 「Markdown 源码 区域」。所以这个按钮**刻意不做成 aria-pressed 的切换按钮**：切换按钮的
		// 可访问名必须恒定（名字指代被切换的东西，按下状态才携带开 / 关），而这里文案是在翻的，
		// 「渲染视图 + 已按下」字面意思是「渲染视图已开启」，正好和实际状态相反，比不加更误导；
		// 想靠 aria-label 固定名字又会违反 WCAG 2.5.3 Label in Name，语音控制说「点击 渲染视图」会失败
		(showSource ? source : doc).focus();
	});

	copyBtn.addEventListener("click", async () => {
		try {
			// 127.0.0.1 属于安全上下文，剪贴板 API 可用；仍然兜底提示，
			// 否则浏览器一旦拒绝授权，按钮就成了点了没反应的哑巴
			await navigator.clipboard.writeText(result.markdown);
			copyBtn.textContent = "已复制";
		} catch {
			copyBtn.textContent = "复制失败，请用源码视图手动复制";
		}
		setTimeout(() => {
			if (copyBtn.isConnected) copyBtn.textContent = "复制 Markdown";
		}, 2000);
	});

	if (toc) {
		const tocLinks = [...toc.querySelectorAll(".report-toc-link")];
		const setActive = (link) => {
			for (const el of tocLinks) {
				const active = el === link;
				el.classList.toggle("is-active", active);
				// 光靠 class 高亮，读屏用户不知道自己读到哪一章了——状态得进语义层
				if (active) el.setAttribute("aria-current", "true");
				else el.removeAttribute("aria-current");
			}
		};
		toc.addEventListener("click", (event) => {
			const link = event.target.closest(".report-toc-link");
			if (!link) return;
			const target = doc.querySelector(`[id="${link.dataset.target}"]`);
			if (target) {
				// 焦点跟着滚动一起过去，否则键盘用户点完目录还要再 Tab 十几下才摸到正文。
				// tabindex="-1" 只让标题能被脚本聚焦，不把它塞进 Tab 序列
				target.tabIndex = -1;
				target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
				target.focus({ preventScroll: true });
			}
			setActive(link);
		});
		// 高亮跟随滚动：只在点击时更新的话，用户手动滚过几章之后高亮还钉在上次点的那条。
		// root 取 #report-doc 而不是视口——报告是在它自己的滚动容器里滚的
		if (typeof IntersectionObserver === "function") {
			const headings = tocLinks.map((link) => doc.querySelector(`[id="${link.dataset.target}"]`));
			const visible = new Set();
			const observer = new IntersectionObserver((entries) => {
				// 切到「Markdown 源码」视图会把 #report-doc 整个设 hidden，所有标题同时离开视口。
				// 不挡住这一格，高亮会被清空，切回渲染视图时目录一片空白
				if (doc.hidden) return;
				for (const entry of entries) {
					if (entry.isIntersecting) visible.add(entry.target);
					else visible.delete(entry.target);
				}
				// 取当前可见的最靠前那条：视口里同时露出两三个小节时，高亮应该跟着最上面那个
				const index = headings.findIndex((heading) => heading && visible.has(heading));
				if (index >= 0) setActive(tocLinks[index]);
			}, { root: doc, rootMargin: "0px 0px -70% 0px" });
			for (const heading of headings) if (heading) observer.observe(heading);
		}
	}
}

// isCurrent 必须校验：点击后用户可能在 POST /api/report 挂起期间导航离开，
// 届时 btn/body 已随 content.innerHTML 被整体替换而与文档分离，写入分离节点
// 虽不抛错但用户看不到任何反馈——静默生成成功却像是失败
function bindDossierReportButton(content, marketRef, isCurrent) {
	const btn = content.querySelector("#dossier-report-btn");
	const body = content.querySelector("#dossier-report-body");
	if (!btn || !body) return;
	btn.addEventListener("click", async () => {
		btn.disabled = true;
		btn.textContent = "生成中…";
		body.innerHTML = `<span class="report-result-path mono">生成中…</span>`;
		try {
			const result = await fetchApi("/api/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marketRef }) });
			if (!isCurrent()) return;
			body.innerHTML = `
				<span class="report-result-path mono" title="${escapeHtml(result.path)}">${escapeHtml(result.path)}</span>
				<button type="button" class="btn btn-outline" id="dossier-report-open">查看最近报告</button>
			`;
			// 报告正文留在闭包里：重看不必再生成一次（生成会重算 GSE 并覆盖当天的 .md）
			body.querySelector("#dossier-report-open").addEventListener("click", (event) => openReportOverlay(result, event.currentTarget));
			openReportOverlay(result, btn);
		} catch (error) {
			if (!isCurrent()) return;
			body.innerHTML = `<div class="error-panel">生成失败：${escapeHtml(error.message)}</div>`;
		} finally {
			if (isCurrent()) {
				btn.disabled = false;
				btn.textContent = "生成五维报告";
			}
		}
	});
}

async function renderMarketDossier(content, isCurrent, marketRef) {
	refreshGlobalChrome(isCurrent);
	let data;
	try {
		data = await fetchApi(`/api/markets/${encodeURIComponent(marketRef)}`);
	} catch (error) {
		if (!isCurrent()) return;
		content.innerHTML = `<div class="error-panel">加载市场档案失败：${escapeHtml(error.message)}</div>`;
		return;
	}
	if (!isCurrent()) return;
	content.innerHTML = buildMarketDossierHtml(data);
	bindDossierDimensionFilter(content);
	bindDossierReportButton(content, marketRef, isCurrent);
}

// ── 候选池页 ──────────────────────────────────────────────────────

// 阶段中文标签与顺序：与 types.ts 的 CANDIDATE_STAGES/STAGE_LABELS 同口径，
// app.js 无模块共享机制，域枚举一律像 GATE_LABELS 一样在前端独立小份复制
const CANDIDATE_STAGES_CLIENT = ["lead", "screen", "deep_research", "risk", "decision", "testing", "review", "archived"];
const STAGE_LABELS_CLIENT = { lead: "线索", screen: "粗筛", deep_research: "深研", risk: "风控", decision: "决策", testing: "测品", review: "复盘", archived: "归档" };
const POOL_STANDARD_STAGES = ["lead", "screen", "deep_research", "risk"];
const POOL_COLLAPSED_STAGES = ["decision", "testing", "review", "archived"];
const POOL_LANE_EMPTY_TEXT = {
	lead: "暂无候选——从词根/竞品建立线索",
	screen: "暂无候选——导入 CSV 后自动进入粗筛并跑 Gate",
	deep_research: "暂无候选——粗筛通过 Gate 后自动流入",
	risk: "暂无候选——深研完成后流入风控核查",
};
const DECISION_OPTIONS = [
	{ key: "go", label: "上" },
	{ key: "waitlist", label: "观望" },
	{ key: "no_go", label: "不做" },
];

function poolCandidateCardHtml(item) {
	const gate = item.gateOutcome
		? `<span class="pool-gate-badge ${GATE_TONES[item.gateOutcome]}">${gateIconFor(item.gateOutcome)}${escapeHtml(item.gateOutcome)}</span>`
		: "";
	const score = item.score !== null ? `<span class="mono pool-card-score">${item.score.toFixed(1)}</span>` : "";
	const decision = item.decisionStatus
		? `<span class="pool-card-decision ${DECISION_TONES[item.decisionStatus] || ""}">${escapeHtml(DECISION_LABELS[item.decisionStatus] || item.decisionStatus)}</span>`
		: item.stage === "decision" || item.stage === "testing"
			? `<span class="pool-card-decision cell-dim">待决策</span>`
			: "";
	const snapshotMeta = item.snapshotAgeDays !== null
		? `<div class="pool-card-meta mono cell-dim">快照 ${item.snapshotAgeDays}d${item.snapshotSource ? ` · ${escapeHtml(item.snapshotSource)}` : ""}</div>`
		: "";
	const contextLine = item.stageReason ? `<div class="pool-card-context">${escapeHtml(item.stageReason)}</div>` : "";
	const tags = item.tags && item.tags.length ? `<div class="pool-card-tags">${item.tags.map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("")}</div>` : "";
	return `
		<a class="pool-card" href="#/pool/${encodeURIComponent(item.id)}">
			<div class="pool-card-title cell-truncate">${escapeHtml(item.marketName || item.marketId)}</div>
			<div class="pool-card-row">${gate}${score}${decision}</div>
			${snapshotMeta}
			${contextLine}
			${tags}
		</a>
	`;
}

function poolLaneColumnHtml(lane) {
	const countCls = lane.count === 0 ? "is-empty" : "";
	const cards = lane.items.length
		? lane.items.map((item) => poolCandidateCardHtml(item)).join("")
		: `<div class="pool-empty-slot">${escapeHtml(POOL_LANE_EMPTY_TEXT[lane.stage] || "暂无候选")}</div>`;
	return `
		<div class="pool-lane">
			<div class="pool-lane-head">
				<span class="pool-lane-label">${escapeHtml(lane.label)}</span>
				<span class="mono pool-lane-count ${countCls}">${lane.count}</span>
			</div>
			<div class="pool-lane-body">${cards}</div>
		</div>
	`;
}

function poolCollapsedColumnHtml(lanes) {
	const rows = lanes.map((lane) => `
		<div class="pool-collapsed-row ${lane.stage === "archived" ? "is-archived" : ""}">
			<span>${escapeHtml(lane.label)}</span>
			<span class="mono">${lane.count}</span>
		</div>
	`).join("");
	return `
		<div class="pool-lane pool-lane-collapsed">
			<div class="pool-lane-head"><span class="pool-lane-label cell-dim">后段</span></div>
			<div class="pool-lane-body">
				${rows}
				<div class="pool-collapsed-note">否决品保留不删除</div>
			</div>
		</div>
	`;
}

function buildPoolBoardHtml(lanes) {
	const standardLanes = POOL_STANDARD_STAGES.map((stage) => lanes.find((l) => l.stage === stage));
	const collapsedLanes = POOL_COLLAPSED_STAGES.map((stage) => lanes.find((l) => l.stage === stage));
	return `
		<div class="pool-board" id="pool-board">
			${standardLanes.map((lane) => poolLaneColumnHtml(lane)).join("")}
			${poolCollapsedColumnHtml(collapsedLanes)}
		</div>
	`;
}

const POOL_GATE_CHIPS = [{ key: "pass", label: "pass" }, { key: "review", label: "review" }, { key: "reject", label: "reject" }];
const POOL_DECISION_CHIPS = [{ key: "go", label: "go" }, { key: "waitlist", label: "waitlist" }, { key: "no_go", label: "no_go" }];

function buildPoolFilterBarHtml(data) {
	const gateChips = [
		`<button type="button" class="chip pool-gate-chip is-active" data-gate="all">全部 <span class="mono">×${data.total}</span></button>`,
		...POOL_GATE_CHIPS.map((c) => `<button type="button" class="chip pool-gate-chip" data-gate="${c.key}">${escapeHtml(c.label)} <span class="mono">×${data.gateCounts[c.key] || 0}</span></button>`),
	].join("");
	const decisionChips = POOL_DECISION_CHIPS.map((c) => `<button type="button" class="chip pool-decision-chip" data-decision="${c.key}">${escapeHtml(c.label)} <span class="mono">×${data.decisionCounts[c.key] || 0}</span></button>`).join("");
	return `
		<div class="pool-filter-bar" id="pool-filter-bar">
			<span class="panel-hint">Gate</span>${gateChips}
			<span class="pool-filter-sep"></span>
			<span class="panel-hint">决策</span>${decisionChips}
			<span class="pool-filter-count mono cell-dim">排序：Score（同批分位） · ${data.total} 张候选卡</span>
		</div>
	`;
}

function filterPoolLanes(data, state) {
	const matches = (item) =>
		(state.gate === "all" || item.gateOutcome === state.gate) &&
		(!state.decisions.size || (item.decisionStatus && state.decisions.has(item.decisionStatus)));
	return data.lanes.map((lane) => ({ ...lane, items: lane.items.filter(matches) }));
}

function bindPoolFilters(content, data, state) {
	const bar = content.querySelector("#pool-filter-bar");
	if (!bar) return;
	const rerenderBoard = () => {
		const boardEl = content.querySelector("#pool-board");
		if (boardEl) boardEl.outerHTML = buildPoolBoardHtml(filterPoolLanes(data, state));
	};
	for (const chip of bar.querySelectorAll(".pool-gate-chip")) {
		chip.addEventListener("click", () => {
			for (const el of bar.querySelectorAll(".pool-gate-chip")) el.classList.toggle("is-active", el === chip);
			state.gate = chip.dataset.gate;
			rerenderBoard();
		});
	}
	for (const chip of bar.querySelectorAll(".pool-decision-chip")) {
		chip.addEventListener("click", () => {
			const key = chip.dataset.decision;
			if (state.decisions.has(key)) {
				state.decisions.delete(key);
				chip.classList.remove("is-active");
			} else {
				state.decisions.add(key);
				chip.classList.add("is-active");
			}
			rerenderBoard();
		});
	}
}

function gateRuleListHtml(rules) {
	return `<div class="gate-rule-list">${rules.map((rule) => `
		<div class="gate-rule-row">
			${ruleStatusIcon(rule.status)}
			<span class="gate-rule-label cell-truncate ${ruleStatusTone(rule.status)}">${escapeHtml(rule.label)}</span>
			<span class="mono cell-right ${ruleStatusTone(rule.status)}" style="font-size:11px;">${escapeHtml(rule.message || "—")}</span>
		</div>
	`).join("")}</div>`;
}

function buildMoveStageFormHtml(candidate) {
	const options = CANDIDATE_STAGES_CLIENT.filter((stage) => stage !== candidate.stage)
		.map((stage) => `<option value="${stage}">${escapeHtml(STAGE_LABELS_CLIENT[stage])}</option>`)
		.join("");
	return `
		<form id="pool-move-form" class="drawer-form">
			<div class="drawer-form-label">移动阶段</div>
			<div class="drawer-form-row">
				<select name="stage" class="field-select" style="flex:0 0 auto;">${options}</select>
				<input name="reason" type="text" class="field-input" style="flex:1 1 auto;" placeholder="必填：为什么移动？将写入决策日志">
			</div>
			<div class="drawer-form-row" style="margin-top:10px;">
				<button type="submit" class="btn btn-accent-fill" style="flex:1 1 auto; justify-content:center;">移动并写入决策日志</button>
				<button type="button" class="btn btn-outline" id="pool-toggle-decide" style="flex:0 0 auto;">记录决策…</button>
			</div>
			<div class="drawer-form-hint">阶段移动与 go / waitlist / no_go 均强制填写理由，不可跳过</div>
			<div class="drawer-form-error" id="pool-move-error" hidden></div>
		</form>
	`;
}

function buildDecideFormHtml() {
	const buttons = DECISION_OPTIONS.map((opt) => `<button type="button" class="chip decide-status-chip" data-status="${opt.key}">${escapeHtml(opt.label)}</button>`).join("");
	return `
		<form id="pool-decide-form" class="drawer-form" hidden>
			<div class="drawer-form-label">记录决策</div>
			<div class="chip-row" id="pool-decide-status-row">${buttons}</div>
			<textarea name="reason" class="field-textarea" placeholder="必填：为什么是这个决策？将写入决策日志" style="margin-top:8px;"></textarea>
			<div class="drawer-form-row" style="margin-top:10px;">
				<button type="submit" class="btn btn-accent-fill" style="flex:1 1 auto; justify-content:center;">记录决策并写入决策日志</button>
				<button type="button" class="btn btn-outline" id="pool-toggle-move" style="flex:0 0 auto;">取消</button>
			</div>
			<div class="drawer-form-hint">阶段移动与 go / waitlist / no_go 均强制填写理由，不可跳过</div>
			<div class="drawer-form-error" id="pool-decide-error" hidden></div>
		</form>
	`;
}

// 写操作失败原样展示后端中文错误（含「候选已处于 X 阶段」「阶段移动必须填写理由」等）；
// 成功与失败都不在这里决定下一步——调用方决定成功后如何刷新
async function submitPoolWrite(path, payload, formEl, errorEl) {
	errorEl.hidden = true;
	const submitBtn = formEl.querySelector('button[type="submit"]');
	submitBtn.disabled = true;
	try {
		await fetchApi(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
		return true;
	} catch (error) {
		errorEl.textContent = error.message;
		errorEl.hidden = false;
		return false;
	} finally {
		submitBtn.disabled = false;
	}
}

function bindDecisionForms(content, candidateId, onSuccess) {
	const moveForm = content.querySelector("#pool-move-form");
	const decideForm = content.querySelector("#pool-decide-form");
	if (!moveForm || !decideForm) return;
	const moveError = content.querySelector("#pool-move-error");
	const decideError = content.querySelector("#pool-decide-error");
	const statusRow = content.querySelector("#pool-decide-status-row");
	let selectedStatus = null;

	content.querySelector("#pool-toggle-decide").addEventListener("click", () => {
		moveForm.hidden = true;
		decideForm.hidden = false;
	});
	content.querySelector("#pool-toggle-move").addEventListener("click", () => {
		decideForm.hidden = true;
		moveForm.hidden = false;
	});
	statusRow.addEventListener("click", (event) => {
		const chip = event.target.closest(".decide-status-chip");
		if (!chip) return;
		for (const el of statusRow.querySelectorAll(".decide-status-chip")) el.classList.toggle("is-active", el === chip);
		selectedStatus = chip.dataset.status;
	});

	moveForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const reason = moveForm.reason.value.trim();
		if (!reason) {
			moveError.textContent = "必填：请填写理由";
			moveError.hidden = false;
			return;
		}
		const ok = await submitPoolWrite("/api/pool/move", { candidateRef: candidateId, stage: moveForm.stage.value, reason }, moveForm, moveError);
		if (ok) onSuccess();
	});

	decideForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const reason = decideForm.reason.value.trim();
		if (!selectedStatus) {
			decideError.textContent = "请先选择 go / waitlist / no_go";
			decideError.hidden = false;
			return;
		}
		if (!reason) {
			decideError.textContent = "必填：请填写理由";
			decideError.hidden = false;
			return;
		}
		const ok = await submitPoolWrite("/api/pool/decide", { candidateRef: candidateId, status: selectedStatus, reason }, decideForm, decideError);
		if (ok) onSuccess();
	});
}


// ── 单品决策页：点候选卡后全屏聚焦该产品（看板退场），链接/证据/操作一屏完成 ──

function buildDecisionBreadcrumbHtml(candidate) {
	return `
		<div class="breadcrumb-row">
			<div class="breadcrumb">
				<a href="#/pool" class="breadcrumb-back" title="返回候选池">${ICON_BACK}</a>
				<span class="cell-muted">候选池</span>
				<span class="cell-dim">/</span>
				<span class="breadcrumb-current cell-truncate">${escapeHtml(candidate.marketName || candidate.marketId)}</span>
			</div>
			<div class="breadcrumb-actions">
				<a href="#/market/${encodeURIComponent(candidate.marketId)}" class="btn btn-outline">查看市场档案 →</a>
			</div>
		</div>
	`;
}

function buildDecisionHeaderHtml(candidate) {
	const badges = [
		`<span class="badge-pill pill-accent">阶段 ${escapeHtml(candidate.stageLabel)}</span>`,
		candidate.gateOutcome
			? `<span class="badge-pill ${toneToPillClass(GATE_TONES[candidate.gateOutcome])}" style="display:inline-flex; align-items:center; gap:4px;">${gateIconFor(candidate.gateOutcome)}Gate <span class="mono">${escapeHtml(candidate.gateOutcome.toUpperCase())}</span></span>`
			: `<span class="badge-pill pill-muted">Gate —</span>`,
		candidate.decisionStatus
			? `<span class="badge-pill ${toneToPillClass(DECISION_TONES[candidate.decisionStatus])}">决策 ${escapeHtml(DECISION_LABELS[candidate.decisionStatus] || candidate.decisionStatus)}</span>`
			: `<span class="badge-pill pill-muted">待决策</span>`,
		`Score <span class="mono" style="font-size:15px; font-weight:600;">${candidate.score !== null ? candidate.score.toFixed(1) : "—"}</span>`,
	];
	const metaParts = [`建卡 ${escapeHtml(candidate.createdAt.slice(0, 10))}`, `更新 ${escapeHtml(candidate.updatedAt.slice(0, 10))}`];
	if (candidate.owner) metaParts.push(`负责人 ${escapeHtml(candidate.owner)}`);
	if (candidate.tags.length) metaParts.push(candidate.tags.map((tag) => `#${escapeHtml(tag)}`).join(" "));
	return `
		<div class="dossier-header">
			<div class="dossier-title cell-truncate">${escapeHtml(candidate.marketName || candidate.marketId)}</div>
			<div class="dossier-badges">${badges.join(`<span class="cell-dim">·</span>`)}</div>
			<div class="dossier-meta mono cell-dim">${metaParts.join(" · ")}</div>
		</div>
	`;
}

function decisionListingRowHtml(row) {
	const price = row.price !== null ? `$${row.price.toFixed(2)}` : "—";
	const rating = row.rating !== null ? `★${row.rating.toFixed(1)}` : "—";
	const sales = row.monthlySales !== null ? `月销 ${row.monthlySales.toLocaleString("zh-CN")}` : "月销 —";
	// url 为 null（无/非法 ASIN）时行保留参考数据但不带链接（spec 4.2.5）
	const open = row.url
		? `<a class="btn btn-outline listing-open" href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">打开 ↗</a>`
		: `<span class="cell-dim" style="font-size:11px;">无链接</span>`;
	return `
		<div class="listing-row">
			<span class="mono cell-dim">#${row.rank}</span>
			<span class="cell-truncate" title="${escapeHtml(row.title || "")}">${escapeHtml(row.title || row.asin || "（无标题）")}</span>
			<span class="mono cell-right">${escapeHtml(price)}</span>
			<span class="mono cell-right">${escapeHtml(rating)}</span>
			<span class="mono cell-right">${escapeHtml(sales)}</span>
			${open}
		</div>
	`;
}

function buildDecisionLinksPanelHtml(links) {
	const searches = links.searches.length
		? `<div class="chip-row" style="margin-bottom:10px;">${links.searches.map((item) => `<a class="chip" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">搜索：${escapeHtml(item.keyword)} ↗</a>`).join("")}</div>`
		: "";
	const listings = links.topListings.length
		? `<div class="listing-rows">${links.topListings.map(decisionListingRowHtml).join("")}</div>`
		: `<div class="empty-note">尚无可核对的竞品 listing——先导入市场 CSV</div>`;
	return `
		<div class="panel">
			<div class="panel-title">Amazon 实况核对</div>
			${searches}
			${listings}
			<div class="panel-footnote">链接在新标签页打开你自己的浏览器会话；行内数字来自本地快照，非实时</div>
		</div>
	`;
}

function buildDecisionMetricsPanelHtml(keyMetrics) {
	const cards = keyMetrics.map((row) => {
		const missing = row.value === null;
		const sub = row.source
			? [escapeHtml(row.source), row.capturedAt ? escapeHtml(row.capturedAt.slice(5, 10)) : null].filter(Boolean).join(" · ")
			: "—";
		return `
			<div class="kpi-card">
				<div class="kpi-label">${escapeHtml(row.label)}</div>
				<div class="kpi-value ${missing ? "tone-warning" : ""}">${escapeHtml(row.display)}</div>
				<div class="kpi-sub mono">${sub}</div>
			</div>
		`;
	}).join("");
	return `
		<div class="panel">
			<div class="panel-title">关键指标 <span class="cell-muted" style="font-weight:400;">Gate 口径</span></div>
			<div class="kpi-grid">${cards}</div>
			<div class="panel-footnote">与策略引擎同口径：无快照或未测算时按「缺」展示，不回填估算值</div>
		</div>
	`;
}

function buildDecisionScorePanelHtml(latestRun) {
	if (!latestRun) return `<div class="panel"><div class="panel-title">五维评分</div><div class="empty-note" style="margin-top:10px;">尚无策略评估</div></div>`;
	const rows = latestRun.dimensionScores.map((dimension) => {
		const score = dimension.score;
		const pct = score === null ? 0 : Math.max(0, Math.min(100, score));
		const fillTone = score === null ? "" : score >= 75 ? "tone-success-fill" : "tone-warning-fill";
		return `
			<div class="score-row">
				<div class="score-label">${escapeHtml(dimension.label)}</div>
				<div class="score-track"><div class="score-fill ${fillTone}" style="width:${pct}%;"></div></div>
				<div class="score-value mono cell-right">${score === null ? "—" : score.toFixed(1)}</div>
			</div>
		`;
	}).join("");
	return `<div class="panel"><div class="panel-title">五维评分</div><div class="score-rows">${rows}</div></div>`;
}

function buildDecisionProfitPanelHtml(profit) {
	if (!profit) return `<div class="panel"><div class="panel-title">利润测算</div><div class="empty-note" style="margin-top:10px;">尚无测算——在 pi 里说「给这个市场做利润测算」</div></div>`;
	const rows = [
		["毛利率", `${(profit.grossMargin * 100).toFixed(1)}%`],
		["BE-CPC", `${profit.breakEvenCpc.toFixed(2)} ${profit.currency}`],
		["CPC 承受度", profit.cpcRatio !== null ? profit.cpcRatio.toFixed(2) : "—"],
		["启动资金", `${profit.startupCapital.toFixed(0)} ${profit.currency}`],
	].map(([label, value]) => `<div class="fact-row"><span class="cell-muted">${escapeHtml(label)}</span><span class="mono cell-right">${escapeHtml(value)}</span></div>`).join("");
	return `<div class="panel"><div class="panel-title">利润测算 <span class="mono cell-muted" style="font-weight:400;">${escapeHtml(profit.createdAt.slice(0, 10))}</span></div>${rows}</div>`;
}

const RISK_FLAG_LABELS = { certStatus: "认证", ipRiskLevel: "知识产权", seasonFlag: "季节", policyFlag: "政策", logisticsRisk: "物流" };
const RISK_VALUE_TONES = { pass: "tone-success", clear: "tone-success", review: "tone-warning", strong: "tone-warning", unknown: "tone-warning", red: "tone-error" };

function buildDecisionRiskPanelHtml(risk) {
	if (!risk) return `<div class="panel"><div class="panel-title">风险核查</div><div class="empty-note" style="margin-top:10px;">尚未核查——五类风险需官方证据留痕</div></div>`;
	const overallTone = RISK_VALUE_TONES[risk.overall] || "tone-muted";
	const flags = Object.entries(RISK_FLAG_LABELS)
		.map(([key, label]) => `<div class="fact-row"><span class="cell-muted">${escapeHtml(label)}</span><span class="mono cell-right ${RISK_VALUE_TONES[risk[key]] || ""}">${escapeHtml(risk[key])}</span></div>`)
		.join("");
	return `<div class="panel"><div class="panel-title">风险核查 <span class="badge-pill ${toneToPillClass(overallTone)}">${escapeHtml(risk.overall)}</span></div>${flags}</div>`;
}

function buildDecisionRulesPanelHtml(latestRun) {
	const body = latestRun && latestRun.rules.length ? gateRuleListHtml(latestRun.rules) : `<div class="empty-note">尚无策略评估</div>`;
	return `<div class="panel"><div class="panel-title">Gate 规则摘要${latestRun ? ` <span class="mono cell-muted" style="font-weight:400;">${escapeHtml(latestRun.strategyRef)}</span>` : ""}</div>${body}</div>`;
}

function buildDecisionHistoryPanelHtml(decisions) {
	const shown = decisions.slice(0, 8);
	const body = shown.length
		? `<div class="decision-timeline">${shown.map(decisionTimelineItemHtml).join("")}</div>`
		: `<div class="empty-note">暂无决策记录</div>`;
	// API 对 decisions 封顶 50 条（web/data.ts）：满 50 时真实总数可能更多，措辞用「50+」防自述失真
	const countLabel = decisions.length >= 50 ? "50+" : String(decisions.length);
	const more = decisions.length > 8 ? `<div class="panel-footnote">仅显示最近 8 条 / 共 ${countLabel} 条；完整历史可在 pi 中用 compass_history 查询</div>` : "";
	return `<div class="panel"><div class="panel-title">决策日志 <span class="mono cell-muted">${countLabel}</span></div>${body}${more}</div>`;
}

function buildDecisionPageHtml(detail) {
	return `
		<div class="decide-page">
			${buildDecisionBreadcrumbHtml(detail.candidate)}
			${buildDecisionHeaderHtml(detail.candidate)}
			${buildDecisionLinksPanelHtml(detail.links)}
			${buildDecisionMetricsPanelHtml(detail.keyMetrics)}
			<div class="decide-grid-3">
				${buildDecisionScorePanelHtml(detail.latestRun)}
				${buildDecisionProfitPanelHtml(detail.profitSummary)}
				${buildDecisionRiskPanelHtml(detail.riskSummary)}
			</div>
			${buildDecisionRulesPanelHtml(detail.latestRun)}
			${buildDecisionHistoryPanelHtml(detail.decisions)}
			<div class="panel decide-actions">
				<div class="panel-title">决策操作</div>
				${buildMoveStageFormHtml(detail.candidate)}
				${buildDecideFormHtml()}
			</div>
		</div>
	`;
}

async function renderPoolDecision(content, isCurrent, candidateRef) {
	refreshGlobalChrome(isCurrent);
	let detail;
	try {
		detail = await fetchApi(`/api/pool/${encodeURIComponent(candidateRef)}`);
	} catch (error) {
		if (!isCurrent()) return;
		content.innerHTML = `<div class="error-panel">加载候选详情失败：${escapeHtml(error.message)} <a href="#/pool">← 返回候选池</a></div>`;
		return;
	}
	if (!isCurrent()) return;
	content.innerHTML = buildDecisionPageHtml(detail);
	// 决策/移动成功即完成聚焦页的任务，回看板（spec 4.3）。
	// isCurrent 必须校验：POST 挂起期间用户可导航离开，成功回调不得把人从别的页面拽回看板
	bindDecisionForms(content, detail.candidate.id, () => { if (isCurrent()) location.hash = "#/pool"; });
}

async function renderPool(content, isCurrent, candidateRef) {
	if (candidateRef) return renderPoolDecision(content, isCurrent, candidateRef);
	refreshGlobalChrome(isCurrent);
	let data;
	try {
		data = await fetchApi("/api/pool");
	} catch (error) {
		if (!isCurrent()) return;
		content.innerHTML = `<div class="error-panel">加载候选池失败：${escapeHtml(error.message)}</div>`;
		return;
	}
	if (!isCurrent()) return;
	content.innerHTML = `
		<div class="pool-main">
			${buildPoolFilterBarHtml(data)}
			${buildPoolBoardHtml(data.lanes)}
		</div>
	`;
	const state = { gate: "all", decisions: new Set() };
	bindPoolFilters(content, data, state);
}

// ── 导入 CSV 向导 ──────────────────────────────────────────────────────

const ICON_CLOSE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>`;

// 与 types.ts SNAPSHOT_SOURCES 同口径的前端小份复制（见候选池段落顶部注释的说明）
const SNAPSHOT_SOURCES_CLIENT = ["auto", "sellersprite", "sorftime", "keepa", "compass_browser", "manual_csv", "generic_csv"];

const ICON_FILE = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" style="flex:0 0 auto;"><path d="M6 3 H14 L19 8 V21 H6 Z" stroke="#8b98a5" stroke-width="1.6" stroke-linejoin="round"></path><path d="M14 3 V8 H19" stroke="#8b98a5" stroke-width="1.6" stroke-linejoin="round"></path><path d="M9 13 H16 M9 16.5 H16" stroke="#8b98a5" stroke-width="1.4" stroke-linecap="round"></path></svg>`;

function buildImportFormHtml(today) {
	const sourceChips = SNAPSHOT_SOURCES_CLIENT.map((s) => `<button type="button" class="chip import-source-chip mono ${s === "auto" ? "is-active" : ""}" data-source="${s}">${escapeHtml(s)}</button>`).join("");
	return `
		<form id="import-form">
			<div class="import-source-tabs" id="import-source-tabs">
				<button type="button" class="import-tab is-active" data-tab="pick">从 compass-imports/ 选择</button>
				<button type="button" class="import-tab" data-tab="manual">手动输入路径</button>
			</div>
			<div id="import-file-picker"><div class="loading">加载文件列表…</div></div>
			<div id="import-manual-path" hidden>
				<input type="text" name="manualPath" class="field-input mono" placeholder="/path/to/your-file.csv 或相对 compass-imports/ 的路径">
			</div>

			<div class="field">
				<label class="field-label">市场名 <span class="field-required">*</span></label>
				<input type="text" name="marketName" class="field-input" placeholder="必填：英文市场名（可附中文括注，如 Clear Stadium Bag（透明球场包））">
			</div>

			<div class="field">
				<label class="field-label">数据来源</label>
				<div class="chip-row" id="import-source-chips">${sourceChips}</div>
			</div>

			<div class="field" style="width:200px;">
				<label class="field-label">采集日期</label>
				<input type="text" name="capturedAt" class="field-input mono" value="${escapeHtml(today)}" placeholder="YYYY-MM-DD">
			</div>

			<label class="import-toggle-row">
				<input type="checkbox" name="runScreen" checked class="toggle-checkbox-input">
				<span class="toggle-switch"></span>
				<span>导入后自动跑粗筛 Gate</span>
			</label>

			<div class="empty-note">原始文件将归档到 .pi/compass/raw/ · 快照不可变、按日期追加 · 同市场相隔 ≥7 天的新快照会自动做错杀对照</div>

			<div class="drawer-form-error" id="import-error" hidden></div>
		</form>
	`;
}

function buildImportWizardHtml() {
	const today = todayLocalDate();
	return `
		<div class="modal-backdrop">
			<div class="modal">
				<div class="modal-header">
					<div class="modal-title">导入 CSV — 生成市场快照</div>
					<a href="#/markets" class="drawer-close" title="关闭">${ICON_CLOSE}</a>
				</div>
				<div class="modal-body" id="import-modal-body">${buildImportFormHtml(today)}</div>
				<div class="modal-footer" id="import-modal-footer">
					<a href="#/markets" class="btn btn-outline">取消</a>
					<button type="submit" form="import-form" class="btn btn-accent-fill" id="import-submit-btn">导入并跑粗筛</button>
				</div>
			</div>
		</div>
	`;
}

// 这一排是「从 compass-imports/ 里挑一个文件」的单选。用真的 <input type="radio"> 而不是
// 挂了 click 的 <div>：后者键盘完全够不着（全站扫描下来这里曾是唯一一处），而原生单选还
// 白拿到方向键在组内移动、整组只占一个 Tab 停留点、读屏能念出「第 2 项，共 5 项」。
// radio 铺满整行并 pointer-events: none，是为了让键盘聚焦时滚动落到这一行本身而不是列表顶部；
// 点击照旧穿透给 <label>，由 for 转发回 radio。
function fileRowHtml(file, isSelected, index) {
	const sizeKb = (file.size / 1024).toFixed(1);
	const id = `import-file-${index}`;
	return `
		<div class="import-file-item">
			<input type="radio" class="import-file-radio" name="import-file" id="${id}" value="${escapeHtml(file.path)}"${isSelected ? " checked" : ""}>
			<label class="import-file-row ${isSelected ? "is-selected" : ""}" for="${id}" data-path="${escapeHtml(file.path)}">
				${ICON_FILE}
				<div style="min-width:0; flex:1 1 auto;">
					<div class="mono cell-truncate" style="font-size:12px; color:var(--c-text);">${escapeHtml(file.name)}</div>
					<div class="cell-muted" style="font-size:11px;">${sizeKb} KB · 修改于 ${escapeHtml(formatDateTime(file.mtime))}</div>
				</div>
				<span class="import-file-check">${ICON_CHECK}</span>
			</label>
		</div>
	`;
}

function bindFilePicker(pickerEl, files, state) {
	pickerEl.innerHTML = `<div class="import-file-list" role="radiogroup" aria-label="compass-imports/ 下待导入的 CSV">${files.map((file, index) => fileRowHtml(file, file.path === state.path, index)).join("")}</div>`;
	// 听 change 而不是 click，且**不重新渲染**：原生单选用方向键在组内移动时只发 change，
	// 重渲染会把焦点连同整棵 DOM 一起抹掉——键盘用户按一下方向键，焦点就掉回 <body>。
	// 勾选图标改由 CSS 按 .is-selected 显隐（visibility 而非 display，免得选中时行高跳一下）
	pickerEl.addEventListener("change", (event) => {
		const input = event.target.closest(".import-file-radio");
		if (!input) return;
		state.path = input.value;
		for (const row of pickerEl.querySelectorAll(".import-file-row")) row.classList.toggle("is-selected", row.dataset.path === state.path);
	});
}

function bindImportSourceTabs(content, state) {
	const tabsEl = content.querySelector("#import-source-tabs");
	const pickerWrap = content.querySelector("#import-file-picker");
	const manualWrap = content.querySelector("#import-manual-path");
	const manualInput = manualWrap.querySelector('input[name="manualPath"]');
	tabsEl.addEventListener("click", (event) => {
		const tab = event.target.closest(".import-tab");
		if (!tab) return;
		for (const el of tabsEl.querySelectorAll(".import-tab")) el.classList.toggle("is-active", el === tab);
		const isPick = tab.dataset.tab === "pick";
		pickerWrap.hidden = !isPick;
		manualWrap.hidden = isPick;
		// 切走 tab 清空另一侧已选内容：避免同时存在「选中文件」与「手输路径」两个数据源。
		// 选择器那侧是原生单选，光清 state 不够——DOM 里的 checked 与高亮会原样留着，
		// 切回来时界面显示「已选中」而 state 其实是空的，一提交报「未选择文件」，看着像 bug
		for (const input of pickerWrap.querySelectorAll(".import-file-radio")) input.checked = false;
		for (const row of pickerWrap.querySelectorAll(".import-file-row")) row.classList.remove("is-selected");
		state.path = "";
		manualInput.value = "";
	});
	manualInput.addEventListener("input", () => {
		state.path = manualInput.value.trim();
	});
}

function bindImportSourceChips(content, state) {
	const row = content.querySelector("#import-source-chips");
	row.addEventListener("click", (event) => {
		const chip = event.target.closest(".import-source-chip");
		if (!chip) return;
		for (const el of row.querySelectorAll(".import-source-chip")) el.classList.toggle("is-active", el === chip);
		state.source = chip.dataset.source;
	});
}

function importResultRow(label, valueHtml) {
	return `<div class="import-result-row"><span class="cell-muted">${escapeHtml(label)}</span><span>${valueHtml}</span></div>`;
}

function renderImportSuccess(content, result) {
	const bodyEl = content.querySelector("#import-modal-body");
	const footerEl = content.querySelector("#import-modal-footer");
	const titleEl = content.querySelector(".modal-title");
	if (titleEl) titleEl.textContent = `导入完成 — ${result.market.name}`;
	const gateBadge = result.candidate.gateOutcome
		? `<span class="badge-pill ${toneToPillClass(GATE_TONES[result.candidate.gateOutcome])}" style="display:inline-flex; align-items:center; gap:4px;">${gateIconFor(result.candidate.gateOutcome)}${escapeHtml(result.candidate.gateOutcome.toUpperCase())}</span>`
		: `<span class="badge-pill pill-muted">未跑粗筛</span>`;
	const rows = [
		importResultRow("市场", escapeHtml(result.market.name)),
		importResultRow("快照 ID", `<span class="mono">${escapeHtml(result.snapshot.id)}</span>`),
		importResultRow("来源 · 采集日期", `<span class="mono">${escapeHtml(result.snapshot.source)} · ${escapeHtml(result.snapshot.capturedAt.slice(0, 10))}</span>`),
		importResultRow("粗筛 Gate 结论", gateBadge),
	];
	if (result.candidate.score !== null) rows.push(importResultRow("Score", `<span class="mono">${result.candidate.score.toFixed(1)}</span>`));
	if (result.snapshot.warnings.length) rows.push(importResultRow("警告", escapeHtml(result.snapshot.warnings.join("；"))));
	bodyEl.innerHTML = `<div class="import-result-card"><div class="import-result-title">${ICON_CHECK}市场快照已生成</div>${rows.join("")}</div>`;
	footerEl.innerHTML = `
		<a href="#/import" class="btn btn-outline">继续导入下一个</a>
		<a href="#/market/${encodeURIComponent(result.market.id)}" class="btn btn-accent-fill">查看市场档案 →</a>
	`;
}

// isCurrent 必须校验：提交请求挂起期间用户可点击取消/切 tab 导航离开，
// 届时 form/errorEl/submitBtn 已随 content.innerHTML 被整体替换而与文档分离——
// 不判空直接写会抛 TypeError（被 catch 吞掉，错误信息还写去了分离节点，用户完全看不到
// 后端其实已经真实完成了导入），判过 isCurrent 后静默放弃即可，无需再对分离节点判空
function bindImportSubmit(content, state, isCurrent) {
	const form = content.querySelector("#import-form");
	const errorEl = content.querySelector("#import-error");
	const submitBtn = content.querySelector("#import-submit-btn");
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		errorEl.hidden = true;
		const marketName = form.marketName.value.trim();
		const capturedAt = form.capturedAt.value.trim();
		if (!state.path) {
			errorEl.textContent = "必填：请选择或输入 CSV 文件路径";
			errorEl.hidden = false;
			return;
		}
		if (!marketName) {
			errorEl.textContent = "必填：请输入市场名";
			errorEl.hidden = false;
			return;
		}
		if (capturedAt && !/^\d{4}-\d{2}-\d{2}$/.test(capturedAt)) {
			errorEl.textContent = "日期格式需为 YYYY-MM-DD";
			errorEl.hidden = false;
			return;
		}
		submitBtn.disabled = true;
		submitBtn.textContent = "导入中…";
		try {
			const result = await fetchApi("/api/import", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: state.path, marketName, source: state.source, capturedAt: capturedAt || undefined, runScreen: form.runScreen.checked }),
			});
			if (!isCurrent()) return;
			renderImportSuccess(content, result);
		} catch (error) {
			if (!isCurrent()) return;
			errorEl.textContent = error.message;
			errorEl.hidden = false;
			submitBtn.disabled = false;
			submitBtn.textContent = "导入并跑粗筛";
		}
	});
}

async function renderImportWizard(content, isCurrent) {
	refreshGlobalChrome(isCurrent);
	content.innerHTML = buildImportWizardHtml();
	if (!isCurrent()) return;
	const state = { path: "", source: "auto" };
	bindImportSourceTabs(content, state);
	bindImportSourceChips(content, state);
	bindImportSubmit(content, state, isCurrent);

	let filesData;
	try {
		filesData = await fetchApi("/api/import/files");
	} catch (error) {
		if (!isCurrent()) return;
		content.querySelector("#import-file-picker").innerHTML = `<div class="error-panel">文件列表加载失败：${escapeHtml(error.message)}</div>`;
		return;
	}
	if (!isCurrent()) return;
	const pickerEl = content.querySelector("#import-file-picker");
	if (!filesData.files.length) {
		pickerEl.innerHTML = `<div class="import-empty-slot">compass-imports/ 目录下暂无文件——请将 CSV 放入该目录后刷新，或切换到「手动输入路径」</div>`;
		return;
	}
	bindFilePicker(pickerEl, filesData.files, state);
}

// ── 路由 ──────────────────────────────────────────────────────

// 市场引用与候选引用都允许直接是市场名/候选 id（findMarket/findCandidate 双解析），
// 百分号编码非法时退回列表页而不是让路由中断
function decodeRouteParam(raw, fallbackRouteName) {
	try {
		return decodeURIComponent(raw);
	} catch {
		return { name: fallbackRouteName };
	}
}

function parseRoute(hash) {
	const normalized = hash && hash.startsWith("#/") ? hash : "#/overview";
	const marketMatch = /^#\/market\/(.+)$/.exec(normalized);
	if (marketMatch) {
		const decoded = decodeRouteParam(marketMatch[1], "overview");
		return typeof decoded === "string" ? { name: "market-dossier", param: decoded } : decoded;
	}
	const poolMatch = /^#\/pool\/(.+)$/.exec(normalized);
	if (poolMatch) {
		const decoded = decodeRouteParam(poolMatch[1], "pool");
		return typeof decoded === "string" ? { name: "pool", param: decoded } : decoded;
	}
	const name = normalized.slice(2) || "overview";
	if (TABS.some((tab) => tab.id === name)) return { name };
	if (name === "import") return { name: "import" };
	return { name: "overview" };
}

function tabIdForRoute(route) {
	if (route.name === "market-dossier") return "markets";
	if (route.name === "import") return null;
	return route.name;
}

// 路由世代计数：每次导航自增，异步渲染回来时先核对自己仍是最新一次导航再落笔，
// 否则快速切换 tab 时较慢的旧请求会在新页面渲染完之后把内容覆盖回去
let routeGeneration = 0;

const PAGE_RENDERERS = {
	overview: renderOverview,
	todos: renderTodos,
	markets: renderMarkets,
	"market-dossier": renderMarketDossier,
	pool: renderPool,
	budget: renderBudget,
	retro: renderRetro,
	import: renderImportWizard,
};

async function handleRoute() {
	const generation = ++routeGeneration;
	const isCurrent = () => generation === routeGeneration;

	const route = parseRoute(location.hash);
	setActiveTab(tabIdForRoute(route));
	const content = document.getElementById("content");
	content.innerHTML = `<div class="loading">加载中…</div>`;

	// parseRoute 的输出是闭合的 8 个名字，全部在 PAGE_RENDERERS 里有对应渲染器
	const renderer = PAGE_RENDERERS[route.name];
	await renderer(content, isCurrent, route.param);
}

window.addEventListener("hashchange", handleRoute);
window.addEventListener("DOMContentLoaded", () => {
	renderShell();
	handleRoute();
});

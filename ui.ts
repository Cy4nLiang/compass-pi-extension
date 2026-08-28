import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { budgetStatus, gateDefaultsLine, listRetroDue, listWorkbenchTodos } from "./service.ts";
import { todoResolutionBadge } from "./todo.ts";
import { CANDIDATE_STAGES, STAGE_LABELS, TODO_GROUP_LABELS, TODO_PRIORITIES, type CompassStore, type TodoPriority, type WorkbenchTodo } from "./types.ts";

const TAB_NAMES = ["总览", "待办", "市场", "候选池", "预算", "复盘"] as const;

function ageDays(date: string): number {
	return Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 86_400_000));
}

function padAnsi(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function compactDashboardSummary(store: CompassStore): string {
	const active = store.candidates.filter((candidate) => !["archived", "review"].includes(candidate.stage)).length;
	const review = store.candidates.filter((candidate) => candidate.gateOutcome === "review").length;
	const rejected = store.candidates.filter((candidate) => candidate.gateOutcome === "reject").length;
	const spent = budgetStatus(store).reduce((sum, pool) => sum + pool.spentCny, 0);
	// listWorkbenchTodos 内部会再算一次 budgetStatus/listRetroDue；<10³ 量级毫秒级双算，
	// 换取待办口径与待办页完全一致（Task 3 review F-3 备忘：接受双算并注明）
	const todos = listWorkbenchTodos(store);
	const due = todos.filter((todo) => todo.kind === "retro_due").length;
	const urgent = todos.filter((todo) => todo.priority === 1).length;
	const conclusive = store.outcomeChecks.filter((check) => check.verdict !== "inconclusive");
	const validationRate = conclusive.length ? `${(conclusive.filter((check) => check.verdict === "validated").length / conclusive.length * 100).toFixed(0)}%` : "—";
	// 已提交待 agent 验证的条目：运营看得见「球在会话侧」，避免提交后无声等待
	const pendingVerify = todos.filter((todo) => todo.resolution?.status === "submitted").length;
	return `${store.markets.length} 市场 · ${active} 活跃候选 · ${review} 待复核 · ${rejected} 否决 · ${due} 待复盘 · ${todos.length} 待办${urgent ? `（P1 ${urgent}）` : ""}${pendingVerify ? ` · 待验证 ${pendingVerify}` : ""} · 验证率 ${validationRate} · 本月 ¥${spent.toFixed(0)}`;
}

export class CompassDashboard {
	private readonly store: CompassStore;
	private readonly theme: Theme;
	private readonly onClose: () => void;
	// 打开工作台时推导一次，总览/待办/复盘页共用同一时刻的快照，避免跨日界切 tab 时页间计数漂移
	private readonly todos: WorkbenchTodo[];
	private readonly retroDue: ReturnType<typeof listRetroDue>;
	private tab = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(store: CompassStore, theme: Theme, onClose: () => void) {
		this.store = store;
		this.theme = theme;
		this.onClose = onClose;
		this.todos = listWorkbenchTodos(store);
		this.retroDue = listRetroDue(store);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.tab = (this.tab + 1) % TAB_NAMES.length;
			this.invalidate();
		} else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.tab = (this.tab - 1 + TAB_NAMES.length) % TAB_NAMES.length;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const renderWidth = Math.max(1, width);
		const lines: string[] = [];
		const th = this.theme;
		const add = (line = "") => lines.push(truncateToWidth(line, renderWidth));
		const border = th.fg("borderAccent", "─".repeat(renderWidth));

		add(border);
		add(` ${th.fg("accent", th.bold("罗盘 COMPASS"))}  ${th.fg("muted", "Amazon US 精铺选品工作台")}`);
		add(` ${TAB_NAMES.map((name, index) => index === this.tab ? th.bg("selectedBg", th.fg("text", ` ${name} `)) : th.fg("muted", ` ${name} `)).join(" ")}`);
		add(th.fg("borderMuted", "─".repeat(renderWidth)));

		if (this.tab === 0) this.renderOverview(add, renderWidth);
		else if (this.tab === 1) this.renderTodos(add);
		else if (this.tab === 2) this.renderMarkets(add, renderWidth);
		else if (this.tab === 3) this.renderPool(add, renderWidth);
		else if (this.tab === 4) this.renderBudget(add, renderWidth);
		else this.renderRetro(add);

		add("");
		for (const helpLine of wrapTextWithAnsi(th.fg("dim", " ←→ / Tab 切换 · Esc 关闭 · /compass-help 手册 · /compass-import 导入 · /compass-report 报告"), renderWidth)) {
			add(helpLine);
		}
		add(border);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private renderOverview(add: (line?: string) => void, width: number): void {
		const th = this.theme;
		const stageCounts = Object.fromEntries(CANDIDATE_STAGES.map((stage) => [stage, this.store.candidates.filter((candidate) => candidate.stage === stage).length]));
		const outcomes = {
			pass: this.store.candidates.filter((candidate) => candidate.gateOutcome === "pass").length,
			review: this.store.candidates.filter((candidate) => candidate.gateOutcome === "review").length,
			reject: this.store.candidates.filter((candidate) => candidate.gateOutcome === "reject").length,
		};
		const snapshots = [...this.store.snapshots].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
		const stale = this.store.markets.filter((market) => {
			const snapshot = snapshots.find((item) => item.marketId === market.id);
			return !snapshot || ageDays(snapshot.capturedAt) > 30;
		}).length;
		const budgets = budgetStatus(this.store);
		const spent = budgets.reduce((sum, pool) => sum + pool.spentCny, 0);
		const fused = budgets.filter((pool) => pool.state === "fused").length;

		add("");
		add(` ${th.fg("accent", th.bold("经营快照"))}`);
		add(` 市场 ${th.fg("text", String(this.store.markets.length))}  ·  候选 ${th.fg("text", String(this.store.candidates.length))}  ·  30天过期 ${stale ? th.fg("warning", String(stale)) : th.fg("success", "0")}  ·  本月数据成本 ${th.fg("text", `¥${spent.toFixed(2)}`)}`);
		add(` Gate  ${th.fg("success", `通过 ${outcomes.pass}`)}  /  ${th.fg("warning", `复核 ${outcomes.review}`)}  /  ${th.fg("error", `否决 ${outcomes.reject}`)}  ·  预算熔断 ${fused ? th.fg("error", String(fused)) : th.fg("success", "0")}`);
		add("");
		add(` ${th.fg("accent", th.bold("阶段流水线"))}`);
		const cellWidth = Math.max(9, Math.floor((width - 4) / 4));
		for (let index = 0; index < CANDIDATE_STAGES.length; index += 4) {
			const row = CANDIDATE_STAGES.slice(index, index + 4).map((stage) => {
				const count = stageCounts[stage] ?? 0;
				return padAnsi(`${STAGE_LABELS[stage]} ${th.fg(count ? "accent" : "dim", String(count))}`, cellWidth);
			});
			add(` ${row.join("│")}`);
		}
		add("");
		const todoCounts = TODO_PRIORITIES.map((priority) => this.todos.filter((todo) => todo.priority === priority).length);
		const todoParts = todoCounts.map((count, index) => {
			const priority = index + 1;
			const color = count === 0 ? "dim" : priority === 1 ? "error" : priority === 2 ? "warning" : "text";
			return th.fg(color, `P${priority} ${count}`);
		});
		add(` ${th.fg("accent", th.bold("待办"))} ${this.todos.length ? `${th.fg("text", String(this.todos.length))} 项：${todoParts.join(" · ")}` : th.fg("success", "0 项")}`);
		add("");
		add(` ${th.fg("muted", gateDefaultsLine(this.store))}`);
	}

	// 处理状态徽标（只读）：颜色按「谁的球」分——待办方 warning、被驳回 error、可勾选 success、未处理 dim
	private todoBadge(todo: WorkbenchTodo): string {
		const badge = todoResolutionBadge(todo);
		if (!badge) return "";
		const status = todo.resolution?.lapsed ? "lapsed" : todo.resolution?.status;
		const color = status === undefined ? "dim" : status === "rejected" ? "error" : status === "verified" ? "success" : "warning";
		return ` ${this.theme.fg(color, `[${badge}]`)}`;
	}

	// 行内第二行：闭环类按处理状态给出下一步（驳回理由须在 TUI 可见 —— spec §3.1 R2），
	// 其余保持派生的 suggestedAction；每条仍占 2 行，分组布局不变
	private todoNextStep(todo: WorkbenchTodo): string {
		const resolution = todo.resolution;
		if (!resolution) return todo.suggestedAction;
		if (resolution.lapsed) return `已处理后出现新事实并重新浮出：compass_todo action=reopen todo_id=${todo.id} 后重新提交`;
		// 理由在前、重提路径在后：窄终端只会截掉行尾的命令，驳回理由不会被吃掉
		if (resolution.status === "rejected") return `驳回：${resolution.verdictReason ?? "未留理由"} · 改好后重新提交：compass_todo action=submit todo_id=${todo.id}`;
		if (resolution.status === "submitted") return `待 agent 验证：在 pi 会话执行 compass_todo action=verify todo_id=${todo.id}`;
		if (resolution.status === "verified") return `验证通过：在 Web 待办页勾选「已处理」，或 compass_todo action=complete todo_id=${todo.id}`;
		if (resolution.status === "reopened") return "已重开：请重新提交处理结果（compass_todo action=submit）";
		return todo.suggestedAction;
	}

	private renderTodos(add: (line?: string) => void): void {
		const th = this.theme;
		const pendingVerify = this.todos.filter((todo) => todo.resolution?.status === "submitted").length;
		add("");
		add(` ${th.fg("accent", th.bold(`待办清单 · ${this.todos.length}`))}${pendingVerify ? `  ${th.fg("warning", `待验证 ${pendingVerify}`)}` : ""}  ${th.fg("muted", "多数事项解决即消失；闭环四类需提交→验证→勾选")}`);
		if (!this.todos.length) {
			add(` ${th.fg("success", "当前没有需要人工处理的事项")}`);
			return;
		}
		for (const priority of TODO_PRIORITIES) {
			const group = this.todos.filter((todo) => todo.priority === priority);
			if (!group.length) continue;
			const color = priority === 1 ? "error" : priority === 2 ? "warning" : "accent";
			add("");
			add(` ${th.fg(color, th.bold(`${TODO_GROUP_LABELS[priority]} (${group.length})`))}`);
			// spec §4.3：每组最多 6 物理行 = 3 条 × 每条 2 行（主行 + 建议动作行）
			for (const todo of group.slice(0, 3)) {
				const name = todo.marketName ?? todo.source ?? "—";
				add(`   ${th.fg(color, "●")} ${name} · ${todo.title}${this.todoBadge(todo)} · ${th.fg("muted", todo.reason)}${todo.overdueDays ? th.fg("dim", ` · 逾期${todo.overdueDays}天`) : ""}`);
				add(`     ${th.fg("dim", `→ ${this.todoNextStep(todo)}`)}`);
			}
			if (group.length > 3) add(`   ${th.fg("dim", `… +${group.length - 3}；compass_todo priority=${priority} 查看全部`)}`);
		}
	}

	private renderMarkets(add: (line?: string) => void, width: number): void {
		const th = this.theme;
		add("");
		add(` ${th.fg("accent", th.bold(`市场雷达 · ${this.store.markets.length}`))}`);
		if (!this.store.markets.length) {
			add(` ${th.fg("dim", "尚无市场。运行 /compass-import <csv> 开始。")}`);
			return;
		}
		const nameWidth = Math.max(18, Math.min(42, width - 42));
		add(` ${padAnsi(th.fg("muted", "市场"), nameWidth)} ${padAnsi(th.fg("muted", "Gate"), 8)} ${padAnsi(th.fg("muted", "Score"), 8)} ${th.fg("muted", "快照 / 来源")}`);
		for (const market of [...this.store.markets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20)) {
			const snapshot = this.store.snapshots.filter((item) => item.marketId === market.id).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
			const candidate = this.store.candidates.find((item) => item.marketId === market.id);
			const outcome = candidate?.gateOutcome;
			const gate = outcome === "pass" ? th.fg("success", "PASS") : outcome === "reject" ? th.fg("error", "REJECT") : outcome === "review" ? th.fg("warning", "REVIEW") : th.fg("dim", "—");
			const score = candidate?.score === undefined ? "—" : candidate.score.toFixed(1);
			const snapshotText = snapshot ? `${ageDays(snapshot.capturedAt)}d · ${snapshot.source}` : "无快照";
			add(` ${padAnsi(market.name, nameWidth)} ${padAnsi(gate, 8)} ${padAnsi(score, 8)} ${snapshotText}`);
		}
		if (this.store.markets.length > 20) add(` ${th.fg("dim", `… 另有 ${this.store.markets.length - 20} 个市场，可用 compass_market_scan 查询`)}`);
	}

	private renderPool(add: (line?: string) => void, _width: number): void {
		const th = this.theme;
		add("");
		add(` ${th.fg("accent", th.bold("候选池 · 阶段流转"))}`);
		for (const stage of CANDIDATE_STAGES) {
			const candidates = this.store.candidates.filter((candidate) => candidate.stage === stage);
			const color = stage === "archived" ? "dim" : candidates.length ? "accent" : "muted";
			add(` ${th.fg(color, `${STAGE_LABELS[stage]} (${candidates.length})`)}`);
			for (const candidate of candidates.slice(0, 4)) {
				const market = this.store.markets.find((item) => item.id === candidate.marketId);
				const badge = candidate.gateOutcome === "pass" ? th.fg("success", "✓") : candidate.gateOutcome === "reject" ? th.fg("error", "×") : candidate.gateOutcome === "review" ? th.fg("warning", "?") : th.fg("dim", "·");
				const decision = candidate.decisionStatus ? th.fg(candidate.decisionStatus === "go" ? "success" : candidate.decisionStatus === "no_go" ? "error" : "warning", ` · ${candidate.decisionStatus}`) : "";
				add(`   ${badge} ${market?.name ?? candidate.marketId}${candidate.score === undefined ? "" : th.fg("dim", ` · ${candidate.score.toFixed(1)}`)}${decision}`);
			}
			if (candidates.length > 4) add(`   ${th.fg("dim", `… +${candidates.length - 4}`)}`);
		}
	}

	private renderRetro(add: (line?: string) => void): void {
		const th = this.theme;
		const due = this.retroDue;
		const checks = [...this.store.outcomeChecks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const activeLessons = this.store.lessons.filter((lesson) => lesson.status === "active");
		add("");
		add(` ${th.fg("accent", th.bold(`复盘闭环 · ${due.length} 到期`))}`);
		add(` OutcomeCheck ${checks.length}  ·  ${th.fg("success", `validated ${checks.filter((check) => check.verdict === "validated").length}`)}  /  ${th.fg("warning", `challenged ${checks.filter((check) => check.verdict === "challenged").length}`)}  /  ${th.fg("muted", `inconclusive ${checks.filter((check) => check.verdict === "inconclusive").length}`)}  ·  active lessons ${activeLessons.length}`);
		add("");
		add(` ${th.fg("accent", th.bold("到期队列"))}`);
		if (!due.length) add(` ${th.fg("success", "当前没有逾期复盘对象")}`);
		for (const item of due.slice(0, 10)) add(` ${th.fg(item.overdueDays > 30 ? "error" : "warning", `${item.group} · ${item.marketName} · +${item.overdueDays}d`)}  ${th.fg("dim", item.suggestedAction)}`);
		if (due.length > 10) add(` ${th.fg("dim", `… +${due.length - 10}；/compass-retro 查看全部`)}`);
		add("");
		add(` ${th.fg("accent", th.bold("最近对照"))}`);
		for (const check of checks.slice(0, 6)) {
			const market = this.store.markets.find((item) => item.id === check.marketId);
			const color = check.verdict === "validated" ? "success" : check.verdict === "challenged" ? "warning" : "muted";
			add(` ${th.fg(color, check.verdict)} · ${market?.name ?? check.marketId} · ${check.id} · ${check.createdAt.slice(0, 10)}`);
		}
		if (!checks.length) add(` ${th.fg("dim", "尚无复盘对照；使用 /compass-retro 开始。")}`);
	}

	private renderBudget(add: (line?: string) => void, width: number): void {
		const th = this.theme;
		const pools = budgetStatus(this.store);
		add("");
		add(` ${th.fg("accent", th.bold("数据源与预算 · 当月"))}`);
		const sourceWidth = Math.max(14, Math.min(24, width - 50));
		add(` ${padAnsi(th.fg("muted", "数据源"), sourceWidth)} ${padAnsi(th.fg("muted", "档位"), 6)} ${padAnsi(th.fg("muted", "已用/上限"), 16)} ${padAnsi(th.fg("muted", "调用"), 12)} ${th.fg("muted", "状态")}`);
		for (const pool of pools) {
			const state = pool.state === "fused" ? th.fg("error", "熔断") : pool.state === "warning" ? th.fg("warning", "80%告警") : pool.state === "free" ? th.fg("success", "免费") : th.fg("success", "正常");
			const usage = pool.monthlyLimitCny > 0 ? `¥${pool.spentCny.toFixed(0)} / ¥${pool.monthlyLimitCny.toFixed(0)}` : `¥${pool.spentCny.toFixed(0)} / 免费`;
			// 统一显示当月次数（0 次起），与 compass_budget status 的 calls=n 口径一致，
			// 避免「计量在工作但没调用」与「不计量」在 TUI 上不可区分
			const calls = `${pool.callCount}${pool.monthlyCallLimit !== undefined ? `/${pool.monthlyCallLimit}` : ""} 次`;
			add(` ${padAnsi(pool.source, sourceWidth)} ${padAnsi(pool.tier, 6)} ${padAnsi(usage, 16)} ${padAnsi(calls, 12)} ${state}${pool.enabled ? "" : th.fg("dim", " · 禁用")}`);
		}
		const attributed = this.store.costEvents.filter((event) => event.marketId).reduce((sum, event) => sum + event.amountCny, 0);
		const total = this.store.costEvents.reduce((sum, event) => sum + event.amountCny, 0);
		add("");
		add(` ${th.fg("muted", `累计成本 ¥${total.toFixed(2)} · 可归因到市场 ¥${attributed.toFixed(2)} · 归因率 ${total > 0 ? ((attributed / total) * 100).toFixed(0) : "100"}%`)}`);
	}
}

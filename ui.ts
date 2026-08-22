import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { budgetStatus } from "./service.ts";
import { CANDIDATE_STAGES, type CompassStore } from "./types.ts";

const TAB_NAMES = ["总览", "市场", "候选池", "预算"] as const;
const STAGE_LABELS: Record<string, string> = {
	lead: "线索",
	screen: "粗筛",
	deep_research: "深研",
	risk: "风控",
	decision: "决策",
	testing: "测品",
	review: "复盘",
	archived: "归档",
};

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
	return `${store.markets.length} 市场 · ${active} 活跃候选 · ${review} 待复核 · ${rejected} 否决 · 本月 ¥${spent.toFixed(0)}`;
}

export class CompassDashboard {
	private readonly store: CompassStore;
	private readonly theme: Theme;
	private readonly onClose: () => void;
	private tab = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(store: CompassStore, theme: Theme, onClose: () => void) {
		this.store = store;
		this.theme = theme;
		this.onClose = onClose;
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
		else if (this.tab === 1) this.renderMarkets(add, renderWidth);
		else if (this.tab === 2) this.renderPool(add, renderWidth);
		else this.renderBudget(add, renderWidth);

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
		add(` ${th.fg("muted", "默认 Gate：QRD(300)≥20 · 新品占比≥15% · 毛利≥40% · CPC承受度≤0.60 · 风险非红")}`);
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
				add(`   ${badge} ${market?.name ?? candidate.marketId}${candidate.score === undefined ? "" : th.fg("dim", ` · ${candidate.score.toFixed(1)}`)}`);
			}
			if (candidates.length > 4) add(`   ${th.fg("dim", `… +${candidates.length - 4}`)}`);
		}
	}

	private renderBudget(add: (line?: string) => void, width: number): void {
		const th = this.theme;
		const pools = budgetStatus(this.store);
		add("");
		add(` ${th.fg("accent", th.bold("数据源与预算 · 当月"))}`);
		const sourceWidth = Math.max(16, Math.min(28, width - 38));
		add(` ${padAnsi(th.fg("muted", "数据源"), sourceWidth)} ${padAnsi(th.fg("muted", "档位"), 6)} ${padAnsi(th.fg("muted", "已用/上限"), 18)} ${th.fg("muted", "状态")}`);
		for (const pool of pools) {
			const state = pool.state === "fused" ? th.fg("error", "熔断") : pool.state === "warning" ? th.fg("warning", "80%告警") : pool.state === "free" ? th.fg("success", "免费") : th.fg("success", "正常");
			const usage = pool.monthlyLimitCny > 0 ? `¥${pool.spentCny.toFixed(0)} / ¥${pool.monthlyLimitCny.toFixed(0)}` : `¥${pool.spentCny.toFixed(0)} / 免费`;
			add(` ${padAnsi(pool.source, sourceWidth)} ${padAnsi(pool.tier, 6)} ${padAnsi(usage, 18)} ${state}${pool.enabled ? "" : th.fg("dim", " · 禁用")}`);
		}
		const attributed = this.store.costEvents.filter((event) => event.marketId).reduce((sum, event) => sum + event.amountCny, 0);
		const total = this.store.costEvents.reduce((sum, event) => sum + event.amountCny, 0);
		add("");
		add(` ${th.fg("muted", `累计成本 ¥${total.toFixed(2)} · 可归因到市场 ¥${attributed.toFixed(2)} · 归因率 ${total > 0 ? ((attributed / total) * 100).toFixed(0) : "100"}%`)}`);
	}
}

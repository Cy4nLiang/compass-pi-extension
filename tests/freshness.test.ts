import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarketCsv } from "../csv.ts";
import {
	FRESHNESS_LABELS,
	FRESHNESS_SHORT_LABELS,
	SNAPSHOT_FRESHNESS_DAYS,
	snapshotFreshness,
	snapshotNeedsRefresh,
	snapshotTtlDays,
	type SnapshotFreshness,
} from "../defaults.ts";
import { ensureDefaults, generateMarketReport, importMarketAndScreen } from "../service.ts";
import { createEmptyStore } from "../store.ts";
import { marketsData } from "../web/data.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;

// 三档阈值的边界口径：含端点（恰好 7 天仍是深研新鲜、恰好 30 天仍够粗筛）
test("snapshotFreshness 三档边界含端点，无快照单独成档", () => {
	const table: Array<[number | null, SnapshotFreshness]> = [
		[0, "deep_fresh"],
		[1, "deep_fresh"],
		[6, "deep_fresh"],
		[7, "deep_fresh"],
		[8, "screen_only"],
		[29, "screen_only"],
		[30, "screen_only"],
		[31, "stale"],
		[null, "missing"],
	];
	for (const [age, tier] of table) assert.equal(snapshotFreshness(age), tier, `ageDays=${age}`);
});

test("三档阈值常量与两套文案同源，改常量文案跟着走", () => {
	assert.deepEqual(SNAPSHOT_FRESHNESS_DAYS, { deepResearch: 7, screen: 30, testing: 1 });
	assert.deepEqual(FRESHNESS_LABELS, {
		deep_fresh: "深研新鲜（≤7天）",
		screen_only: "仅适合粗筛（≤30天）",
		stale: "已过期（>30天）",
		missing: "无快照",
	});
	assert.deepEqual(FRESHNESS_SHORT_LABELS, {
		deep_fresh: "深研新鲜",
		screen_only: "仅适合粗筛",
		stale: "已过期，建议补数",
		missing: "无快照",
	});
});

test("snapshotNeedsRefresh 把「过期」与「无快照」并成一类，粗筛档不算", () => {
	assert.equal(snapshotNeedsRefresh(7), false);
	assert.equal(snapshotNeedsRefresh(30), false);
	assert.equal(snapshotNeedsRefresh(31), true);
	assert.equal(snapshotNeedsRefresh(null), true);
});

test("snapshotTtlDays 把五个漏斗阶段映到三档，不额外引入第四档", () => {
	assert.equal(snapshotTtlDays("lead"), 30);
	assert.equal(snapshotTtlDays("screen"), 30);
	assert.equal(snapshotTtlDays("deep_research"), 7);
	assert.equal(snapshotTtlDays("risk"), 7);
	assert.equal(snapshotTtlDays("testing"), 1);
	assert.deepEqual(
		[...new Set(["lead", "screen", "deep_research", "risk", "testing"].map((stage) => snapshotTtlDays(stage as never)))].sort((a, b) => a - b),
		[1, 7, 30],
	);
});

// M76「新鲜度文案」那一组的交叉断言：同一快照在 Web 市场列表与五维报告里必须落同一档
test("同一快照在 Web 列表与五维报告落同一档", async () => {
	const csv = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	for (const [ageDays, tier] of [[6, "deep_fresh"], [8, "screen_only"], [31, "stale"]] as const) {
		const now = new Date().toISOString();
		const capturedAt = new Date(Date.parse(now) - ageDays * DAY).toISOString();
		const store = createEmptyStore("2026-01-01T00:00:00.000Z");
		ensureDefaults(store, "test");
		const parsed = parseMarketCsv(csv, { source: "sellersprite", capturedAt });
		importMarketAndScreen(store, { marketName: "m1", parsed, capturedAt, actor: "tester", runScreen: true });

		const row = marketsData(store, now).rows[0];
		assert.equal(row?.freshness, tier, `${ageDays} 天应落 ${tier}`);
		assert.equal(row?.freshnessLabel, FRESHNESS_LABELS[tier]);

		const line = generateMarketReport(store, "m1").markdown.split("\n").find((item) => item.startsWith("> 数据快照："));
		assert.ok(line, "报告应有快照行");
		assert.match(line, new RegExp(`（${ageDays} 天前，${FRESHNESS_SHORT_LABELS[tier]}）`, "u"));
	}
});

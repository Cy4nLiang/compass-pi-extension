import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarketCsv } from "../csv.ts";
import { DEFAULT_STRATEGY_YAML } from "../defaults.ts";
import { calculateMarketMetrics } from "../metrics.ts";
import { evaluateExpression, evaluateStrategy, parseStrategyYaml } from "../strategy.ts";

const here = dirname(fileURLToPath(import.meta.url));

async function context() {
	const text = await readFile(join(here, "../examples/demo-market.csv"), "utf8");
	const parsed = parseMarketCsv(text, { source: "sellersprite", capturedAt: "2026-08-22T00:00:00.000Z" });
	return {
		listings: parsed.listings,
		metrics: calculateMarketMetrics({
			listings: parsed.listings,
			keywords: parsed.keywords,
			source: parsed.source,
			capturedAt: "2026-08-22T00:00:00.000Z",
			targetMonthlyUnits: 300,
		}),
	};
}

test("safe expression evaluator supports GSE DSL without eval", async () => {
	const ctx = await context();
	const result = evaluateExpression("qualify_rank_depth(300) >= 20 && (cr3 < 0.60 || amz_share < 0.10)", ctx);
	assert.equal(result.missing, false);
	assert.equal(result.value, true);
	assert.ok(result.references.has("qualify_rank_depth"));
	assert.ok(result.references.has("cr3"));
});

test("default market screen passes demo and veto wins when red sea condition is true", async () => {
	const strategy = parseStrategyYaml(DEFAULT_STRATEGY_YAML);
	const ctx = await context();
	const pass = evaluateStrategy(strategy, ctx, "screen");
	assert.equal(pass.outcome, "pass");

	ctx.metrics.amz_share = { ...ctx.metrics.amz_share, value: 0.4 };
	ctx.metrics.cr3 = { ...ctx.metrics.cr3, value: 0.7 };
	const reject = evaluateStrategy(strategy, ctx, "screen");
	assert.equal(reject.outcome, "reject");
	assert.equal(reject.rules.find((rule) => rule.id === "red_sea_veto")?.status, "veto");
});

test("missing required evidence is review rather than a fabricated pass", () => {
	const strategy = parseStrategyYaml(DEFAULT_STRATEGY_YAML);
	const result = evaluateStrategy(strategy, { metrics: {}, listings: [] }, "full");
	assert.equal(result.outcome, "review");
	assert.ok(result.rules.some((rule) => rule.status === "missing"));
	assert.ok(result.missingMetrics.includes("gross_margin"));
});

test("unsafe or unsupported expression syntax is rejected", () => {
	assert.throws(
		() => parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("gross_margin >= 0.40", "process.exit(1)")),
		/不支持的策略函数/,
	);
	assert.throws(
		() => parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace('when: "gross_margin >= 0.40"', `when: 'cr3 > "abc"'`)),
		/两侧必须为数字/,
	);
	assert.throws(
		() => parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("display_name: 精铺 · 日均10单", "display_name: 2024")),
		/display_name 必须是字符串/,
	);
	const emptyDisplay = parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("display_name: 精铺 · 日均10单", 'display_name: ""'));
	assert.equal(emptyDisplay.meta.display_name, undefined);
});

test("strategy QRD function uses the same Top100 scope as the metric", () => {
	const listings = Array.from({ length: 150 }, (_, index) => ({
		rank: index + 1,
		monthlySales: index < 15 || (index >= 100 && index < 110) ? 300 : 0,
		sourceRow: index + 2,
	}));
	const metrics = calculateMarketMetrics({ listings, keywords: [], source: "generic_csv", capturedAt: "2026-08-22T00:00:00.000Z", targetMonthlyUnits: 300 });
	const result = evaluateExpression("qualify_rank_depth(300)", { listings, metrics });
	assert.equal(metrics.qualify_rank_depth.value, 15);
	assert.equal(result.value, 15);
	assert.equal(evaluateExpression("qualify_rank_depth(300) >= 20", { listings, metrics }).value, false);
});

test("screen with no market_screen rules is review rather than pass", () => {
	const strategy = parseStrategyYaml(`
meta:
  name: custom
  display_name: 自定义
stages:
  - stage: screening
    rules: []
scoring:
  weights:
    demand: 1
`);
	const result = evaluateStrategy(strategy, { metrics: {}, listings: [] }, "screen");
	assert.equal(result.outcome, "review");
	assert.equal(result.rules[0].status, "missing");
});

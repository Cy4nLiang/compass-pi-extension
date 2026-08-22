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
});

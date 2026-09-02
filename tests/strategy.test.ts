import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarketCsv } from "../csv.ts";
import { DEFAULT_STRATEGY_ID, DEFAULT_STRATEGY_YAML } from "../defaults.ts";
import { estimateProfit, normalizeProfitInput, profitMetrics } from "../economics.ts";
import { calculateMarketMetrics } from "../metrics.ts";
import { evaluateExpression, evaluateStrategy, parseStrategyYaml, slugify, strategyTargetDailyUnits, strategyTargetMonthlyUnits } from "../strategy.ts";
import type { StrategyContext } from "../strategy.ts";
import type { MetricEvidence, MetricMap, MetricScalar } from "../types.ts";

const here = dirname(fileURLToPath(import.meta.url));

// 稀疏自营列构造器（与 csv-metrics.test.ts 里的同名 helper 保持一致）：
// 只有前 marked 行填了自营标记，其余留空；withSeller 时另给一列卖家名走逐行回退。
// 数据保持虚构（B0DEMO 前缀 ASIN、虚构品牌）。
function sparseAmazonCsv(options: { rows: number; marked: number; mark?: string; withSeller?: boolean }): string {
	const mark = options.mark ?? "是";
	const header = ["排名", "ASIN", "品牌", "月销量", "上架月数", "亚马逊自营"];
	if (options.withSeller) header.push("卖家");
	const lines = [header.join(",")];
	for (let rank = 1; rank <= options.rows; rank++) {
		const flagged = rank <= options.marked;
		const row = [
			String(rank),
			`B0DEMO${String(rank).padStart(4, "0")}`,
			`Brand${(rank % 3) + 1}`,
			String(1000 - rank * 10),
			rank <= Math.ceil(options.rows * 0.3) ? "6" : "30",
			flagged ? mark : "",
		];
		if (options.withSeller) row.push(flagged ? "Amazon.com" : `Seller ${rank}`);
		lines.push(row.join(","));
	}
	return lines.join("\n") + "\n";
}

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


// —— 审计 M10 回归 ——
test("整列占位文本的上架月龄让粗筛落到 review，而不是伪装成 pass", () => {
	const lines = ["ASIN,标题,排名,价格,评分,评论数,月销量,品牌,卖家,上架月数"];
	const placeholders = ["暂无", "未知", "待定", "?", "NaN", "TBD", "None", "--"];
	for (let i = 1; i <= 50; i++) {
		lines.push(
			`B0DEMO${String(i).padStart(4, "0")},商品${i},${i},19.99,4.4,${100 + i},${400 + i},品牌${i % 7},第三方卖家,${placeholders[i % placeholders.length]}`,
		);
	}
	const capturedAt = "2026-08-22T00:00:00.000Z";
	const parsed = parseMarketCsv(`${lines.join("\n")}\n`, { source: "generic_csv", capturedAt });
	const metrics = calculateMarketMetrics({
		listings: parsed.listings,
		keywords: parsed.keywords,
		source: parsed.source,
		capturedAt,
		targetMonthlyUnits: 300,
	});
	assert.equal(metrics.new_listing_share_12m.value, null);
	assert.equal(metrics.new_listing_share_12m.sampleSize, 0);
	assert.equal(metrics.new_listing_share_12m.confidence, 0);

	const evaluation = evaluateStrategy(
		parseStrategyYaml(DEFAULT_STRATEGY_YAML),
		{ metrics, listings: parsed.listings, targetMonthlyUnits: 300 },
		"screen",
	);
	assert.equal(evaluation.outcome, "review");
	assert.deepEqual(evaluation.missingMetrics, ["new_listing_share_12m"]);
	assert.equal(evaluation.rules.find((rule) => rule.id === "high_activity_entry")?.status, "missing");
});


// —— 审计 M196 回归 ——
// 这是本缺陷的核心断言：同一批数据 cr3=1.0（>0.60），修前 amz_share 被伪造成 1.0 直接凑齐
// 「AMZ>30% 且 CR3>60%」触发 veto → outcome=reject；修后 amz_share 缺失 → 规则转 missing → review。
// 需要在文件顶部另加一个本地构造器（与 csv-metrics.test.ts 的同名 helper 内容一致，或抽到共享位置）。
test("稀疏自营列的红海 veto 转为 missing 而不是一票否决", () => {
	const strategy = parseStrategyYaml(DEFAULT_STRATEGY_YAML);
	const csv = sparseAmazonCsv({ rows: 20, marked: 3 });
	const parsed = parseMarketCsv(csv, { source: "generic_csv", capturedAt: "2026-09-01T00:00:00.000Z" });
	const metrics = calculateMarketMetrics({
		listings: parsed.listings,
		keywords: parsed.keywords,
		source: parsed.source,
		capturedAt: "2026-09-01T00:00:00.000Z",
		targetMonthlyUnits: 300,
	});
	assert.equal(metrics.cr3.value, 1);
	const result = evaluateStrategy(strategy, { metrics, listings: parsed.listings, targetMonthlyUnits: 300 }, "screen");
	assert.equal(result.rules.find((rule) => rule.id === "red_sea_veto")?.status, "missing");
	assert.equal(result.outcome, "review");
	assert.deepEqual(result.missingMetrics, ["amz_share"]);
});


// —— 审计 M21 回归 ——
test("CPC 为 0 时两条 CPC Gate 转 missing，不得无声通过", () => {
	const strategy = parseStrategyYaml(DEFAULT_STRATEGY_YAML);
	const input = normalizeProfitInput({
		salePrice: 25.99,
		purchaseCost: 3.5,
		firstMileCost: 0.9,
		fbaFee: 5.2,
		referralRate: 0.15,
		cvr: 0.12,
		cpc: 0,
	});
	const result = estimateProfit(input);
	const evaluation = evaluateStrategy(
		strategy,
		{ metrics: profitMetrics(input, result, "2026-08-22T00:00:00.000Z"), listings: [] },
		"full",
	);
	assert.equal(evaluation.rules.find((rule) => rule.id === "cpc_hard_ceiling")?.status, "missing");
	assert.equal(evaluation.rules.find((rule) => rule.id === "cpc_affordability")?.status, "missing");
	assert.ok(evaluation.missingMetrics.includes("cpc_ratio"));
	assert.notEqual(evaluation.outcome, "pass");
});


// —— 审计 M105 回归：DSL 三值逻辑（missing 沿 ||/&& 传播）——
// 语义是 Kleene 强三值逻辑，不是「missing 当 false」也不是「沾到 missing 就整体 missing」：
// `||` 只有在某一侧**确定为真**时才敢给 true，`&&` 只有在某一侧**确定为假**时才敢给 false，
// 其余组合一律把 missing 往上传播，最终落到 evaluateStrategy 的 status="missing" → review。
// 无论取值走哪条分支，references 都收全两侧，missingMetrics 才不会漏记缺失指标。
function m105Evidence(value: MetricScalar): MetricEvidence {
	return { value, source: "manual_csv", capturedAt: "2026-09-01T00:00:00.000Z", confidence: 0.7, sampleSize: 1 };
}

// present=1 → `present > 0` 恒真、`present < 0` 恒假；blank 存在但 value=null（metrics.ts 判缺失的实际形态）；
// absent_a / absent_b 整条不在 metrics 里（CSV 缺列的形态）。
const M105_CONTEXT: StrategyContext = {
	metrics: { present: m105Evidence(1), blank: m105Evidence(null) },
	listings: [],
};
const M105_T = "present > 0";
const M105_F = "present < 0";
const M105_M = "absent_a > 0";
const M105_M2 = "absent_b > 0";
const M105_NULL = "blank > 0";

// —— 审计 M105 回归 ——
test("三值逻辑真值表：missing 沿 || 与 && 传播，两侧引用始终收全", () => {
	const cases: Array<{ label: string; expr: string; value: unknown; missing: boolean; references: string[] }> = [
		// —— || ——
		{ label: "missing || true", expr: `${M105_M} || ${M105_T}`, value: true, missing: false, references: ["absent_a", "present"] },
		{ label: "missing || false", expr: `${M105_M} || ${M105_F}`, value: undefined, missing: true, references: ["absent_a", "present"] },
		{ label: "true || missing", expr: `${M105_T} || ${M105_M}`, value: true, missing: false, references: ["absent_a", "present"] },
		{ label: "false || missing", expr: `${M105_F} || ${M105_M}`, value: undefined, missing: true, references: ["absent_a", "present"] },
		{ label: "missing || missing", expr: `${M105_M} || ${M105_M2}`, value: undefined, missing: true, references: ["absent_a", "absent_b"] },
		// —— && ——
		{ label: "missing && true", expr: `${M105_M} && ${M105_T}`, value: undefined, missing: true, references: ["absent_a", "present"] },
		{ label: "missing && false", expr: `${M105_M} && ${M105_F}`, value: false, missing: false, references: ["absent_a", "present"] },
		{ label: "true && missing", expr: `${M105_T} && ${M105_M}`, value: undefined, missing: true, references: ["absent_a", "present"] },
		{ label: "false && missing", expr: `${M105_F} && ${M105_M}`, value: false, missing: false, references: ["absent_a", "present"] },
		{ label: "missing && missing", expr: `${M105_M} && ${M105_M2}`, value: undefined, missing: true, references: ["absent_a", "absent_b"] },
		// —— value=null 与整条缺列同权 ——
		{ label: "null || true", expr: `${M105_NULL} || ${M105_T}`, value: true, missing: false, references: ["blank", "present"] },
		{ label: "null || false", expr: `${M105_NULL} || ${M105_F}`, value: undefined, missing: true, references: ["blank", "present"] },
		{ label: "null && false", expr: `${M105_NULL} && ${M105_F}`, value: false, missing: false, references: ["blank", "present"] },
		{ label: "null && true", expr: `${M105_NULL} && ${M105_T}`, value: undefined, missing: true, references: ["blank", "present"] },
		// —— 取反与嵌套：missing 不会被 ! 折成 true/false ——
		{ label: "!missing", expr: `!(${M105_M})`, value: undefined, missing: true, references: ["absent_a"] },
		{ label: "!true", expr: `!(${M105_T})`, value: false, missing: false, references: ["present"] },
		{ label: "(missing || false) && true", expr: `(${M105_M} || ${M105_F}) && ${M105_T}`, value: undefined, missing: true, references: ["absent_a", "present"] },
		{ label: "(missing && false) || false", expr: `(${M105_M} && ${M105_F}) || ${M105_F}`, value: false, missing: false, references: ["absent_a", "present"] },
		// —— 无 missing 参与时退化成普通布尔 ——
		{ label: "true || false", expr: `${M105_T} || ${M105_F}`, value: true, missing: false, references: ["present"] },
		{ label: "false || false", expr: `${M105_F} || ${M105_F}`, value: false, missing: false, references: ["present"] },
		{ label: "true && true", expr: `${M105_T} && ${M105_T}`, value: true, missing: false, references: ["present"] },
		{ label: "true && false", expr: `${M105_T} && ${M105_F}`, value: false, missing: false, references: ["present"] },
	];
	for (const item of cases) {
		const result = evaluateExpression(item.expr, M105_CONTEXT);
		assert.deepEqual(
			{ value: result.value, missing: result.missing, references: [...result.references].sort() },
			{ value: item.value, missing: item.missing, references: item.references },
			`三值逻辑用例「${item.label}」（${item.expr}）与预期不符`,
		);
	}
});


// —— 审计 M105 回归 ——
test("|| 规则缺一侧仍可判定：另一侧为真给 pass，另一侧为假才转 missing", () => {
	const strategy = parseStrategyYaml(`
meta:
  name: m105-or-probe
stages:
  - stage: market_screen
    rules:
      - id: or_gate
        when: "cr3 < 0.60 || amz_share < 0.10"
        action: require
        label: 集中度或自营占比至少一项达标
scoring:
  weights:
    competition: 1
`);
	// amz_share 整条缺失，但 cr3 已确定达标 → 不必等缺失指标补齐就能放行。
	const decided = evaluateStrategy(strategy, { metrics: { cr3: m105Evidence(0.5) }, listings: [] }, "screen");
	assert.equal(decided.rules[0].status, "pass");
	assert.equal(decided.outcome, "pass");
	// 取值虽已确定，缺失指标仍照实登记，报告与待办不会漏掉「amz_share 没有数据」。
	assert.deepEqual(decided.missingMetrics, ["amz_share"]);
	assert.deepEqual(decided.rules[0].references, ["cr3", "amz_share"]);

	// cr3 不达标 → 结论取决于缺失的 amz_share → 只能转人工复核，绝不能伪装成 fail 或 pass。
	const undecided = evaluateStrategy(strategy, { metrics: { cr3: m105Evidence(0.8) }, listings: [] }, "screen");
	assert.equal(undecided.rules[0].status, "missing");
	assert.equal(undecided.rules[0].condition, null);
	assert.equal(undecided.outcome, "review");
	assert.deepEqual(undecided.missingMetrics, ["amz_share"]);
});


// —— 审计 M105 回归 ——
test("默认策略 red_sea_veto 的 && 缺一侧：另一侧确定为假时不误判红海", () => {
	const strategy = parseStrategyYaml(DEFAULT_STRATEGY_YAML);
	// 20 个坑位月销均达标，新品占比达标，cr3 确定为 0.5（不红海），amz_share 整条缺失。
	const listings = Array.from({ length: 25 }, (_, index) => ({ rank: index + 1, monthlySales: 500, sourceRow: index + 2 }));
	const metrics = {
		cr3: m105Evidence(0.5),
		new_listing_share_12m: m105Evidence(0.4),
		qualify_rank_depth: m105Evidence(25),
	};
	const result = evaluateStrategy(strategy, { metrics, listings, targetMonthlyUnits: 300 }, "screen");
	assert.equal(result.rules.find((rule) => rule.id === "red_sea_veto")?.status, "pass");
	assert.equal(result.outcome, "pass");
	assert.deepEqual(result.missingMetrics, ["amz_share"]);
});

// —— 审计 M3/M16/M8 回归 ——
// —— 审计 M3 / M16 回归 ——
test("策略 meta 的数值口径字段写了就必须是有限正数", () => {
	const bad: Array<[string, string, RegExp]> = [
		["monthly_units_q: 300", "monthly_units_q: 3OO", /策略 meta\.monthly_units_q 必须是有限正数，实际为 "3OO"/],
		["monthly_units_q: 300", "monthly_units_q: 300个", /策略 meta\.monthly_units_q 必须是有限正数，实际为 "300个"/],
		["monthly_units_q: 300", 'monthly_units_q: "500"', /策略 meta\.monthly_units_q 必须是有限正数，实际为 "500"/],
		["monthly_units_q: 300", "monthly_units_q: -5", /策略 meta\.monthly_units_q 必须是有限正数，实际为 -5/],
		["monthly_units_q: 300", "monthly_units_q: 0", /策略 meta\.monthly_units_q 必须是有限正数，实际为 0/],
		["monthly_units_q: 300", "monthly_units_q:", /策略 meta\.monthly_units_q 必须是有限正数，实际为 null/],
		["target_daily_units: 10", "target_daily_units: abc", /策略 meta\.target_daily_units 必须是有限正数/],
		// 天数字段的文案与口径不同：它们要求**正整数**（下游按整天计算）
		["retro_go_days: 30", "retro_go_days: -1", /策略 meta\.retro_go_days 必须是正整数天数/],
		["retro_review_days: 30", "retro_review_days: 0", /策略 meta\.retro_review_days 必须是正整数天数/],
		// R16：小数从前能通过校验，再被 history.ts 的 Math.floor 压成 0 天——
		// retro_due 于是恒为到期、录了实绩也清不掉，且全程没有任何报错。
		["retro_go_days: 30", "retro_go_days: 0.5", /策略 meta\.retro_go_days 必须是正整数天数.*实际为 0\.5/],
		["retro_waitlist_days: 45", "retro_waitlist_days: 7.5", /策略 meta\.retro_waitlist_days 必须是正整数天数/],
	];
	for (const [from, to, pattern] of bad) {
		assert.throws(() => parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace(from, to)), pattern, `${to} 应当在解析期被拒绝`);
	}
	// 整条不写才回落缺省口径
	assert.equal(parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("  monthly_units_q: 300\n", "")).meta.monthly_units_q, undefined);
	assert.equal(parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("monthly_units_q: 300", "monthly_units_q: 500")).meta.monthly_units_q, 500);
});


// —— 审计 M3/M16/M8 回归 ——
test("strategyTargetMonthlyUnits 是月销门槛的唯一口径，脏 definition 也回落 300", () => {
	assert.equal(strategyTargetMonthlyUnits(parseStrategyYaml(DEFAULT_STRATEGY_YAML)), 300);
	assert.equal(strategyTargetMonthlyUnits(parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("monthly_units_q: 300", "monthly_units_q: 500"))), 500);
	assert.equal(strategyTargetMonthlyUnits(undefined), 300);
	// 存量 store 的 definition 不重新走 parseStrategyYaml，读取口径必须自己兜住历史脏值
	const base = parseStrategyYaml(DEFAULT_STRATEGY_YAML);
	for (const dirty of ["300个", "500", -5, 0, null, undefined, Number.NaN]) {
		const definition = { ...base, meta: { ...base.meta, monthly_units_q: dirty as unknown as number } };
		assert.equal(strategyTargetMonthlyUnits(definition), 300, `脏值 ${JSON.stringify(dirty)} 应回落 300`);
	}
	assert.equal(strategyTargetDailyUnits(parseStrategyYaml(DEFAULT_STRATEGY_YAML)), 10);
	assert.equal(strategyTargetDailyUnits(undefined), 10);
});


// —— 审计 M3/M16/M8 回归 ——
// —— 审计 M8 回归 ——
test("scoring 权重键、normalize 与 rule id 的非法写法在解析期就被拒绝", () => {
	assert.throws(
		() => parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("    demand: 0.20", "    demandd: 0.20")),
		/scoring\.weights\.demandd 不是可用维度/,
	);
	for (const key of ["constructor", "toString", "__proto__"]) {
		assert.throws(
			() => parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace(/scoring:\n  weights:\n(?:    .*\n)+/, `scoring:\n  weights:\n    ${key}: 1\n`)),
			/不是可用维度/,
			`${key} 不该被当成评分维度`,
		);
	}
	assert.throws(
		() => parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("normalize: percentile", "normalize: percentil")),
		/scoring\.normalize 只能取 percentile \/ none/,
	);
	assert.equal(parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("normalize: percentile", "normalize: none")).scoring.normalize, "none");
	assert.throws(
		() => parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("      - id: high_activity_entry", "      - id: red_sea_veto")),
		/规则 id 重复：red_sea_veto/,
	);
	assert.throws(
		() => parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("      - id: high_activity_entry", '      - id: ""')),
		/的 id 不能为空/,
	);
});


// —— 审计 M3/M16/M8 回归 ——
test("存量脏 definition 的权重键不再把综合分算成 NaN", () => {
	const strategy = parseStrategyYaml(DEFAULT_STRATEGY_YAML);
	// 绕过 parseStrategyYaml，模拟历史 store.json 里已经落盘的原型键权重
	strategy.scoring.weights = { constructor: 1 } as unknown as Record<string, number>;
	const result = evaluateStrategy(strategy, { metrics: {}, listings: [] }, "screen");
	assert.equal(Number.isNaN(result.score), false);
	assert.equal(result.score, 50);
});


// —— 审计 M3/M16/M8 回归 ——
test("YAML 里的 .nan / .inf 月销口径也被拒绝，且错误文案回显原值", () => {
	assert.throws(
		() => parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("monthly_units_q: 300", "monthly_units_q: .nan")),
		/策略 meta\.monthly_units_q 必须是有限正数，实际为 NaN/,
	);
	assert.throws(
		() => parseStrategyYaml(DEFAULT_STRATEGY_YAML.replace("monthly_units_q: 300", "monthly_units_q: .inf")),
		/策略 meta\.monthly_units_q 必须是有限正数，实际为 Infinity/,
	);
});

// —— 审计 M7 回归 ——
// —— 审计 M7 回归 ——
// Object.prototype 上的 constructor / __proto__ / toString / valueOf / hasOwnProperty
// 一旦出现在表达式里，修前会被当成「存在但没有 value」的指标：missing 不传播、require 规则
// 凭空 pass、missingMetrics 为空。修后一律按缺指标处理 → 规则 missing → 整体 review。
const PROTOTYPE_NAMES = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"];

test("原型属性名不是指标：require 规则必须转人工复核而不是凭空 pass", () => {
	for (const name of PROTOTYPE_NAMES) {
		const probe = evaluateExpression(`${name} != red`, { metrics: {}, listings: [] });
		assert.equal(probe.missing, true, `${name} 应按缺指标处理`);
		assert.equal(probe.value, undefined);
	}
	const strategy = parseStrategyYaml(`
meta:
  name: proto-probe
stages:
  - stage: market_screen
    rules:
${PROTOTYPE_NAMES.map((name, index) => `      - id: proto_gate_${index}\n        when: "${name} != red"\n        action: require\n        label: "硬门槛 ${name}"`).join("\n")}
scoring:
  weights:
    demand: 1
`);
	const result = evaluateStrategy(strategy, { metrics: {}, listings: [] }, "screen");
	assert.equal(result.outcome, "review");
	assert.deepEqual(result.rules.map((rule) => rule.status), ["missing", "missing", "missing", "missing", "missing"]);
	assert.deepEqual(result.missingMetrics, ["__proto__", "constructor", "hasOwnProperty", "toString", "valueOf"]);
	// evidence 不得把 Object 构造函数之类的原型成员当证据带出去（会跟着 strategyRuns 落库）
	for (const rule of result.rules) {
		for (const value of Object.values(rule.evidence)) assert.equal(value, undefined);
	}
});


// —— 审计 M7 回归 ——
test("veto 规则引用原型属性名同样按缺指标处理，不会静默放行", () => {
	const strategy = parseStrategyYaml(`
meta:
  name: proto-veto
stages:
  - stage: market_screen
    rules:
      - id: proto_veto
        when: "constructor == red"
        action: veto
        label: "红海一票否决"
scoring:
  weights:
    demand: 1
`);
	const result = evaluateStrategy(strategy, { metrics: {}, listings: [] }, "screen");
	assert.equal(result.rules[0].status, "missing");
	assert.equal(result.outcome, "review");
	assert.deepEqual(result.missingMetrics, ["constructor"]);
});


// —— 审计 M7 回归 ——
test("value 键缺席的指标（JSON 往返丢掉 undefined）按缺数据处理", () => {
	// MetricEvidence.value 类型上不允许 undefined，但 `{value: undefined}` 经 JSON.stringify
	// 会把 value 键整个丢掉，回读后就是一个没有 value 的指标对象——落盘往返是真实触发面。
	const roundTripped = JSON.parse(
		JSON.stringify({ gross_margin: { value: undefined, source: "manual", capturedAt: "2026-09-01T00:00:00.000Z", confidence: 0.9 } }),
	) as MetricMap;
	assert.equal("value" in roundTripped.gross_margin, false);
	const strategy = parseStrategyYaml(`
meta:
  name: margin-probe
stages:
  - stage: market_screen
    rules:
      - id: margin_gate
        when: "gross_margin != red"
        action: require
        label: "毛利硬门槛"
scoring:
  weights:
    demand: 1
`);
	const result = evaluateStrategy(strategy, { metrics: roundTripped, listings: [] }, "screen");
	assert.equal(result.rules[0].status, "missing");
	assert.equal(result.outcome, "review");
	assert.deepEqual(result.missingMetrics, ["gross_margin"]);
});

// —— 审计 M5 回归 ——
// 需同时改两行 import：
// import { DEFAULT_STRATEGY_ID, DEFAULT_STRATEGY_YAML } from "../defaults.ts";
// import { evaluateExpression, evaluateStrategy, parseStrategyYaml, slugify } from "../strategy.ts";

test("DEFAULT_STRATEGY_ID 必须等于内置 YAML meta.name 的 slug", () => {
	// defaults.ts 里 id 写成字面量是为了避开 defaults→strategy→metrics→defaults 的循环依赖，
	// 一致性只能靠这条断言守：改了 meta.name 却忘了改常量，这里立刻红。
	assert.equal(DEFAULT_STRATEGY_ID, slugify(parseStrategyYaml(DEFAULT_STRATEGY_YAML).meta.name));
});

// 已实测：在「改了 meta.name 但忘记同步常量」的变体上必红——
//   AssertionError: actual: 'jingpu-daily10', expected: 'jingpu-daily12'


// —— 审计 M5 回归 ——
test("默认策略 id 只有 defaults.ts 一处定义，其余模块一律引用常量", async () => {
	// M5：曾有 8 处 "jingpu-daily10" 字面量散落在 service.ts / history.ts，
	// 改 meta.name 时 tsc 全程无提示，一半静默回退默认值、一半在运行期抛「未找到策略」。
	const roots = ["service.ts", "history.ts", "index.ts", "store.ts", "todo.ts", "report.ts", "metrics.ts", "csv.ts", "economics.ts", "importer.ts", "ui.ts", "strategy.ts", "web/data.ts", "web/server.ts"];
	const offenders: string[] = [];
	for (const file of roots) {
		const text = await readFile(join(here, "..", file), "utf8");
		if (text.includes(DEFAULT_STRATEGY_ID)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `以下文件仍硬编码默认策略 id，请改用 defaults.ts 的 DEFAULT_STRATEGY_ID：${offenders.join("、")}`);
});

// readFile / join / here 在 tests/strategy.test.ts 里已经有了，无需新 import。
// 这是唯一一条在「修复前」的真实工作树上必红的用例，实测判定结果：
//   offenders = ["service.ts","history.ts"]

// —— review R17/R19 回归 ——
test("qualify_rank_depth 的 derived 证据：明细缺失时诊断 note 不被口径描述覆盖", () => {
	// 快照明细缺失时 depth 为 null，basis.note 里写的是「为什么算不出来」——那是唯一的诊断线索。
	// 从前 note 被无条件覆盖成口径描述，运营在规则证据里只看到「月销≥300 的 listing 数」和一个
	// null，完全不知道是数据没了还是真的一个都没有。
	const context: StrategyContext = {
		metrics: {
			qualify_rank_depth: {
				value: null,
				source: "sellersprite",
				capturedAt: "2026-01-01T00:00:00.000Z",
				confidence: 0,
				note: "快照明细缺失，无法按目标月销 300 重算；导入时冻结口径为 300，按缺数据处理",
			},
		},
		listings: [],
	};
	const result = evaluateExpression("qualify_rank_depth(300) >= 20", context);
	const derived = result.derived?.qualify_rank_depth;
	assert.ok(derived, "应产出 derived 证据");
	assert.equal(derived.value, null);
	assert.equal(derived.targetMonthlyUnits, 300);
	assert.match(derived.note ?? "", /月销≥300 的 listing 数/, "口径描述要在");
	assert.match(derived.note ?? "", /快照明细缺失/, "诊断 note 必须保留，不能被口径描述覆盖");
});

test("qualify_rank_depth 的 derived 证据：算得出来时只写口径，不拖着旧诊断", () => {
	const context: StrategyContext = {
		metrics: {
			qualify_rank_depth: {
				value: 7,
				source: "sellersprite",
				capturedAt: "2026-01-01T00:00:00.000Z",
				confidence: 1,
				note: "导入时按 q=300 冻结",
			},
		},
		listings: [
			{ asin: "B0DEMO0001", rank: 1, monthlySales: 900, sourceRow: 2 },
			{ asin: "B0DEMO0002", rank: 2, monthlySales: 100, sourceRow: 3 },
		] as StrategyContext["listings"],
	};
	const derived = evaluateExpression("qualify_rank_depth(300) >= 1", context).derived?.qualify_rank_depth;
	assert.ok(derived);
	assert.equal(derived.value, 1);
	assert.equal(derived.note, "月销≥300 的 listing 数", "算得出来时不该拖着导入时的旧 note");
});

test("冻结口径被原样透传时不追加它的 note：不产出两段并列的口径描述", () => {
	// service.ts 在「冻结口径与当前 q 相同」时会原样透传冻结证据，它的 note 本身就是
	// 一句口径描述（不是诊断）。无条件追加会串成「月销≥300 的 listing 数；月销≥300 的 listing 数」；
	// 表达式阈值不同时更会并列两个互斥口径，让人无从判断这条 null 按哪个 q 算。
	const passthrough: StrategyContext = {
		metrics: {
			qualify_rank_depth: {
				value: 22,
				source: "sellersprite",
				capturedAt: "2026-01-01T00:00:00.000Z",
				confidence: 1,
				note: "月销≥300 的 listing 数",
				targetMonthlyUnits: 300,
			},
		},
		listings: [],
	};
	assert.equal(
		evaluateExpression("qualify_rank_depth(300) >= 20", passthrough).derived?.qualify_rank_depth?.note,
		"月销≥300 的 listing 数",
	);
	assert.equal(
		evaluateExpression("qualify_rank_depth(800) >= 5", passthrough).derived?.qualify_rank_depth?.note,
		"月销≥800 的 listing 数",
		"阈值不同时只保留本次表达式的口径，不并列冻结时的旧口径",
	);

	// 判据不能用 basis.value === null：冻结口径与策略 q 相同、但冻结值本身就是 null 时
	// （快照有 listing 却一行月销都没有），note 仍然是口径描述而不是诊断，照样不该追加。
	const frozenNullButScopeNote: StrategyContext = {
		metrics: {
			qualify_rank_depth: {
				value: null,
				source: "sellersprite",
				capturedAt: "2026-01-01T00:00:00.000Z",
				confidence: 0,
				note: "月销≥300 的 listing 数",
				targetMonthlyUnits: 300,
			},
		},
		listings: [],
	};
	assert.equal(
		evaluateExpression("qualify_rank_depth(800) >= 5", frozenNullButScopeNote).derived?.qualify_rank_depth?.note,
		"月销≥800 的 listing 数",
		"口径描述形状的 note 一律不追加，无论 basis.value 是不是 null",
	);

	// 真正的诊断（service.ts 那条「快照明细缺失…」）必须保住
	const realDiagnosis: StrategyContext = {
		metrics: {
			qualify_rank_depth: {
				value: null,
				source: "sellersprite",
				capturedAt: "2026-01-01T00:00:00.000Z",
				confidence: 0,
				note: "快照明细缺失，无法按目标月销 300 重算；按缺数据处理",
			},
		},
		listings: [],
	};
	assert.match(
		String(evaluateExpression("qualify_rank_depth(800) >= 5", realDiagnosis).derived?.qualify_rank_depth?.note),
		/月销≥800 的 listing 数；快照明细缺失/,
	);

	// 口径描述的数字部分可以是小数：monthly_units_q 只被要求「有限正数」，不要求整数
	// （不同于 retro_*_days）。判据里写 \d+ 就匹配不到，会重新串出两段口径。
	const fractionalQ: StrategyContext = {
		metrics: {
			qualify_rank_depth: {
				value: null,
				source: "sellersprite",
				capturedAt: "2026-01-01T00:00:00.000Z",
				confidence: 0,
				note: "月销≥250.5 的 listing 数",
				targetMonthlyUnits: 250.5,
			},
		},
		listings: [],
	};
	assert.equal(
		evaluateExpression("qualify_rank_depth(250.5) >= 5", fractionalQ).derived?.qualify_rank_depth?.note,
		"月销≥250.5 的 listing 数",
		"非整数 q 的口径描述同样不该被追加",
	);
});

test("derived 证据的底座走 readMetric：原型链上的同名属性不算真证据", () => {
	// Object.hasOwn 口径：手工构造 / JSON 往返出来的 context 可能从原型链带出同名属性，
	// 那不是这份快照的证据，不该被当成底座 spread 进去。
	const metrics = Object.create({ qualify_rank_depth: { value: 99, source: "伪造", capturedAt: "x", confidence: 1 } });
	const context: StrategyContext = { metrics, listings: [] };
	const derived = evaluateExpression("qualify_rank_depth(300) >= 1", context).derived?.qualify_rank_depth;
	assert.equal(derived, undefined, "原型链上的同名属性不该产出 derived 证据");
});


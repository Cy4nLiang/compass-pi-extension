import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { qualifyRankDepth } from "./metrics.ts";
import type {
	ListingRecord,
	MetricMap,
	RuleEvaluation,
	StrategyDefinition,
	StrategyEvaluation,
} from "./types.ts";

export interface StrategyContext {
	metrics: MetricMap;
	listings: ListingRecord[];
	targetMonthlyUnits?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rankedTop100(listings: ListingRecord[]): ListingRecord[] {
	return [...listings].sort((a, b) => a.rank - b.rank).slice(0, 100);
}

export function slugify(value: string): string {
	const slug = value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 56);
	return slug || "strategy";
}

export function parseStrategyYaml(yaml: string): StrategyDefinition {
	let raw: unknown;
	try {
		raw = parseYaml(yaml);
	} catch (error) {
		throw new Error(`策略 YAML 解析失败：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(raw)) throw new Error("策略 YAML 顶层必须是对象");
	if (!isRecord(raw.meta) || typeof raw.meta.name !== "string" || !raw.meta.name.trim()) {
		throw new Error("策略 meta.name 必填");
	}
	if (raw.meta.display_name !== undefined && typeof raw.meta.display_name !== "string") {
		throw new Error("策略 meta.display_name 必须是字符串");
	}
	if (!Array.isArray(raw.stages) || raw.stages.length === 0) throw new Error("策略 stages 至少需要一个阶段");
	if (!isRecord(raw.scoring) || !isRecord(raw.scoring.weights)) throw new Error("策略 scoring.weights 必填");

	const stages = raw.stages.map((stageValue, stageIndex) => {
		if (!isRecord(stageValue) || typeof stageValue.stage !== "string" || !Array.isArray(stageValue.rules)) {
			throw new Error(`stages[${stageIndex}] 必须包含 stage 与 rules`);
		}
		const rules = stageValue.rules.map((ruleValue, ruleIndex) => {
			if (!isRecord(ruleValue)) throw new Error(`stages[${stageIndex}].rules[${ruleIndex}] 格式错误`);
			const action = ruleValue.action;
			if (!(["veto", "require", "review_if_fail"] as unknown[]).includes(action)) {
				throw new Error(`规则 ${String(ruleValue.id ?? ruleIndex)} action 必须为 veto/require/review_if_fail`);
			}
			if (typeof ruleValue.id !== "string" || typeof ruleValue.when !== "string") {
				throw new Error(`stages[${stageIndex}].rules[${ruleIndex}] 的 id 与 when 必须是字符串`);
			}
			// Parse once during validation so invalid expressions fail before a version is saved.
			evaluateExpression(ruleValue.when, { metrics: {}, listings: [] });
			return {
				id: ruleValue.id,
				when: ruleValue.when,
				action: action as "veto" | "require" | "review_if_fail",
				label: typeof ruleValue.label === "string" ? ruleValue.label : ruleValue.id,
			};
		});
		return { stage: stageValue.stage, rules };
	});

	const weights: Record<string, number> = {};
	for (const [name, value] of Object.entries(raw.scoring.weights)) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error(`scoring.weights.${name} 必须是非负数字`);
		}
		weights[name] = value;
	}
	if (Object.values(weights).reduce((sum, value) => sum + value, 0) <= 0) {
		throw new Error("scoring.weights 合计必须大于 0");
	}

	const meta: StrategyDefinition["meta"] = { ...raw.meta, name: raw.meta.name.trim() };
	if (typeof meta.display_name === "string") {
		meta.display_name = meta.display_name.trim() || undefined;
		if (meta.display_name === undefined) delete meta.display_name;
	}

	return {
		meta,
		stages,
		scoring: {
			weights,
			normalize: typeof raw.scoring.normalize === "string" ? raw.scoring.normalize : undefined,
		},
	};
}

export function strategyToYaml(strategy: StrategyDefinition): string {
	return stringifyYaml(strategy, { lineWidth: 120 });
}

type TokenType = "number" | "string" | "identifier" | "operator" | "lparen" | "rparen" | "comma" | "eof";
interface Token {
	type: TokenType;
	value: string;
	position: number;
}

function tokenize(expression: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	let nesting = 0;
	while (index < expression.length) {
		const char = expression[index];
		if (/\s/.test(char)) {
			index++;
			continue;
		}
		const two = expression.slice(index, index + 2);
		if (["&&", "||", ">=", "<=", "==", "!="].includes(two)) {
			tokens.push({ type: "operator", value: two, position: index });
			index += 2;
			continue;
		}
		if ([">", "<", "!", "-"].includes(char)) {
			tokens.push({ type: "operator", value: char, position: index++ });
			continue;
		}
		if (char === "(") {
			nesting++;
			if (nesting > 100) throw new Error("表达式嵌套层级不能超过 100");
			tokens.push({ type: "lparen", value: char, position: index++ });
			continue;
		}
		if (char === ")") {
			nesting = Math.max(0, nesting - 1);
			tokens.push({ type: "rparen", value: char, position: index++ });
			continue;
		}
		if (char === ",") {
			tokens.push({ type: "comma", value: char, position: index++ });
			continue;
		}
		if (char === '"' || char === "'") {
			const quote = char;
			const start = index++;
			let value = "";
			let closed = false;
			while (index < expression.length) {
				const current = expression[index++];
				if (current === "\\" && index < expression.length) {
					value += expression[index++];
				} else if (current === quote) {
					closed = true;
					break;
				} else value += current;
			}
			if (!closed) throw new Error(`表达式第 ${start + 1} 位字符串未闭合`);
			tokens.push({ type: "string", value, position: start });
			continue;
		}
		const number = expression.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?/i)?.[0];
		if (number) {
			tokens.push({ type: "number", value: number, position: index });
			index += number.length;
			continue;
		}
		const identifier = expression.slice(index).match(/^[A-Za-z_][A-Za-z0-9_.]*/)?.[0];
		if (identifier) {
			tokens.push({ type: "identifier", value: identifier, position: index });
			index += identifier.length;
			continue;
		}
		throw new Error(`表达式第 ${index + 1} 位包含不支持的字符 “${char}”`);
	}
	if (nesting > 0) throw new Error("表达式括号未闭合");
	tokens.push({ type: "eof", value: "", position: expression.length });
	return tokens;
}

interface EvalValue {
	value: unknown;
	missing: boolean;
	references: Set<string>;
}

function mergeReferences(...values: EvalValue[]): Set<string> {
	return new Set(values.flatMap((value) => [...value.references]));
}

const LITERALS: Record<string, unknown> = {
	true: true,
	false: false,
	null: null,
	pass: "pass",
	red: "red",
	strong: "strong",
	clear: "clear",
	review: "review",
	unknown: "unknown",
};

class ExpressionParser {
	private index = 0;
	private readonly tokens: Token[];
	private readonly context: StrategyContext;

	constructor(tokens: Token[], context: StrategyContext) {
		this.tokens = tokens;
		this.context = context;
	}

	parse(): EvalValue {
		const result = this.parseOr();
		this.expect("eof");
		return result;
	}

	private current(): Token {
		return this.tokens[this.index];
	}

	private match(type: TokenType, value?: string): boolean {
		const token = this.current();
		if (token.type !== type || (value !== undefined && token.value !== value)) return false;
		this.index++;
		return true;
	}

	private expect(type: TokenType, value?: string): Token {
		const token = this.current();
		if (!this.match(type, value)) {
			throw new Error(`表达式第 ${token.position + 1} 位应为 ${value ?? type}，实际为 ${token.value || token.type}`);
		}
		return token;
	}

	private parseOr(): EvalValue {
		let left = this.parseAnd();
		while (this.match("operator", "||")) {
			const right = this.parseAnd();
			const references = mergeReferences(left, right);
			if (!left.missing && Boolean(left.value)) left = { value: true, missing: false, references };
			else if (!right.missing && Boolean(right.value)) left = { value: true, missing: false, references };
			else if (left.missing || right.missing) left = { value: undefined, missing: true, references };
			else left = { value: false, missing: false, references };
		}
		return left;
	}

	private parseAnd(): EvalValue {
		let left = this.parseComparison();
		while (this.match("operator", "&&")) {
			const right = this.parseComparison();
			const references = mergeReferences(left, right);
			if (!left.missing && !Boolean(left.value)) left = { value: false, missing: false, references };
			else if (!right.missing && !Boolean(right.value)) left = { value: false, missing: false, references };
			else if (left.missing || right.missing) left = { value: undefined, missing: true, references };
			else left = { value: true, missing: false, references };
		}
		return left;
	}

	private parseComparison(): EvalValue {
		let left = this.parseUnary();
		const operator = this.current();
		if (operator.type !== "operator" || ![">", ">=", "<", "<=", "==", "!="].includes(operator.value)) {
			return left;
		}
		this.index++;
		const right = this.parseUnary();
		const references = mergeReferences(left, right);
		const isRelational = [">", ">=", "<", "<="].includes(operator.value);
		if (isRelational) {
			if (!left.missing && typeof left.value !== "number") throw new Error(`操作符 ${operator.value} 两侧必须为数字`);
			if (!right.missing && typeof right.value !== "number") throw new Error(`操作符 ${operator.value} 两侧必须为数字`);
		}
		if (left.missing || right.missing || left.value === null || right.value === null) {
			return { value: undefined, missing: true, references };
		}
		let value: boolean;
		switch (operator.value) {
			case "==":
				value = left.value === right.value;
				break;
			case "!=":
				value = left.value !== right.value;
				break;
			default: {
				const lhs = left.value as number;
				const rhs = right.value as number;
				if (!Number.isFinite(lhs) || !Number.isFinite(rhs)) {
					throw new Error(`操作符 ${operator.value} 两侧必须为数字`);
				}
				value =
					operator.value === ">" ? lhs > rhs :
					operator.value === ">=" ? lhs >= rhs :
					operator.value === "<" ? lhs < rhs : lhs <= rhs;
			}
		}
		return { value, missing: false, references };
	}

	private parseUnary(): EvalValue {
		if (this.match("operator", "!")) {
			const result = this.parseUnary();
			return result.missing ? result : { ...result, value: !Boolean(result.value) };
		}
		if (this.match("operator", "-")) {
			const result = this.parseUnary();
			if (result.missing) return result;
			const number = Number(result.value);
			if (!Number.isFinite(number)) throw new Error("负号后必须为数字");
			return { ...result, value: -number };
		}
		return this.parsePrimary();
	}

	private parsePrimary(): EvalValue {
		const token = this.current();
		if (this.match("number")) return { value: Number(token.value), missing: false, references: new Set() };
		if (this.match("string")) return { value: token.value, missing: false, references: new Set() };
		if (this.match("lparen")) {
			const value = this.parseOr();
			this.expect("rparen");
			return value;
		}
		if (token.type === "identifier") {
			this.index++;
			const name = token.value;
			if (this.match("lparen")) {
				const args: EvalValue[] = [];
				if (!this.match("rparen")) {
					do args.push(this.parseOr()); while (this.match("comma"));
					this.expect("rparen");
				}
				return this.callFunction(name, args);
			}
			if (Object.hasOwn(LITERALS, name)) return { value: LITERALS[name], missing: false, references: new Set() };
			const metric = this.context.metrics[name];
			return {
				value: metric?.value ?? undefined,
				missing: !metric || metric.value === null,
				references: new Set([name]),
			};
		}
		throw new Error(`表达式第 ${token.position + 1} 位缺少值`);
	}

	private callFunction(name: string, args: EvalValue[]): EvalValue {
		const references = new Set<string>([name, ...args.flatMap((arg) => [...arg.references])]);
		if (args.some((arg) => arg.missing)) return { value: undefined, missing: true, references };
		if (name === "qualify_rank_depth") {
			if (args.length !== 1) throw new Error("qualify_rank_depth(q) 需要一个参数");
			const threshold = Number(args[0].value);
			if (!Number.isFinite(threshold) || threshold < 0) throw new Error("qualify_rank_depth(q) 的 q 必须是非负数字");
			const top = rankedTop100(this.context.listings);
			const hasSales = top.some((listing) => listing.monthlySales !== undefined);
			return {
				value: hasSales ? qualifyRankDepth(top, threshold) : undefined,
				missing: !hasSales,
				references,
			};
		}
		throw new Error(`不支持的策略函数：${name}`);
	}
}

export function evaluateExpression(expression: string, context: StrategyContext): EvalValue {
	return new ExpressionParser(tokenize(expression), context).parse();
}

function metricNumber(metrics: MetricMap, name: string): number | undefined {
	const value = metrics[name]?.value;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampScore(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function average(values: Array<number | undefined>): number {
	const known = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
	return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : 50;
}

export function calculateDimensionScores(metrics: MetricMap, targetMonthlyUnits = 300): Record<string, number> {
	const qrd = metricNumber(metrics, "qualify_rank_depth");
	const waistSales = metricNumber(metrics, "waist_monthly_sales");
	const keywordVolume = metricNumber(metrics, "keyword_search_volume");
	const demand = average([
		qrd === undefined ? undefined : clampScore((qrd / 40) * 100),
		waistSales === undefined ? undefined : clampScore((waistSales / Math.max(targetMonthlyUnits * 2, 1)) * 100),
		keywordVolume === undefined ? undefined : clampScore((Math.log10(Math.max(1, keywordVolume)) / 5) * 100),
	]);

	const cr3 = metricNumber(metrics, "cr3");
	const amzShare = metricNumber(metrics, "amz_share");
	const newShare = metricNumber(metrics, "new_listing_share_12m");
	const hhi = metricNumber(metrics, "hhi");
	const lowRating = metricNumber(metrics, "low_rating_high_sales_count");
	const competition = average([
		cr3 === undefined ? undefined : clampScore((1 - cr3) * 100),
		amzShare === undefined ? undefined : clampScore((1 - amzShare) * 100),
		newShare === undefined ? undefined : clampScore((newShare / 0.3) * 100),
		hhi === undefined ? undefined : clampScore(100 - hhi / 35),
		lowRating === undefined ? undefined : clampScore((lowRating / 10) * 100),
	]);

	const margin = metricNumber(metrics, "gross_margin");
	const cpcRatio = metricNumber(metrics, "cpc_ratio");
	const capitalShare = metricNumber(metrics, "capital_share");
	const unitEconomics = average([
		margin === undefined ? undefined : clampScore((margin / 0.6) * 100),
		cpcRatio === undefined ? undefined : clampScore(((1 - cpcRatio) / 0.7) * 100),
		capitalShare === undefined ? undefined : clampScore((1 - capitalShare / 0.4) * 100),
	]);

	const ratingGap = metricNumber(metrics, "est_rating_gap");
	const fixability = metricNumber(metrics, "pain_fixability");
	const product = average([
		ratingGap === undefined ? undefined : clampScore(((ratingGap + 0.5) / 0.8) * 100),
		fixability === undefined ? undefined : clampScore(fixability * 100),
		lowRating === undefined ? undefined : clampScore((lowRating / 10) * 100),
	]);

	const riskValues: Array<number | undefined> = ["risk_overall", "cert_status", "ip_risk_level", "policy_flag", "logistics_risk"].map((name) => {
		const value = metrics[name]?.value;
		return value === "pass" || value === "clear" ? 100 : value === "review" ? 45 : value === "red" ? 0 : undefined;
	});
	const season = metrics.season_flag?.value;
	riskValues.push(season === "clear" ? 100 : season === "strong" ? 25 : season === "review" ? 50 : undefined);
	const risk = average(riskValues);

	return {
		demand: Math.round(demand * 10) / 10,
		competition: Math.round(competition * 10) / 10,
		unit_economics: Math.round(unitEconomics * 10) / 10,
		product: Math.round(product * 10) / 10,
		risk: Math.round(risk * 10) / 10,
	};
}

export function evaluateStrategy(
	strategy: StrategyDefinition,
	context: StrategyContext,
	mode: "screen" | "full" = "full",
): StrategyEvaluation {
	const stages = mode === "screen" ? strategy.stages.filter((stage) => stage.stage === "market_screen") : strategy.stages;
	const rules: RuleEvaluation[] = [];
	const missingMetrics = new Set<string>();

	for (const stage of stages) {
		for (const rule of stage.rules) {
			try {
				const evaluation = evaluateExpression(rule.when, context);
				const references = [...evaluation.references];
				const missing = references.filter((reference) => {
					if (reference === "qualify_rank_depth") return !rankedTop100(context.listings).some((listing) => listing.monthlySales !== undefined);
					return !context.metrics[reference] || context.metrics[reference].value === null;
				});
				for (const name of missing) missingMetrics.add(name);
				const evidence = Object.fromEntries(
					references.map((reference) => [reference, context.metrics[reference] ?? (reference === "qualify_rank_depth" ? context.metrics.qualify_rank_depth : undefined)]),
				);

				if (evaluation.missing) {
					rules.push({
						...rule,
						stage: stage.stage,
						condition: null,
						status: "missing",
						references,
						evidence,
						message: `缺少指标：${missing.join(", ") || "未知"}，转人工复核`,
					});
					continue;
				}

				const condition = Boolean(evaluation.value);
				const status =
					rule.action === "veto" ? (condition ? "veto" : "pass") :
					rule.action === "require" ? (condition ? "pass" : "fail") :
					condition ? "pass" : "review";
				const message =
					status === "veto" ? `触发一票否决：${rule.label}` :
					status === "fail" ? `未满足硬门槛：${rule.label}` :
					status === "review" ? `需人工复核：${rule.label}` : `通过：${rule.label}`;
				rules.push({ ...rule, stage: stage.stage, condition, status, references, evidence, message });
			} catch (error) {
				rules.push({
					...rule,
					stage: stage.stage,
					condition: null,
					status: "error",
					references: [],
					evidence: {},
					message: `规则执行错误：${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	}

	if (rules.length === 0) {
		const screenMode = mode === "screen";
		rules.push({
			id: "screen_rules_present",
			stage: screenMode ? "market_screen" : "strategy",
			action: "require",
			label: screenMode ? "市场粗筛规则集不能为空" : "策略规则集不能为空",
			when: screenMode ? "market_screen.rules" : "strategy.rules",
			condition: null,
			status: "missing",
			references: [],
			evidence: {},
			message: screenMode ? "策略没有可执行的 market_screen 规则，转人工复核" : "策略没有可执行规则，转人工复核",
		});
	}

	const outcome = rules.some((rule) => rule.status === "veto" || rule.status === "fail")
		? "reject"
		: rules.some((rule) => ["review", "missing", "error"].includes(rule.status))
			? "review"
			: "pass";
	const dimensionScores = calculateDimensionScores(context.metrics, context.targetMonthlyUnits ?? 300);
	const weightEntries = Object.entries(strategy.scoring.weights);
	const totalWeight = weightEntries.reduce((sum, [, weight]) => sum + weight, 0);
	const score = totalWeight > 0
		? weightEntries.reduce((sum, [dimension, weight]) => sum + (dimensionScores[dimension] ?? 50) * weight, 0) / totalWeight
		: 50;

	return {
		outcome,
		score: Math.round(score * 10) / 10,
		dimensionScores,
		rules,
		missingMetrics: [...missingMetrics].sort(),
	};
}

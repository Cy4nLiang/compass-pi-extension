import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_TARGET_DAILY_UNITS, DEFAULT_TARGET_MONTHLY_UNITS } from "./defaults.ts";
import { qualifyRankDepth } from "./metrics.ts";
import type {
	ListingRecord,
	MetricEvidence,
	MetricMap,
	MetricScalar,
	RuleEvaluation,
	StrategyDefinition,
	StrategyEvaluation,
	StrategyMode,
} from "./types.ts";

export interface StrategyContext {
	metrics: MetricMap;
	// readonly：service 层以惰性 getter 提供（无 setter），赋值在编译期即拦截
	readonly listings: ListingRecord[];
	targetMonthlyUnits?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// MetricMap 是 JSON 往返出来的普通对象，原型上挂着 constructor / __proto__ / toString /
// valueOf / hasOwnProperty。直接下标读会把这些原型属性当成「存在但没有 value」的指标：
// missing 不再传播，require 规则凭空 pass，违反「缺失硬指标 → 结论为 review」。
// 指标查表一律先过 Object.hasOwn（与 parsePrimary 里 LITERALS 的写法保持一致）。
// qualify_rank_depth 的口径描述形状（metrics.ts 的 targetDependentMetrics 生成）。
// 它不是诊断，追加进 derived 证据只会并列两段互斥口径。
// 数字部分要容忍小数：monthly_units_q 只被 POSITIVE_META_FIELDS 要求「有限正数」，
// 不要求整数，写 250.5 时 metrics 生成的就是「月销≥250.5 的 listing 数」，
// 用 \\d+ 匹配不到就会重新串出两段口径。
const SCOPE_NOTE = /^月销≥[\d.]+ 的 listing 数$/u;

function readMetric(metrics: MetricMap, name: string): MetricEvidence | undefined {
	return Object.hasOwn(metrics, name) ? metrics[name] : undefined;
}

// 取标量：键不存在、指标对象为空、value 为 null，或 JSON 往返把 value 键整个丢掉
// （`{value: undefined}` 序列化后不落盘），统一折成 null 表示「缺数据」。
function readMetricValue(metrics: MetricMap, name: string): MetricScalar {
	return readMetric(metrics, name)?.value ?? null;
}

// 评分维度白名单：与 calculateDimensionScores 的返回键一一对应。
// 返回类型写成 Record<ScoringDimension, number>，任何一边漏改都会在 tsc 阶段报错。
export const SCORING_DIMENSIONS = ["demand", "competition", "unit_economics", "product", "risk"] as const;
export type ScoringDimension = (typeof SCORING_DIMENSIONS)[number];

// 归一化口径白名单：percentile 由 scanMarkets 做同批分位化，none 表示保留策略引擎的有界基准分。
const NORMALIZE_MODES = ["percentile", "none"] as const;

// meta 里必须是「有限正数」的数值字段：写了就得是正数，只有整条不写才回落缺省。
const POSITIVE_META_FIELDS = [
	"target_daily_units",
	"monthly_units_q",
] as const;

// 天数字段还要求是**正整数**：下游 history.ts 的 positiveInteger 会 Math.floor，
// 0.5 天会被压成 0 天 —— retro_due 于是恒为到期、录了实绩也清不掉，且全程无报错。
// 与其让它静默劣化，不如在保存策略时就拒绝。
const POSITIVE_INTEGER_META_FIELDS = [
	"retro_go_days",
	"retro_testing_stale_days",
	"retro_waitlist_days",
	"retro_no_go_days",
	"retro_review_days",
] as const;

function positiveMetaNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// 月销门槛（QRD 的 q）的唯一读取口径。存量 store 里的 definition 没经过新版校验就直接落盘，
// 所以这里仍然做防御式回落，而不是假设 parseStrategyYaml 已经把非法值全挡在门外。
export function strategyTargetMonthlyUnits(definition?: StrategyDefinition): number {
	return positiveMetaNumber(definition?.meta?.monthly_units_q) ?? DEFAULT_TARGET_MONTHLY_UNITS;
}

// 日均目标单量的唯一读取口径，回落规则同上。
export function strategyTargetDailyUnits(definition?: StrategyDefinition): number {
	return positiveMetaNumber(definition?.meta?.target_daily_units) ?? DEFAULT_TARGET_DAILY_UNITS;
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
	// 数值口径在这里定型：不再放行 "300个" / "500" / -5 / 0 / null 之类靠下游 Number() 各自解释的写法
	for (const field of POSITIVE_META_FIELDS) {
		const value = raw.meta[field];
		if (value === undefined) continue;
		if (positiveMetaNumber(value) === undefined) {
			// 数字原样打印（NaN/Infinity 不被 JSON.stringify 吞成 null），其余带引号回显运营写的原文
			throw new Error(`策略 meta.${field} 必须是有限正数，实际为 ${typeof value === "number" ? value : JSON.stringify(value)}`);
		}
	}
	for (const field of POSITIVE_INTEGER_META_FIELDS) {
		const value = raw.meta[field];
		if (value === undefined) continue;
		if (positiveMetaNumber(value) === undefined || !Number.isInteger(value)) {
			throw new Error(`策略 meta.${field} 必须是正整数天数（下游按整天计算，0.5 会被截成 0 天让复盘永远到期），实际为 ${typeof value === "number" ? value : JSON.stringify(value)}`);
		}
	}
	if (!Array.isArray(raw.stages) || raw.stages.length === 0) throw new Error("策略 stages 至少需要一个阶段");
	if (!isRecord(raw.scoring) || !isRecord(raw.scoring.weights)) throw new Error("策略 scoring.weights 必填");

	const ruleIds = new Set<string>();
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
			if (!ruleValue.id.trim()) throw new Error(`stages[${stageIndex}].rules[${ruleIndex}] 的 id 不能为空`);
			// 复盘重放、命中统计、Web 详情都按 rule id 对齐，重复 id 会让证据张冠李戴
			if (ruleIds.has(ruleValue.id)) throw new Error(`规则 id 重复：${ruleValue.id}，同一策略内必须全局唯一`);
			ruleIds.add(ruleValue.id);
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
		// 维度是 calculateDimensionScores 硬编码的五个，拼错的键既拿不到真实维度分，
		// 又会以 50 分的伪维度混进加权总分，所以直接拒绝
		if (!(SCORING_DIMENSIONS as readonly string[]).includes(name)) {
			throw new Error(`scoring.weights.${name} 不是可用维度，只能取 ${SCORING_DIMENSIONS.join(" / ")}`);
		}
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error(`scoring.weights.${name} 必须是非负数字`);
		}
		weights[name] = value;
	}
	if (Object.values(weights).reduce((sum, value) => sum + value, 0) <= 0) {
		throw new Error("scoring.weights 合计必须大于 0");
	}
	const normalize = raw.scoring.normalize;
	if (normalize !== undefined && (typeof normalize !== "string" || !(NORMALIZE_MODES as readonly string[]).includes(normalize))) {
		throw new Error(`策略 scoring.normalize 只能取 ${NORMALIZE_MODES.join(" / ")}`);
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
			normalize,
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
	// 表达式自带阈值的函数（目前只有 qualify_rank_depth(q)）在求值过程中产出的证据：
	// 规则 evidence 必须是「这条表达式真正算的那个数」，不能拿 context.metrics 里按 meta q
	// 算的另一个数冒充（M15：evidence 显示 22、表达式实际求 4）。只在顶层结果上出现。
	derived?: Record<string, MetricEvidence>;
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
	// 本次表达式里带阈值的函数调用产出的证据，evaluateExpression 在顶层一次性带出
	readonly derivedEvidence = new Map<string, MetricEvidence>();

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
			const value = readMetricValue(this.context.metrics, name);
			return {
				value: value ?? undefined,
				missing: value === null,
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
			const depth = hasSales ? qualifyRankDepth(top, threshold) : null;
			// 证据 = 这条表达式自己算出来的那个数，口径就是表达式里的 threshold。
			// 底座沿用 context 里的同名证据（source / capturedAt / confidence / sampleSize 与它同源），
			// 手工构造的 context 可能没有该项，那就不产出 derived，退回原来的取值方式。
			// **已知边界**：derivedEvidence 以指标名为键，装不下同名的两份证据。同一条表达式里
			// 写两次 qualify_rank_depth(q) 且 q 不同时（如「≥300 有 20 个 或 ≥800 有 5 个」这种
			// 两档门槛），只会留下最后一次调用的阈值与取值，前一档在规则证据里看不到。
			// 求值结果本身是对的，错的只是证据展示。要真正支持得改 evidence 的数据结构
			// （波及 types.ts 的 RuleEvaluation 与 service.ts 的消费点），是产品取舍、留给人拍板。
			// 走 readMetric 而不是直接下标：与本文件其余取指标的路径同口径（Object.hasOwn），
			// 否则原型链上的同名属性会被当成真证据。
			const basis = readMetric(this.context.metrics, "qualify_rank_depth");
			if (basis) {
				// note 用**追加**而不是覆盖：明细缺失时 basis.note 里写的是「为什么算不出来」，
				// 直接覆盖成口径描述会把唯一的诊断线索抹掉。两者都留着，口径在前、诊断在后。
				const scope = `月销≥${threshold} 的 listing 数`;
				this.derivedEvidence.set("qualify_rank_depth", {
					...basis,
					value: depth,
					// 只追加**诊断型** note。metrics.ts 的 targetDependentMetrics 给这个指标写的 note
				// 永远是 `月销≥<q> 的 listing 数`（与 value 是否为 null 无关），那是口径描述不是诊断；
				// 无条件追加会串成「月销≥300 的 listing 数；月销≥300 的 listing 数」，阈值不同时更会
				// 并列两个互斥口径，让人无从判断这条 null 按哪个 q 算。真正的诊断只有 service.ts 那条
				// 「快照明细缺失…」，按「形状不是口径描述」来认，比按 value===null 稳（后者筛不掉
				// 「冻结 q 与策略 q 相同、但冻结值本身就是 null」这一格）。
				note: depth === null && basis.note && !SCOPE_NOTE.test(basis.note) ? `${scope}；${basis.note}` : scope,
					targetMonthlyUnits: threshold,
				});
			}
			return {
				value: hasSales ? depth ?? undefined : undefined,
				missing: !hasSales,
				references,
			};
		}
		throw new Error(`不支持的策略函数：${name}`);
	}
}

export function evaluateExpression(expression: string, context: StrategyContext): EvalValue {
	const parser = new ExpressionParser(tokenize(expression), context);
	const result = parser.parse();
	return parser.derivedEvidence.size
		? { ...result, derived: Object.fromEntries(parser.derivedEvidence) }
		: result;
}

function metricNumber(metrics: MetricMap, name: string): number | undefined {
	const value = readMetricValue(metrics, name);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampScore(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function average(values: Array<number | undefined>): number {
	const known = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
	return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : 50;
}

export function calculateDimensionScores(metrics: MetricMap, targetMonthlyUnits = DEFAULT_TARGET_MONTHLY_UNITS): Record<ScoringDimension, number> {
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
		const value = readMetricValue(metrics, name);
		return value === "pass" || value === "clear" ? 100 : value === "review" ? 45 : value === "red" ? 0 : undefined;
	});
	const season = readMetricValue(metrics, "season_flag");
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
	mode: StrategyMode = "full",
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
					return readMetricValue(context.metrics, reference) === null;
				});
				for (const name of missing) missingMetrics.add(name);
				// 表达式自带阈值的引用（qualify_rank_depth(q)）以本次求值产出的证据为准，
				// 其余引用照常取 context.metrics
				const evidence = Object.fromEntries(
					// derived 由 Object.fromEntries 生成、带完整 Object.prototype，直接下标会把
					// toString / constructor 这类原型属性当成真证据（存量 store 的 metrics 是 JSON 往返对象，
					// 正是 readMetric 要防的场景）。与同文件 readMetric 保持同一口径。
					references.map((reference) => [
						reference,
						evaluation.derived && Object.hasOwn(evaluation.derived, reference)
							? evaluation.derived[reference]
							: readMetric(context.metrics, reference),
					]),
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
	const dimensionScores: Record<string, number> = calculateDimensionScores(context.metrics, context.targetMonthlyUnits ?? DEFAULT_TARGET_MONTHLY_UNITS);
	const weightEntries = Object.entries(strategy.scoring.weights);
	const totalWeight = weightEntries.reduce((sum, [, weight]) => sum + weight, 0);
	// 存量 store 里的 definition 绕过了 parseStrategyYaml，可能仍存着 constructor 之类的原型键：
	// 用 hasOwn 取值，避免把 Object.prototype 上的函数乘进总分得到 NaN
	const score = totalWeight > 0
		? weightEntries.reduce((sum, [dimension, weight]) => sum + (Object.hasOwn(dimensionScores, dimension) ? dimensionScores[dimension] : 50) * weight, 0) / totalWeight
		: 50;

	return {
		outcome,
		score: Math.round(score * 10) / 10,
		dimensionScores,
		rules,
		missingMetrics: [...missingMetrics].sort(),
	};
}

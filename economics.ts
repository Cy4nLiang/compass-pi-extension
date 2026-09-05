import { DEFAULT_GATE_THRESHOLDS, formatGatePercent, type GateThresholds } from "./defaults.ts";
import type { MetricMap, ProfitInput, ProfitResult } from "./types.ts";

// 利润测算只消费毛利 Gate 阈值；CPC 的 0.60 / 0.80 本批仍按内置常量比较、文案不变
// （D-1 缺陷组 ② 拍板 ②-5：CPC 三条警告的字面量被 gaps.ts 与工作区 follower 逐字钉住，另立专题再参数化）。
// fallbacks 由 service.ts 的 gateThresholds 带来：毛利阈值是从规则表达式读出的还是回落的内置默认，
// 警告文案要说实话——回落时不能冒充「策略 Gate」。
export type ProfitGateThresholds = Pick<GateThresholds, "grossMargin"> & { fallbacks?: ReadonlyArray<keyof GateThresholds> };

function round(value: number, digits = 4): number {
	const factor = 10 ** digits;
	return Math.round((value + Number.EPSILON) * factor) / factor;
}

function assertFiniteNonNegative(name: string, value: number): void {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} 必须是非负有限数字`);
}

export function normalizeProfitInput(input: Partial<ProfitInput> & Pick<ProfitInput, "salePrice" | "purchaseCost" | "fbaFee">): ProfitInput {
	const normalized: ProfitInput = {
		marketId: input.marketId,
		candidateId: input.candidateId,
		salePrice: input.salePrice,
		purchaseCost: input.purchaseCost,
		firstMileCost: input.firstMileCost ?? 0,
		tariffCost: input.tariffCost ?? 0,
		referralRate: input.referralRate ?? 0.15,
		fbaFee: input.fbaFee,
		cvr: input.cvr ?? 0.12,
		cpc: input.cpc,
		returnRate: input.returnRate ?? 0.05,
		returnProcessingFee: input.returnProcessingFee ?? 0,
		residualValue: input.residualValue ?? 0,
		dailyUnits: input.dailyUnits ?? 10,
		stockDays: input.stockDays ?? 60,
		testAdBudget: input.testAdBudget ?? 0,
		oneTimeCosts: input.oneTimeCosts ?? 0,
		portfolioCapital: input.portfolioCapital,
		tacosScenarios: input.tacosScenarios?.length ? input.tacosScenarios : [0.1, 0.15, 0.2],
		currency: input.currency ?? "USD",
	};

	for (const [name, value] of Object.entries({
		salePrice: normalized.salePrice,
		purchaseCost: normalized.purchaseCost,
		firstMileCost: normalized.firstMileCost,
		tariffCost: normalized.tariffCost,
		referralRate: normalized.referralRate,
		fbaFee: normalized.fbaFee,
		cvr: normalized.cvr,
		returnRate: normalized.returnRate,
		returnProcessingFee: normalized.returnProcessingFee,
		residualValue: normalized.residualValue,
		dailyUnits: normalized.dailyUnits,
		stockDays: normalized.stockDays,
		testAdBudget: normalized.testAdBudget,
		oneTimeCosts: normalized.oneTimeCosts,
	})) {
		assertFiniteNonNegative(name, value);
	}
	if (normalized.cpc !== undefined) assertFiniteNonNegative("cpc", normalized.cpc);
	if (normalized.salePrice <= 0) throw new Error("salePrice 必须大于 0");
	if (normalized.referralRate > 1 || normalized.cvr > 1 || normalized.returnRate > 1) {
		throw new Error("referralRate、cvr、returnRate 应使用 0–1 小数（例如 15% 写 0.15）");
	}
	if (normalized.portfolioCapital !== undefined && normalized.portfolioCapital <= 0) {
		throw new Error("portfolioCapital 必须大于 0");
	}
	for (const tacos of normalized.tacosScenarios) {
		if (!Number.isFinite(tacos) || tacos < 0 || tacos > 1) throw new Error("TACOS 情景值应在 0–1 之间");
	}
	return normalized;
}

// thresholds 由调用方从最新默认策略读出（service.ts gateThresholds），脱离 store 的纯函数调用用内置默认。
export function estimateProfit(input: ProfitInput, thresholds: ProfitGateThresholds = DEFAULT_GATE_THRESHOLDS): ProfitResult {
	const landedCost = input.purchaseCost + input.firstMileCost + input.tariffCost;
	const referralFee = input.salePrice * input.referralRate;
	const grossProfit = input.salePrice - referralFee - input.fbaFee - landedCost;
	const grossMargin = grossProfit / input.salePrice;
	const breakEvenCpc = input.salePrice * grossMargin * input.cvr;
	// cpc 为 0 一律按缺失处理（Amazon 最低竞价约 $0.02，0 是数据源表达「无竞价数据」的写法）：
	// 否则 cpcRatio=0 会让两条 CPC Gate 无警告通过，并让 D3 的 CPC 分项直接拿满分。
	const knownCpc = input.cpc !== undefined && input.cpc > 0 ? input.cpc : undefined;
	const cpcRatio = knownCpc !== undefined && breakEvenCpc > 0 ? knownCpc / breakEvenCpc : undefined;
	const returnLossPerReturn = Math.max(0, landedCost + input.returnProcessingFee - input.residualValue);
	const returnLossRate = (input.returnRate * returnLossPerReturn) / input.salePrice;
	const monthlyUnits = input.dailyUnits * 30;
	const monthlyRevenue = input.salePrice * monthlyUnits;
	const firstInventoryCost = input.dailyUnits * input.stockDays * landedCost;
	const startupCapital = firstInventoryCost + input.testAdBudget + input.oneTimeCosts;

	const netMarginScenarios = input.tacosScenarios.map((tacos) => ({
		tacos: round(tacos),
		netMargin: round(grossMargin - tacos - returnLossRate),
	}));
	const monthlyNetProfitScenarios = netMarginScenarios.map(({ tacos, netMargin }) => ({
		tacos,
		monthlyNetProfit: round(monthlyRevenue * netMargin, 2),
	}));
	const paybackMonthsScenarios = monthlyNetProfitScenarios.map(({ tacos, monthlyNetProfit }) => ({
		tacos,
		paybackMonths: monthlyNetProfit > 0 ? round(startupCapital / monthlyNetProfit, 2) : null,
	}));

	const warnings: string[] = [];
	if (grossMargin < thresholds.grossMargin) {
		// 三种来源要说实话：没读 store（fallbacks 缺席）= 内置默认；读了但规则回落 = 内置默认 + 原因；读到规则 = 策略 Gate
		const fromRule = thresholds.fallbacks !== undefined && !thresholds.fallbacks.includes("grossMargin");
		const fellBack = thresholds.fallbacks?.includes("grossMargin") === true;
		warnings.push(
			`毛利率低于${fromRule ? "策略 Gate" : "内置默认 Gate"} ${formatGatePercent(thresholds.grossMargin)}${fellBack ? "（默认策略的 gross_margin_gate 未按 gross_margin >= 阈值 的形状声明）" : ""}`,
		);
	}
	if (cpcRatio === undefined) {
		warnings.push(
			input.cpc === undefined
				? "未提供主词 CPC，CPC 承受度 Gate 保持待复核"
				: input.cpc <= 0
					? "主词 CPC 为 0，按缺数据处理（Amazon 最低竞价约 $0.02），CPC 承受度 Gate 保持待复核"
					: "毛利不足以形成正向盈亏平衡 CPC，CPC 承受度 Gate 保持待复核",
		);
	}
	// 数字与文案同源插值（渲染结果与此前字面量逐字相同；gaps.ts 与工作区 follower 钉的是「超过默认硬上限」「需人工复核」子串）
	if (cpcRatio !== undefined && cpcRatio > DEFAULT_GATE_THRESHOLDS.cpcHard) {
		warnings.push(`CPC 承受度高于 ${DEFAULT_GATE_THRESHOLDS.cpcHard.toFixed(2)}，超过默认硬上限`);
	} else if (cpcRatio !== undefined && cpcRatio > DEFAULT_GATE_THRESHOLDS.cpcReview) {
		warnings.push(`CPC 承受度位于 ${DEFAULT_GATE_THRESHOLDS.cpcReview.toFixed(2)}–${DEFAULT_GATE_THRESHOLDS.cpcHard.toFixed(2)}，需人工复核`);
	}
	if (netMarginScenarios.every((scenario) => scenario.netMargin <= 0)) warnings.push("所有 TACOS 情景均为非正净利率");
	if (input.portfolioCapital && startupCapital / input.portfolioCapital > 0.2) {
		warnings.push("单 SKU 启动资金超过组合资金的 20%");
	}

	return {
		landedCost: round(landedCost, 2),
		referralFee: round(referralFee, 2),
		grossProfit: round(grossProfit, 2),
		grossMargin: round(grossMargin),
		breakEvenCpc: round(breakEvenCpc, 2),
		cpcRatio: cpcRatio === undefined ? undefined : round(cpcRatio),
		returnLossRate: round(returnLossRate),
		netMarginScenarios,
		monthlyRevenue: round(monthlyRevenue, 2),
		monthlyNetProfitScenarios,
		firstInventoryCost: round(firstInventoryCost, 2),
		startupCapital: round(startupCapital, 2),
		paybackMonthsScenarios,
		warnings,
	};
}

export function profitMetrics(input: ProfitInput, result: ProfitResult, capturedAt: string): MetricMap {
	const source = "profit_calculator";
	const metric = (value: number | null, note?: string) => ({
		value,
		source,
		capturedAt,
		confidence: 0.9,
		note,
	});
	const metrics: MetricMap = {
		landed_cost: metric(result.landedCost),
		gross_margin: metric(result.grossMargin, "不含广告与退货；输入成本口径决定精度"),
		break_even_cpc: metric(result.breakEvenCpc, "售价×毛利率×CVR"),
		cpc_ratio: metric(result.cpcRatio ?? null, "主词建议CPC÷盈亏平衡CPC"),
		return_loss_rate: metric(result.returnLossRate),
		startup_capital: metric(result.startupCapital),
	};
	if (input.portfolioCapital !== undefined) {
		metrics.capital_share = metric(result.startupCapital / input.portfolioCapital, "单SKU启动资金÷总选品资金");
	}
	return metrics;
}

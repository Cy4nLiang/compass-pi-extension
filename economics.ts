import type { MetricMap, ProfitInput, ProfitResult } from "./types.ts";

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

export function estimateProfit(input: ProfitInput): ProfitResult {
	const landedCost = input.purchaseCost + input.firstMileCost + input.tariffCost;
	const referralFee = input.salePrice * input.referralRate;
	const grossProfit = input.salePrice - referralFee - input.fbaFee - landedCost;
	const grossMargin = grossProfit / input.salePrice;
	const breakEvenCpc = input.salePrice * grossMargin * input.cvr;
	const cpcRatio = input.cpc !== undefined && breakEvenCpc > 0 ? input.cpc / breakEvenCpc : undefined;
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
	if (grossMargin < 0.4) warnings.push("毛利率低于默认 Gate 40%");
	if (cpcRatio === undefined) {
		warnings.push(input.cpc === undefined ? "未提供主词 CPC，CPC 承受度 Gate 保持待复核" : "毛利不足以形成正向盈亏平衡 CPC，CPC 承受度 Gate 保持待复核");
	}
	if (cpcRatio !== undefined && cpcRatio > 0.8) warnings.push("CPC 承受度高于 0.80，超过默认硬上限");
	else if (cpcRatio !== undefined && cpcRatio > 0.6) warnings.push("CPC 承受度位于 0.60–0.80，需人工复核");
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

import type { KeywordRecord, ListingRecord, ParsedMarketCsv } from "./types.ts";

const FIELD_ALIASES: Record<string, string[]> = {
	asin: ["asin", "商品asin", "父asin", "parentasin", "childasin", "商品编号"],
	title: ["title", "producttitle", "商品标题", "标题", "产品名称", "商品名称"],
	rank: ["rank", "ranking", "序号", "排名", "自然排名", "bsr", "bsr排名", "类目排名"],
	price: ["price", "售价", "价格", "当前价格", "buybox价格", "buyboxprice", "商品价格"],
	rating: ["rating", "ratings", "评分", "星级", "reviewrating", "平均评分"],
	reviewCount: ["reviewcount", "reviews", "ratingscount", "评论数", "评价数", "评分数", "review"],
	monthlySales: [
		"monthlysales",
		"monthlysalesestimate",
		"estimatedmonthlysales",
		"sales30d",
		"近30天销量",
		"月销量",
		"预估月销量",
		"月销售量",
		"销量",
	],
	monthlyRevenue: [
		"monthlyrevenue",
		"estimatedmonthlyrevenue",
		"salesamount30d",
		"近30天销售额",
		"月销售额",
		"预估月销售额",
		"销售额",
	],
	brand: ["brand", "品牌", "品牌名", "brandname"],
	seller: ["seller", "sellername", "sellertype", "卖家", "卖家名称", "卖家类型", "配送卖家"],
	isAmazon: ["isamazon", "amazonretail", "amz自营", "亚马逊自营", "是否亚马逊自营", "amazon自营"],
	launchDate: [
		"launchdate",
		"listingdate",
		"datefirstavailable",
		"firstavailable",
		"上架时间",
		"上架日期",
		"首次上架时间",
	],
	monthsOnline: ["monthsonline", "listingagemonths", "上架月数", "在线月数", "链接月龄"],
	category: ["category", "categorypath", "类目", "类目路径", "细分类目"],
	keyword: ["keyword", "searchterm", "关键词", "搜索词", "流量词", "关键词名称"],
	searchVolume: [
		"searchvolume",
		"monthlysearchvolume",
		"月搜索量",
		"搜索量",
		"月度搜索量",
		"流量",
	],
	cpc: ["cpc", "suggestedbid", "suggestedcpc", "建议cpc", "建议竞价", "点击单价", "ppc竞价"],
};

function normalizeHeader(value: string): string {
	return value
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/[\s_\-./()（）【】\[\]:：%$¥￥]+/gu, "");
}

const NORMALIZED_ALIASES = Object.fromEntries(
	Object.entries(FIELD_ALIASES).map(([field, aliases]) => [field, new Set(aliases.map(normalizeHeader))]),
) as Record<string, Set<string>>;

export function decodeCsvBuffer(buffer: Buffer): string {
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
		return buffer.subarray(2).toString("utf16le");
	}
	if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
		const swapped = Buffer.allocUnsafe(buffer.length - 2);
		for (let i = 2; i + 1 < buffer.length; i += 2) {
			swapped[i - 2] = buffer[i + 1];
			swapped[i - 1] = buffer[i];
		}
		return swapped.toString("utf16le");
	}
	return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function countDelimiter(line: string, delimiter: string): number {
	let count = 0;
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			if (quoted && line[i + 1] === '"') i++;
			else quoted = !quoted;
		} else if (!quoted && char === delimiter) {
			count++;
		}
	}
	return count;
}

export function detectDelimiter(text: string): string {
	const sample = text.split(/\r?\n/).slice(0, 5).join("\n");
	const options = [",", "\t", ";", "|"];
	return options
		.map((delimiter) => ({ delimiter, count: countDelimiter(sample, delimiter) }))
		.sort((a, b) => b.count - a.count)[0]?.delimiter ?? ",";
}

export function parseDelimited(text: string, delimiter = detectDelimiter(text)): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quoted) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				field += char;
			}
			continue;
		}

		if (char === '"' && field.length === 0) {
			quoted = true;
		} else if (char === delimiter) {
			row.push(field.trim());
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[i + 1] === "\n") i++;
			row.push(field.trim());
			field = "";
			if (row.some((cell) => cell.length > 0)) rows.push(row);
			row = [];
		} else {
			field += char;
		}
	}

	row.push(field.trim());
	if (row.some((cell) => cell.length > 0)) rows.push(row);
	return rows;
}

export function parseNumeric(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	let normalized = value.normalize("NFKC").trim();
	if (!normalized || /^(?:-|—|n\/?a|null|无)$/i.test(normalized)) return undefined;

	let multiplier = 1;
	if (/万(?:\+)?$/u.test(normalized)) multiplier = 10_000;
	else if (/千(?:\+)?$/u.test(normalized)) multiplier = 1_000;
	else if (/k(?:\+)?$/i.test(normalized)) multiplier = 1_000;
	else if (/m(?:\+)?$/i.test(normalized)) multiplier = 1_000_000;

	normalized = normalized
		.replace(/[,，\s]/gu, "")
		.replace(/(?:USD|US\$|RMB|CNY)/gi, "")
		.replace(/[$¥￥€£]/gu, "")
		.replace(/[万千kKmM+]/gu, "")
		.replace(/[^0-9.eE+\-]/g, "");
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed * multiplier : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = normalizeHeader(value);
	if (["1", "true", "yes", "是", "自营", "amazon", "amz"].includes(normalized)) return true;
	if (["0", "false", "no", "否", "非自营"].includes(normalized)) return false;
	return undefined;
}

function parseDate(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	const excelSerial = parseNumeric(value);
	if (excelSerial && /^\d{5}(?:\.\d+)?$/.test(value.trim()) && excelSerial > 20_000 && excelSerial < 80_000) {
		const date = new Date(Date.UTC(1899, 11, 30) + excelSerial * 86_400_000);
		return date.toISOString();
	}
	const normalized = value
		.normalize("NFKC")
		.trim()
		.replace(/[年/.]/gu, "-")
		.replace(/月/gu, "-")
		.replace(/日/gu, "");
	const timestamp = Date.parse(normalized);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function monthsSince(date: string, capturedAt: string): number | undefined {
	const start = new Date(date);
	const end = new Date(capturedAt);
	if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return undefined;
	return Math.max(
		0,
		(end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth(),
	);
}

function detectSource(headers: string[], requested?: string): string {
	if (requested && requested !== "auto") return requested;
	const joined = headers.join(" ").toLowerCase();
	if (/seller\s*sprite|卖家精灵|西柚/i.test(joined)) return "sellersprite";
	if (/sorftime|鸥鹭/i.test(joined)) return "sorftime";
	if (/keepa/i.test(joined)) return "keepa";
	return "generic_csv";
}

function mapColumns(headers: string[]): Record<string, number> {
	const columns: Record<string, number> = {};
	const normalizedHeaders = headers.map(normalizeHeader);
	for (const [field, aliases] of Object.entries(NORMALIZED_ALIASES)) {
		const index = normalizedHeaders.findIndex((header) => aliases.has(header));
		if (index >= 0) columns[field] = index;
	}
	return columns;
}

function cell(row: string[], columns: Record<string, number>, field: string): string | undefined {
	const index = columns[field];
	return index === undefined ? undefined : row[index]?.trim() || undefined;
}

export function parseMarketCsv(
	text: string,
	options: { source?: string; capturedAt?: string } = {},
): ParsedMarketCsv {
	const delimiter = detectDelimiter(text);
	const rows = parseDelimited(text.replace(/^\uFEFF/, ""), delimiter);
	if (rows.length < 2) throw new Error("CSV 至少需要表头和一行数据");

	const headers = rows[0].map((header) => header.trim());
	const columns = mapColumns(headers);
	const source = detectSource(headers, options.source);
	const capturedAt = options.capturedAt ?? new Date().toISOString();
	const listings: ListingRecord[] = [];
	const keywords: KeywordRecord[] = [];
	const warnings: string[] = [];

	for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
		const row = rows[rowIndex];
		const sourceRow = rowIndex + 1;
		const launchDate = parseDate(cell(row, columns, "launchDate"));
		const explicitMonths = parseNumeric(cell(row, columns, "monthsOnline"));
		const seller = cell(row, columns, "seller");
		const explicitAmazon = parseBoolean(cell(row, columns, "isAmazon"));
		const isAmazon =
			explicitAmazon ?? (seller ? /(?:amazon|amz|亚马逊自营)/i.test(seller.normalize("NFKC")) : undefined);
		const monthlySales = parseNumeric(cell(row, columns, "monthlySales"));
		const price = parseNumeric(cell(row, columns, "price"));
		const monthlyRevenue = parseNumeric(cell(row, columns, "monthlyRevenue")) ??
			(monthlySales !== undefined && price !== undefined ? monthlySales * price : undefined);

		const listingIdentity = cell(row, columns, "asin") ?? cell(row, columns, "title");
		if (listingIdentity) {
			listings.push({
				asin: cell(row, columns, "asin")?.toUpperCase(),
				title: cell(row, columns, "title"),
				rank: Math.max(1, Math.round(parseNumeric(cell(row, columns, "rank")) ?? listings.length + 1)),
				price,
				rating: parseNumeric(cell(row, columns, "rating")),
				reviewCount: parseNumeric(cell(row, columns, "reviewCount")),
				monthlySales,
				monthlyRevenue,
				brand: cell(row, columns, "brand"),
				seller,
				isAmazon,
				launchDate,
				monthsOnline: explicitMonths ?? (launchDate ? monthsSince(launchDate, capturedAt) : undefined),
				category: cell(row, columns, "category"),
				sourceRow,
			});
		}

		const keyword = cell(row, columns, "keyword");
		if (keyword) {
			keywords.push({
				keyword,
				searchVolume: parseNumeric(cell(row, columns, "searchVolume")),
				cpc: parseNumeric(cell(row, columns, "cpc")),
				rank: parseNumeric(cell(row, columns, "rank")),
				sourceRow,
			});
		}
	}

	if (listings.length === 0 && keywords.length === 0) {
		throw new Error("没有识别到商品或关键词行；请检查 CSV 表头映射");
	}
	if (listings.length > 0 && !Object.hasOwn(columns, "monthlySales")) {
		warnings.push("未识别到月销量列，QRD、CR3、HHI 等销量指标会缺失或降置信度");
	}
	if (listings.length > 0 && !Object.hasOwn(columns, "brand")) {
		warnings.push("未识别到品牌列，品牌集中度指标不可计算");
	}
	if (listings.length > 0 && !Object.hasOwn(columns, "launchDate") && !Object.hasOwn(columns, "monthsOnline")) {
		warnings.push("未识别到上架日期/月龄，新品占比不可计算");
	}
	if (listings.length > 100) warnings.push(`导入 ${listings.length} 条 listing；市场指标按排名前100计算，其余行仍保留在快照中`);

	const mappedFields = Object.keys(columns);
	return {
		source,
		delimiter: delimiter === "\t" ? "tab" : delimiter,
		headers,
		listings,
		keywords,
		warnings,
		rowCount: rows.length - 1,
		mappedFields,
	};
}

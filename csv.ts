import type { KeywordRecord, ListingRecord, ParsedMarketCsv } from "./types.ts";

const FIELD_ALIASES: Record<string, string[]> = {
	asin: ["asin", "商品asin", "父asin", "parentasin", "childasin", "商品编号"],
	title: ["title", "producttitle", "商品标题", "标题", "产品名称", "商品名称"],
	rank: ["rank", "ranking", "排名", "自然排名", "bsr", "bsr排名", "类目排名", "序号"],
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

// 出现在告警里的数值列中文名（用户可见），仅用于「N 个单元格按缺失处理」的明细。
const NUMERIC_FIELD_LABELS: Record<string, string> = {
	rank: "排名",
	price: "价格",
	rating: "评分",
	reviewCount: "评论数",
	monthlySales: "月销量",
	monthlyRevenue: "月销售额",
	monthsOnline: "上架月数",
	searchVolume: "搜索量",
	cpc: "CPC",
};

const REPLACEMENT_CHAR = "�";

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

// 生成 CSV 时该用哪个表头：每组别名的第一个（一律是英文小写形态）。
// 语义定死在这里而不是让调用方自己去 `FIELD_ALIASES[field][0]`——否则「取第一个」这条规则
// 会变成外部文件与本表数组顺序之间的隐式契约（补数转换的映射文件用的就是这些字符串做键）。
export const CSV_ALIAS_HEADERS: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(Object.entries(FIELD_ALIASES).map(([field, aliases]) => [field, aliases[0]])),
);

export interface DecodedCsv {
	text: string;
	/** 实际采用的编码标签，供告警文案与排查使用 */
	encoding: string;
	warnings: string[];
}

// 非法 UTF-8 字节占「非 ASCII 字符」的比例阈值：GBK/GB18030 的中文正文按 UTF-8 读会成片
// 变成替换字符（比例接近 1），而本来就是 UTF-8、只是被污染了几个字节的文件比例极低。
// 用比例而不是绝对条数，才不会漏掉「只有一两个中文表头」的 GBK 文件。
const LEGACY_GARBLED_RATIO = 0.5;

function countChars(text: string, predicate: (char: string) => boolean): number {
	let count = 0;
	for (const char of text) if (predicate(char)) count++;
	return count;
}

const isReplacement = (char: string): boolean => char === REPLACEMENT_CHAR;
const isNonAscii = (char: string): boolean => (char.codePointAt(0) ?? 0) > 0x7f;

export function decodeCsvBuffer(buffer: Buffer): DecodedCsv {
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
		return { text: buffer.subarray(2).toString("utf16le"), encoding: "utf-16le", warnings: [] };
	}
	if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
		const swapped = Buffer.allocUnsafe(buffer.length - 2);
		for (let i = 2; i + 1 < buffer.length; i += 2) {
			swapped[i - 2] = buffer[i + 1];
			swapped[i - 1] = buffer[i];
		}
		return { text: swapped.toString("utf16le"), encoding: "utf-16be", warnings: [] };
	}
	// 先按严格 UTF-8 解码：合法就走原路，既有的 UTF-8 / BOM 文件行为完全不变。
	try {
		return {
			text: new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^﻿/, ""),
			encoding: "utf-8",
			warnings: [],
		};
	} catch {
		// 不是合法 UTF-8：多半是 Excel / 国内选品工具导出的 GBK、GB18030。
	}
	const lossy = buffer.toString("utf8").replace(/^﻿/, "");
	const invalid = countChars(lossy, isReplacement);
	let legacy: string | undefined;
	try {
		// 只有带 full-icu 的 Node 才有 gb18030 解码器，small-icu 会抛 RangeError。
		legacy = new TextDecoder("gb18030").decode(buffer).replace(/^﻿/, "");
	} catch {
		legacy = undefined;
	}
	if (legacy === undefined) {
		return {
			text: lossy,
			encoding: "utf-8",
			warnings: [
				`CSV 不是合法 UTF-8，且当前 Node 运行时不支持 GB18030 解码，${invalid} 处非法字节已替换为「${REPLACEMENT_CHAR}」；请用 Excel 另存为「CSV UTF-8」后重新导入`,
			],
		};
	}
	const nonAscii = countChars(lossy, isNonAscii);
	if (nonAscii === 0 || invalid / nonAscii < LEGACY_GARBLED_RATIO || countChars(legacy, isReplacement) >= invalid) {
		return {
			text: lossy,
			encoding: "utf-8",
			warnings: [`CSV 含 ${invalid} 处非法 UTF-8 字节，已替换为「${REPLACEMENT_CHAR}」；请检查原文件是否损坏`],
		};
	}
	return {
		text: legacy,
		encoding: "gb18030",
		warnings: ["CSV 不是合法 UTF-8，已按 GB18030（GBK）解码；若报告中仍出现乱码，请用 Excel 另存为「CSV UTF-8」后重新导入"],
	};
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

// 分隔符候选：平局时按此顺序取胜。制表符/分号/竖线几乎不出现在商品标题正文里，逗号最常见，故逗号排最后。
const DELIMITER_CANDIDATES = ["\t", ";", "|", ","];
const DELIMITER_SAMPLE_ROWS = 5;

// 按引号状态切出前 limit 个逻辑行：引号内的换行不算行尾，CRLF 算一个行尾，空行丢弃，末行无换行也 flush。
function sampleRows(text: string, limit: number): string[] {
	const rows: string[] = [];
	let row = "";
	let quoted = false;
	for (let i = 0; i < text.length && rows.length < limit; i++) {
		const char = text[i];
		if (char === '"') {
			if (quoted && text[i + 1] === '"') {
				row += '""';
				i++;
			} else {
				quoted = !quoted;
				row += char;
			}
			continue;
		}
		if (!quoted && (char === "\n" || char === "\r")) {
			if (char === "\r" && text[i + 1] === "\n") i++;
			if (row.trim()) rows.push(row);
			row = "";
			continue;
		}
		row += char;
	}
	if (rows.length < limit && row.trim()) rows.push(row);
	return rows;
}

// 取「非零计数里出现次数最多」的那一档：agreement = 有多少行同意这个列数，count = 该档的分隔符个数。
function delimiterConsistency(perRow: number[]): { agreement: number; count: number } {
	let best = { agreement: 0, count: 0 };
	for (const count of perRow) {
		if (count === 0) continue;
		const agreement = perRow.filter((other) => other === count).length;
		if (agreement > best.agreement || (agreement === best.agreement && count > best.count)) {
			best = { agreement, count };
		}
	}
	return best;
}

// 一致性优先：逐行计数，先比「多少行的计数一致」，再比列数，最后按候选顺序打破平局。
// 只比总数会让「窄表 TSV + 正文里的逗号/千分位」被误判成逗号 CSV，导入随后以误导性的表头映射错误失败。
export function detectDelimiter(text: string): string {
	const rows = sampleRows(text, DELIMITER_SAMPLE_ROWS);
	let winner: { delimiter: string; agreement: number; count: number } | undefined;
	for (const delimiter of DELIMITER_CANDIDATES) {
		const { agreement, count } = delimiterConsistency(rows.map((row) => countDelimiter(row, delimiter)));
		if (agreement === 0) continue;
		if (!winner || agreement > winner.agreement || (agreement === winner.agreement && count > winner.count)) {
			winner = { delimiter, agreement, count };
		}
	}
	return winner?.delimiter ?? ",";
}

function parseDelimitedInternal(text: string, delimiter: string): { rows: string[][]; unclosedQuote: boolean } {
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
	return { rows, unclosedQuote: quoted };
}

export function parseDelimited(text: string, delimiter = detectDelimiter(text)): string[][] {
	return parseDelimitedInternal(text, delimiter).rows;
}

// 数值列里常见的「没有值」写法。比对前已做 NFKC + trim + toLowerCase，
// 因此全角问号、全角连字符等会先被折叠成这里的 ASCII 形态。
const MISSING_VALUE_TOKENS = new Set([
	"-", "--", "---", "—", "——", "―", "――", "–", "––", "‒", "‐",
	"_", "__", ".", "..", "/", "//", "\\", "?", "??", "???",
	"n/a", "n.a.", "n.a", "na", "null", "nil", "none", "nan", "tbd", "t.b.d", "t.b.d.", "unknown", "pending",
	"无", "暂无", "未知", "待定", "不详", "缺失", "无数据", "暂无数据", "未收录", "待补充", "未提供", "空",
	"#n/a", "#na", "#value!", "#ref!", "#div/0!", "#name?", "#null!", "#num!",
]);

// 一个数字 token：可选符号 + 千分位整数或小数 + 可选科学计数法（Excel 导出的 1.23E+08 要保住）。
const NUMBER_TOKEN = /[-+−]?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/u;

// 量词后缀只在「紧跟数字 token」的位置判定；k/m 后面再接英文字母时是单位缩写（km/mm/mAh），不是倍率。
const SUFFIX_MULTIPLIERS: Array<[RegExp, number]> = [
	[/^千万/u, 10_000_000],
	[/^亿/u, 100_000_000],
	[/^万/u, 10_000],
	[/^千/u, 1_000],
	[/^[kK](?![A-Za-z])/u, 1_000],
	[/^[mM](?![A-Za-z])/u, 1_000_000],
];

// 紧贴数字的英文字母通常是量纲单位（5cm / 5mm / 300pcs），只有货币代码例外。
const ADJACENT_CURRENCY = /^(?:USD|CNY|RMB|EUR|GBP|JPY)\b/iu;

function suffixMultiplier(tail: string): number | undefined {
	for (const [pattern, factor] of SUFFIX_MULTIPLIERS) {
		if (pattern.test(tail)) return factor;
	}
	return undefined;
}

// "4.5 out of 5 stars" / "4.5/5" / "4.5 颗星，最多 5 颗星"：尾部只剩一个 5 且带量表标记时取分子。
function isFiveScaleTail(rest: string): boolean {
	const digits = rest.match(/\d+(?:\.\d+)?/gu) ?? [];
	if (digits.length !== 1 || Number(digits[0]) !== 5) return false;
	return /out\s*of|[\/／]|满分|最多|星|stars?|分/iu.test(rest);
}

export function parseNumeric(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const normalized = value.normalize("NFKC").trim();
	if (!normalized || MISSING_VALUE_TOKENS.has(normalized.toLowerCase())) return undefined;

	const match = NUMBER_TOKEN.exec(normalized);
	// 剥离单位后必须还剩下数字，否则是占位文本而不是 0。老实现剥光后 Number("") === 0，
	// 把「暂无」「?」「$」这类缺失伪装成满样本的硬指标 0。
	if (!match) return undefined;
	if (/^[-−]/u.test(match[0])) return undefined;

	const rest = normalized.slice(match.index + match[0].length);
	// 同一格里还有第二个数字（"4.5 (1,234)"、"5 x 3 x 2"）一律判缺失，除非是五分制量表。
	if (/\d/u.test(rest) && !isFiveScaleTail(rest)) return undefined;

	const parsed = Number(match[0].replace(/,/gu, ""));
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;

	const tail = rest.replace(/^\s+/u, "");
	const multiplier = suffixMultiplier(tail);
	if (multiplier === undefined && /^[A-Za-z]/u.test(rest) && !ADJACENT_CURRENCY.test(rest)) return undefined;
	if (multiplier === undefined && /^%/u.test(tail)) return parsed / 100;
	return parsed * (multiplier ?? 1);
}

function parseRating(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	// 百分制评分不做换算，按缺失处理：0.9 落在 0–5 内，单靠范围校验抓不住。
	if (/%/u.test(value.normalize("NFKC"))) return undefined;
	const rating = parseNumeric(value);
	if (rating === undefined || rating > 5) return undefined;
	return rating;
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = normalizeHeader(value);
	if (["1", "true", "yes", "是", "自营", "amazon", "amz"].includes(normalized)) return true;
	if (["0", "false", "no", "否", "非自营"].includes(normalized)) return false;
	return undefined;
}

const EXCEL_SERIAL_PATTERN = /^\d{5}(?:\.\d+)?$/u;
const DOTTED_DATE_PATTERN = /^\d{4}\.\d{1,2}\.\d{1,2}$/u;
const MIN_PLAUSIBLE_YEAR = 1990;
const MAX_PLAUSIBLE_YEAR = 2100;

function plausibleIso(timestamp: number): string | undefined {
	if (!Number.isFinite(timestamp)) return undefined;
	const date = new Date(timestamp);
	const year = date.getUTCFullYear();
	if (year < MIN_PLAUSIBLE_YEAR || year > MAX_PLAUSIBLE_YEAR) return undefined;
	return date.toISOString();
}

function parseDate(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	const trimmed = value.normalize("NFKC").trim();

	// Excel 序列号必须先判：Date.parse("45000") 会解成公元 44999 年。
	if (EXCEL_SERIAL_PATTERN.test(trimmed)) {
		const serial = Number(trimmed);
		if (serial > 20_000 && serial < 80_000) {
			// 同样过 plausibleIso：序列号区间的两端（≈1954 与 ≈2118）都在 1990–2100 闸门之外，
			// 直接 return 会让这条分支成为闸门的旁路。
			const iso = plausibleIso(Date.UTC(1899, 11, 30) + serial * 86_400_000);
			if (iso) return iso;
		}
	}

	// 中文/斜杠日期归一；点号只在「纯日期」形态下替换，避免打断 ISO 毫秒与秒小数。
	// 归一必须排在 Date.parse(原串) 之前：直接解析 "2024/10/01" 会按本地零点算，
	// 与既有的 UTC 零点语义差一个时区，每月 1 号的月龄会整整差一个月。
	let normalized = trimmed
		.replace(/[年月]/gu, "-")
		.replace(/日/gu, "")
		.replace(/\//gu, "-")
		.trim();
	if (DOTTED_DATE_PATTERN.test(normalized)) normalized = normalized.replace(/\./gu, "-");
	return plausibleIso(Date.parse(normalized)) ?? plausibleIso(Date.parse(trimmed));
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
	for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
		for (const alias of aliases) {
			const index = normalizedHeaders.indexOf(normalizeHeader(alias));
			if (index >= 0) {
				columns[field] = index;
				break;
			}
		}
	}
	return columns;
}

function cell(row: string[], columns: Record<string, number>, field: string): string | undefined {
	const index = columns[field];
	return index === undefined ? undefined : row[index]?.trim() || undefined;
}

export interface KeywordDedupeResult {
	keywords: KeywordRecord[];
	duplicateRows: number;
	conflicts: Array<{ keyword: string; field: "searchVolume" | "cpc"; sourceRow: number; kept: number; dropped: number[] }>;
}

function keywordKey(value: string): string {
	return value.normalize("NFKC").trim().toLocaleLowerCase();
}

// 同一个关键词可能被逐行重复（宽表布局：每条 listing 行都挂着同一个流量词）。
// 折叠成一条，否则 keyword_search_volume 会按行数整整放大一个量级。
// AMZ 自营占比的样本诊断：份额按月销加权，有效样本 = 卖家类型与月销量**同时**有值的行。
// csv.ts 的导入告警与 metrics.ts 的指标 note 都从这里出，避免两条运营可见信号对同一份数据
// 给出互相矛盾的处置——那正是「照做无效」的来源。返回 undefined 表示样本足够、无需告警。
//
// 注意两个调用方的分母不同：导入告警按全部 listing，指标按 rankedTop100，
// >100 行的文件上松紧会有差异（已知残留，见 review-followups/tasks.md）。
// 判定用的行集：按排名取前 100。指标只在这 100 行上算，导入告警也必须用同一个行集，
// 否则 200 行的文件里「告警说算出来了、指标却是缺数据」（两条运营可见信号给出相反结论）。
// 放在 csv.ts 是因为 metrics.ts 依赖 csv.ts，反向会成环。
export function rankedTop100(listings: ListingRecord[]): ListingRecord[] {
	return [...listings].sort((a, b) => a.rank - b.rank).slice(0, 100);
}

// AMZ 告警与指标 note 共用的开头。两处只差一个字也会让运营 grep 不到（手册按这个前缀索引）。
export const AMZ_MISSING_PREFIX = "AMZ 自营占比按缺失处理并转人工复核";

export interface AmazonSampleCounts {
	/** 参与判定的 listing 数 */
	total: number;
	/** 卖家类型有值的行数 */
	sellerKnown: number;
	/** 月销量有值（≥0）的行数 */
	salesKnown: number;
	/** 两列同时有值的行数 —— 这才是有效样本 */
	usable: number;
	/** 有效样本的月销合计；为 0 时份额的分母是 0，同样算不出来 */
	salesTotal: number;
}

/** 从同一批 listing 数出 counts：两个调用方共用，避免 filter 谓词各抄一份后静默分叉。 */
export function amazonSampleCounts(listings: ListingRecord[]): AmazonSampleCounts {
	const usableRows = listings.filter(
		(listing) => listing.isAmazon !== undefined && listing.monthlySales !== undefined && listing.monthlySales >= 0,
	);
	return {
		total: listings.length,
		sellerKnown: listings.filter((listing) => listing.isAmazon !== undefined).length,
		salesKnown: listings.filter((listing) => listing.monthlySales !== undefined && listing.monthlySales >= 0).length,
		usable: usableRows.length,
		salesTotal: usableRows.reduce((sum, listing) => sum + (listing.monthlySales ?? 0), 0),
	};
}

export function amazonSampleDiagnosis(counts: AmazonSampleCounts): string | undefined {
	const { total, sellerKnown, salesKnown, usable, salesTotal } = counts;
	// 没有任何 listing 也要给一句：返回 undefined 会让调用方按「算出来了」走，
	// 于是 0/0=NaN 且挂上一句断言已算出份额的 note（纯关键词 CSV 就会走到这里）。
	// csv.ts 侧有 listings.length > 0 的前置判断，所以这句不会变成导入噪音。
	if (total === 0) return "没有任何 listing 行，无法计算";
	const sellerShort = sellerKnown * 2 < total;
	const salesShort = salesKnown * 2 < total;
	// 月销合计为 0 的提示要排在样本量之后：两个问题同时存在时，「只有 1/100 行可用」
	// 才是主要矛盾，先报「月销被清零」会让运营改完那一格重导、再撞上另一条诊断。
	const zeroSales = salesTotal <= 0 ? `；另外有值的那 ${usable}/${total} 行月销量合计为 0，即使补齐样本也算不出份额——请一并确认月销量列不是被清零或写成了占位符` : "";
	if (usable === 0) {
		if (sellerKnown === 0 && salesKnown === 0) return "卖家类型与月销量两列都没有任何值";
		if (sellerKnown === 0) return "一行都没有卖家类型——请补全自营列，或补一列卖家名称让系统逐行判断";
		if (salesKnown === 0) return "一行都没有月销量——请补全月销量列";
		return `卖家类型 ${sellerKnown}/${total}、月销量 ${salesKnown}/${total}，但没有任何一行两列同时有值——请把两列补到同一批行上`;
	}
	if (usable * 2 < total) {
		if (sellerShort && salesShort) {
			return `卖家类型 ${sellerKnown}/${total}、月销量 ${salesKnown}/${total}，两列都不足半数，只补一列不会改变结论${zeroSales}`;
		}
		if (sellerShort) {
			return `卖家类型仅 ${sellerKnown}/${total} 行有值——请补全自营列，或补一列卖家名称让系统逐行判断${zeroSales}`;
		}
		if (salesShort) {
			return `卖家类型有 ${sellerKnown}/${total} 行，但同时有月销量的仅 ${usable}/${total} 行——缺的是月销量列，请补全它${zeroSales}`;
		}
		return `卖家类型 ${sellerKnown}/${total}、月销量 ${salesKnown}/${total} 各自都不算少，但两列的缺口落在不同行上，同时有值的只有 ${usable}/${total} 行——请把两列补到同一批行上${zeroSales}`;
	}
	if (salesTotal <= 0) {
		return `有值的 ${usable}/${total} 行月销量合计为 0，份额按月销加权、分母为 0 算不出来——请确认月销量列不是被清零或写成了占位符`;
	}
	return undefined;
}

export function dedupeKeywordRecords(keywords: KeywordRecord[]): KeywordDedupeResult {
	const groups = new Map<string, KeywordRecord[]>();
	for (const record of keywords) {
		const key = keywordKey(record.keyword);
		const bucket = groups.get(key);
		if (bucket) bucket.push(record);
		else groups.set(key, [record]);
	}
	if (groups.size === keywords.length) return { keywords, duplicateRows: 0, conflicts: [] };

	const unique: KeywordRecord[] = [];
	const conflicts: KeywordDedupeResult["conflicts"] = [];
	for (const rows of groups.values()) {
		const first = rows[0];
		const distinctOf = (field: "searchVolume" | "cpc" | "rank"): number[] => [
			...new Set(rows.map((row) => row[field]).filter((value): value is number => value !== undefined)),
		];
		const volumes = distinctOf("searchVolume");
		const cpcs = distinctOf("cpc");
		const ranks = distinctOf("rank");
		// 行号要指向**实际被保留的那个值**所在的行：保留的是第一个出现的非空值，
		// 而组内首行未必带这一列（宽表里同一关键词的多行常常只有一行填了搜索量）。
		// 报组内首行会把人带到一个根本看不到该值的位置。
		const keptRow = (field: "searchVolume" | "cpc", value: number): number =>
			(rows.find((row) => row[field] === value) ?? first).sourceRow;
		if (volumes.length > 1) {
			conflicts.push({ keyword: first.keyword, field: "searchVolume", sourceRow: keptRow("searchVolume", volumes[0]!), kept: volumes[0], dropped: volumes.slice(1) });
		}
		if (cpcs.length > 1) {
			conflicts.push({ keyword: first.keyword, field: "cpc", sourceRow: keptRow("cpc", cpcs[0]!), kept: cpcs[0], dropped: cpcs.slice(1) });
		}
		unique.push({
			keyword: first.keyword,
			searchVolume: volumes.length ? volumes[0] : undefined,
			cpc: cpcs.length ? cpcs[0] : undefined,
			// rank 与 listing 共用同一列：宽表里每行的 rank 是该 listing 的 BSR，不是词排名。
			// 组内取值不一致时降级为缺失，绝不把 listing 排名冒充成关键词排名。
			rank: ranks.length === 1 ? ranks[0] : undefined,
			sourceRow: first.sourceRow,
		});
	}
	return { keywords: unique, duplicateRows: keywords.length - unique.length, conflicts };
}

export function parseMarketCsv(
	text: string,
	options: { source?: string; capturedAt?: string } = {},
): ParsedMarketCsv {
	const delimiter = detectDelimiter(text);
	const parsedDelimited = parseDelimitedInternal(text.replace(/^﻿/, ""), delimiter);
	const rows = parsedDelimited.rows;
	if (rows.length < 2) throw new Error("CSV 至少需要表头和一行数据");

	const headers = rows[0].map((header) => header.trim());
	const columns = mapColumns(headers);
	const source = detectSource(headers, options.source);
	const capturedAt = options.capturedAt ?? new Date().toISOString();
	const listings: ListingRecord[] = [];
	const keywordRows: KeywordRecord[] = [];
	const warnings: string[] = [];

	// GBK/GB18030 被当 UTF-8 读进来时中文表头会整片变成替换字符，只剩 ASIN 这类 ASCII 列还能
	// 映射上，于是静默落一份全空指标的快照——快照不可变，只能重导才能修。表头带乱码且几乎
	// 没映射到列时直接拒绝导入，不把「缺数据」伪装成一次成功导入。
	const garbledHeaders = headers.filter((header) => header.includes(REPLACEMENT_CHAR));
	if (garbledHeaders.length > 0) {
		const mappedCount = Object.keys(columns).length;
		if (mappedCount <= 1) {
			throw new Error(
				`CSV 表头疑似编码错误：${garbledHeaders.length} 个表头含乱码字符「${REPLACEMENT_CHAR}」，只识别到 ${mappedCount} 个字段；请用 Excel 另存为「CSV UTF-8」后重新导入`,
			);
		}
		warnings.push(
			`CSV 有 ${garbledHeaders.length} 个表头含乱码字符「${REPLACEMENT_CHAR}」，相关列未被识别；建议用 Excel 另存为「CSV UTF-8」后重新导入`,
		);
	}

	// 「映射到了数值列 + 原始值非空 + 解析不出数字」的单元格，用 `行号:字段` 去重
	// （排名列会被 listing 与 keyword 各读一次，同一个单元格只能计一次）。
	const unparsedNumericCells = new Set<string>();
	const numericCell = (
		row: string[],
		rowIndex: number,
		field: string,
		parse: (value: string | undefined) => number | undefined = parseNumeric,
	): number | undefined => {
		const raw = cell(row, columns, field);
		if (raw === undefined) return undefined;
		const parsed = parse(raw);
		if (parsed === undefined) unparsedNumericCells.add(`${rowIndex}:${field}`);
		return parsed;
	};
	if (parsedDelimited.unclosedQuote) warnings.push("检测到未闭合的 CSV 引号；文件末尾内容可能被合并为同一行，请检查原文件");

	let launchDateCells = 0;
	let launchDateParsed = 0;
	for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
		const row = rows[rowIndex];
		const sourceRow = rowIndex + 1;
		const launchDateCell = cell(row, columns, "launchDate");
		const launchDate = parseDate(launchDateCell);
		const explicitMonths = numericCell(row, rowIndex, "monthsOnline");
		const seller = cell(row, columns, "seller");
		const explicitAmazon = parseBoolean(cell(row, columns, "isAmazon"));
		const isAmazon =
			explicitAmazon ?? (seller ? /(?:amazon|amz|亚马逊自营)/i.test(seller.normalize("NFKC")) : undefined);
		const monthlySales = numericCell(row, rowIndex, "monthlySales");
		const price = numericCell(row, rowIndex, "price");
		const monthlyRevenue = numericCell(row, rowIndex, "monthlyRevenue") ??
			(monthlySales !== undefined && price !== undefined ? monthlySales * price : undefined);

		const listingIdentity = cell(row, columns, "asin") ?? cell(row, columns, "title");
		if (listingIdentity) {
			// 上架日期的识别率只在 listing 行上统计：纯关键词行即使误带日期单元格也不该进分母。
			if (launchDateCell !== undefined) {
				launchDateCells++;
				if (launchDate !== undefined) launchDateParsed++;
			}
			listings.push({
				asin: cell(row, columns, "asin")?.toUpperCase(),
				title: cell(row, columns, "title"),
				rank: Math.max(1, Math.round(numericCell(row, rowIndex, "rank") ?? listings.length + 1)),
				price,
				rating: numericCell(row, rowIndex, "rating", parseRating),
				reviewCount: numericCell(row, rowIndex, "reviewCount"),
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
			keywordRows.push({
				keyword,
				searchVolume: numericCell(row, rowIndex, "searchVolume"),
				cpc: numericCell(row, rowIndex, "cpc"),
				rank: numericCell(row, rowIndex, "rank"),
				sourceRow,
			});
		}
	}

	const deduped = dedupeKeywordRecords(keywordRows);
	const keywords = deduped.keywords;

	if (listings.length === 0 && keywords.length === 0) {
		const delimiterLabel = delimiter === "\t" ? "制表符" : `“${delimiter}”`;
		const headerPreview = headers.slice(0, 8).map((header) => header.replace(/\t/g, "⇥")).join(" | ") +
			(headers.length > 8 ? " | …" : "");
		const suspectDelimiter = headers.some((header) => header.includes("\t"))
			? "；表头单元格里还留着制表符（显示为 ⇥），分隔符很可能识别错了"
			: headers.length === 1
				? `；表头按${delimiterLabel}只切出 1 列，分隔符很可能识别错了`
				: "";
		throw new Error(
			`没有识别到商品或关键词行；请检查 CSV 表头映射（分隔符=${delimiterLabel}，切出 ${headers.length} 列：${headerPreview}）${suspectDelimiter}`,
		);
	}
	if (listings.length > 0 && !Object.hasOwn(columns, "monthlySales")) {
		warnings.push("未识别到月销量列，QRD、CR3、HHI 等销量指标会缺失或降置信度");
	}
	if (listings.length > 0 && !Object.hasOwn(columns, "brand")) {
		warnings.push("未识别到品牌列，品牌集中度指标不可计算");
	}
	if (listings.length > 0 && !Object.hasOwn(columns, "rating")) {
		warnings.push("未识别到评分列，低分高销数与腰部星级指标不可计算");
	}
	if (listings.length > 0 && !Object.hasOwn(columns, "launchDate") && !Object.hasOwn(columns, "monthsOnline")) {
		warnings.push("未识别到上架日期/月龄，新品占比不可计算");
	}
	// 判据看的是逐行回退（卖家名匹配）之后的最终结果，因此带卖家列的文件不会被误报。
	// 行集必须与指标一致（排名前 100）：按全部行判会让 200 行的文件出现
	// 「告警说算出来了、指标却是缺数据」这种相反结论。
	const amazonJudged = rankedTop100(listings);
	const amazonCounts = amazonSampleCounts(amazonJudged);
	const scopeHint = listings.length > amazonJudged.length ? `（按排名前 ${amazonJudged.length} 行判定，与指标口径一致）` : "";
	if (listings.length > 0 && !Object.hasOwn(columns, "isAmazon") && !Object.hasOwn(columns, "seller")) {
		warnings.push("未识别到卖家类型/自营列，AMZ 自营占比不可计算");
	} else if (listings.length > 0) {
		const diagnosis = amazonSampleDiagnosis(amazonCounts);
		if (diagnosis) {
			warnings.push(`${AMZ_MISSING_PREFIX}${scopeHint}：${diagnosis}。补齐后重新导入。`);
		} else if (amazonCounts.usable < amazonCounts.total) {
			warnings.push(
				`${AMZ_MISSING_PREFIX.replace("按缺失处理并转人工复核", "的有效样本")} ${amazonCounts.usable}/${amazonCounts.total} 行${scopeHint}（需卖家类型与月销量同时有值），按已知样本计算，置信度已相应下调`,
			);
		}
	}
	if (launchDateCells > 0 && launchDateParsed * 2 < launchDateCells) {
		warnings.push(
			`上架日期列有 ${launchDateCells - launchDateParsed}/${launchDateCells} 个值无法识别，已按缺失处理；新品占比等月龄指标会降置信度，请核对日期格式`,
		);
	}
	if (unparsedNumericCells.size > 0) {
		const perField = new Map<string, number>();
		for (const key of unparsedNumericCells) {
			const field = key.slice(key.indexOf(":") + 1);
			perField.set(field, (perField.get(field) ?? 0) + 1);
		}
		const detail = [...perField.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([field, count]) => `${NUMERIC_FIELD_LABELS[field] ?? field} ${count}`)
			.join("、");
		warnings.push(
			`${unparsedNumericCells.size} 个数值单元格无法解析为数字（占位文本、超出取值范围或单位异常），已按缺失处理：${detail}；相关指标的样本量与置信度已相应下调`,
		);
	}
	if (listings.length > 100) warnings.push(`导入 ${listings.length} 条 listing；市场指标按排名前100计算，其余行仍保留在快照中`);
	const rankHeaders = headers.map(normalizeHeader).filter((header) => NORMALIZED_ALIASES.rank.has(header));
	if (rankHeaders.includes(normalizeHeader("序号")) && rankHeaders.some((header) => header !== normalizeHeader("序号"))) {
		warnings.push("同时识别到“序号”和正式排名列，已优先使用正式排名列");
	}
	if (deduped.duplicateRows > 0) {
		warnings.push(
			`关键词行去重：${keywordRows.length} 行折叠为 ${keywords.length} 个词（重复 ${deduped.duplicateRows} 行）；词族搜索量按去重后合计，避免同一个词被重复累加`,
		);
		for (const conflict of deduped.conflicts.slice(0, 3)) {
			const label = conflict.field === "cpc" ? "CPC" : "搜索量";
			warnings.push(
				`关键词“${conflict.keyword}”的重复行给出了不一致的${label}：保留第 ${conflict.sourceRow} 行的 ${conflict.kept}，忽略 ${conflict.dropped.join("、")}；请核对原文件`,
			);
		}
		if (deduped.conflicts.length > 3) {
			warnings.push(`另有 ${deduped.conflicts.length - 3} 处关键词数值冲突未逐条列出，请核对原文件`);
		}
		const listingRows = new Set(listings.map((listing) => listing.sourceRow));
		if (keywordRows.every((record) => listingRows.has(record.sourceRow))) {
			warnings.push(
				`疑似宽表布局：关键词随每条 listing 行重复出现（${keywordRows.length} 行 → ${keywords.length} 个词），词族很可能不完整；请补充独立的关键词表后重新导入，再据此判断需求`,
			);
		}
	}

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

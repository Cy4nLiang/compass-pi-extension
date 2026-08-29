// 罗盘 Compass — 报告 Markdown 渲染器（浏览器 + node:test 共用的纯函数模块）
//
// 只服务「五维报告弹窗」一个场景：把 report.ts 输出的 Markdown 子集渲染成 HTML。
// 这不是通用 Markdown 实现，覆盖范围严格对齐 report.ts 实际会生成的语法——
// ATX 标题、引用块、无序/有序列表、GFM 表格（含 `---:` 对齐与 `\|` 转义单元格）、
// 分隔线、段落，行内支持 **粗体** / *斜体* / `代码` / [文本](链接)。
//
// 刻意不支持（report.ts 不生成，也别去生成——括号里是实测的退化行为）：
// - 嵌套列表（2 空格缩进被拉平成同级 <li>，4 空格缩进直接掉出列表变段落，都与 GitHub 不一致）
// - 围栏代码块 ```（整段当普通段落，反引号原样显示）
// - setext 标题（`标题\n====` 变段落）
// - 下划线强调 __粗__ / _斜_（原样输出）
// - ***三星号***（渲染成 <strong>*…</strong>*，漏出裸的 *；单独一行的 *** 是分隔线）
// 生成侧新增语法前先回这里对表：落盘的 .md 还要过 GitHub 与 pi TUI（marked）两个渲染器，
// 三方行为不一致的语法一律不用。
// 前端零构建、零运行时依赖的约定延伸到这里：不引第三方 Markdown 库，也不走 CDN
// （工作台只绑回环地址，必须能离线打开）。
//
// 安全边界（改动前必读）：报告正文里混着市场名、差评痛点、决策理由等用户自由文本，
// 因此**先整体 HTML 转义、再套我们自己生成的标签**，任何输入都不可能注入**渲染出的 html**；
// 注意这条只覆盖返回值的 html 那一半，toc[].text 是未转义的纯文本，见 renderMarkdown 的 JSDoc；
// 链接只放行 http/https/mailto，其余（javascript:、data: 等）原样退回成纯文本。
// 顺序反过来（先套标签再转义）会把生成的标签一起转义掉，先转义再拼是唯一正确的方向。

const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

// 行内代码占位符用 U+0000 包裹：HTML 转义后的正文里不可能出现控制字符
// （renderInline 入口先把输入自带的 U+0000 清掉），因此占位符不会与内容撞车
const PLACEHOLDER = "\u0000";

const UL_RE = /^ {0,3}[-*+][ \t]+(.*)$/;
const OL_RE = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const HR_RE = /^ {0,3}(-{3,}|\*{3,}|_{3,})[ \t]*$/;
const QUOTE_RE = /^ {0,3}>/;
const TABLE_ROW_RE = /^ {0,3}\|/;

// 白名单式协议放行：只认这三种前缀，其余一律不生成 <a>。
// 用「必须匹配」而不是「必须不匹配 javascript:」——黑名单挡不住 data: / vbscript: /
// 大小写与实体变形，白名单没有这个问题。
function safeUrl(target) {
	return /^(https?:\/\/|mailto:)/i.test(target) ? target : null;
}

const TOKEN_RE = new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g");
const LINK_RE = /\[([^\]]*)\]\(([^()\s]+)\)/g;

// 单趟还原就够：存进 tokens 的片段本身不再含占位符——链接与粗体片段在入栈前
// 都已经把内部的占位符还原过了。String.replace 不会重扫自己插入的内容，
// 若哪天新增一种「片段里还留着占位符」的 token，这里必须改成多趟。
function restoreTokens(text, tokens) {
	return text.replace(TOKEN_RE, (_whole, index) => tokens[Number(index)] ?? "");
}

function applyItalic(text) {
	return text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
}

// 粗体必须惰性匹配、且整段抽成占位符再递归处理内部，两件事缺一不可：
// - 用 `[^*]+` 的话，报告把 lesson 标题这类用户自由文本整段包进 **…**，里面出现一个 `5*7`
//   就会让整对粗体失配，弹窗里漏出裸的 **；
// - 只改惰性还不够——`**标题 5*7**：说明 5*7 规格` 这种一行里粗体内外各有一个 `*` 的形状
//   （report.ts 第 9 章 lesson 行就是），斜体正则会从粗体内部一路配到粗体外面，
//   生成跨 </strong> 的错位标签并吃掉两个 `*`。占位符把内外隔开，等价于 CommonMark 的嵌套语义。
function applyEmphasis(text, tokens) {
	const out = text.replace(/\*\*(.+?)\*\*/g, (_whole, inner) => {
		// 入栈前就把内部的占位符还原掉，最终还原才能只跑一趟
		tokens.push(`<strong>${restoreTokens(applyItalic(inner), tokens)}</strong>`);
		return `${PLACEHOLDER}${tokens.length - 1}${PLACEHOLDER}`;
	});
	return applyItalic(out);
}

function renderInline(text) {
	const tokens = [];
	// 顺带还原 `\|`：report.ts 的 escapeCell 无条件把 `|` 写成 `\|`，而它不只用在表格行
	// （「状态原因」与 lesson 都是列表项），表格外没有第二处还原它，不补这一手就会漏出字面反斜杠
	let out = escapeHtml(String(text ?? "").replaceAll(PLACEHOLDER, "")).replaceAll("\\|", "|");
	// 代码优先抽走：`**x**` 这类写在反引号里的内容不该被当成粗体
	out = out.replace(/`([^`]+)`/g, (_whole, code) => {
		tokens.push(`<code>${code}</code>`);
		return `${PLACEHOLDER}${tokens.length - 1}${PLACEHOLDER}`;
	});
	// 链接连同标签一起抽走，标签内部的强调就地处理完再入栈。
	// 若像从前那样直接把 <a> 拼进字符串，后面的 ** / * 替换会继续在这串已含标签的文本上跑：
	// URL 里带 `*` 会被改写成 href="…q=<em>rug</em>"（点过去是错地址），
	// 同一行有两条证据链接（report.ts 第 5 章就是这个形状）时还会让 <em> 在前一个 </a> 里
	// 打开、在后一个 <a> 里闭合，浏览器解析时整行链接错乱且吃掉 `*` 字符。
	out = out.replace(LINK_RE, (whole, label, target) => {
		const href = safeUrl(target);
		// 协议不放行时退回原文（已转义），链接文字仍然可读，只是不可点
		if (!href) return whole;
		const inner = restoreTokens(applyEmphasis(label, tokens), tokens) || href;
		// target=_blank 必须配 rel=noopener：被打开页能通过 window.opener 反向操纵工作台
		tokens.push(`<a href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`);
		return `${PLACEHOLDER}${tokens.length - 1}${PLACEHOLDER}`;
	});
	return restoreTokens(applyEmphasis(out, tokens), tokens);
}

// 目录文字用纯文本：剥掉行内标记，避免小目录里出现 ** 与反引号
function stripInline(text) {
	return String(text ?? "")
		.replaceAll("\\|", "|")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/\*([^*\n]+)\*/g, "$1")
		.replace(/\[([^\]]*)\]\([^()\s]+\)/g, "$1")
		.trim();
}

// 表格单元格切分：report.ts 的 escapeCell 把正文里的 `|` 写成 `\|`，
// 按裸 split("|") 切会把一个单元格劈成两半、整行错列，必须逐字符扫描还原转义
function splitRow(line) {
	const text = line.trim();
	const cells = [];
	let current = "";
	let endsWithPipe = false;
	for (let index = 0; index < text.length; index++) {
		const ch = text[index];
		if (ch === "\\" && text[index + 1] === "|") {
			current += "|";
			index++;
			endsWithPipe = false;
			continue;
		}
		if (ch === "|") {
			cells.push(current);
			current = "";
			endsWithPipe = true;
			continue;
		}
		current += ch;
		endsWithPipe = false;
	}
	// 行尾管道只是收边，不产生空单元格；行首同理
	if (!endsWithPipe) cells.push(current);
	if (text.startsWith("|")) cells.shift();
	return cells.map((cell) => cell.trim());
}

function isTableDelimiter(line) {
	if (!TABLE_ROW_RE.test(line)) return false;
	const cells = splitRow(line);
	return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function alignClass(cell) {
	if (!cell) return "";
	const left = cell.startsWith(":");
	const right = cell.endsWith(":");
	if (left && right) return " class=\"md-center\"";
	if (right) return " class=\"md-right\"";
	return "";
}

// 段落收行时用来判断「下一行已经是新块」：漏判会让标题/表格被吞进上一段
function isBlockStart(line) {
	if (!line || !line.trim()) return true;
	return HR_RE.test(line) || HEADING_RE.test(line) || QUOTE_RE.test(line) || UL_RE.test(line) || OL_RE.test(line) || TABLE_ROW_RE.test(line);
}

function renderTable(lines, start, section) {
	const header = splitRow(lines[start]);
	const aligns = splitRow(lines[start + 1]);
	let index = start + 2;
	const rows = [];
	while (index < lines.length && TABLE_ROW_RE.test(lines[index]) && !isTableDelimiter(lines[index])) {
		rows.push(splitRow(lines[index]));
		index++;
	}
	const head = header.map((cell, i) => `<th${alignClass(aligns[i])}>${renderInline(cell)}</th>`).join("");
	const body = rows.map((cells) => {
		// 列数以「表头与本行取大」补齐：多出来的列照样渲染，绝不静默丢内容
		const width = Math.max(header.length, cells.length);
		const tds = [];
		for (let i = 0; i < width; i++) tds.push(`<td${alignClass(aligns[i])}>${renderInline(cells[i] ?? "")}</td>`);
		return `<tr>${tds.join("")}</tr>`;
	}).join("");
	// 横向溢出的表格必须自己进 Tab 序列：只有 Chrome 会隐式把溢出的滚动容器变成焦点目标，
	// Firefox / Safari 不会——不加 tabindex，那两个浏览器里宽表只能用鼠标滚。
	// role + aria-label 是配套的：缺了名字，焦点落到这里在读屏里就是「焦点凭空消失了」。
	// 名字取「所在小节 · 表头首列」而不是统一写死——报告固定九章有 ≥5 张表，同名 region 会把读屏的
	// 地标列表塞满。只取表头首列还不够：五维证据下 D1–D5 各有一张表、首列都叫「指标」，实测撞名 5 次。
	// 不按「是否真的溢出」区分：那要量 scrollWidth，而本模块的约定是纯函数、不碰 DOM
	// （还得挂 resize 重算，弹窗宽度是 min(1120px, 100%)）。代价是最多多几个 Tab 停留点，
	// 换来三个浏览器行为一致、以及 app.js 那份哨兵名单能和原生 Tab 序列一一对应
	const head0 = (header[0] ?? "").replaceAll("\\|", "|").replace(/[*`_]/g, "").trim() || "报告";
	const caption = `${section ? `${section} · ` : ""}${head0} 表格（可横向滚动）`;
	const html = `<div class="md-table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(caption)}"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
	return [html, index];
}

function renderList(lines, start, ordered) {
	const re = ordered ? OL_RE : UL_RE;
	const items = [];
	let index = start;
	while (index < lines.length) {
		const match = re.exec(lines[index]);
		if (match) {
			items.push([ordered ? match[2] : match[1]]);
			index++;
			continue;
		}
		// 缩进续行接到上一条：报告目前不产生，留着是为了不把手写补充内容切碎
		if (items.length && lines[index].trim() && /^[ \t]{2,}/.test(lines[index]) && !isBlockStart(lines[index].trim())) {
			items[items.length - 1].push(lines[index].trim());
			index++;
			continue;
		}
		break;
	}
	const tag = ordered ? "ol" : "ul";
	const body = items.map((parts) => `<li>${parts.map(renderInline).join("<br>")}</li>`).join("");
	return [`<${tag} class="md-list">${body}</${tag}>`, index];
}

// toc 为 null 时表示在引用块内部递归：嵌套标题不进小目录，也不占用 id 序号
function renderBlocks(lines, toc) {
	const out = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (!line.trim()) {
			index++;
			continue;
		}
		if (HR_RE.test(line)) {
			out.push("<hr class=\"md-hr\">");
			index++;
			continue;
		}
		const heading = HEADING_RE.exec(line);
		if (heading) {
			const level = heading[1].length;
			const text = heading[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
			// id 用序号而不是标题 slug：报告标题以中文为主，slug 化后既不可读也不稳定
			const id = toc ? `md-h${toc.length}` : "";
			if (toc) toc.push({ id, level, text: stripInline(text) });
			out.push(`<h${level}${id ? ` id="${id}"` : ""} class="md-h md-h${level}">${renderInline(text)}</h${level}>`);
			index++;
			continue;
		}
		if (TABLE_ROW_RE.test(line) && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
			// toc 末项就是这张表所在的那一节（引用块里 toc 为 null，退化成只用表头首列命名）
			const [html, next] = renderTable(lines, index, toc && toc.length ? toc[toc.length - 1].text : "");
			out.push(html);
			index = next;
			continue;
		}
		if (QUOTE_RE.test(line)) {
			const inner = [];
			while (index < lines.length && QUOTE_RE.test(lines[index])) {
				inner.push(lines[index].replace(/^ {0,3}>[ \t]?/, ""));
				index++;
			}
			out.push(`<blockquote class="md-quote">${renderBlocks(inner, null)}</blockquote>`);
			continue;
		}
		if (UL_RE.test(line) || OL_RE.test(line)) {
			const [html, next] = renderList(lines, index, !UL_RE.test(line));
			out.push(html);
			index = next;
			continue;
		}
		const paragraph = [];
		while (index < lines.length && lines[index].trim() && !(paragraph.length && isBlockStart(lines[index]))) {
			paragraph.push(lines[index].trim());
			index++;
		}
		// 软换行渲染成 <br>：报告里「数据快照 / 策略」这类相邻行是刻意分行的元信息，
		// 按标准 Markdown 合成一行会读成一句话
		out.push(`<p class="md-p">${paragraph.map(renderInline).join("<br>")}</p>`);
	}
	return out.join("\n");
}

/**
 * 把报告 Markdown 渲染成 HTML，并抽出 h2/h3 小目录。
 *
 * 返回值的两半**安全等级不同**：
 * - `html` 已整体 HTML 转义，可以直接 innerHTML；
 * - `toc[].text` 是 stripInline 之后的**纯文本原文、未做 HTML 转义**，调用方插进 DOM 之前
 *   必须自己转（app.js 的 reportTocHtml 用的是 `escapeHtml(item.text)`）。这里不预先转义，
 *   是因为目录文字也可能被拿去做 title / aria-label 等纯文本用途，预转义会让那些场景
 *   显示出 &amp;lt; 这类实体。
 *
 * @param {string} markdown
 * @returns {{ html: string, toc: Array<{ id: string, level: number, text: string }> }}
 */
export function renderMarkdown(markdown) {
	const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
	const toc = [];
	const html = renderBlocks(lines, toc);
	return { html, toc: toc.filter((item) => item.level === 2 || item.level === 3) };
}

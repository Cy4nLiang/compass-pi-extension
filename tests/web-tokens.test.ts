import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// web/assets/tokens.figma.json 是 Figma 暗色工作台 Color 集合的只读快照（纯色值）。style.css 的 :root
// 与它必须逐名同值：设计侧改了颜色只刷新快照，这里先红，再改 CSS；反过来 CSS 里冒出快照没有的
// 名字也要红。全部写成负向全称（差集恰好等于某个集合），不钉计数——计数留余量就等于可以被悄悄改掉的量。
const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, "../web/assets");
const readAsset = (name: string): Promise<string> => readFile(join(assetsDir, name), "utf8");

interface TokenSnapshot {
	file: { key: string; collection: string; modes: Record<string, string>; readAt: string };
	dark: Record<string, string>;
	scale: Record<string, string>;
}

/** 快照有、CSS 目前没有的四条 tier 色：设计稿的分档底色，代码侧还没用上。加进 CSS 后把它从这里删掉。 */
const KNOWN_MISSING_IN_CSS = ["--c-tier-a-bg", "--c-tier-a-border", "--c-tier-b-bg", "--c-tier-b-border"];
/** :root 里允许比快照多出的名字：字体栈与圆角不是 Color 集合的成员 */
const ROOT_EXTRA = ["--f-mono", "--f-sans", "--radius", "--radius-sm"];

const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//gu, "");

/** 从 header 起按花括号配平截出整块（含收尾 `}`） */
function block(source: string, header: string): string {
	const start = source.indexOf(header);
	assert.notEqual(start, -1, `style.css 里找不到 ${header}`);
	let depth = 0;
	for (let i = source.indexOf("{", start); i < source.length; i += 1) {
		if (source[i] === "{") depth += 1;
		else if (source[i] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`${header} 的块没有闭合`);
}

/** 块内的 `--name: value;` 声明（value 去首尾空白、小写） */
function declarations(text: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const match of text.matchAll(/(?:^|[\s;{])(--[a-z0-9-]+)\s*:\s*([^;}]+?)\s*;/gu)) {
		found.set(match[1] ?? "", (match[2] ?? "").toLowerCase());
	}
	return found;
}

const sorted = (keys: Iterable<string>): string[] => [...keys].sort();
const difference = (a: Iterable<string>, b: Iterable<string>): string[] => {
	const exclude = new Set(b);
	return sorted([...a].filter((key) => !exclude.has(key)));
};

async function load(): Promise<{ snapshot: TokenSnapshot; css: string; root: Map<string, string> }> {
	const snapshot = JSON.parse(await readAsset("tokens.figma.json")) as TokenSnapshot;
	const css = stripComments(await readAsset("style.css"));
	return { snapshot, css, root: declarations(block(css, ":root {")) };
}

test("tokens.figma 快照：23 个 --c-* 小写 6 位 hex，file 段指向暗色工作台的 Color 集合", async () => {
	const { snapshot } = await load();
	assert.equal(Object.keys(snapshot.dark).length, 23);
	for (const [name, hex] of Object.entries(snapshot.dark)) {
		assert.match(name, /^--c-[a-z0-9-]+$/u, `键 ${name} 要是裸 --c-x 形式（不带 var()）`);
		assert.match(hex, /^#[0-9a-f]{6}$/u, `${name} 要是小写 6 位 hex：${hex}`);
	}
	assert.deepEqual(snapshot.file, { key: "6fSw84YOQZswY0lGC7BmnO", collection: "VariableCollectionId:2:2", modes: { dark: "2:0" }, readAt: "2026-09-13" });
});

test("tokens.figma 快照的 --c-* 在 style.css :root 同名同值；缺失恰好是 tier-* 四条已知缺口", async () => {
	const { snapshot, root } = await load();
	const missing: string[] = [];
	const mismatched: string[] = [];
	for (const [name, hex] of Object.entries(snapshot.dark)) {
		const value = root.get(name);
		if (value === undefined) missing.push(name);
		else if (value !== hex.toLowerCase()) mismatched.push(`${name}: CSS ${value} ≠ 快照 ${hex}`);
	}
	assert.deepEqual(mismatched, []);
	assert.deepEqual(sorted(missing), KNOWN_MISSING_IN_CSS, "快照有、CSS 无的名字必须恰好是已知缺口；补上了就把它从 KNOWN_MISSING_IN_CSS 删掉");
});

test("tokens.figma：style.css 的 --c-* 没有快照之外的名字；:root 多出的只能是 f-sans / f-mono / radius / radius-sm", async () => {
	const { snapshot, css, root } = await load();
	// 全文件扫（不只 :root）：别的选择器里重新声明一个快照没有的 --c-* 也要红
	const declaredAnywhere = [...css.matchAll(/(?:^|[\s;{])(--c-[a-z0-9-]+)\s*:/gu)].map((match) => match[1] ?? "");
	assert.ok(declaredAnywhere.length > 0, "没扫到任何 --c-* 声明——正则要跟着源码一起改");
	assert.deepEqual(difference(declaredAnywhere, Object.keys(snapshot.dark)), []);
	assert.deepEqual(difference(root.keys(), Object.keys(snapshot.dark)), ROOT_EXTRA);
	assert.deepEqual(ROOT_EXTRA.filter((name) => !root.has(name)), [], "允许集里的每个名字都真的在 :root 里（差集恰好等于不能被空集蒙混）");
});

test("tokens.figma scale：--radius / --radius-sm 与快照同值", async () => {
	const { snapshot, root } = await load();
	assert.deepEqual(sorted(Object.keys(snapshot.scale)), ["--radius", "--radius-sm"]);
	for (const [name, value] of Object.entries(snapshot.scale)) {
		assert.equal(root.get(name), value.toLowerCase(), `${name} 与快照 scale 同值`);
	}
});

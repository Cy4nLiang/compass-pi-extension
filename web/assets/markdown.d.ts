// markdown.js 是浏览器直接加载的 ES 模块（assets/ 下的资源一律不进构建、不写成 .ts），
// 但它是纯函数、可脱离 DOM 运行，所以 tests/web-markdown.test.ts 会直接 import 它跑用例。
// tsconfig 的 include 是 **/*.ts、allowJs 关闭，没有这份声明 tsc 会把那次 import 报成
// TS2307「找不到模块」——即：这个文件只为 npm run check 存在，运行时无人加载。

// 返回值两半的安全等级不同：html 已转义可直接 innerHTML；toc[].text 是未转义的纯文本，
// 调用方插进 DOM 前必须自己转义。详见 markdown.js 里 renderMarkdown 的 JSDoc。
export declare function renderMarkdown(markdown: string): {
	html: string;
	toc: Array<{ id: string; level: number; text: string }>;
};

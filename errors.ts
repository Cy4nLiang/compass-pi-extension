// 领域错误的分类信息落在**类型**上，不落在给人看的中文句子里。
// 调用方（Web 层的 HTTP 状态码分级、service 内部的错误改写）按 instanceof 判定，
// 改一句措辞不会连带改掉状态码，同一概念换个说法也不会掉进另一档。
//
// 与 store.ts 的 StoreIoError 是同一形状、不同分工：那条区分「系统故障 vs 业务拒绝」，
// 这两条区分业务拒绝内部的「实体不存在（404）vs 入参不合法（400）」。
//
// 本文件是零 import 的叶子模块，故意放在仓库根而不是 service.ts / web/ 里：
// 抛出方是编排层、识别方同时有编排层与 Web 层，任何一层定义都会逼出反向 import，
// 而零 import 的叶子被谁 import 都不可能成环（单向分层见 CLAUDE.md「架构」）。
//
// ⚠️ 字段命名禁区：不要给这些类加名为 `code` 的字符串字段。
// web/server.ts 的 errno 兜底判的就是 `typeof error.code === "string"`，
// 领域错误一旦带上它就会被当成文件系统故障吞成 500。

/** 缺失实体的种类。只用于排障与调用方的二次分派，状态码分级只看类型本身 */
export type MissingEntityKind = "market" | "candidate" | "snapshot" | "strategy" | "todo" | "cost_reference";

/** 引用指向的实体不存在（Web 层映射为 404） */
export class NotFoundError extends Error {
	readonly entity: MissingEntityKind;

	constructor(entity: MissingEntityKind, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "NotFoundError";
		this.entity = entity;
	}
}

/** 入参本身不合法：格式、取值范围、引用歧义（Web 层映射为 400） */
export class ValidationError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ValidationError";
	}
}

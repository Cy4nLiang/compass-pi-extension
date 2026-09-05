import assert from "node:assert/strict";

// 四时区行为测试夹具（D-1 缺陷组 ③ 起共用）。
// Node 允许运行期改 process.env.TZ（内部会 tzset 并清 V8 的日期缓存），但 CI 跑在 UTC：
// 「切换没生效」时 UTC 那一轮照样绿，所以每次切换后必须先断言偏移量，否则整条用例假绿。
export const FOUR_TIME_ZONES: ReadonlyArray<{ tz: string; offsets: readonly number[] }> = [
	{ tz: "UTC", offsets: [0] },
	{ tz: "Asia/Shanghai", offsets: [-480] },
	// 夏令时 240（EDT）/ 冬令时 300（EST），取决于探针时刻
	{ tz: "America/New_York", offsets: [240, 300] },
	{ tz: "Pacific/Kiritimati", offsets: [-840] },
];

function assertZoneActive(tz: string, offsets: readonly number[], probe: string): void {
	const offset = new Date(probe).getTimezoneOffset();
	assert.ok(
		offsets.includes(offset),
		`夹具前提：TZ=${tz} 未生效（getTimezoneOffset=${offset}，期望 ${offsets.join(" 或 ")}）`,
	);
}

function restoreTimeZone(original: string | undefined): void {
	if (original === undefined) delete process.env.TZ;
	else process.env.TZ = original;
}

/** 依次在四个时区下跑同一段断言；probe 是不带时区的本地时间串，用来证明切换已生效。 */
export function withTimeZones(probe: string, run: (tz: string) => void): void {
	const original = process.env.TZ;
	try {
		for (const { tz, offsets } of FOUR_TIME_ZONES) {
			process.env.TZ = tz;
			assertZoneActive(tz, offsets, probe);
			run(tz);
		}
	} finally {
		restoreTimeZone(original);
	}
}

/** 只在指定时区下跑一段异步断言（导入链路这类带磁盘 I/O 的用例用）。 */
export async function withTimeZone(tz: string, probe: string, run: () => Promise<void>): Promise<void> {
	const zone = FOUR_TIME_ZONES.find((entry) => entry.tz === tz);
	if (!zone) throw new Error(`未知时区夹具：${tz}`);
	const original = process.env.TZ;
	try {
		process.env.TZ = tz;
		assertZoneActive(tz, zone.offsets, probe);
		await run();
	} finally {
		restoreTimeZone(original);
	}
}

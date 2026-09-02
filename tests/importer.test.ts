import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { snapshotsForMarket } from "../history.ts";
import { normalizeCapturedAt, performCsvImport, type CsvImportDeps } from "../importer.ts";
import { ensureDefaults, generateMarketReport, latestSnapshotIfPresent, scanMarkets } from "../service.ts";
import { CompassRepository } from "../store.ts";
import { marketDossierData } from "../web/data.ts";

const here = dirname(fileURLToPath(import.meta.url));

async function setupProject(): Promise<{ root: string; deps: CsvImportDeps; csvPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "compass-importer-"));
	try {
		const csvPath = join(root, "demo-market.csv");
		await copyFile(join(here, "../examples/demo-market.csv"), csvPath);
		const repo = new CompassRepository(root);
		const deps: CsvImportDeps = {
			repo,
			mutate: (mutator) => repo.update(async (store) => {
				ensureDefaults(store, "test");
				return mutator(store);
			}),
		};
		return { root, deps, csvPath };
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

test("performCsvImport creates market, snapshot, candidate and archives the raw file", async () => {
	const { root, deps, csvPath } = await setupProject();
	try {
		const outcome = await performCsvImport(deps, {
			path: csvPath,
			marketName: "demo market",
			source: "sellersprite",
			capturedAt: "2026-08-22T00:00:00.000Z",
			actor: "tester",
			runScreen: true,
		});
		assert.equal(outcome.market.name, "demo market");
		assert.equal(outcome.snapshot.capturedAt, "2026-08-22T00:00:00.000Z");
		assert.equal(outcome.snapshot.fileName, "demo-market.csv");
		assert.ok(outcome.candidate.gateOutcome, "runScreen=true 应产生粗筛 Gate 结论");
		assert.ok(outcome.archivedFile.includes("raw"), `原始文件应归档到 raw/：${outcome.archivedFile}`);
		const archived = await readdir(join(root, ".pi", "compass", "raw"));
		assert.equal(archived.length, 1);
		// 事务应已持久化：重新从磁盘加载能看到市场与快照
		const reloaded = await deps.repo.load();
		assert.equal(reloaded.markets.length, 1);
		assert.equal(reloaded.snapshots.length, 1);
		assert.equal(reloaded.snapshots[0].fileHash, outcome.snapshot.fileHash);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("performCsvImport rejects duplicate content before archiving anything", async () => {
	const { root, deps, csvPath } = await setupProject();
	try {
		await performCsvImport(deps, { path: csvPath, marketName: "demo market", source: "sellersprite", actor: "tester" });
		await assert.rejects(
			performCsvImport(deps, { path: csvPath, marketName: "demo market again", source: "sellersprite", actor: "tester" }),
			/重复 CSV/,
		);
		const archived = await readdir(join(root, ".pi", "compass", "raw"));
		assert.equal(archived.length, 1, "重复导入不得再次归档原始文件");
		const reloaded = await deps.repo.load();
		assert.equal(reloaded.snapshots.length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("performCsvImport refuses paths outside the project root", async () => {
	const { root, deps } = await setupProject();
	try {
		await assert.rejects(
			performCsvImport(deps, { path: join(here, "../examples/demo-market.csv"), marketName: "demo", actor: "tester" }),
			/项目目录内/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("normalizeCapturedAt normalizes valid input and rejects garbage", () => {
	assert.equal(normalizeCapturedAt("2026-08-22"), "2026-08-22T00:00:00.000Z");
	assert.throws(() => normalizeCapturedAt("not-a-date"), /captured_at 无效/);
	const fallback = normalizeCapturedAt();
	assert.ok(Number.isFinite(new Date(fallback).getTime()));
});


// —— 审计 M19 回归 ——
test("performCsvImport decodes a GBK export and carries the encoding warning into the snapshot", async () => {
	const { root, deps } = await setupProject();
	try {
		// ASIN,月销量,价格\nB0GBKDEMO1,1250,19.99\n 的 GBK 字节（虚构数据）
		const gbkPath = join(root, "gbk-market.csv");
		await writeFile(gbkPath, Buffer.from([
			0x41, 0x53, 0x49, 0x4e, 0x2c, 0xd4, 0xc2, 0xcf, 0xfa, 0xc1, 0xbf, 0x2c, 0xbc, 0xdb, 0xb8, 0xf1,
			0x0a, 0x42, 0x30, 0x47, 0x42, 0x4b, 0x44, 0x45, 0x4d, 0x4f, 0x31, 0x2c, 0x31, 0x32, 0x35, 0x30,
			0x2c, 0x31, 0x39, 0x2e, 0x39, 0x39, 0x0a,
		]));
		const outcome = await performCsvImport(deps, {
			path: gbkPath,
			marketName: "gbk market",
			source: "generic_csv",
			capturedAt: "2026-08-22T00:00:00.000Z",
			actor: "tester",
		});
		assert.deepEqual(outcome.parsed.mappedFields, ["asin", "price", "monthlySales"]);
		assert.equal(outcome.parsed.listings[0].monthlySales, 1250);
		assert.ok(outcome.snapshot.warnings.some((warning) => warning.includes("GB18030")), JSON.stringify(outcome.snapshot.warnings));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// —— 审计 G6/G7 回归 ——
test("normalizeCapturedAt 拒绝未来与史前日期，但给跨时区留 36 小时余量", () => {
	const now = Date.parse("2026-09-01T00:00:00.000Z");
	// 向导按运营本地日发纯日期，UTC+14 的运营会天然超前十几个小时：必须放行
	assert.equal(normalizeCapturedAt("2026-09-01", now), "2026-09-01T00:00:00.000Z");
	assert.equal(normalizeCapturedAt("2026-09-02T11:59:00.000Z", now), "2026-09-02T11:59:00.000Z");
	// 恰好 36 小时是上界（含端点）
	assert.equal(normalizeCapturedAt("2026-09-02T12:00:00.000Z", now), "2026-09-02T12:00:00.000Z");
	// 手滑把 2026 打成 2062：拒绝，而不是让它永久占住「最新快照」
	assert.throws(() => normalizeCapturedAt("2062-09-01", now), /captured_at 不能晚于当前时间 36 小时/);
	assert.throws(() => normalizeCapturedAt("2026-09-02T12:00:00.001Z", now), /captured_at 不能晚于当前时间 36 小时/);
	// 下界：2000-01-01 之前一律判手滑
	assert.throws(() => normalizeCapturedAt("1026-08-22", now), /captured_at 过早/);
	assert.equal(normalizeCapturedAt("2000-01-01", now), "2000-01-01T00:00:00.000Z");
});


// —— 审计 G6/G7 回归 ——
test("performCsvImport 拒绝未来 captured_at，且不留归档与快照", async () => {
	const { root, deps, csvPath } = await setupProject();
	try {
		await assert.rejects(
			performCsvImport(deps, { path: csvPath, marketName: "future market", capturedAt: "2062-09-01", actor: "tester" }),
			/captured_at 不能晚于当前时间 36 小时/,
		);
		await assert.rejects(readdir(join(root, ".pi", "compass", "raw")), /ENOENT/);
		const reloaded = await deps.repo.load();
		assert.equal(reloaded.snapshots.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});


// —— 审计 G6/G7 回归 ——
test("补录早于现有最新的快照时，成功页警告说明读面仍用更新的那份", async () => {
	const { root, deps, csvPath } = await setupProject();
	try {
		const latest = await performCsvImport(deps, { path: csvPath, marketName: "backfill", source: "sorftime", capturedAt: "2026-08-28", actor: "tester", runScreen: false });
		const backfillPath = join(root, "backfill.csv");
		await writeFile(backfillPath, `${await readFile(csvPath, "utf8")}B0DEMO8888,Backfill Row,26,11.99,4.0,10,40,Extra,Third Party,3,Sports & Outdoors,backfill kw,100,0.5\n`);
		const older = await performCsvImport(deps, { path: backfillPath, marketName: "backfill", source: "sorftime", capturedAt: "2026-08-20", actor: "tester", runScreen: false });
		assert.ok(
			older.snapshot.warnings.some((warning) => warning.includes(latest.snapshot.id) && warning.includes("早于")),
			JSON.stringify(older.snapshot.warnings),
		);
		const store = await deps.repo.load();
		assert.equal(latestSnapshotIfPresent(store, older.market.id)?.id, latest.snapshot.id, "补录不得夺走「最新」");
		// 正向导入不得夹带该警告
		assert.deepEqual(latest.snapshot.warnings, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});


// —— 审计 G6/G7 回归 ——
test("同日重导的修正版快照在所有读面胜出（capturedAt 相同则比 importedAt）", async () => {
	const { root, deps, csvPath } = await setupProject();
	try {
		const original = await performCsvImport(deps, { path: csvPath, marketName: "duffle", source: "sorftime", capturedAt: "2026-09-01", actor: "tester", runScreen: true });
		// 修正版：同一份 CSV 多一行（内容 hash 不同才不会被查重拦下），采集日期仍是同一天
		const fixedPath = join(root, "fixed.csv");
		await writeFile(fixedPath, `${await readFile(csvPath, "utf8")}B0DEMO9999,Extra Row,26,12.99,4.0,10,40,Extra,Third Party,3,Sports & Outdoors,extra kw,100,0.5\n`);
		const fixed = await performCsvImport(deps, { path: fixedPath, marketName: "duffle", source: "sorftime", capturedAt: "2026-09-01", actor: "tester", runScreen: true });

		assert.equal(fixed.snapshot.capturedAt, original.snapshot.capturedAt, "两份快照的 capturedAt 应当相同，用来锁住平局场景");
		assert.ok(fixed.snapshot.importedAt > original.snapshot.importedAt);

		const store = await deps.repo.load();
		const marketId = original.market.id;
		assert.equal(latestSnapshotIfPresent(store, marketId)?.id, fixed.snapshot.id, "service 取最新必须是修正版");
		assert.equal(snapshotsForMarket(store, marketId)[0].id, fixed.snapshot.id, "历史面取最新必须是修正版");
		assert.equal(scanMarkets(store, {})[0]?.snapshot.id, fixed.snapshot.id, "粗筛必须用修正版");
		assert.equal(marketDossierData(store, marketId).snapshot?.id, fixed.snapshot.id, "Web 市场档案必须用修正版");
		assert.match(generateMarketReport(store, marketId).markdown, new RegExp(fixed.snapshot.id, "u"));
		// 导入成功页展示的快照与其 Gate 结论必须出自同一份快照
		const latestRun = store.strategyRuns.filter((run) => run.marketId === marketId).sort((a, b) => b.runAt.localeCompare(a.runAt))[0];
		assert.equal(latestRun?.snapshotId, fixed.snapshot.id, "粗筛 Gate 的结论必须出自导入成功页展示的那份快照");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});


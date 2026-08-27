import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeCapturedAt, performCsvImport, type CsvImportDeps } from "../importer.ts";
import { ensureDefaults } from "../service.ts";
import { CompassRepository } from "../store.ts";

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

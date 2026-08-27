import assert from "node:assert/strict";
import test from "node:test";
import { amazonProductUrl, amazonSearchUrl, marketAmazonLinks } from "../service.ts";
import { createEmptyStore } from "../store.ts";
import type { CompassStore, ListingRecord } from "../types.ts";

const AT = "2026-08-27T00:00:00.000Z";

function addMarket(store: CompassStore, id: string, keywords: string[]): void {
	store.markets.push({ id, name: `market ${id}`, keywords, createdAt: AT, updatedAt: AT });
}

function addSnapshot(store: CompassStore, id: string, marketId: string, listings: ListingRecord[], capturedAt = AT): void {
	store.snapshots.push({ id, marketId, source: "sellersprite", capturedAt, importedAt: capturedAt, rowCount: listings.length, listings, keywords: [], metrics: {}, warnings: [] });
}

function listing(rank: number, asin?: string, extra: Partial<ListingRecord> = {}): ListingRecord {
	return { rank, asin, sourceRow: rank, ...extra };
}

test("amazonProductUrl whitelists and normalizes ASINs", () => {
	assert.equal(amazonProductUrl("B0ABC12345"), "https://www.amazon.com/dp/B0ABC12345");
	// CSV 常见小写/带空白形态归一为大写
	assert.equal(amazonProductUrl("b0abc12345"), "https://www.amazon.com/dp/B0ABC12345");
	assert.equal(amazonProductUrl(" B0ABC12345 "), "https://www.amazon.com/dp/B0ABC12345");
	assert.equal(amazonProductUrl("B0ABC1234"), undefined);
	assert.equal(amazonProductUrl("B0ABC123456"), undefined);
	assert.equal(amazonProductUrl('B0ABC12"45'), undefined);
	assert.equal(amazonProductUrl("B0ABC12<45"), undefined);
	assert.equal(amazonProductUrl(""), undefined);
	assert.equal(amazonProductUrl(undefined), undefined);
});

test("amazonSearchUrl URL-encodes keywords", () => {
	assert.equal(amazonSearchUrl("clear duffle bag"), "https://www.amazon.com/s?k=clear%20duffle%20bag");
	assert.equal(amazonSearchUrl(" 瑜伽垫 绑带 "), `https://www.amazon.com/s?k=${encodeURIComponent("瑜伽垫 绑带")}`);
	assert.equal(amazonSearchUrl('a&b="c"'), `https://www.amazon.com/s?k=${encodeURIComponent('a&b="c"')}`);
});

test("marketAmazonLinks picks top-ranked listings and caps keywords", () => {
	const store = createEmptyStore();
	addMarket(store, "m1", ["kw one", "kw two", "kw three", "kw four", "  "]);
	addSnapshot(store, "s1", "m1", [
		listing(5, "B000000005"),
		listing(1, "B000000001", { title: "Top item", price: 24.99, rating: 4.6, monthlySales: 3200 }),
		listing(3, "bad asin!!"),
		listing(2, undefined),
		listing(4, "B000000004"),
		listing(6, "B000000006"),
	]);
	const links = marketAmazonLinks(store, "m1");
	assert.deepEqual(links.searches.map((item) => item.keyword), ["kw one", "kw two", "kw three"]);
	assert.equal(links.searches[0].url, "https://www.amazon.com/s?k=kw%20one");
	assert.deepEqual(links.topListings.map((item) => item.rank), [1, 2, 3, 4, 5]);
	assert.equal(links.topListings[0].url, "https://www.amazon.com/dp/B000000001");
	assert.equal(links.topListings[0].price, 24.99);
	// 无 ASIN / 非法 ASIN：保留参考数据但不带链接
	assert.equal(links.topListings[1].url, undefined);
	assert.equal(links.topListings[2].asin, "bad asin!!");
	assert.equal(links.topListings[2].url, undefined);
});

test("marketAmazonLinks honors topN/maxKeywords options and uses the latest snapshot", () => {
	const store = createEmptyStore();
	addMarket(store, "m1", ["kw one", "kw two"]);
	addSnapshot(store, "old", "m1", [listing(1, "B00000OLD1")], "2026-08-01T00:00:00.000Z");
	addSnapshot(store, "new", "m1", [listing(1, "B00000NEW1"), listing(2, "B00000NEW2")], "2026-08-20T00:00:00.000Z");
	const links = marketAmazonLinks(store, "m1", { topN: 1, maxKeywords: 1 });
	assert.equal(links.searches.length, 1);
	assert.equal(links.topListings.length, 1);
	assert.equal(links.topListings[0].url, "https://www.amazon.com/dp/B00000NEW1");
});

test("marketAmazonLinks degrades non-finite numeric fields to missing", () => {
	const store = createEmptyStore();
	addMarket(store, "m1", []);
	// 手改 sidecar 可能混入字符串数值（"12.99"）或 NaN：前端 toFixed 会抛错，helper 必须先降级
	addSnapshot(store, "s1", "m1", [
		listing(1, "B000000001", { price: "12.99" as unknown as number, rating: Number.NaN, monthlySales: 3200 }),
	]);
	const [row] = marketAmazonLinks(store, "m1").topListings;
	assert.equal(row.price, undefined);
	assert.equal(row.rating, undefined);
	assert.equal(row.monthlySales, 3200);
});

test("marketAmazonLinks returns an empty structure without snapshot or market", () => {
	const store = createEmptyStore();
	addMarket(store, "m1", ["kw one"]);
	const noSnapshot = marketAmazonLinks(store, "m1");
	assert.equal(noSnapshot.searches.length, 1);
	assert.deepEqual(noSnapshot.topListings, []);
	const unknown = marketAmazonLinks(store, "does-not-exist");
	assert.deepEqual(unknown, { searches: [], topListings: [] });
	// 市场存在但关键词为空/全空白（filter(Boolean) 分支的直接观测点）
	addMarket(store, "m2", ["   "]);
	assert.deepEqual(marketAmazonLinks(store, "m2").searches, []);
});

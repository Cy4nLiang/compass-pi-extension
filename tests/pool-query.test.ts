import assert from "node:assert/strict";
import test from "node:test";
import { candidateDetail, listPoolCandidates } from "../service.ts";
import { createEmptyStore } from "../store.ts";
import type { Candidate, CandidateStage, CompassStore, DecisionLog } from "../types.ts";

function baseStore(): CompassStore {
	return createEmptyStore("2026-08-01T00:00:00.000Z");
}

function addMarket(store: CompassStore, id: string, name: string): void {
	store.markets.push({ id, name, keywords: [], createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" });
}

function addCandidate(store: CompassStore, id: string, marketId: string, stage: CandidateStage, extra: Partial<Candidate> = {}): Candidate {
	const candidate: Candidate = { id, marketId, stage, tags: [], createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", ...extra };
	store.candidates.push(candidate);
	return candidate;
}

function addDecision(store: CompassStore, id: string, candidateId: string, createdAt: string, extra: Partial<DecisionLog> = {}): void {
	const marketId = store.candidates.find((candidate) => candidate.id === candidateId)?.marketId ?? "m1";
	store.decisionLog.push({ id, candidateId, marketId, type: "stage_move", conclusion: "c", reason: "r", actor: "t", createdAt, ...extra });
}

function seededStore(): CompassStore {
	const store = baseStore();
	addMarket(store, "m1", "Clear Duffle Bag");
	addMarket(store, "m2", "Toiletry Organizer");
	addCandidate(store, "cand1", "m1", "deep_research", { gateOutcome: "review", decisionStatus: "waitlist", score: 82.6 });
	addCandidate(store, "cand2", "m2", "deep_research", { gateOutcome: "review" });
	addCandidate(store, "cand3", "m2", "archived", { gateOutcome: "reject", decisionStatus: "no_go" });
	return store;
}

test("listPoolCandidates without filter returns all candidates with market names", () => {
	const items = listPoolCandidates(seededStore());
	assert.equal(items.length, 3);
	assert.deepEqual(items.map((item) => item.candidate.id), ["cand1", "cand2", "cand3"]);
	assert.equal(items[0].marketName, "Clear Duffle Bag");
	assert.equal(items[1].marketName, "Toiletry Organizer");
});

test("listPoolCandidates filters by stage, outcome and decisionStatus", () => {
	const store = seededStore();
	assert.deepEqual(listPoolCandidates(store, { stage: "archived" }).map((item) => item.candidate.id), ["cand3"]);
	assert.deepEqual(listPoolCandidates(store, { outcome: "review" }).map((item) => item.candidate.id), ["cand1", "cand2"]);
	assert.deepEqual(listPoolCandidates(store, { decisionStatus: "waitlist" }).map((item) => item.candidate.id), ["cand1"]);
	assert.deepEqual(listPoolCandidates(store, { stage: "deep_research", decisionStatus: "no_go" }), []);
});

test("listPoolCandidates keeps candidate without market resolvable", () => {
	const store = seededStore();
	addCandidate(store, "orphan", "missing-market", "lead");
	const items = listPoolCandidates(store, { stage: "lead" });
	assert.equal(items.length, 1);
	assert.equal(items[0].marketName, undefined);
});

test("candidateDetail returns decisions sorted by createdAt descending", () => {
	const store = seededStore();
	addDecision(store, "d1", "cand1", "2026-08-02T00:00:00.000Z");
	addDecision(store, "d2", "cand1", "2026-08-05T00:00:00.000Z", { type: "decision" });
	addDecision(store, "d3", "cand1", "2026-08-03T00:00:00.000Z");
	addDecision(store, "other", "cand2", "2026-08-09T00:00:00.000Z");
	const detail = candidateDetail(store, "cand1");
	assert.equal(detail.candidate.id, "cand1");
	assert.equal(detail.marketName, "Clear Duffle Bag");
	assert.deepEqual(detail.decisions.map((decision) => decision.id), ["d2", "d3", "d1"]);
});

test("candidateDetail resolves by market reference and throws on unknown ref", () => {
	const store = seededStore();
	const detail = candidateDetail(store, "Clear Duffle Bag");
	assert.equal(detail.candidate.id, "cand1");
	assert.deepEqual(detail.decisions, []);
	assert.throws(() => candidateDetail(store, "no-such-candidate"), /未找到候选/);
});

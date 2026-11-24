/** Zero-rate catalog entries: a free model keeps the $0.00 it cost when the call
 *  ran, and a paid plan with no per-token dollar rate is unknown, never $0.00. */
import assert from "node:assert/strict";
import test from "node:test";
import { captureCallUsage, type DispatchedModel } from "../src/agent/pricing.ts";
import { piModels } from "../src/agent/models.ts";
import { callCost, sessionCost } from "../src/server/pricing.ts";
import type { CallUsage } from "../src/core/contracts.ts";
import type { Usage } from "@earendil-works/pi-ai";

const usage: Usage = { input: 100_000, output: 50_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, totalTokens: 150_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const catalog = (provider: string, id: string) => {
	const model = piModels().getModel(provider, id);
	assert.ok(model, `${provider}:${id} is in the catalog`);
	return model;
};
const isZero = (m: { cost: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: readonly { input: number; output: number; cacheRead: number; cacheWrite: number }[] } }) =>
	[m.cost, ...(m.cost.tiers ?? [])].every((r) => !r.input && !r.output && !r.cacheRead && !r.cacheWrite);
const restore = <T extends { cost: object }>(model: T, fn: () => void) => {
	const original = structuredClone(model.cost);
	try { fn(); } finally { Object.assign(model.cost, original); }
};

test("a call on a zero-rate free model stores $0.00 and keeps it when the catalog later prices the model", () => {
	for (const [provider, id] of [["google", "gemma-4-26b-a4b-it"], ["opencode", "big-pickle"]] as const) {
		const model = catalog(provider, id);
		assert.ok(isZero(model), `${provider}:${id} ships zero rates`);
		const call = captureCallUsage(usage, model);
		assert.equal(call.costUsd, 0, `${provider}:${id} records $0.00 at call time`);
		restore(model, () => {
			model.cost.input = 0.3;
			model.cost.output = 1;
			assert.equal(callCost(call, `${provider}:${id}`), 0, `${provider}:${id} stays $0.00 after the catalog prices it`);
		});
	}
});

test("a record with no stored cost still reads through the live catalog", () => {
	const old: CallUsage = { inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 };
	assert.equal(callCost(old, "google:gemma-4-26b-a4b-it"), 0);
	assert.equal(callCost(old, "openrouter:openrouter/auto"), null, "a router with no bill stays unknown");
});

test("a zero-rate model the catalog does not list is not frozen at $0.00", () => {
	const unlisted: DispatchedModel = { provider: "unknown", id: "model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	assert.equal(captureCallUsage(usage, unlisted).costUsd, undefined);
});

const paidPlans = [
	["qwen-token-plan-individual", "qwen3.7-max"],
	["zai", "glm-5.2-highspeed"],
	["zai", "glm-5.3-highspeed"],
	["zai-coding-cn", "glm-5.3-highspeed"],
	["vercel-ai-gateway", "reflection/beam"],
] as const;

test("paid token-plan models with zero catalog rates are unknown, not $0.00", () => {
	for (const [provider, id] of paidPlans) {
		const model = catalog(provider, id);
		assert.ok(isZero(model), `${provider}:${id} ships zero rates`);
		const call = captureCallUsage(usage, model);
		assert.equal(call.costUsd, undefined, `${provider}:${id} stores no cost`);
		assert.equal(callCost(call, `${provider}:${id}`), null, `${provider}:${id} reads as unknown`);
		const turn = { id: "t", messageId: "m", at: "2026-01-01T00:00:00Z", model: `${provider}:${id}`, steps: [call] };
		const priced = sessionCost({ turns: [turn] } as never);
		assert.equal(priced.unpriced, 1, `${provider}:${id} counts as an unpriced turn`);
		assert.equal(priced.cost, 0);
	}
});

test("every zero-rate token-plan catalog entry is unknown", () => {
	let seen = 0;
	for (const provider of piModels().getProviders()) {
		if (!/-token-plan(-|$)/.test(provider.id)) continue;
		for (const model of piModels().getModels(provider.id)) {
			if (!isZero(model)) continue;
			seen++;
			assert.equal(callCost({ inputTokens: 10, outputTokens: 10, costUsd: undefined }, `${provider.id}:${model.id}`), null, `${provider.id}:${model.id}`);
		}
	}
	assert.ok(seen > 0);
});

test("a paid plan the catalog gives real rates prices normally", () => {
	const model = catalog("zai", "glm-5.2-highspeed");
	restore(model, () => {
		model.cost.input = 1;
		model.cost.output = 2;
		assert.ok(Math.abs(captureCallUsage(usage, model).costUsd! - 0.2) < 1e-9);
	});
});

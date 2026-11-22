/** Catalog/calculator parity replaces the old generated-table drift test. */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { isKnownFreeModelId } from "../src/agent/pricing.ts";
import { piModels } from "../src/agent/models.ts";
import { callCost, jobCost } from "../src/server/pricing.ts";
import { accumulateJobUsage, piUsageToStep } from "../src/core/contracts/jobs.ts";

const models = piModels().getProviders().flatMap((p) => piModels().getModels(p.id));
const nativeUsage = (input: number): Usage => ({ input, output: 1_000, cacheRead: 10_000, cacheWrite: 2_000, cacheWrite1h: 500, totalTokens: input + 13_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const saved = (u: Usage) => ({ inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite, cacheWrite1hTokens: u.cacheWrite1h, reasoningTokens: 500 });

test("API catalog models price through Pi at every tier boundary; native CLI stays unpriced and saved usage is never mutated", () => {
	assert.ok(models.length > 100);
	for (const model of models) {
		const sizes = [1_000, ...(model.cost.tiers ?? []).flatMap((t) => [Math.max(0, t.inputTokensAbove - 12_000), Math.max(0, t.inputTokensAbove - 12_000 + 1)])];
		for (const input of sizes) {
			const usage = nativeUsage(input);
			const call = Object.freeze(saved(usage));
			const before = structuredClone(call);
			const total = calculateCost(model, usage).total;
			const free = (model as typeof model & { free?: boolean }).free === true || isKnownFreeModelId(model.id);
			const expected = model.provider === "claude-code" || (model.provider === "openrouter" && !free && total === 0 && [model.cost, ...(model.cost.tiers ?? [])].every(r => r.input === 0 && r.output === 0 && r.cacheRead === 0 && r.cacheWrite === 0)) ? null : free ? 0 : total;
			assert.equal(callCost(call, `${model.provider}:${model.id}`), expected, `${model.provider}:${model.id} input=${input}`);
			assert.deepEqual(call, before);
		}
	}
});

test("job capture preserves individual tier sizes and one-hour writes; old tier aggregates are unknown", () => {
	const model = models.find((m) => m.cost.tiers?.length)!;
	assert.ok(model);
	const id = `${model.provider}:${model.id}`;
	const threshold = model.cost.tiers![0]!.inputTokensAbove;
	const first = nativeUsage(Math.ceil(threshold / 2));
	const second = nativeUsage(Math.ceil(threshold / 2));
	const total = accumulateJobUsage(accumulateJobUsage(undefined, id, piUsageToStep(first)), id, piUsageToStep(second));
	assert.equal(total.calls?.length, 2);
	assert.equal(total.cacheWrite1hTokens, 1000);
	assert.equal(total.lastStep?.cacheWrite1hTokens, 500);
	assert.equal(jobCost({ usage: total }), calculateCost(model, first).total + calculateCost(model, second).total);
	assert.equal(jobCost({ usage: { ...total, calls: undefined } }), null);
	const legacyOne = { ...total, ...saved(first), calls: undefined, steps: 1 };
	assert.equal(jobCost({ usage: legacyOne }), calculateCost(model, first).total);
	const resumedLegacy = accumulateJobUsage({ ...total, calls: undefined }, id, piUsageToStep(first));
	assert.equal(resumedLegacy.calls, undefined, "never pretend the missing old calls were reconstructed");
});

test("usage recorded on a model Pi's catalog dropped keeps its estimate from the retired table", async () => {
	const { RETIRED_MODELS } = await import("../src/server/retired-models.ts");
	const id = "opencode-go:gemini-4-argon-contributor";
	assert.equal(piModels().getModel("opencode-go", "gemini-4-argon-contributor"), undefined, "the current catalog has no entry");
	const usage = nativeUsage(1_000);
	const expected = calculateCost({ cost: RETIRED_MODELS[id]!.cost } as Parameters<typeof calculateCost>[0], structuredClone(usage)).total;
	assert.ok(expected > 0);
	assert.equal(callCost(saved(usage), id), expected);
	const job = { usage: { model: id, steps: 1, inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite, cacheWrite1hTokens: usage.cacheWrite1h, reasoningTokens: 0 } };
	assert.equal(jobCost(job as never), expected);
	assert.equal(callCost(saved(usage), "opencode-go:never-existed"), null, "an id in neither table stays unpriced");
});

test("the retired table holds only ids the current catalog lacks", async () => {
	const { RETIRED_MODELS } = await import("../src/server/retired-models.ts");
	assert.equal(Object.keys(RETIRED_MODELS).length, 75);
	for (const id of Object.keys(RETIRED_MODELS)) {
		const colon = id.indexOf(":");
		assert.equal(piModels().getModel(id.slice(0, colon), id.slice(colon + 1)), undefined, id);
	}
});

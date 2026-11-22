/** Per-call API-dollar calculation. Record-time capture prices each call from
 *  the dispatched model's own rates (never re-reading the live catalog) and
 *  skips $0 placeholder models that are not known to be free. Read-time
 *  fallback (src/server/pricing.ts) shares computeCallCost and liveCatalogModel.
 *  Never mutate saved native messages: calculateCost mutates its usage.cost. */
import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { piModels } from "./models.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import type { CallUsage } from "../core/contracts.ts";
import { piUsageToStep, type UsageStepLike } from "../core/contracts/jobs.ts";
import { isSubscriptionModel } from "../core/prices.ts";

export type PricedModel = { cost: Model<Api>["cost"] };

/** The dispatched model metadata available when a call completes. */
export type DispatchedModel = {
	provider: string;
	id: string;
	cost?: Model<Api>["cost"];
};

const dispatchedModels = new WeakMap<Usage, DispatchedModel>();

/** Associate a finalized Pi Usage with the exact Model dispatched for that call. */
export function recordDispatchedModel(usage: Usage, model: DispatchedModel): void {
	dispatchedModels.set(usage, model);
}

/** Look up the exact Model recorded for a finalized Pi Usage, if any. */
export function dispatchedModelOf(usage: Usage): DispatchedModel | undefined {
	return dispatchedModels.get(usage);
}

export function isUnpricedModelId(id: string): boolean {
	const colon = id.indexOf(":");
	// Native CLI routing determines billing. Adapter zero-rate placeholders
	// must never become an apparent $0 estimate or subscription classification.
	return colon < 0 || isSubscriptionModel(id) || [CLAUDE_CODE_PROVIDER, CUSTOM_PROVIDER.id].includes(id.slice(0, colon));
}

export function liveCatalogModel(id: string): PricedModel | undefined {
	if (isUnpricedModelId(id)) return undefined;
	const colon = id.indexOf(":");
	return piModels().getModel(id.slice(0, colon), id.slice(colon + 1));
}

function hasNonZeroRate(cost: Model<Api>["cost"]): boolean {
	return [cost, ...(cost.tiers ?? [])].some(
		(rate) => rate.input > 0 || rate.output > 0 || rate.cacheRead > 0 || rate.cacheWrite > 0,
	);
}

export function isKnownFreeModelId(id: string): boolean {
	return /(?:^|[:/-])free(?:$|[:/-])/i.test(id);
}

/** Whether a model's rates are real and safe to persist (not an unpriced provider or $0 placeholder). */
export function hasRecordableCost(model: DispatchedModel): boolean {
	const modelId = `${model.provider}:${model.id}`;
	if (isUnpricedModelId(modelId) || !model.cost) return false;
	// Do not freeze $0 placeholder rates unless the model id marks it free;
	// leaving costUsd absent lets later catalog updates price it at read time.
	return hasNonZeroRate(model.cost) || isKnownFreeModelId(model.id);
}

function dispatchedCost(call: Partial<CallUsage>, model: DispatchedModel): number | null {
	if (!hasRecordableCost(model)) return null;
	return computeCallCost(call, { cost: model.cost! });
}

export function computeCallCost(call: Partial<CallUsage>, model: PricedModel | undefined): number | null {
	if (!model || call.inputTokens === undefined || call.outputTokens === undefined) return null;
	const input = call.inputTokens;
	const output = call.outputTokens;
	const cacheRead = call.cacheReadTokens ?? 0;
	const cacheWrite = call.cacheWriteTokens ?? 0;
	const cacheWrite1h = call.cacheWrite1hTokens ?? 0;
	if ([input, output, cacheRead, cacheWrite, cacheWrite1h].some((v) => !Number.isFinite(v) || v < 0) || cacheWrite1h > cacheWrite) return null;
	// Old records discarded this split. Only price them if it cannot affect
	// the result; do not invent short-retention precision from a missing field.
	if (cacheWrite > 0 && call.cacheWrite1hTokens === undefined &&
		[model.cost, ...(model.cost.tiers ?? [])].some((rate) => rate.cacheWrite !== 2 * rate.input)) return null;
	const usage: Usage = {
		input, output, cacheRead, cacheWrite, cacheWrite1h,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const total = calculateCost({ cost: model.cost } as Model<Api>, usage).total;
	return Number.isFinite(total) && total >= 0 ? total : null;
}

/** Capture one completed Pi model call's tokens and cost from the dispatched model. */
export function captureCallUsage(usage: Usage, model: DispatchedModel): CallUsage {
	const call: CallUsage = {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
		// Optional in pi's Usage; persisted as 0, never dropped.
		reasoningTokens: usage.reasoning ?? 0,
	};
	const costUsd = dispatchedCost(call, model);
	return costUsd !== null ? { ...call, costUsd } : call;
}

/** Convert a Pi Usage into a JobUsage step carrying its dispatched model cost. */
export function captureJobUsageStep(usage: Usage, model: DispatchedModel): UsageStepLike {
	return priceJobUsageStep(piUsageToStep(usage), model);
}

/** Attach the dispatched model cost to a job usage step when not already set. */
export function priceJobUsageStep(step: UsageStepLike, model: DispatchedModel): UsageStepLike {
	if (step.costUsd !== undefined) return step;
	const costUsd = dispatchedCost({
		inputTokens: step.inputTokens,
		outputTokens: step.outputTokens,
		cacheReadTokens: step.inputTokenDetails?.cacheReadTokens,
		cacheWriteTokens: step.inputTokenDetails?.cacheWriteTokens,
		cacheWrite1hTokens: step.inputTokenDetails?.cacheWrite1hTokens,
		reasoningTokens: step.outputTokenDetails?.reasoningTokens,
	}, model);
	return costUsd !== null ? { ...step, costUsd } : step;
}

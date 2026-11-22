/** Per-call API-dollar calculation against Pi's live catalog (bundled plus
 *  any pi.dev refresh overlay). Used when recording a call so history keeps
 *  the price that was active when the call ran, and shared with
 *  src/server/pricing.ts for read-time fallback on older records.
 *  Never mutate saved native messages: calculateCost mutates its usage.cost. */
import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { piModels } from "./models.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import type { CallUsage } from "../core/contracts.ts";
import { piUsageToStep, type UsageStepLike } from "../core/contracts/jobs.ts";
import { isSubscriptionModel } from "../core/prices.ts";

export type PricedModel = { cost: Model<Api>["cost"] };

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

/** Capture one completed Pi model call's tokens and its live catalog cost. */
export function captureCallUsage(usage: Usage, modelId: string): CallUsage {
	const call: CallUsage = {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
		// Optional in pi's Usage; persisted as 0, never dropped.
		reasoningTokens: usage.reasoning ?? 0,
	};
	const costUsd = computeCallCost(call, liveCatalogModel(modelId));
	return costUsd !== null ? { ...call, costUsd } : call;
}

/** Convert a Pi Usage into a JobUsage step carrying its live catalog cost. */
export function captureJobUsageStep(usage: Usage, modelId: string): UsageStepLike {
	const step = piUsageToStep(usage);
	return priceJobUsageStep(step, modelId);
}

/** Attach the live catalog cost to a job usage step when not already set. */
export function priceJobUsageStep(step: UsageStepLike, modelId: string): UsageStepLike {
	if (step.costUsd !== undefined) return step;
	const costUsd = computeCallCost({
		inputTokens: step.inputTokens,
		outputTokens: step.outputTokens,
		cacheReadTokens: step.inputTokenDetails?.cacheReadTokens,
		cacheWriteTokens: step.inputTokenDetails?.cacheWriteTokens,
		cacheWrite1hTokens: step.inputTokenDetails?.cacheWrite1hTokens,
		reasoningTokens: step.outputTokenDetails?.reasoningTokens,
	}, liveCatalogModel(modelId));
	return costUsd !== null ? { ...step, costUsd } : step;
}

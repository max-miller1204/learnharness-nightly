/** API-dollar estimates. Recorded calls store their record-time costUsd; older
 * records without it fall back to Pi's live catalog first, then the retired
 * models table. Catalog resolution is key-independent. */
import { computeCallCost, hasNonZeroRate, isKnownFreeModelId, isUnpricedModelId, isUnratedPaidModelId, liveCatalogModel, type PricedModel } from "../agent/pricing.ts";
import { RETIRED_MODELS } from "./retired-models.ts";
import type { CallUsage, ChatRecord, JobRecord, TurnUsage } from "../core/contracts.ts";
import { sessionCost as foldSessionCost, turnCost as foldTurnCost, jobCost as foldJobCost } from "../core/prices.ts";

function catalogModel(id: string): PricedModel | undefined {
	if (isUnpricedModelId(id)) return undefined;
	// History on a model no catalog has (Pi's bundled one or a pi.dev
	// refresh) keeps the estimate it had when Pi dropped it.
	return liveCatalogModel(id) ?? (Object.hasOwn(RETIRED_MODELS, id) ? RETIRED_MODELS[id] : undefined);
}

export function callCost(call: Partial<CallUsage>, modelId: string): number | null {
	if (isUnpricedModelId(modelId)) return null;
	if (call.costUsd !== undefined) {
		return typeof call.costUsd === "number" && Number.isFinite(call.costUsd) && call.costUsd >= 0 ? call.costUsd : null;
	}
	const model = catalogModel(modelId);
	if (model && (model.free === true || isKnownFreeModelId(modelId))) {
		return computeCallCost(call, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	}
	// All-zero rates carry no dollar figure on a router or a paid plan.
	if (model && !hasNonZeroRate(model.cost) && (modelId.startsWith("openrouter:") || isUnratedPaidModelId(modelId))) return null;
	return computeCallCost(call, model);
}

export function turnCost(turn: TurnUsage): number | null {
	return foldTurnCost(turn, callCost);
}
export function sessionCost(record: Pick<ChatRecord, "turns">) {
	return foldSessionCost(record, callCost);
}
export function jobCost(job: Pick<JobRecord, "usage">): number | null {
	const usage = job.usage;
	if (!usage || usage.steps < 1) return null;
	const hasCalls = usage.calls?.length === usage.steps;
	if (!hasCalls && usage.steps > 1 && catalogModel(usage.model)?.cost.tiers?.length) return null;
	return foldJobCost(job, callCost);
}

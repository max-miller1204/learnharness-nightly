/** API-dollar estimates. Recorded calls store their record-time costUsd; older
 * records without it fall back to Pi's live catalog first, then the retired
 * models table. Catalog resolution is key-independent. */
import { computeCallCost, hasRecordableCost, isUnpricedModelId, liveCatalogModel } from "../agent/pricing.ts";
import { RETIRED_MODELS } from "./retired-models.ts";
import type { CallUsage, ChatRecord, JobRecord, TurnUsage } from "../core/contracts.ts";
import { sessionCost as foldSessionCost, turnCost as foldTurnCost, jobCost as foldJobCost } from "../core/prices.ts";

function catalogModel(id: string) {
	if (isUnpricedModelId(id)) return undefined;
	// History on a model no catalog has (Pi's bundled one or a pi.dev
	// refresh) keeps the estimate it had when Pi dropped it.
	return liveCatalogModel(id) ?? (Object.hasOwn(RETIRED_MODELS, id) ? RETIRED_MODELS[id] : undefined);
}

// These catalog entries route to other models, so zero rates do not describe
// the selected model's price. The free router is explicitly free.
const ROUTER_PLACEHOLDERS = new Set([
	"openrouter:auto", "openrouter:openrouter/auto", "openrouter:openrouter/auto-beta",
	"openrouter:openrouter/auto-code", "openrouter:openrouter/fusion",
	"openrouter:openrouter/pareto-code", "openrouter:typesafe/jev-router",
]);

export function callCost(call: Partial<CallUsage>, modelId: string): number | null {
	if (isUnpricedModelId(modelId)) return null;
	if (call.costUsd !== undefined) {
		return typeof call.costUsd === "number" && Number.isFinite(call.costUsd) && call.costUsd >= 0 ? call.costUsd : null;
	}
	const model = catalogModel(modelId);
	const colon = modelId.indexOf(":");
	if (model && ROUTER_PLACEHOLDERS.has(modelId) && !hasRecordableCost({ provider: modelId.slice(0, colon), id: modelId.slice(colon + 1), cost: model.cost })) return null;
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

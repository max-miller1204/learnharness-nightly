/**
 * Graph-pipeline cost summary (2026-09 graph cost metrics wave) — the pure
 * fold behind the graph view's cost pill. Two usage channels in: chat
 * extraction runs (ChatRecord.extractions) and notes-source runs
 * (NotesSource.extractions). Out: per-stage totals (extraction / audit)
 * + a capped recent-runs list. (The cluster-naming channel died with the
 * extraction-UX close-out, 2026-09-24 — UI's displayCostTotals had already
 * dropped it; historical naming-runs.jsonl spend is simply not displayed,
 * the same ruling as wave 7's stages.embedding.)
 *
 * MONEY CHANNEL LAW: dollars come from each step's stored `costUsd` when
 * present, falling back to an injected server-side Pi pricer for older
 * records without it. An unpriced model contributes ZERO dollars but is
 * counted in `unpricedRuns` so the UI can render unpriced honestly, never
 * a silent zero. Tokens always sum.
 *
 * Client-safe: pure types + math, no node imports; exposed via the core
 * barrel so the pill/panel components carry no cost math.
 */

import type { CallUsage, EmissionStats, ExtractionRunUsage } from "./contracts.ts";
import { sumSteps, isSubscriptionModel, subscriptionLabels, type CallPricer } from "./prices.ts";

/** One pipeline stage's cumulative cost across every run. */
export interface StageCost {
	/** Subscription stage-runs, excluded from API dollars and unpriced counts. */
	subscriptionRuns?: number;
	subscriptionProviders?: string[];
	/** Inferred USD summed over the calls that priced (partial when unpricedRuns > 0). */
	dollars: number;
	/** Stage-runs whose model is missing from Pi's catalog (render "—", never zero). */
	unpricedRuns: number;
	/** Runs where at least one API part is priced, so `dollars` is known spend
	 *  (partial when the same run is also counted in `unpricedRuns`). */
	pricedRuns?: number;
	/** Runs that billed this stage. */
	runs: number;
	/** Token totals across every run. */
	tokens: CallUsage;
}

/** One run in the recent-runs list (extraction or naming). */
export interface RecentRun {
	subscriptionRuns?: number;
	subscriptionProviders?: string[];
	startedAt: number;
	/** ISO wall-clock. */
	at: string;
	durationMs: number;
	/** "extraction" covers both front doors (chat + notes). */
	kind: "extraction";
	/** Chat title / source file path / fixed label for naming runs. */
	title: string;
	/** Whole-run inferred USD over the calls that priced; null when none did. */
	dollars: number | null;
	/** Some API call of this run has no known cost (dollars may still be known). */
	unpriced: boolean;
	tokens: CallUsage;
	/** What the run merged into the graph; absent on failed runs. */
	merged?: EmissionStats;
}

/** The cost pill's whole payload: stage totals + recent runs. */
export interface GraphCostSummary {
	subscriptionRuns?: number;
	subscriptionProviders?: string[];
	/** Inferred USD across all priced stages of all runs. */
	totalDollars: number;
	/** Runs with at least one API call of unknown cost, counted once per run. */
	unpricedRuns: number;
	/** The billable pipeline stages. (Wave 7, owner ruling 2026-09-23:
	 *  the embedding stage is gone with the provider embedder; the
	 *  2026-09-24 close-out culled cluster naming the same way —
	 *  historical spend on either is simply not displayed.) */
	stages: {
		extraction: StageCost;
		audit: StageCost;
	};
	/** Newest first, capped at `recentCap` (default 10). */
	runs: RecentRun[];
}

/** What the fold reads: already-collected run records, front-door-tagged. */
export interface CostSummaryInput {
	/** Chat-front-door runs: chat title + the record's usage log. */
	chats: { title: string; extractions: ExtractionRunUsage[] }[];
	/** Notes-front-door runs: imported file path + the source's usage log. */
	sources: { filePath: string; extractions: ExtractionRunUsage[] }[];
	recentCap?: number;
}

const ZERO_TOKENS: CallUsage = {
	inputTokens: undefined,
	outputTokens: undefined,
	cacheReadTokens: undefined,
	cacheWriteTokens: undefined,
	reasoningTokens: undefined,
};

const emptyStage = (): StageCost => ({ dollars: 0, unpricedRuns: 0, pricedRuns: 0, runs: 0, tokens: { ...ZERO_TOKENS } });

/** One part of a run (extractor, image reader or auditor) folded over its calls.
 *  Known spend and unknown calls are kept apart, so a part with one billed and
 *  one unbilled call keeps the billed dollars and carries an unknown mark. */
interface PartCost {
	subscription: boolean;
	calls: number;
	/** Dollars over the calls that priced. */
	dollars: number;
	/** At least one call priced. */
	priced: boolean;
	/** At least one call has no known cost. */
	unknown: boolean;
}

function partCost(model: string, steps: readonly CallUsage[], price: CallPricer): PartCost {
	const part: PartCost = { subscription: isSubscriptionModel(model), calls: steps.length, dollars: 0, priced: false, unknown: false };
	if (part.subscription) return part;
	for (const step of steps) {
		const c = price(step, model);
		if (c === null) part.unknown = true;
		else {
			part.dollars += c;
			part.priced = true;
		}
	}
	return part;
}

/** Merge one step-set's tokens into an accumulating CallUsage. */
function mergeTokens(into: CallUsage, steps: readonly CallUsage[]): void {
	const summed = sumSteps(steps);
	// Fold this before updating total writes, so an older write-bearing
	// aggregate with a missing split remains unknown even after fresh data.
	into.cacheWrite1hTokens = sumSteps([into, summed]).cacheWrite1hTokens;
	into.inputTokens = (into.inputTokens ?? 0) + (summed.inputTokens ?? 0);
	into.outputTokens = (into.outputTokens ?? 0) + (summed.outputTokens ?? 0);
	into.cacheReadTokens = (into.cacheReadTokens ?? 0) + (summed.cacheReadTokens ?? 0);
	into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + (summed.cacheWriteTokens ?? 0);
	into.reasoningTokens = (into.reasoningTokens ?? 0) + (summed.reasoningTokens ?? 0);
}

/** Fold every usage channel into the pill's payload. Pure: same input,
 *  same output — no clock, no fs, no store reads. */
export function graphCostSummary(input: CostSummaryInput, price: CallPricer): GraphCostSummary {
	const extraction = emptyStage();
	const audit = emptyStage();
	const runs: RecentRun[] = [];

	const foldExtractionRun = (run: ExtractionRunUsage, title: string) => {
		const stages = run.stages ?? { extractor: { model: "unknown", steps: [] }, auditor: { model: "unknown", steps: [] } };
		const image = stages.imageReader;
		// An image's description (item 26) is part of extracting from that file.
		const extractionParts = [partCost(stages.extractor.model, stages.extractor.steps, price), ...(image ? [partCost(image.model, image.steps, price)] : [])];
		const auditPart = partCost(stages.auditor.model, stages.auditor.steps, price);
		const parts = [...extractionParts, auditPart];
		// A part with no calls billed nothing and is not unknown (a run cancelled
		// after the extractor has an empty audit). A run with no calls at all has
		// no known cost, so each of its API stages is unknown.
		const noCalls = parts.every((part) => part.calls === 0);
		const unknownOf = (part: PartCost) => !part.subscription && (part.unknown || (noCalls && part.calls === 0));

		extraction.runs++;
		mergeTokens(extraction.tokens, stages.extractor.steps);
		if (image) mergeTokens(extraction.tokens, image.steps);
		// A run carries each mark at most once, and a mixed run carries both
		// (owner, 2026-11-17: like a subscription extractor beside an unpriced auditor).
		const subscriptionModels = [stages.extractor.model, ...(image ? [image.model] : [])].filter(isSubscriptionModel);
		if (subscriptionModels.length > 0) {
			extraction.subscriptionRuns = (extraction.subscriptionRuns ?? 0) + 1;
			extraction.subscriptionProviders = [...new Set([...(extraction.subscriptionProviders ?? []), ...subscriptionLabels(subscriptionModels)])];
		}
		if (extractionParts.some(unknownOf)) extraction.unpricedRuns++;
		if (extractionParts.some((part) => part.priced)) extraction.pricedRuns = (extraction.pricedRuns ?? 0) + 1;
		for (const part of extractionParts) extraction.dollars += part.dollars;

		audit.runs++;
		mergeTokens(audit.tokens, stages.auditor.steps);
		if (auditPart.subscription) {
			audit.subscriptionRuns = (audit.subscriptionRuns ?? 0) + 1;
			audit.subscriptionProviders = [...new Set([...(audit.subscriptionProviders ?? []), ...subscriptionLabels([stages.auditor.model])])];
		}
		if (unknownOf(auditPart)) audit.unpricedRuns++;
		if (auditPart.priced) audit.pricedRuns = (audit.pricedRuns ?? 0) + 1;
		audit.dollars += auditPart.dollars;

		// Run-level: null only when no API part priced a call; unknown is counted once.
		const runPriced = parts.some((part) => part.priced);
		const subscriptionRuns = [stages.extractor, stages.auditor, ...(image ? [image] : [])].filter((stage) => isSubscriptionModel(stage.model)).length;
		const allSteps = [...stages.extractor.steps, ...stages.auditor.steps, ...(image?.steps ?? [])];
		runs.push({
			...(subscriptionRuns ? { subscriptionRuns, subscriptionProviders: subscriptionLabels([stages.extractor.model, stages.auditor.model, ...(image ? [image.model] : [])]) } : {}),
			startedAt: run.startedAt,
			at: run.at,
			durationMs: run.durationMs,
			kind: "extraction",
			title,
			dollars: runPriced ? parts.reduce((sum, part) => sum + part.dollars, 0) : null,
			unpriced: parts.some(unknownOf),
			tokens: sumSteps(allSteps),
			...(run.stats ? { merged: run.stats } : {}),
		});
	};

	for (const chat of input.chats) {
		for (const run of chat.extractions) foldExtractionRun(run, chat.title);
	}
	for (const source of input.sources) {
		for (const run of source.extractions) foldExtractionRun(run, source.filePath);
	}

	runs.sort((a, b) => b.startedAt - a.startedAt);
	const capped = runs.slice(0, input.recentCap ?? 10);

	const unpricedRuns = runs.filter((r) => r.unpriced).length;
	const subscriptionRuns = (extraction.subscriptionRuns ?? 0) + (audit.subscriptionRuns ?? 0);
	return {
		...(subscriptionRuns ? { subscriptionRuns, subscriptionProviders: [...new Set([...(extraction.subscriptionProviders ?? []), ...(audit.subscriptionProviders ?? [])])] } : {}),
		totalDollars: extraction.dollars + audit.dollars,
		unpricedRuns,
		stages: { extraction, audit },
		runs: capped,
	};
}

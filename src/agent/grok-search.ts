import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import type { SearchHit } from "../core/search.ts";
import { responsesSearchCollector } from "./chatgpt-search.ts";
import { APP_IDENTITY, piModels } from "./models.ts";
import { nativeSubscriptionStream } from "./subscription-stream.ts";

/** One Responses web search through the Grok OAuth lease. The
 * stream reports xAI's own error text, so a refusal reaches the user as is. */
export async function searchGrok(
	model: Model<Api>,
	query: string,
	count: number,
	checkSelection: (connectionId: string) => void,
	signal?: AbortSignal,
): Promise<SearchHit[]> {
	const provider = piModels().getProvider("xai");
	if (!provider) throw new Error("The Grok provider is unavailable in this LearnHarness build.");
	const collector = responsesSearchCollector("Grok");
	const stream = nativeSubscriptionStream(provider, () => true, {
		captured: ({ accountId }) => checkSelection(accountId),
		beforeDispatch: ({ accountId }) => checkSelection(accountId),
		noDispatch: () => {},
	}, true);
	const result = await stream(model, normalizeContext({
		systemPrompt: `Search the web for the user's query. Return up to ${count} relevant sources, with short descriptions and a native source citation for each.`,
		messages: [{ role: "user", content: query, timestamp: Date.now() }],
	}), {
		cacheRetention: "none",
		reasoning: "low",
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
		fetch: (input, init) => globalThis.fetch(input, { ...init, redirect: "error" }),
		onPayload: (raw) => {
			const payload = raw as Record<string, unknown>;
			if (payload.tools) throw new Error("Grok search accepts only the hosted web search tool");
			return { ...payload, tools: [{ type: "web_search" }], tool_choice: "required" };
		},
		onProviderStreamEvent: collector.onProviderStreamEvent,
		identity: APP_IDENTITY,
	}).result();
	if (result.stopReason === "error" || result.stopReason === "aborted") {
		throw new Error(result.errorMessage ?? "Grok search was interrupted. Retry when ready.");
	}
	return collector.hits(count, "Grok did not complete a native web search. xAI may not offer search on this sign-in.");
}

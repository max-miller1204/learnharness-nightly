import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { isWebSourceUrl } from "../core/contracts/jobs.ts";
import type { SearchHit } from "../core/search.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import { APP_IDENTITY } from "./models.ts";

interface ResponsesOutput {
	type?: string;
	status?: string;
	content?: Array<{
		type?: string;
		text?: string;
		annotations?: Array<{ type?: string; url?: string; title?: string; start_index?: number; end_index?: number }>;
	}>;
}

/** Canonical sources come from the provider annotations on a completed native
 * search. Free-form model links and an interrupted stream cannot supply hits. */
function citedSearchHits(output: ResponsesOutput[], count: number): SearchHit[] {
	if (!output.some((item) => item.type === "web_search_call" && item.status === "completed")) {
		throw new Error("ChatGPT did not complete a native web search. Check the account’s search policy or try again.");
	}
	const hits = new Map<string, SearchHit>();
	for (const item of output) {
		if (item.type !== "message") continue;
		for (const part of item.content ?? []) {
			if (part.type !== "output_text") continue;
			for (const citation of part.annotations ?? []) {
				const { url, title, start_index: start, end_index: end } = citation;
				if (citation.type !== "url_citation" || typeof url !== "string" || !isWebSourceUrl(url) || hits.has(url)) continue;
				const snippet = typeof start === "number" && typeof end === "number"
					? part.text?.slice(start, end).trim().slice(0, 500) ?? ""
					: "";
				hits.set(url, { url, title: (typeof title === "string" && title.trim()) || url, snippet });
			}
		}
	}
	if (!hits.size) throw new Error("ChatGPT completed web search without cited sources. Try a more specific search query.");
	return [...hits.values()].slice(0, count);
}

export async function searchChatGPT(
	model: Model<"openai-responses">,
	query: string,
	count: number,
	checkSelection: (accountId: string) => void,
	signal?: AbortSignal,
): Promise<SearchHit[]> {
	let items: ResponsesOutput[] = [];
	const stream = chatGPTStream(() => true, {
		captured: ({ accountId }) => checkSelection(accountId),
		beforeDispatch: ({ accountId }) => checkSelection(accountId),
		noDispatch: () => {},
	}, true);
	const result = await stream(model, normalizeContext({
		systemPrompt: `Search the web for the user's query. Return up to ${count} relevant sources, with short descriptions and a native source citation for each.`,
		messages: [{ role: "user", content: query, timestamp: Date.now() }],
	}), {
		identity: APP_IDENTITY,
		cacheRetention: "none",
		reasoning: "low",
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
		onProviderStreamEvent(raw) {
			const event = raw as { type?: string; response?: { output?: ResponsesOutput[] } };
			if (event.type === "response.completed" && Array.isArray(event.response?.output)) items = event.response.output;
		},
	}).result();
	if (result.stopReason === "error" || result.stopReason === "aborted") {
		throw new Error(result.errorMessage ?? "ChatGPT search was interrupted. Retry when ready.");
	}
	return citedSearchHits(items, count);
}

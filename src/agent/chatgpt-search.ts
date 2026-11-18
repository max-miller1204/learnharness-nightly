import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { isWebSourceUrl } from "../core/contracts/jobs.ts";
import type { SearchHit } from "../core/search.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import { APP_IDENTITY } from "./models.ts";

interface Citation {
	type?: string;
	url?: string;
	title?: string;
	start_index?: number;
	end_index?: number;
}

interface OutputText {
	type?: string;
	text?: string;
	annotations?: Citation[];
}

interface ResponsesOutput {
	type?: string;
	status?: string;
	content?: OutputText[];
}

/** Canonical sources come from the provider annotations on a completed native
 * search. Free-form model links and an interrupted stream cannot supply hits. */
function citedSearchHits(parts: OutputText[], count: number): SearchHit[] {
	const hits = new Map<string, SearchHit>();
	for (const part of parts) {
		if (part.type !== "output_text") continue;
		const text = typeof part.text === "string" ? part.text : "";
		for (const citation of part.annotations ?? []) {
			const { url, title, start_index: start, end_index: end } = citation;
			if (citation.type !== "url_citation" || typeof url !== "string" || !isWebSourceUrl(url)) continue;
			const snippet = typeof start === "number" && typeof end === "number"
				&& Number.isSafeInteger(start) && Number.isSafeInteger(end)
				&& start >= 0 && end > start && end <= text.length
				? text.slice(start, end).trim().slice(0, 500)
				: "";
			const previous = hits.get(url);
			if (previous) {
				previous.snippet ||= snippet;
			} else {
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
	let searched = false;
	const parts: OutputText[] = [];
	const streamedText = new Map<string, { type: "output_text"; text: string; annotations: Citation[] }>();
	const collectItem = (item: ResponsesOutput) => {
		if (item.type === "web_search_call" && item.status === "completed") searched = true;
		if (item.type === "message" && item.content) parts.push(...item.content);
	};
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
			const event = raw as {
				type?: string; response?: { output?: ResponsesOutput[] }; item?: ResponsesOutput;
				part?: OutputText; item_id?: string; content_index?: number; annotation?: Citation | null; text?: string;
			};
			// The terminal envelope may omit output even when completed items,
			// text and annotations were sent as individual stream events.
			if (event.type === "response.web_search_call.completed") searched = true;
			if (event.type === "response.output_item.done" && event.item) collectItem(event.item);
			if (event.type === "response.content_part.done" && event.part?.type === "output_text") parts.push(event.part);
			if (event.type === "response.completed" && Array.isArray(event.response?.output)) event.response.output.forEach(collectItem);
			if (event.type === "response.output_text.annotation.added" || event.type === "response.output_text.done") {
				const key = `${event.item_id}:${event.content_index}`;
				const part = streamedText.get(key) ?? { type: "output_text", text: "", annotations: [] };
				if (event.annotation) part.annotations.push(event.annotation);
				if (typeof event.text === "string") part.text = event.text;
				streamedText.set(key, part);
			}
		},
	}).result();
	if (result.stopReason === "error" || result.stopReason === "aborted") {
		throw new Error(result.errorMessage ?? "ChatGPT search was interrupted. Retry when ready.");
	}
	if (!searched) throw new Error("ChatGPT did not complete a native web search. Check the account’s search policy or try again.");
	return citedSearchHits([...parts, ...streamedText.values()], count);
}

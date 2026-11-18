/**
 * The search-provider port (search port + model slots wave, 2026-09-20).
 *
 * Search engines are pluggable behind ONE seam: the settings record names a
 * preferred engine (agent.search.engine — optional), keys live in the auth
 * store (the curated key catalog), and the server composes the live adapter.
 *
 * Owner decisions baked here:
 *  - Automatic uses configured keyed engines. A subscription requires
 *    an explicit preference bound to the selected account.
 *  - Nothing silently falls back: no engine live = search is honestly
 *    unavailable (the tool says so). Research remains available keylessly
 *    through web_fetch for known URLs.
 *
 * Pure types, the engine table + protocol docs only (browser-safe, no node
 * imports): the adapters are server-side (src/server/search.ts) and arrive
 * as injected dependencies — the agent-layer tool depends on THIS port only.
 */

/** One search result row — the shape every adapter must produce (the
 *  researcher's tool contract; same fields the old Google adapter emitted). */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** Search engines in automatic preference order. Keep existing preferences
 * stable when adding an engine: an explicit pin always wins. */
export const SEARCH_ENGINES = [
	{ id: "tavily", label: "Tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", label: "Brave", envVar: "BRAVE_API_KEY" },
	{ id: "exa", label: "Exa", envVar: "EXA_API_KEY" },
	{ id: "firecrawl", label: "Firecrawl", envVar: "FIRECRAWL_API_KEY" },
	{ id: "ollama", label: "Ollama", envVar: "OLLAMA_API_KEY" },
] as const;

export const SUBSCRIPTION_SEARCH_ENGINES = [
	{ id: "chatgpt", label: "ChatGPT subscription" },
	{ id: "claude-code", label: "Claude Code subscription" },
	{ id: "xai-subscription", label: "Grok subscription" },
	{ id: "github-copilot-subscription", label: "GitHub Copilot subscription" },
] as const;

export type KeyedSearchEngineId = (typeof SEARCH_ENGINES)[number]["id"];
export type SubscriptionSearchEngineId = (typeof SUBSCRIPTION_SEARCH_ENGINES)[number]["id"];
export type SearchEngineId = KeyedSearchEngineId | SubscriptionSearchEngineId;

export function isSubscriptionSearchEngineId(value: unknown): value is SubscriptionSearchEngineId {
	return SUBSCRIPTION_SEARCH_ENGINES.some(({ id }) => id === value);
}

/** The read/write guards' membership check (settings record + PUT body). */
export function isSearchEngineId(value: unknown): value is SearchEngineId {
	return SEARCH_ENGINES.some((engine) => engine.id === value) || isSubscriptionSearchEngineId(value);
}

export interface SearchSettings {
	engine?: SearchEngineId;
	/** Non-secret ID for the explicit account selection, invalidated by account changes. */
	accountSelection?: string;
}

export function isSearchAccountSelection(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

/** A live search engine: an id (for status/labels) + one operation. The
 *  adapters own their wire protocol (fetch, timeouts, error mapping) —
 *  callers see only this. `search` throws on failure (adapters map HTTP
 *  errors to clear Error messages); the tool layer catches and reports. */
export interface SearchProvider {
	id: SearchEngineId;
	search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]>;
}

/** Why search is (un)available — the honest status the UI and the tool
 *  layer explain from. `engine` is the ACTIVE engine when live. */
export interface SearchStatus {
	available: boolean;
	/** The active engine (null when unavailable). */
	engine: SearchEngineId | null;
	/** The one-line reason for the state (status text for the UI). */
	reason: string;
}

export interface SubscriptionSearchOption {
	id: SubscriptionSearchEngineId;
	available: boolean;
	reason: string;
	account?: { label: string; selection: string };
}

export interface SearchPickerStatus extends SearchStatus {
	subscriptions: SubscriptionSearchOption[];
}

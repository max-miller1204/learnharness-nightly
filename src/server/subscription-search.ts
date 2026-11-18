import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { chatGPTConnected, chatGPTModels, chatGPTStatus, refreshChatGPTStatus } from "../agent/chatgpt-bridge.ts";
import { searchChatGPT } from "../agent/chatgpt-search.ts";
import {
	isSearchAccountSelection,
	type SubscriptionSearchOption,
	type SubscriptionSearchEngineId,
	type SearchProvider,
	type SearchSettings,
} from "../core/search.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { effectiveSettings } from "./stores.ts";

const RESELECT = "The ChatGPT account selection changed. Reselect ChatGPT in Settings → Agent → Tools.";
const BACKGROUND = "ChatGPT background use is off. Enable Allow background use for all ChatGPT accounts in Providers to use subscription search.";
const CATALOG = "No ChatGPT search model is available for this account. Check the ChatGPT connection in Providers and retry.";

// Account-visible models with documented Responses web search. Order by
// OpenAI's published standard output token rate as a proxy for efficiency.
// The OAuth catalog has no per-tool capability or plan usage ranking.
const CHATGPT_SEARCH_MODELS = [
	"gpt-6-luna",
	"gpt-5.6-luna",
	"gpt-6.1-terra",
	"gpt-6.2-sol",
	"gpt-6.1-sol",
	"gpt-6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-sol",
	"gpt-6.2-astra",
	"gpt-6-astra",
];

function chatGPTOption(): SubscriptionSearchOption {
	const { activeId, accountSelection, accounts, available, allowBackgroundUse } = chatGPTStatus();
	const active = accounts.find(({ id }) => id === activeId);
	const account = active && isSearchAccountSelection(accountSelection)
		? { label: active.email?.trim() || "ChatGPT account", selection: accountSelection }
		: undefined;
	if (!available) return { id: "chatgpt", available: false, reason: "ChatGPT sign-in is unavailable on this LearnHarness connection." };
	if (!account || !chatGPTConnected()) {
		return { id: "chatgpt", account, available: false, reason: "Connect ChatGPT and authorize plan use in Providers." };
	}
	return {
		id: "chatgpt", account, available: true,
		reason: allowBackgroundUse
			? "Search can use your ChatGPT plan allowance or credits."
			: `Search can use your ChatGPT plan allowance or credits. ${BACKGROUND}`,
	};
}

export function subscriptionSearchOptions(): SubscriptionSearchOption[] {
	return [
		chatGPTOption(),
		{ id: "claude-code", available: false, reason: "Claude Code subscription search is pending headless and distribution verification." },
		{ id: "xai-subscription", available: false, reason: "Subscription search is unavailable on the LearnHarness Grok OAuth connection." },
		{ id: "github-copilot-subscription", available: false, reason: "Subscription search is unavailable on the LearnHarness GitHub Copilot connection." },
	];
}

export function subscriptionSearchReason(settings: SearchSettings): string | undefined {
	const option = subscriptionSearchOptions().find(({ id }) => id === settings.engine);
	if (!option?.available) return option?.reason ?? "This subscription cannot be used for search.";
	if (option.account?.selection !== settings.accountSelection) return RESELECT;
	if (!chatGPTStatus().allowBackgroundUse) return BACKGROUND;
}

let refreshingCatalog: Promise<void> | undefined;
export function subscriptionSearchProvider(settings: SearchSettings & { engine: SubscriptionSearchEngineId }): SearchProvider {
	return {
		id: settings.engine,
		async search(query, count, signal) {
			signal?.throwIfAborted();
			if (settings.engine === "chatgpt") {
				await refreshChatGPTStatus().catch(() => {
					throw new Error("ChatGPT connection is unavailable. Check or reconnect the account in Providers.");
				});
			}
			const requireSelection = (accountId?: string) => {
				signal?.throwIfAborted();
				const selected = effectiveSettings().agent.search;
				if (selected?.engine !== settings.engine || selected.accountSelection !== settings.accountSelection) {
					throw new Error("The Search engine selection changed. Run the search again.");
				}
				const reason = subscriptionSearchReason(settings);
				if (reason) throw new Error(reason);
				if (accountId && chatGPTStatus().activeId !== accountId) throw new Error(RESELECT);
			};
			requireSelection();
			const accountId = chatGPTStatus().activeId;
			if (!accountId) throw new Error(RESELECT);
			if (!chatGPTModels().length) {
				refreshingCatalog ??= refreshConnectionCatalog("chatgpt").finally(() => { refreshingCatalog = undefined; });
				await refreshingCatalog;
			}
			requireSelection(accountId);
			const models = chatGPTModels();
			let model: (typeof models)[number] | undefined;
			for (const id of CHATGPT_SEARCH_MODELS) {
				model = models.find((entry) =>
					entry.id === id && entry.input.includes("text") && getSupportedThinkingLevels(entry).includes("low"));
				if (model) break;
			}
			if (!model) throw new Error(CATALOG);
			try {
				return await searchChatGPT(model, query, count, (admittedAccountId) => {
					requireSelection(accountId);
					if (admittedAccountId !== accountId) throw new Error(RESELECT);
				}, signal);
			} finally {
				requireSelection(accountId);
			}
		},
	};
}

import { createHash } from "node:crypto";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { chatGPTConnected, chatGPTModels, chatGPTStatus, refreshChatGPTStatus } from "../agent/chatgpt-bridge.ts";
import { searchChatGPT } from "../agent/chatgpt-search.ts";
import { inspectClaudeAccount, searchClaudeCode, type ClaudeAccount } from "../agent/claude-code/search.ts";
import type { RunClaude } from "../agent/claude-code/stream.ts";
import { searchGrok } from "../agent/grok-search.ts";
import {
	nativeSubscriptionBackgroundAllowed,
	nativeSubscriptionConnected,
	nativeSubscriptionModels,
	nativeSubscriptionStatus,
	refreshSubscriptionModels,
} from "../agent/subscription-bridge.ts";
import type { ClaudeCodeStatus } from "../core/contracts/claude-code.ts";
import {
	isSearchAccountSelection,
	type SearchHit,
	type SubscriptionSearchOption,
	type SubscriptionSearchEngineId,
	type SearchProvider,
	type SearchSettings,
} from "../core/search.ts";
import { claudeCodeInstallationStatus } from "./claude-code.ts";
import { claudeCodeEnabled } from "./claude-code-config.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { effectiveSettings } from "./stores.ts";
// Ensure the server's web subscription runtime is registered before refresh calls.
import "./web-subscriptions.ts";

const LABELS: Record<SubscriptionSearchEngineId, string> = {
	chatgpt: "ChatGPT", "claude-code": "Claude Code", "xai-subscription": "Grok", "github-copilot-subscription": "GitHub Copilot",
};
const reselect = (label: string) => `The ${label} account selection changed. Reselect ${label} in Settings → Agent → Tools.`;
const RESELECT = reselect("ChatGPT");
const BACKGROUND = "ChatGPT background use is off. Enable Allow background use for all ChatGPT accounts in Providers to use subscription search.";
const GROK_BACKGROUND = "Grok background use is off. Enable it for Grok in Providers to use subscription search.";
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

// Owner decision: the latest small Grok model only, at low reasoning. No
// other Grok model is tried when the connection does not offer it.
const GROK_SEARCH_MODEL = "grok-4.7";

/** Test seams: production reads the installed CLI. */
export const claudeSearchSeams: {
	installation: () => Promise<ClaudeCodeStatus>;
	account: () => Promise<ClaudeAccount | null>;
	run?: RunClaude;
} = { installation: claudeCodeInstallationStatus, account: () => inspectClaudeAccount() };

/** Last CLI check. Refreshed by the picker and before every search. */
let claude: { installation: ClaudeCodeStatus; account: ClaudeAccount | null } | undefined;

async function refreshClaude(): Promise<void> {
	if (!claudeCodeEnabled()) { claude = undefined; return; }
	// The installation check initializes credential provenance for the child env.
	const installation = await claudeSearchSeams.installation();
	claude = { installation, account: installation.state === "not-found" ? null : await claudeSearchSeams.account() };
}

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

function claudeOption(): SubscriptionSearchOption {
	const id = "claude-code";
	if (!claudeCodeEnabled()) return { id, available: false, reason: "Enable Claude Code in Settings → Providers → External CLI to search with it." };
	if (!claude) return { id, available: false, reason: "Claude Code sign-in has not been checked yet. Reopen Settings to check it." };
	const { installation, account } = claude;
	if (installation.state === "not-found") return { id, available: false, reason: "Claude Code CLI was not found on the LearnHarness server. Install it, then reopen Settings." };
	if (installation.state === "update-required") {
		return { id, available: false, reason: `Claude Code ${installation.version} requires an update to ${installation.minimumVersion} or later.` };
	}
	if (installation.state !== "meets-minimum") return { id, available: false, reason: "Claude Code's version could not be checked. Check the installation, then reopen Settings." };
	if (!account) return { id, available: false, reason: "Sign in to Claude Code with `claude auth login` in a terminal on the LearnHarness server, then reopen Settings." };
	return {
		id, available: true, account: { label: account.label, selection: account.selection },
		reason: account.plan
			? "Search can use your Claude plan usage limits (Claude Code)."
			: `Claude Code is signed in with ${account.method}, so search may be billed to that account.`,
	};
}

const grokSelection = (connectionId: string) => createHash("sha256").update(connectionId).digest("hex").slice(0, 32);

function grokOption(): SubscriptionSearchOption {
	const id = "xai-subscription";
	const status = nativeSubscriptionStatus("xai");
	if (!status?.available) return { id, available: false, reason: "Grok sign-in is unavailable on this LearnHarness connection." };
	const connectionId = status.connectionId;
	if (!connectionId || !nativeSubscriptionConnected("xai")) return { id, available: false, reason: "Connect Grok in Providers to use it for search." };
	const reason = "Search can use your Grok subscription allowance or credits, or be billed by xAI.";
	return {
		id, available: true, account: { label: "Grok account", selection: grokSelection(connectionId) },
		reason: nativeSubscriptionBackgroundAllowed("xai") ? reason : `${reason} ${GROK_BACKGROUND}`,
	};
}

export function subscriptionSearchOptions(): SubscriptionSearchOption[] {
	return [
		chatGPTOption(),
		claudeOption(),
		grokOption(),
		{ id: "github-copilot-subscription", available: false, reason: "Subscription search is unavailable on the LearnHarness GitHub Copilot connection." },
	];
}

/** Fresh provider state for the picker; failures surface through the options. */
export async function refreshSubscriptionSearch(): Promise<void> {
	await Promise.all([
		refreshChatGPTStatus().catch(() => { /* runtime connection changes are reflected by the bridge */ }),
		refreshClaude().catch(() => { claude = undefined; }),
		refreshSubscriptionModels(),
	]);
}

export function subscriptionSearchReason(settings: SearchSettings): string | undefined {
	const option = subscriptionSearchOptions().find(({ id }) => id === settings.engine);
	if (!option?.available) return option?.reason ?? "This subscription cannot be used for search.";
	if (option.account?.selection !== settings.accountSelection) return reselect(LABELS[option.id]);
	if (option.id === "chatgpt" && !chatGPTStatus().allowBackgroundUse) return BACKGROUND;
	if (option.id === "xai-subscription" && !nativeSubscriptionBackgroundAllowed("xai")) return GROK_BACKGROUND;
}

let refreshingCatalog: Promise<void> | undefined;
export function subscriptionSearchProvider(settings: SearchSettings & { engine: SubscriptionSearchEngineId }): SearchProvider {
	const requireSelection = (signal?: AbortSignal) => {
		signal?.throwIfAborted();
		const selected = effectiveSettings().agent.search;
		if (selected?.engine !== settings.engine || selected.accountSelection !== settings.accountSelection) {
			throw new Error("The Search engine selection changed. Run the search again.");
		}
		const reason = subscriptionSearchReason(settings);
		if (reason) throw new Error(reason);
	};
	return {
		id: settings.engine,
		async search(query, count, signal) {
			signal?.throwIfAborted();
			switch (settings.engine) {
				case "chatgpt": return searchWithChatGPT(query, count, requireSelection, signal);
				case "claude-code": {
					await refreshClaude();
					requireSelection(signal);
					try {
						return await searchClaudeCode(query, count, signal, claudeSearchSeams.run);
					} finally {
						// The CLI account may change while the child runs.
						if (!signal?.aborted) await refreshClaude();
						requireSelection(signal);
					}
				}
				case "xai-subscription": {
					await refreshSubscriptionModels();
					requireSelection(signal);
					const model = nativeSubscriptionModels().find((entry) =>
						entry.provider === "xai-subscription" && entry.id === GROK_SEARCH_MODEL && entry.input.includes("text"));
					if (!model) throw new Error(`Grok search needs ${GROK_SEARCH_MODEL}, which this Grok connection does not offer. Check the Grok connection in Providers and retry.`);
					try {
						return await searchGrok(model, query, count, (connectionId) => {
							requireSelection(signal);
							if (grokSelection(connectionId) !== settings.accountSelection) throw new Error(reselect("Grok"));
						}, signal);
					} finally {
						requireSelection(signal);
					}
				}
				default:
					requireSelection(signal);
					throw new Error("This subscription cannot be used for search.");
			}
		},
	};
}

async function searchWithChatGPT(
	query: string,
	count: number,
	requireBase: (signal?: AbortSignal) => void,
	signal?: AbortSignal,
): Promise<SearchHit[]> {
	await refreshChatGPTStatus().catch(() => {
		throw new Error("ChatGPT connection is unavailable. Check or reconnect the account in Providers.");
	});
	const requireSelection = (accountId?: string) => {
		requireBase(signal);
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
}

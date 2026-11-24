import { AUTH_PROVIDER_KEYS, CUSTOM_PROVIDER } from "./auth-keys.ts";
import { CLAUDE_CODE_PROVIDER } from "./contracts/claude-code.ts";
import { NATIVE_SUBSCRIPTIONS } from "./contracts/subscriptions.ts";

/** A saved model the catalog no longer lists fails what would run it with this
 *  message, and never switches to another model. */
export const MODEL_UNAVAILABLE = "model_unavailable";

/** The settings section that holds provider keys and subscription connections. */
export const PROVIDERS_SECTION_LABEL = "Providers";

/** What a person calls a provider id; an unknown id stays as it is. */
export function providerLabel(provider: string): string {
	if (provider === "chatgpt") return "ChatGPT";
	if (provider === CLAUDE_CODE_PROVIDER) return "Claude Code";
	if (provider === CUSTOM_PROVIDER.id) return CUSTOM_PROVIDER.label;
	return AUTH_PROVIDER_KEYS.find((p) => p.id === provider)?.label
		?? NATIVE_SUBSCRIPTIONS.find((p) => p.logicalId === provider)?.label
		?? provider;
}

/** The one refusal sentence. A catalog without a model has several causes the
 *  caller cannot always tell apart (retired, provider disconnected, provider
 *  unreachable), so it is true in each and says where to look. */
export function modelUnavailableMessage(provider: string, id: string): string {
	return `The model ${id} from ${providerLabel(provider)} isn't available right now. It may be retired, or its provider isn't connected or can't be reached. Check ${PROVIDERS_SECTION_LABEL} in Settings, or pick another model.`;
}

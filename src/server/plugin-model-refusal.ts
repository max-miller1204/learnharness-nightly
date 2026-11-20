import { catalogModelGone } from "../agent/models.ts";
import { isSubscriptionProvider, subscriptionStatusUnknown } from "../agent/subscription-connections.ts";
import { providerKeyMissing, subscriptionUnreachable } from "../core/settings.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";

/** For a plugin's model_unavailable refusal: the key-missing envelope only when
 *  the model still exists and its provider key is gone, or the unreachable
 *  envelope when a subscription's status check fails. A model that can't run
 *  never asks for a key. */
export async function pluginKeyMissing(provider: string, id: string): Promise<object | null> {
	if (catalogModelGone(provider, id)) return null;
	if (isSubscriptionProvider(provider)) {
		await refreshConnectionCatalog(provider);
		if (subscriptionStatusUnknown(provider)) return subscriptionUnreachable(provider);
	}
	return providerKeyPresent(provider) ? null : providerKeyMissing(provider, []);
}

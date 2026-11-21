import { isSubscriptionProvider, connectionUnreachable } from "../agent/subscription-connections.ts";
import { providerKeyMissing, subscriptionUnreachable, type ConnectionRefusal, type ModelSlotName } from "../core/settings.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";

/** The key gate every model run shares. A subscription refreshes its status
 *  first: a failed check while its runtime is still connected is an outage
 *  (subscription_unreachable, retryable); a confirmed "not connected" or a
 *  lost runtime is setup (provider_key_missing). null = run. */
export async function connectionRefusal(provider: string, slots: ModelSlotName[]): Promise<ConnectionRefusal | null> {
	if (isSubscriptionProvider(provider)) {
		await refreshConnectionCatalog(provider);
		if (connectionUnreachable(provider)) return subscriptionUnreachable(provider);
	}
	return providerKeyPresent(provider) ? null : providerKeyMissing(provider, slots);
}

import { catalogModelGone } from "../agent/models.ts";
import { connectionRefusal } from "./connection-refusal.ts";

/** For a plugin's model_unavailable refusal: the key-missing envelope only when
 *  the model still exists and its provider key is gone, or the unreachable
 *  envelope when a subscription's status check fails. A model that can't run
 *  never asks for a key. */
export async function pluginKeyMissing(provider: string, id: string): Promise<object | null> {
	if (catalogModelGone(provider, id)) return null;
	return connectionRefusal(provider, []);
}

/** Whether the host lists the provider, from the same rows host inference
 *  validates a plugin's model provider against. */
export async function pluginKnowsProvider(provider: string): Promise<boolean> {
	return (await import("./model-catalog.ts")).catalogProviders().some((p) => p.id === provider);
}

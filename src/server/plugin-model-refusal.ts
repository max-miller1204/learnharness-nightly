import { catalogModelGone } from "../agent/models.ts";
import { providerKeyMissing } from "../core/settings.ts";
import { providerKeyPresent } from "./keys.ts";

/** For a plugin's model_unavailable refusal: the key-missing envelope only when
 *  the model still exists and its provider key is gone. A model that can't run
 *  never asks for a key. */
export function pluginKeyMissing(provider: string, id: string): object | null {
	return catalogModelGone(provider, id) || providerKeyPresent(provider) ? null : providerKeyMissing(provider, []);
}

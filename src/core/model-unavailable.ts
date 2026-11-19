/** A saved model the catalog no longer has fails what would run it with this
 *  message, and never switches to another model. */
export const MODEL_UNAVAILABLE = "model_unavailable";

export function modelUnavailableMessage(provider: string, id: string): string {
	return `The model ${provider}/${id} is no longer available. Pick another model in Settings.`;
}

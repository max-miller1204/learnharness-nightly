import { chatGPTBackgroundAllowed, chatGPTConnected, chatGPTScopeCurrent, chatGPTStatusUnknown, onChatGPTChange } from "./chatgpt-bridge.ts";
import { nativeSubscriptionId, nativeSubscriptionConnected, nativeSubscriptionBackgroundAllowed, nativeAdmissionCurrent, nativeSubscriptionStatusUnknown, onNativeSubscriptionChange } from "./subscription-bridge.ts";
import type { AdmissionScope } from "./subscription-request-cycle.ts";

export function isSubscriptionProvider(provider: string | undefined): boolean { return provider === "chatgpt" || !!(provider && nativeSubscriptionId(provider)); }
export function subscriptionConnected(provider: string): boolean {
	if (provider === "chatgpt") return chatGPTConnected();
	const native = nativeSubscriptionId(provider); return !!native && nativeSubscriptionConnected(native);
}
/** The subscription's last status or catalog check failed, so whether it is connected is unknown right now. */
export function subscriptionStatusUnknown(provider: string): boolean {
	if (provider === "chatgpt") return chatGPTStatusUnknown();
	return !!nativeSubscriptionId(provider) && nativeSubscriptionStatusUnknown();
}
/** Ordinary API connections have no subscription background-consent gate. */
export function connectionBackgroundAllowed(provider: string | undefined): boolean {
	if (provider === "chatgpt") return chatGPTBackgroundAllowed();
	const native = provider ? nativeSubscriptionId(provider) : undefined;
	return native ? nativeSubscriptionBackgroundAllowed(native) : true;
}
export function connectionScopeCurrent(provider: string, scope: AdmissionScope): boolean {
	if (provider === "chatgpt") return chatGPTScopeCurrent(scope);
	const native = nativeSubscriptionId(provider); return !!native && nativeAdmissionCurrent(native, scope);
}
export function onSubscriptionChange(listener: () => void): () => void {
	const stopChatGPT = onChatGPTChange(listener), stopNative = onNativeSubscriptionChange(listener);
	return () => { stopChatGPT(); stopNative(); };
}

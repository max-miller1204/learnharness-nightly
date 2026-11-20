"use client";

import { useMemo } from "react";
import type { ChatGPTControlBridge, ChatGPTStatus, NativeSubscriptionControlBridge, NativeSubscriptionProviderId, NativeSubscriptionStatus } from "@/src/core";
import { useNotifyHub, type createNotifyHub } from "@/components/server-events";

type Hub = ReturnType<typeof createNotifyHub> | null;
type Reply<T> = { value: T; browserAction?: string; error?: string };
const PATH = "/api/subscriptions";
const headers = { "Content-Type": "application/json", "x-learnharness-subscriptions": "1" };

async function status() {
	const response = await fetch(PATH, { headers, cache: "no-store" });
	if (!response.ok) throw new Error("Subscription status is unavailable.");
	return response.json() as Promise<{ chatgpt: ChatGPTStatus; native: NativeSubscriptionStatus[] }>;
}
async function control<T>(providerId: string, op: string, fields: Record<string, unknown> = {}): Promise<Reply<T>> {
	const response = await fetch(PATH, { method: "POST", headers, body: JSON.stringify({ providerId, op, ...fields }) });
	if (!response.ok) throw new Error("The subscription connection could not be changed.");
	return response.json() as Promise<Reply<T>>;
}
function onChange(hub: Hub, listener: () => void): () => void {
	const offEvent = hub?.subscribe("subscriptions-changed", listener);
	const offResync = hub?.onResync(listener);
	return () => { offEvent?.(); offResync?.(); };
}
/** Reserve the new tab synchronously in the click gesture. Only a one-use
 * same-origin action URL enters app JS; provider URLs remain in the owner.
 * Electron dev has no tabs: its narrow main-process opener performs this step. */
async function withBrowser<T>(action: () => Promise<Reply<T>>): Promise<T> {
	const external = window.lh?.subscriptionTransport === "web" ? window.lh.openSubscriptionBrowser : undefined;
	const tab = external ? null : window.open("about:blank", "_blank");
	if (!external && !tab) throw new Error("Allow a sign-in tab to open, then try again.");
	if (tab) tab.opener = null;
	try {
		const reply = await action();
		if (reply.browserAction) {
			if (!/^\/api\/subscriptions\/browser\?id=[0-9a-f-]{36}$/.test(reply.browserAction)) throw new Error("Invalid sign-in action.");
			if (external) await external(reply.browserAction);
			else if (tab && !tab.closed) tab.location.href = reply.browserAction;
			else throw new Error("The sign-in tab was closed. Cancel and try again.");
		} else tab?.close();
		return reply.value;
	} catch (error) { tab?.close(); throw error; }
}
/** In the desktop app's window onto this server, its narrow bridge runs the verified
 * sign-in (electron/remote-chatgpt.cjs): the callback reaches the desktop, with no tab
 * or paste-back. It resolves when sign-in ends; the status events carry its progress. */
type DesktopSignIn = NonNullable<NonNullable<Window["lh"]>["chatgptSignIn"]>;
async function desktopLogin(desktop: DesktopSignIn, id?: string): Promise<ChatGPTStatus> {
	const result: unknown = await desktop.start(id);
	const current = (await status()).chatgpt;
	if (result && typeof result === "object" && "ok" in result && result.ok === true) return current;
	const error = result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error.slice(0, 300) : "ChatGPT sign-in failed. Try again.";
	return { ...current, error };
}
export function createWebChatGPTBridge(hub: Hub): ChatGPTControlBridge {
	const call = async (op: string, fields?: Record<string, unknown>) => (await control<ChatGPTStatus>("chatgpt", op, fields)).value;
	return {
		status: async () => (await status()).chatgpt,
		login: (id) => {
			const desktop = window.lh?.chatgptSignIn;
			return desktop ? desktopLogin(desktop, id) : withBrowser(() => control<ChatGPTStatus>("chatgpt", "login", { id }));
		},
		// The desktop's own attempt (its listener, and its browser before it opens) ends with its
		// own scoped cancel. Only without one does the page cancel whatever is pending (an
		// attempt adopted from another device), so this window never ends one it didn't start.
		cancel: async () => {
			const desktop = window.lh?.chatgptSignIn;
			const reply: unknown = desktop ? await desktop.cancel().catch(() => null) : null;
			const ended = !!reply && typeof reply === "object" && "ended" in reply && reply.ended === true;
			return ended ? (await status()).chatgpt : call("cancel");
		}, complete: (url) => call("complete", { url }), select: (id) => call("select", { id }),
		disconnect: (id) => call("disconnect", { id }), logout: (id) => call("logout", { id }),
		consent: (enabled) => call("consent", { enabled }),
		onChange: (listener) => onChange(hub, listener),
	};
}
export function createWebNativeBridge(hub: Hub): NativeSubscriptionControlBridge {
	const call = async (providerId: NativeSubscriptionProviderId, op: string, fields?: Record<string, unknown>) => { await control(providerId, op, fields); };
	return {
		status: async () => (await status()).native,
		login: (providerId, enabled) => call(providerId, "login", { enabled }),
		cancel: (providerId) => call(providerId, "cancel"),
		respond: (providerId, attemptId, promptId, value) => call(providerId, "respond", { attemptId, promptId, value }),
		open: async (providerId, attemptId, actionId) => { await withBrowser(() => control(providerId, "open", { attemptId, actionId })); },
		retry: (providerId) => call(providerId, "retry"), disconnect: (providerId) => call(providerId, "disconnect"),
		consent: (providerId, enabled) => call(providerId, "consent", { enabled }),
		onChange: (listener) => onChange(hub, listener),
	};
}
export function useChatGPTBridge(): ChatGPTControlBridge | undefined {
	const hub = useNotifyHub();
	return useMemo(() => typeof window === "undefined" ? undefined : window.lh?.subscriptionTransport !== "web" && window.lh?.chatgpt ? window.lh.chatgpt : createWebChatGPTBridge(hub), [hub]);
}
export function useNativeSubscriptionBridge(): NativeSubscriptionControlBridge | undefined {
	const hub = useNotifyHub();
	return useMemo(() => typeof window === "undefined" ? undefined : window.lh?.subscriptionTransport !== "web" && window.lh?.subscriptions ? window.lh.subscriptions : createWebNativeBridge(hub), [hub]);
}

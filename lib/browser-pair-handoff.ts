import { BROWSER_HANDOFF_ROUTES, PROTOCOL_ROUTES, type SessionStateResponse } from "../src/client-protocol/index.ts";

/** Accept an opaque session ID, never a path or a URL supplied by the caller. */
export function handoffTarget(chatId: string | null): string | undefined {
	return chatId && /^[A-Za-z0-9_-]+$/.test(chatId) ? BROWSER_HANDOFF_ROUTES.chat(chatId) : undefined;
}

export function readPairingLocation(href: string) {
	const url = new URL(href);
	const fragment = new URLSearchParams(url.hash.slice(1));
	const handoff = url.pathname === "/pair" && fragment.has("chat");
	const target = handoff ? handoffTarget(fragment.get("chat")) : undefined;
	// An invalid handoff cannot spend the supplied code or redirect.
	const token = handoff && !target ? undefined : fragment.get("token") ?? url.searchParams.get("token") ?? undefined;
	if (fragment.has("token") || url.searchParams.has("token") || handoff) {
		url.hash = "";
		url.searchParams.delete("token");
		return { token, target, cleanLocation: url.pathname + url.search };
	}
	return { token, target };
}

/** Spend a handoff code only after the browser reports that it has no session. */
export async function browserAlreadyPaired(request: typeof fetch): Promise<boolean> {
	const response = await request(PROTOCOL_ROUTES.session, { cache: "no-store", credentials: "same-origin" });
	if (!response.ok) throw new Error("Couldn't check this browser's session.");
	const session = await response.json() as SessionStateResponse;
	if (typeof session.authenticated !== "boolean") throw new Error("Couldn't check this browser's session.");
	return session.authenticated;
}


export async function redeemBrowserCode(request: typeof fetch, credential: string, target?: string): Promise<Response | null> {
	if (target && await browserAlreadyPaired(request)) return null;
	return request("/api/auth/browser-session", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ credential }),
	});
}

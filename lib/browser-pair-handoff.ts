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

/** Whether this browser already has a session (GET /api/auth/session). */
export async function browserAlreadyPaired(request: typeof fetch): Promise<boolean> {
	const response = await request(PROTOCOL_ROUTES.session, { cache: "no-store", credentials: "same-origin" });
	if (!response.ok) throw new Error("Couldn't check this browser's session.");
	const session = await response.json() as SessionStateResponse;
	if (typeof session.authenticated !== "boolean") throw new Error("Couldn't check this browser's session.");
	return session.authenticated;
}

/** What the pairing screen does first with a plain link's code (no `chat`).
 * Any site can open `/pair#token=<its own code>` in a new top-level page,
 * so a browser that is already signed in asks before a link replaces its
 * session: "redeem" only when it has none, "confirm" when it has one, and
 * "unchecked" when the check fails, which asks too (the code stays unspent
 * until the person chooses). */
export async function plainLinkStep(request: typeof fetch): Promise<"redeem" | "confirm" | "unchecked"> {
	try {
		return await browserAlreadyPaired(request) ? "confirm" : "redeem";
	} catch {
		return "unchecked";
	}
}

/** A handoff (`chat` set, from the phone app) spends its code only after the
 * browser reports that it has no session; signed in, it opens the chat in
 * the current session (null). The server checks again: a browser that
 * signed in meanwhile gets 409 and keeps its session, unless `replace`,
 * which only the person's "Sign in with this link" sends. */
export async function redeemBrowserCode(request: typeof fetch, credential: string, target?: string, replace = false): Promise<Response | null> {
	if (target && await browserAlreadyPaired(request)) return null;
	return request("/api/auth/browser-session", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(replace ? { credential, replace: true } : { credential }),
	});
}

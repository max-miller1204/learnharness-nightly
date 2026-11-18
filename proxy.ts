import { NextResponse, type NextRequest } from "next/server";
import { authDataDir, authenticate, CREDENTIAL_HEADERS } from "./src/server/auth.ts";
import { touchLastSeen } from "./selfhost/src/auth-store.ts";
import { SERVER_INFO_PATH } from "./src/client-protocol/index.ts";
import { protocolRefusal } from "./src/server/server-info.ts";

/** Paths anyone may load: the pairing screen, the credential exchanges, the
 * health check that already-installed launchers call without a credential
 * (launcher protocol 1 is frozen; docs/specs/login-pairing.md), and the
 * server info a client reads before pairing (docs/specs/client-protocol.md). */
export const PUBLIC_PATHS = new Set(["/pair", "/api/health", "/api/auth/session", "/api/auth/browser-session", "/oauth/token", SERVER_INFO_PATH]);

export const isApiPath = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");

/** The login gate (T3 Code's model, no localhost bypass). Signed-out page
 * requests are rewritten to the pairing screen, because LearnHarness pages
 * render data on the server; signed-out API requests get 401. A request
 * naming another client protocol version gets 426 first. The one
 * streamed document route checks for itself, avoiding Next's silently
 * truncated Proxy body clone. */
export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	if (pathname === SERVER_INFO_PATH) return NextResponse.next();
	// A client naming another protocol version learns that before "signed out".
	const incompatible = protocolRefusal(request);
	if (incompatible) return incompatible;
	if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
	const result = authenticate(request);
	if (result.ok) {
		try { touchLastSeen(authDataDir(), result.session.id); } catch { /* last-seen is best effort */ }
		return NextResponse.next();
	}
	if (isApiPath(pathname)) {
		return NextResponse.json({ error: result.error }, { status: result.status, headers: CREDENTIAL_HEADERS });
	}
	const pair = request.nextUrl.clone();
	pair.pathname = "/pair";
	pair.search = "";
	return NextResponse.rewrite(pair);
}

export const config = {
	// Everything except static files (Next's own /_next/ assets, favicon and
	// public/) and the exact streamed documents endpoint. Must remain static literals.
	matcher: ["/((?!_next/|favicon\\.ico$|fonts/|siwc/|worklets/|plugin-loader\\.js$|api/plugins/[^/]+/documents/markdown/?$).*)"],
};

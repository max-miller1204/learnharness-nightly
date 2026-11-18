import { NextResponse, type NextRequest } from "next/server";
import { authDataDir, authenticate, CREDENTIAL_HEADERS, sessionCookie } from "./src/server/auth.ts";
import { NEVER_EXPIRES, touchLastSeen } from "./selfhost/src/auth-store.ts";
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
 * naming another client protocol version gets 426 first. The streamed
 * document and attachment routes check for themselves, avoiding Next's silently
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
		let seen = false;
		try { seen = touchLastSeen(authDataDir(), result.session.id); } catch { /* last-seen is best effort */ }
		const response = NextResponse.next();
		// Sessions never expire but browsers drop a cookie after at most 400
		// days, so a cookie in use is set again, as often as last seen is.
		if (seen && result.via === "cookie" && result.session.expiresAt === NEVER_EXPIRES) {
			response.headers.append("Set-Cookie", sessionCookie(request, result.token));
			response.headers.set("Cache-Control", CREDENTIAL_HEADERS["Cache-Control"]);
		}
		return response;
	}
	if (isApiPath(pathname)) {
		return NextResponse.json({ error: result.error }, { status: result.status, headers: CREDENTIAL_HEADERS });
	}
	// Next normalizes the loopback hostname to localhost. If its router
	// sees a different origin, it fetches the rewrite over the network.
	// That hop uses the local HTTP listener, even behind a TLS proxy.
	const pair = request.nextUrl.clone();
	// URL omits 443 from an HTTPS URL. Preserve the listener port when
	// switching schemes so an HTTP listener on 443 still works.
	const port = pair.port || (pair.protocol === "https:" ? "443" : "");
	pair.protocol = "http:";
	pair.port = port;
	pair.pathname = "/pair";
	pair.search = "";
	return NextResponse.rewrite(pair);
}

export const config = {
	// Everything except static files (Next's own /_next/ assets, favicon and
	// public/) and the exact streaming endpoints. Must remain static literals.
	matcher: ["/((?!_next/|favicon\\.ico$|fonts/|siwc/|worklets/|plugin-loader\\.js$|api/plugins/[^/]+/documents/markdown/?$|api/attachments/upload/?$).*)"],
};

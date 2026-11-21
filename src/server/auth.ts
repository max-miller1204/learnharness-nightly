/**
 * Login and pairing on the server side (docs/specs/login-pairing.md): which
 * credential a request carries, whether it names a live session, and the
 * session cookie. The store itself is selfhost/src/auth-store.ts, shared
 * with `lh`.
 *
 * Ported from T3 Code (github.com/pingdotgg/t3code, MIT, Copyright (c) 2026
 * T3 Tools Inc.): the credential order and cookie Origin rule of
 * apps/server/src/auth/EnvironmentAuth.ts, the cookie flags of
 * apps/server/src/auth/http.ts, and the User-Agent and IP rules of
 * apps/server/src/auth/utils.ts.
 *
 * Imported by proxy.ts, so it stays free of the app's heavier modules.
 */
import { isIP } from "node:net";
import { PATHS } from "../../config.ts";
import { verifyToken, type ClientInfo, type DeviceType, type SessionRecord } from "../../selfhost/src/auth-store.ts";

export const authDataDir = (): string => PATHS.data;

/** Port-suffixed like T3's t3_session_<port>, so two servers on localhost keep separate cookies. */
export function sessionCookieName(env: Record<string, string | undefined> = process.env): string {
	const port = env.PORT && /^\d+$/.test(env.PORT) ? env.PORT : "3000";
	return `lh_session_${port}`;
}

export const CREDENTIAL_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

type HeaderSource = { headers: Headers; url?: string; method?: string };

function readCookie(headers: Headers, name: string): string | undefined {
	const raw = headers.get("cookie");
	if (!raw) return undefined;
	for (const part of raw.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) {
			const value = part.slice(eq + 1).trim();
			return value || undefined;
		}
	}
	return undefined;
}

/** A page load in the top-level window that another site started (a link or
 * a redirect): GET or HEAD, no Origin, and Fetch Metadata saying so. The
 * cookie's SameSite=Lax sends it cross-site only on these. A layout reads
 * headers with no method; it renders only for page loads. */
function topLevelNavigation(headers: Headers, method: string | undefined): boolean {
	if (method !== undefined && !["GET", "HEAD"].includes(method.toUpperCase())) return false;
	if (headers.get("origin") !== null || headers.get("sec-fetch-mode") !== "navigate") return false;
	const dest = headers.get("sec-fetch-dest");
	return dest === null || dest === "document";
}

/** The rule for cookie credentials, and for the route that sets the cookie.
 * Fetch Metadata first: same-origin passes; same-site and cross-site pass
 * only as a top-level navigation, so another site's page can't send a
 * cookie write even without an Origin header. With no Fetch Metadata (a
 * non-secure context, a native client) or "none" (a typed address), T3's
 * Origin rule: no Origin, or an Origin whose host equals the Host header.
 * Bearer tokens skip it. */
export function cookieOriginAllowed(headers: Headers, method?: string): boolean {
	const site = headers.get("sec-fetch-site");
	if (site === "same-origin") return true;
	if (site === "same-site" || site === "cross-site") return topLevelNavigation(headers, method);
	const origin = headers.get("origin");
	if (origin === null) return true;
	const host = headers.get("host");
	if (!host) return false;
	try {
		return new URL(origin).host.toLowerCase() === host.toLowerCase();
	} catch {
		return false;
	}
}

export type Credential = { token: string; via: "cookie" | "bearer" };

/** The cookie first, then `Authorization: Bearer`. A cookie that fails the
 * Origin rule is not used; with no bearer to fall back on it's "refused". */
export function readCredential(request: HeaderSource): Credential | "refused" | undefined {
	const cookie = readCookie(request.headers, sessionCookieName());
	if (cookie && cookieOriginAllowed(request.headers, request.method)) return { token: cookie, via: "cookie" };
	const authorization = request.headers.get("authorization");
	const bearer = authorization?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
	if (bearer) return { token: bearer, via: "bearer" };
	return cookie ? "refused" : undefined;
}

export type AuthResult =
	| { ok: true; session: SessionRecord; via: Credential["via"]; token: string }
	| { ok: false; status: 401 | 403; error: string };

export const SIGN_IN_REQUIRED = "Sign in required: pair this device with a pairing link (run `lh pair` on the server machine).";

export const CROSS_SITE_REFUSED = "Cross-site requests to LearnHarness are not allowed.";

export function authenticate(request: HeaderSource, dataDir: string = authDataDir()): AuthResult {
	const credential = readCredential(request);
	if (credential === "refused") return { ok: false, status: 403, error: CROSS_SITE_REFUSED };
	if (!credential) return { ok: false, status: 401, error: SIGN_IN_REQUIRED };
	const session = verifyToken(dataDir, credential.token);
	if (!session) return { ok: false, status: 401, error: SIGN_IN_REQUIRED };
	return { ok: true, session, via: credential.via, token: credential.token };
}

/** For handlers that check for themselves (the streamed documents route). */
export function authRefusal(request: HeaderSource): Response | undefined {
	const result = authenticate(request);
	if (result.ok) return undefined;
	return Response.json({ error: result.error }, { status: result.status, headers: CREDENTIAL_HEADERS });
}

function isHttps(request: HeaderSource): boolean {
	if (request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https") return true;
	try { return request.url ? new URL(request.url).protocol === "https:" : false; } catch { return false; }
}

/** The longest cookie life browsers keep (Chrome caps Expires at 400 days).
 * Sessions never expire, so proxy.ts sets the cookie again as it is used. */
export const COOKIE_LIFETIME_MS = 400 * 24 * 60 * 60_000;

/** HttpOnly, Path=/, SameSite=Lax, Secure over https, Expires 400 days on. */
export function sessionCookie(request: HeaderSource, token: string, now = Date.now()): string {
	return [
		`${sessionCookieName()}=${token}`,
		"Path=/",
		`Expires=${new Date(now + COOKIE_LIFETIME_MS).toUTCString()}`,
		"HttpOnly",
		"SameSite=Lax",
		...(isHttps(request) ? ["Secure"] : []),
	].join("; ");
}

// ---------------------------------------------------------------------------
// client metadata (T3: deriveAuthClientMetadata)

export function inferDeviceType(userAgent: string | undefined): DeviceType {
	if (!userAgent) return "unknown";
	const ua = userAgent.toLowerCase();
	if (/bot|crawler|spider|slurp|curl|wget/.test(ua)) return "bot";
	if (/ipad|tablet/.test(ua)) return "tablet";
	if (/iphone|android.+mobile|mobile/.test(ua)) return "mobile";
	return "desktop";
}

export function inferBrowser(userAgent: string | undefined): string | undefined {
	if (!userAgent) return undefined;
	const ua = userAgent.toLowerCase();
	if (/edg(?:e|a|ios)?\//.test(ua)) return "Edge";
	if (/opr\/|opios\//.test(ua)) return "Opera";
	if (/firefox\/|fxios\//.test(ua)) return "Firefox";
	if (/electron\//.test(ua)) return "Electron";
	if (/chrome\//.test(ua) || /crios\//.test(ua)) return "Chrome";
	if (/safari\//.test(ua) && !/chrome\//.test(ua)) return "Safari";
	return undefined;
}

export function inferOs(userAgent: string | undefined): string | undefined {
	if (!userAgent) return undefined;
	const ua = userAgent.toLowerCase();
	if (/iphone|ipad|ipod/.test(ua)) return "iOS";
	if (/android/.test(ua)) return "Android";
	if (/mac os x|macintosh/.test(ua)) return "macOS";
	if (/windows nt/.test(ua)) return "Windows";
	if (/linux/.test(ua)) return "Linux";
	return undefined;
}

const DEVICE_TYPES = new Set<DeviceType>(["desktop", "mobile", "tablet", "bot", "unknown"]);
const clean = (value: string | null | undefined, max = 120) => {
	const trimmed = value?.trim();
	return trimmed ? trimmed.slice(0, max) : undefined;
};

/** The server always binds 127.0.0.1, so the peer is loopback: T3's rule then
 * takes the last X-Forwarded-For entry (the one a local proxy appended). */
export function clientIp(headers: Headers): string {
	const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim().replace(/^::ffff:/i, "");
	return forwarded && isIP(forwarded) !== 0 ? forwarded : "127.0.0.1";
}

export function clientInfo(
	request: HeaderSource,
	presented: { label?: string | null; deviceType?: string | null; os?: string | null } = {},
): ClientInfo {
	const userAgent = clean(request.headers.get("user-agent"), 400);
	const label = clean(presented.label, 80);
	const os = clean(presented.os, 40) ?? inferOs(userAgent);
	const browser = inferBrowser(userAgent);
	const deviceType = presented.deviceType && DEVICE_TYPES.has(presented.deviceType as DeviceType)
		? presented.deviceType as DeviceType
		: inferDeviceType(userAgent);
	return {
		...(label ? { label } : {}),
		deviceType,
		...(os ? { os } : {}),
		...(browser ? { browser } : {}),
		ip: clientIp(request.headers),
		...(userAgent ? { userAgent } : {}),
	};
}

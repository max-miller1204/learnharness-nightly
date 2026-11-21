/**
 * The login and pairing routes (docs/specs/login-pairing.md), modeled on
 * T3 Code's apps/server/src/auth/http.ts (MIT, Copyright (c) 2026 T3 Tools
 * Inc.). Public: session, browser-session, /oauth/token. The rest need a
 * session (proxy.ts) and re-check it here, because they act on it.
 */
import * as fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import {
	claimPairingCode,
	createPairingLink,
	issueSession,
	listSessions,
	LockBusy,
	NEVER_EXPIRES,
	revokeOthers,
	revokeSession,
	type SessionRecord,
} from "../../selfhost/src/auth-store.ts";
import { layout } from "../../selfhost/src/paths.ts";
import { authDataDir, authenticate, clientInfo, cookieOriginAllowed, CREDENTIAL_HEADERS, CROSS_SITE_REFUSED, sessionCookie } from "./auth.ts";
import type { OAuthErrorResponse, SessionStateResponse, TokenExchangeResponse } from "../client-protocol/index.ts";

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
	Response.json(body, { status, headers: { ...CREDENTIAL_HEADERS, ...extra } });

/** { expiresAt } for a session that expires (`lh`'s), nothing for the rest. */
const sessionExpiry = (session: SessionRecord) => (session.expiresAt === NEVER_EXPIRES ? {} : { expiresAt: session.expiresAt });

const BUSY = Symbol("busy");
const LOCK_RETRY_MS = 12_000;
const busy = () => json({ error: "The login store is busy. Try again in a moment." }, 503, { "Retry-After": "1" });

/** Store writes from a request never block the event loop on a held lock
 * (that would stall every request, /api/health too): try once, then retry
 * asynchronously for up to 12 s, longer than a crashed writer's stale lock. */
async function unlocked<T>(write: (options: { wait: false }) => T): Promise<T | typeof BUSY> {
	const deadline = Date.now() + LOCK_RETRY_MS;
	for (;;) {
		try {
			return write({ wait: false });
		} catch (error) {
			if (!(error instanceof LockBusy)) throw error;
			if (Date.now() > deadline) return BUSY;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json() as unknown;
		return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

/** GET /api/auth/session (public). */
export function sessionState(request: Request): Response {
	const result = authenticate(request);
	if (!result.ok) return json({ authenticated: false } satisfies SessionStateResponse);
	return json({ authenticated: true, sessionId: result.session.id, ...sessionExpiry(result.session) } satisfies SessionStateResponse);
}

/** POST /api/auth/browser-session (public): body { credential } -> session cookie.
 * The cookie rule applies before the code is read, so another site's page
 * can neither sign this browser in (login CSRF) nor spend a code. */
export async function browserSession(request: Request): Promise<Response> {
	if (!cookieOriginAllowed(request.headers, request.method)) return json({ error: CROSS_SITE_REFUSED }, 403);
	const { credential } = await jsonBody(request);
	if (typeof credential !== "string" || !credential) return json({ error: "Expected a pairing code." }, 400);
	const claimed = await unlocked((options) => claimPairingCode(authDataDir(), credential, clientInfo(request), options));
	if (claimed === BUSY) return busy();
	if (!claimed.ok) return json({ error: "That code is wrong, expired or already used. Make a new one.", reason: claimed.reason }, 401);
	return json(
		{ authenticated: true, ...sessionExpiry(claimed.session) },
		200,
		{ "Set-Cookie": sessionCookie(request, claimed.token) },
	);
}

export const PAIRING_CODE_TOKEN_TYPE = "urn:learnharness:params:oauth:token-type:pairing-code";
export const DESKTOP_BOOTSTRAP_TOKEN_TYPE = "urn:learnharness:params:oauth:token-type:desktop-bootstrap";
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

const oauthError = (error: string, description: string) => json({ error, error_description: description } satisfies OAuthErrorResponse, 400);

function desktopSecretMatches(supplied: string, env: Record<string, string | undefined> = process.env): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	if (env.LH_DESKTOP_SERVER !== "1" || !expected || expected.length < 64) return false;
	const a = Buffer.from(supplied);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** POST /oauth/token (public): T3's RFC 8693 token exchange for native
 * clients and the desktop shell. Form-encoded in, bearer token out. */
export async function tokenExchange(request: Request): Promise<Response> {
	const params = new URLSearchParams(await request.text().catch(() => ""));
	if (params.get("grant_type") !== TOKEN_EXCHANGE) return oauthError("unsupported_grant_type", `grant_type must be ${TOKEN_EXCHANGE}.`);
	const requested = params.get("requested_token_type");
	if (requested !== null && requested !== ACCESS_TOKEN_TYPE) return oauthError("invalid_request", `requested_token_type must be ${ACCESS_TOKEN_TYPE}.`);
	const subject = params.get("subject_token");
	if (!subject) return oauthError("invalid_request", "subject_token is required.");
	const client = clientInfo(request, {
		label: params.get("client_label"),
		deviceType: params.get("client_device_type"),
		os: params.get("client_os"),
	});
	let issued: { token: string; session: SessionRecord };
	switch (params.get("subject_token_type")) {
		case PAIRING_CODE_TOKEN_TYPE: {
			const claimed = await unlocked((options) => claimPairingCode(authDataDir(), subject, client, options));
			if (claimed === BUSY) return json({ error: "temporarily_unavailable", error_description: "The login store is busy. Try again in a moment." }, 503, { "Retry-After": "1" });
			if (!claimed.ok) return oauthError("invalid_grant", "That pairing code is wrong, expired or already used.");
			issued = claimed;
			break;
		}
		case DESKTOP_BOOTSTRAP_TOKEN_TYPE: {
			if (!desktopSecretMatches(subject)) return oauthError("invalid_grant", "The desktop bootstrap credential is not valid.");
			const desktop = await unlocked((options) => issueSession(authDataDir(), {
				method: "desktop",
				client: { ...client, label: client.label ?? "LearnHarness Desktop", deviceType: params.get("client_device_type") ? client.deviceType : "desktop" },
				replaceMethod: true,
				...options,
			}));
			if (desktop === BUSY) return json({ error: "temporarily_unavailable", error_description: "The login store is busy. Try again in a moment." }, 503, { "Retry-After": "1" });
			issued = desktop;
			break;
		}
		default:
			return oauthError("invalid_request", `subject_token_type must be ${PAIRING_CODE_TOKEN_TYPE}.`);
	}
	// No expires_in: these sessions never expire (RFC 6749 makes it optional).
	return json({ access_token: issued.token, issued_token_type: ACCESS_TOKEN_TYPE, token_type: "Bearer" } satisfies TokenExchangeResponse);
}

/** The launcher's Tailscale HTTPS address, read from its config.json. */
export function tailscaleOrigin(env: Record<string, string | undefined> = process.env): string | undefined {
	if (env.LH_SELFHOST !== "1" || !env.LH_HOME) return undefined;
	try {
		const raw = JSON.parse(fs.readFileSync(layout(env.LH_HOME).config, "utf8")) as { tailscale?: { enabled?: unknown; hostname?: unknown; port?: unknown } };
		const ts = raw.tailscale;
		if (ts?.enabled !== true || typeof ts.hostname !== "string" || !/^[A-Za-z0-9.-]+$/.test(ts.hostname)) return undefined;
		const port = Number.isInteger(ts.port) ? ts.port as number : 8443;
		return `https://${ts.hostname.replace(/\.$/, "")}${port === 443 ? "" : `:${port}`}`;
	} catch {
		return undefined;
	}
}

/** POST /api/auth/pairing-token: body { label? } -> a one-time code. */
export async function createPairingToken(request: Request): Promise<Response> {
	const result = authenticate(request);
	if (!result.ok) return json({ error: result.error }, result.status);
	const { label } = await jsonBody(request);
	const link = await unlocked((options) => createPairingLink(authDataDir(), { ...(typeof label === "string" ? { label } : {}), ...options }));
	if (link === BUSY) return busy();
	const tailscale = tailscaleOrigin();
	return json({ id: link.id, credential: link.code, ...(link.label ? { label: link.label } : {}), expiresAt: link.expiresAt, ...(tailscale ? { tailscaleOrigin: tailscale } : {}) });
}

/** GET /api/auth/clients: the signed-in devices. */
export function listClients(request: Request): Response {
	const result = authenticate(request);
	if (!result.ok) return json({ error: result.error }, result.status);
	const clients = listSessions(authDataDir()).map((s) => ({
		sessionId: s.id,
		method: s.method,
		...(s.label ? { label: s.label } : {}),
		deviceType: s.deviceType,
		...(s.os ? { os: s.os } : {}),
		...(s.browser ? { browser: s.browser } : {}),
		...(s.ip ? { ip: s.ip } : {}),
		issuedAt: s.issuedAt,
		expiresAt: s.expiresAt === NEVER_EXPIRES ? null : s.expiresAt,
		lastSeenAt: s.lastSeenAt ?? null,
		current: s.id === result.session.id,
	}));
	return json({ clients });
}

/** POST /api/auth/clients/revoke: body { sessionId }. Not your own session. */
export async function revokeClient(request: Request): Promise<Response> {
	const result = authenticate(request);
	if (!result.ok) return json({ error: result.error }, result.status);
	const { sessionId } = await jsonBody(request);
	if (typeof sessionId !== "string" || !sessionId) return json({ error: "Expected a sessionId." }, 400);
	if (sessionId === result.session.id) return json({ error: "current_session_revoke_not_allowed" }, 400);
	const revoked = await unlocked((options) => revokeSession(authDataDir(), sessionId, options));
	return revoked === BUSY ? busy() : json({ revoked });
}

/** POST /api/auth/clients/revoke-others. */
export async function revokeOtherClients(request: Request): Promise<Response> {
	const result = authenticate(request);
	if (!result.ok) return json({ error: result.error }, result.status);
	const revokedCount = await unlocked((options) => revokeOthers(authDataDir(), result.session.id, options));
	return revokedCount === BUSY ? busy() : json({ revokedCount });
}

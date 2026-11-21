/**
 * Issue #303: another site's page can't use or set the sign-in cookie. The
 * cookie rule (src/server/auth.ts cookieOriginAllowed) reads Fetch Metadata
 * before Origin, so a cross-site or same-site request with no Origin is
 * refused unless it is a top-level load of a page (never /api/). Bearer clients (the desktop
 * windows, the phone app, `lh`) skip it. docs/specs/login-pairing.md
 */
import "./helpers/auth-data-dir.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";
import { authDir, createPairingLink, revokeSession, tokenState, verifyToken } from "../selfhost/src/auth-store.ts";
import nextConfig from "../next.config.ts";
import { browserSession, createPairingToken, listClients, revokeClient, revokeOtherClients, sessionState } from "../src/server/auth-routes.ts";
import { authenticate, cookieOriginAllowed, reachesApi } from "../src/server/auth.ts";
import { AUTH_TEST_DATA_DIR, cookieName, mintToken } from "./helpers/auth-data-dir.ts";

const origin = "http://localhost:3000";
const host = "localhost:3000";
const evil = "https://evil.example";
const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";
const rewrittenToPair = (response: Response) => new URL(response.headers.get("x-middleware-rewrite") ?? "http://x/").pathname === "/pair";

/** What a browser sends for a fetch() or form post, by where it came from. */
const FETCH = {
	crossSite: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty" },
	sameSite: { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty" },
	sameOrigin: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", origin },
	none: { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
} as const;
const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } as const;

describe("cookieOriginAllowed", () => {
	it("reads Fetch Metadata before Origin, and lets only top-level page loads in from other sites", () => {
		const allowed = (headers: Record<string, string>, method?: string) => cookieOriginAllowed(new Headers({ host, ...headers }), method);
		// The audit's probe: fetch metadata only, no Origin.
		assert.equal(allowed({ "sec-fetch-site": "cross-site" }, "POST"), false, "cross-site write, no Origin");
		assert.equal(allowed({ "sec-fetch-site": "same-site" }, "POST"), false, "same-site write, no Origin");
		assert.equal(allowed(FETCH.crossSite, "GET"), false, "cross-site subresource or fetch");
		assert.equal(allowed({ "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }, "GET"), false, "a same-site <img>");
		assert.equal(allowed({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }, "GET"), false, "a frame");
		assert.equal(allowed({ "sec-fetch-site": "cross-site", ...NAVIGATE, origin: evil }, "POST"), false, "a cross-site form post");
		assert.equal(allowed({ "sec-fetch-site": "cross-site", ...NAVIGATE, origin: evil }), false, "a form post seen by a layout (no method)");
		// Top-level page loads from another site (a link, a redirect) still work.
		assert.equal(allowed({ "sec-fetch-site": "cross-site", ...NAVIGATE }, "GET"), true, "a link from another site");
		assert.equal(allowed({ "sec-fetch-site": "same-site", ...NAVIGATE }, "HEAD"), true);
		assert.equal(allowed({ "sec-fetch-site": "cross-site", ...NAVIGATE }), true, "a layout (no method) on a link from another site");
		// Same-origin, typed addresses, and no Fetch Metadata keep T3's Origin rule.
		assert.equal(allowed(FETCH.sameOrigin, "POST"), true);
		assert.equal(allowed({ ...FETCH.sameOrigin, origin: "http://other:1" }, "POST"), true, "same-origin behind a proxy that rewrites Host");
		assert.equal(allowed(FETCH.none, "GET"), true, "a typed address or bookmark");
		assert.equal(allowed({}, "POST"), true, "no Fetch Metadata, no Origin: curl, lh, the phone");
		assert.equal(allowed({ origin }, "POST"), true, "no Fetch Metadata, matching Origin: a plain-http LAN page");
		assert.equal(allowed({ origin: evil }, "POST"), false, "no Fetch Metadata, foreign Origin");
		assert.equal(allowed({ "sec-fetch-site": "cross-site", origin }, "POST"), false, "Fetch Metadata wins over a matching Origin");
	});
});

describe("the login gate (proxy.ts), every signed-in route", () => {
	it("refuses a cross-site or same-site cookie write with no Origin, and keeps every legitimate client working", () => {
		const cookie = `${cookieName()}=${mintToken()}`;
		const chats = (headers: Record<string, string>, method = "POST", url = `${origin}/api/chats`) =>
			proxy(new NextRequest(url, { method, headers: { cookie, host, ...headers } }));
		// The answer key's request (prove-learnharness references/api.md, issue #303).
		assert.equal(chats({ "sec-fetch-site": "cross-site", "content-type": "application/json" }).status, 403, "cross-site, fetch metadata only");
		assert.equal(chats(FETCH.crossSite).status, 403, "cross-site");
		assert.equal(chats(FETCH.sameSite).status, 403, "same-site");
		assert.equal(chats(FETCH.crossSite, "GET").status, 403, "a cross-site read of the API");
		assert.equal(chats({ ...FETCH.sameSite, "sec-fetch-dest": "image" }, "GET").status, 403, "a same-site <img> at the API");
		assert.equal(chats({ "sec-fetch-site": "cross-site", ...NAVIGATE, origin: evil }).status, 403, "a cross-site form post");
		assert.equal(chats({ origin: evil }).status, 403, "no Fetch Metadata, foreign Origin");
		// Legitimate browsers.
		assert(passes(chats(FETCH.sameOrigin)), "same-origin web app");
		assert(passes(chats({ origin })), "plain-http LAN page (no Fetch Metadata)");
		assert(passes(chats(FETCH.none, "GET", `${origin}/chat/abc`)), "a typed address");
		assert(passes(chats({}, "GET", `${origin}/chat/abc`)), "no headers at all");
		assert(passes(chats({ "sec-fetch-site": "cross-site", ...NAVIGATE }, "GET", `${origin}/chat/abc`)), "a link from another site opens the page");
		// A refused cookie on a page shows the pairing screen, as signed out does.
		assert(rewrittenToPair(chats({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }, "GET", `${origin}/chat/abc`)), "framed by another site");
		// The desktop windows and the phone send a bearer token, which skips the cookie rule.
		const bearer = { authorization: `Bearer ${mintToken("desktop")}` };
		assert(passes(proxy(new NextRequest(`${origin}/api/chats`, { method: "POST", headers: { ...bearer, cookie, ...FETCH.crossSite } }))), "desktop window: a refused cookie falls back to its bearer");
		assert(passes(proxy(new NextRequest("https://box.tail.ts.net:8443/api/subscriptions", { method: "POST", headers: { ...bearer, ...FETCH.sameOrigin, origin: "https://box.tail.ts.net:8443" } }))), "remote window (ChatGPT sign-in bridge)");
		assert(passes(proxy(new NextRequest(`${origin}/api/chats`, { method: "POST", headers: { authorization: `Bearer ${mintToken("phone")}` } }))), "phone app: no Fetch Metadata");
	});

	it("doesn't renew the cookie for another site's request", () => {
		const cookie = `${cookieName()}=${mintToken()}`;
		const response = proxy(new NextRequest(`${origin}/api/settings`, { headers: { cookie, host, ...FETCH.crossSite } }));
		assert.equal(response.status, 403);
		assert.equal(response.headers.get("set-cookie"), null);
	});
});

describe("POST /api/auth/browser-session, the route that sets the cookie", () => {
	const pair = (headers: Record<string, string>) => {
		const { code } = createPairingLink(AUTH_TEST_DATA_DIR);
		const request = new Request(`${origin}/api/auth/browser-session`, { method: "POST", headers: { "content-type": "application/json", host, ...headers }, body: JSON.stringify({ credential: code }) });
		return { code, response: browserSession(request) };
	};
	const stillUnspent = async (code: string) => {
		const retry = await browserSession(new Request(`${origin}/api/auth/browser-session`, { method: "POST", headers: { "content-type": "application/json", host, ...FETCH.sameOrigin }, body: JSON.stringify({ credential: code }) }));
		return retry.status === 200;
	};

	it("refuses a request from another site's page without spending the code, and pairs same-origin and plain-http pages", async () => {
		for (const [label, headers] of Object.entries({
			"cross-site, no Origin": { "sec-fetch-site": "cross-site" },
			"cross-site form post": { "sec-fetch-site": "cross-site", ...NAVIGATE, origin: evil, "content-type": "text/plain" },
			"cross-site fetch": { ...FETCH.crossSite, origin: evil },
			"same-site": FETCH.sameSite,
			"no Fetch Metadata, foreign Origin": { origin: evil },
		} as Record<string, Record<string, string>>)) {
			const { code, response } = pair(headers);
			const refused = await response;
			assert.equal(refused.status, 403, label);
			assert.equal(refused.headers.get("set-cookie"), null, label);
			assert.equal(await stillUnspent(code), true, `${label}: the code still works`);
		}
		for (const [label, headers] of Object.entries({
			"same-origin pairing page": FETCH.sameOrigin,
			"plain-http LAN pairing page (no Fetch Metadata)": { origin },
			"no headers (curl)": {},
		} as Record<string, Record<string, string>>)) {
			const response = await pair(headers).response;
			assert.equal(response.status, 200, label);
			assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`^${cookieName()}=`), label);
		}
	});

	it("takes only a JSON body, so a plain HTML form can't post a code", async () => {
		for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
			const { code } = createPairingLink(AUTH_TEST_DATA_DIR);
			const headers: Record<string, string> = { host, ...FETCH.sameOrigin };
			const request = new Request(`${origin}/api/auth/browser-session`, { method: "POST", headers, body: JSON.stringify({ credential: code }) });
			if (type) request.headers.set("content-type", type); else request.headers.delete("content-type");
			const response = await browserSession(request);
			assert.equal(response.status, 415, type || "no content type");
			assert.equal(response.headers.get("set-cookie"), null, type);
			assert.equal(await stillUnspent(code), true, `${type}: the code still works`);
		}
		const { code } = createPairingLink(AUTH_TEST_DATA_DIR);
		const charset = new Request(`${origin}/api/auth/browser-session`, { method: "POST", headers: { host, ...FETCH.sameOrigin, "content-type": "Application/JSON; charset=utf-8" }, body: JSON.stringify({ credential: code }) });
		assert.equal((await browserSession(charset)).status, 200, "a charset parameter and any case are fine");
	});
});

describe("the navigation exception covers pages only", () => {
	it("refuses another site's top-level GET to an API route, whatever the route does", () => {
		const cookie = `${cookieName()}=${mintToken()}`;
		const navigate = (pathname: string, site = "cross-site", method = "GET") =>
			proxy(new NextRequest(origin + pathname, { method, headers: { cookie, host, "sec-fetch-site": site, ...NAVIGATE } }));
		// API GETs that do work: persist a plugin question's cancellation, mint a
		// Deepgram token, record the last-seen version, sweep stale jobs.
		for (const pathname of ["/api/chats/chat_1", "/api/stt/token", "/api/whats-new", "/api/jobs?chatId=chat_1", "/api/activity", "/api/models", "/api/chats/chat_1/markdown", "/api", "/api/"]) {
			for (const site of ["cross-site", "same-site"]) {
				const response = navigate(pathname, site);
				assert.equal(response.status, 403, `${site} ${pathname}`);
				assert.equal(response.headers.get("set-cookie"), null, `${site} ${pathname}: no renewal`);
			}
		}
		for (const pathname of ["/", "/chat/abc", "/settings", "/apix", "/plugins/x/y"]) assert(passes(navigate(pathname)), `a link to the page ${pathname}`);
		assert(passes(navigate("/chat/abc", "cross-site", "HEAD")));
		// Same-origin, typed and no-metadata API GETs are unchanged.
		assert(passes(proxy(new NextRequest(`${origin}/api/stt/token`, { headers: { cookie, host, ...FETCH.sameOrigin } }))));
		assert(passes(proxy(new NextRequest(`${origin}/api/chats/chat_1/markdown`, { headers: { cookie, host, ...FETCH.none } }))), "a typed address");
		assert(passes(proxy(new NextRequest(`${origin}/api/stt/token`, { headers: { cookie, host } }))), "no Fetch Metadata");
		// The rule itself, as route handlers and the layout call it.
		const crossNav = new Headers({ host, "sec-fetch-site": "cross-site", ...NAVIGATE });
		assert.equal(cookieOriginAllowed(crossNav, "GET", "/api/stt/token"), false);
		assert.equal(cookieOriginAllowed(crossNav, "GET", null), false, "a URL that didn't parse");
		assert.equal(cookieOriginAllowed(crossNav, "GET", "/chat/abc"), true);
		assert.equal(cookieOriginAllowed(crossNav), true, "the layout: no method, no path, renders only for pages");
		assert.equal(authenticate({ headers: new Headers({ cookie, ...Object.fromEntries(crossNav) }), url: `${origin}/api/auth/clients`, method: "GET" }).ok, false, "authenticate() reads the path from the URL");
		assert.equal(authenticate({ headers: new Headers({ cookie, ...Object.fromEntries(crossNav) }), url: `${origin}/chat/abc`, method: "GET" }).ok, true);
	});
});

describe("the signed-in auth routes (they re-check the session themselves)", () => {
	it("refuse a cross-site cookie with no Origin, and accept same-origin cookies and bearer tokens", async () => {
		const own = mintToken("own");
		const other = authenticate({ headers: new Headers({ authorization: `Bearer ${mintToken("other")}` }) });
		assert(other.ok);
		const cookie = `${cookieName()}=${own}`;
		const request = (pathname: string, headers: Record<string, string>, body?: unknown) =>
			new Request(origin + pathname, { method: body === undefined ? "GET" : "POST", headers: { host, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const routes = [
			["pairing-token", (h: Record<string, string>) => createPairingToken(request("/api/auth/pairing-token", h, {}))],
			["clients", (h: Record<string, string>) => Promise.resolve(listClients(request("/api/auth/clients", h)))],
			["revoke", (h: Record<string, string>) => revokeClient(request("/api/auth/clients/revoke", h, { sessionId: "not-a-session" }))],
		] as const;
		for (const [name, call] of routes) {
			assert.equal((await call({ cookie, "sec-fetch-site": "cross-site" })).status, 403, `${name}: cross-site`);
			assert.equal((await call({ cookie, ...FETCH.sameSite })).status, 403, `${name}: same-site`);
			assert.equal((await call({ cookie, ...FETCH.sameOrigin })).status, 200, `${name}: same-origin`);
			assert.equal((await call({ cookie })).status, 200, `${name}: no Fetch Metadata`);
			assert.equal((await call({ authorization: `Bearer ${own}`, ...FETCH.crossSite })).status, 200, `${name}: bearer`);
		}
		// Signing every other device out is the one state change here; a cross-site page can't do it.
		const others = (headers: Record<string, string>) => revokeOtherClients(request("/api/auth/clients/revoke-others", headers, {}));
		assert.equal((await others({ cookie, "sec-fetch-site": "cross-site" })).status, 403);
		assert.equal(authenticate({ headers: new Headers({ authorization: `Bearer ${other.token}` }) }).ok, true, "the other device is still signed in");
		assert.equal((await others({ cookie, ...FETCH.sameOrigin })).status, 200);
		assert.equal(authenticate({ headers: new Headers({ authorization: `Bearer ${other.token}` }) }).ok, false);
		// The public session check reads, and treats another site's request as signed out.
		assert.deepEqual(await sessionState(request("/api/auth/session", { cookie, ...FETCH.crossSite })).json(), { authenticated: false });
		assert.equal((await sessionState(request("/api/auth/session", { cookie, ...FETCH.sameOrigin })).json() as { authenticated: boolean }).authenticated, true);
	});
});

describe("percent-encoded paths are API paths too (Next routes them decoded)", () => {
	it("refuses another site's top-level GET to an encoded API path, and answers 401 to one signed out", () => {
		const cookie = `${cookieName()}=${mintToken()}`;
		const navigate = (pathname: string) => proxy(new NextRequest(origin + pathname, { headers: { cookie, host, "sec-fetch-site": "cross-site", ...NAVIGATE } }));
		for (const pathname of ["/%61pi/stt/token", "/api%2Fwhats-new", "/%61pi/jobs?chatId=chat_1", "/%2561pi/whats-new", "/API/stt/token", "/%2F%2Fapi/activity", "/x/%2e%2e/api/models", "/%5Capi/stt/token", "/%E0%A4%A"]) {
			const response = navigate(pathname);
			assert.equal(response.status, 403, pathname);
			assert.equal(response.headers.get("set-cookie"), null, `${pathname}: no renewal`);
		}
		for (const pathname of ["/chat/%E2%80%A6", "/chat/abc%3Fx", "/settings"]) assert(passes(navigate(pathname)), `the page ${pathname}`);
		// Signed out, an encoded API path is an API request (401 JSON), not a page.
		for (const pathname of ["/%61pi/settings", "/api%2Fsettings"]) {
			const signedOut = proxy(new NextRequest(origin + pathname));
			assert.equal(signedOut.status, 401, pathname);
			assert.equal(signedOut.headers.get("x-middleware-rewrite"), null, `${pathname}: not the pairing screen`);
		}
		assert(rewrittenToPair(proxy(new NextRequest(`${origin}/chat/%E2%80%A6`))), "an encoded page still shows the pairing screen");
		assert.equal(reachesApi("/%25252561pi/x"), true, "still encoded after three decodings: fail closed");
		assert.equal(reachesApi("/apix"), false);
	});
});

describe("POST /api/auth/browser-session keeps a live session (the check-then-redeem race)", () => {
	const post = (code: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
		browserSession(new Request(`${origin}/api/auth/browser-session`, { method: "POST", headers: { "content-type": "application/json", host, ...FETCH.sameOrigin, ...headers }, body: JSON.stringify({ credential: code, ...extra }) }));
	const unspent = async (code: string) => (await post(code, {})).status === 200;

	it("refuses with 409 and spends nothing when the cookie names a live session, unless replace is sent", async () => {
		const live = mintToken("live");
		const cookie = `${cookieName()}=${live}`;
		const first = createPairingLink(AUTH_TEST_DATA_DIR).code;
		const refused = await post(first, { cookie });
		assert.equal(refused.status, 409);
		assert.equal(refused.headers.get("set-cookie"), null);
		assert.equal((await refused.json() as { reason?: string }).reason, "already_signed_in");
		for (const replace of [false, "true", 1]) assert.equal((await post(first, { cookie }, { replace })).status, 409, `replace: ${JSON.stringify(replace)}`);
		assert.equal(await unspent(first), true, "the code still works");
		const second = createPairingLink(AUTH_TEST_DATA_DIR).code;
		const replaced = await post(second, { cookie }, { replace: true });
		assert.equal(replaced.status, 200, "the person chose this link");
		assert.notEqual(replaced.headers.get("set-cookie")?.split(";")[0], cookie, "a new session cookie");
		// A cookie that names no live session is no session to keep.
		const stale = mintToken("stale");
		const session = verifyToken(AUTH_TEST_DATA_DIR, stale);
		assert(session);
		revokeSession(AUTH_TEST_DATA_DIR, session.id);
		assert.equal((await post(createPairingLink(AUTH_TEST_DATA_DIR).code, { cookie: `${cookieName()}=${stale}` })).status, 200, "revoked");
		assert.equal((await post(createPairingLink(AUTH_TEST_DATA_DIR).code, { cookie: `${cookieName()}=forged.token` })).status, 200, "forged");
	});

	it("never takes a login store it can't read for signed out: 503, and the code stays unspent", async () => {
		const live = mintToken("unreadable");
		const code = createPairingLink(AUTH_TEST_DATA_DIR).code;
		const sessions = path.join(authDir(AUTH_TEST_DATA_DIR), "sessions.json");
		const aside = `${sessions}.aside`;
		fs.renameSync(sessions, aside);
		fs.mkdirSync(sessions);
		let response: Response;
		let state: string;
		try {
			state = tokenState(AUTH_TEST_DATA_DIR, live).state;
			response = await post(code, { cookie: `${cookieName()}=${live}` });
		} finally {
			fs.rmdirSync(sessions);
			fs.renameSync(aside, sessions);
		}
		assert.equal(state, "unknown");
		assert.equal(verifyToken(AUTH_TEST_DATA_DIR, "x.y"), undefined, "verifyToken keeps its meaning");
		assert.equal(response.status, 503);
		assert.equal(response.headers.get("set-cookie"), null);
		assert.equal(tokenState(AUTH_TEST_DATA_DIR, live).state, "active", "readable again");
		assert.equal(await unspent(code), true, "the code still works");
	});
});

describe("no page can be framed", () => {
	it("sends frame-ancestors 'none' and X-Frame-Options: DENY on every path", async () => {
		const rules = await nextConfig.headers?.() ?? [];
		const all = rules.find((rule) => rule.source === "/:path*");
		assert(all, "a rule for every path");
		const header = (key: string) => all.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
		assert.equal(header("Content-Security-Policy"), "frame-ancestors 'none'");
		assert.equal(header("X-Frame-Options"), "DENY");
		assert.equal(all.has ?? all.missing, undefined, "unconditional");
	});
});

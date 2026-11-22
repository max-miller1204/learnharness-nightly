/**
 * Issue #323: browsers send no Fetch Metadata to a plain-HTTP, non-loopback
 * origin (a LAN or Tailscale address over http), nor does Safari before 16.4.
 * There, another origin of the same site (another port on the same LAN
 * address) could load an `<img>` or `<script>` from `/api` that carries the
 * sign-in cookie and no Origin. With no Fetch Metadata and no Origin, a cookie
 * request that reaches the API needs a Referer naming this host, as the
 * app's own fetches and EventSource streams send. Pages stay reachable, as
 * navigations. Bearer clients skip the rule. docs/specs/login-pairing.md
 */
import "./helpers/auth-data-dir.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";
import { listClients, sessionState } from "../src/server/auth-routes.ts";
import { CROSS_SITE_REFUSED, REFERER_REQUIRED, cookieOriginAllowed } from "../src/server/auth.ts";
import { cookieName, mintToken } from "./helpers/auth-data-dir.ts";

const lan = "http://192.168.1.5:3774";
const host = "192.168.1.5:3774";
// Another origin of the same site: another port on the same LAN address.
const sibling = "http://192.168.1.5:8080";
const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";

describe("cookieOriginAllowed with no Fetch Metadata", () => {
	it("needs a same-origin Referer for an API request with no Origin, and none for a page", () => {
		const allowed = (headers: Record<string, string>, method: string, pathname: string | null | undefined) =>
			cookieOriginAllowed(new Headers({ host, ...headers }), method, pathname);
		// A sibling origin's subresources: no Origin, its own Referer or none.
		assert.equal(allowed({}, "GET", "/api/stt/token"), false, "<img referrerpolicy=no-referrer>");
		assert.equal(allowed({ referer: `${sibling}/` }, "GET", "/api/stt/token"), false, "<img> from another port");
		assert.equal(allowed({ referer: "http://evil.example/" }, "GET", "/api/whats-new"), false, "<script> from another site");
		assert.equal(allowed({ referer: "not a url" }, "GET", "/api/jobs"), false);
		assert.equal(allowed({}, "POST", "/api/chats"), false, "any method: a POST without Origin isn't a browser's");
		assert.equal(allowed({}, "GET", "/%61pi/stt/token"), false, "an encoded API path");
		assert.equal(allowed({}, "GET", null), false, "a URL that didn't parse");
		// The app's own requests on a plain-HTTP page.
		assert.equal(allowed({ referer: `${lan}/chat/abc` }, "GET", "/api/events"), true, "EventSource");
		assert.equal(allowed({ referer: `${lan}/chat/abc` }, "GET", "/api/chats/chat_1/markdown"), true, "a download link");
		assert.equal(allowed({ referer: `${lan}/settings` }, "GET", "/api/subscriptions/browser"), true, "the sign-in tab, navigated by the app page");
		assert.equal(allowed({ origin: lan }, "PUT", "/api/attachments/upload"), true, "an upload sends Origin");
		assert.equal(allowed({ origin: sibling, referer: `${lan}/x` }, "POST", "/api/chats"), false, "a foreign Origin decides, whatever the Referer");
		// Pages are navigations; a typed address and the layout are unchanged.
		assert.equal(allowed({}, "GET", "/chat/abc"), true, "a page");
		assert.equal(allowed({ referer: `${sibling}/` }, "GET", "/chat/abc"), true, "a link from another port to a page");
		assert.equal(allowed({ "sec-fetch-site": "none" }, "GET", "/api/chats/chat_1/markdown"), true, "a typed address");
		assert.equal(allowed({}, "GET", undefined), true, "the layout (no path) renders only for pages");
	});
});

describe("cookieOriginAllowed: paths and Referer hosts, table-driven", () => {
	const cases: [string, Record<string, string>, string, boolean][] = [
		// [what, headers, pathname, allowed]: no Fetch Metadata, no Origin, GET.
		["/api itself", {}, "/api", false],
		["/api/", {}, "/api/", false],
		["/apiX is a page", {}, "/apiX", true],
		["an encoded slash", {}, "/api%2Fchats", false],
		["an encoded slash, lowercase", {}, "/api%2fchats", false],
		["a page with an encoded slash", {}, "/chat%2Fabc", true],
		["a bracketed IPv6 Referer naming this host", { host: "[fe80::1]:3774", referer: "http://[fe80::1]:3774/chat/abc" }, "/api/chats", true],
		["a bracketed IPv6 Referer on another port", { host: "[fe80::1]:3774", referer: "http://[fe80::1]:8080/" }, "/api/chats", false],
		["a bracketed IPv6 Referer for another address", { host: "[fe80::1]:3774", referer: "http://[fe80::2]:3774/" }, "/api/chats", false],
		["a Referer with userinfo naming this host (userinfo isn't the host)", { referer: `http://user:pass@${host}/settings` }, "/api/chats", true],
		["a Referer whose userinfo looks like this host", { referer: `http://${host}@evil.example/` }, "/api/chats", false],
	];
	for (const [what, headers, pathname, expected] of cases) {
		it(`${what}: ${expected ? "allowed" : "refused"}`, () => {
			assert.equal(cookieOriginAllowed(new Headers({ host, ...headers }), "GET", pathname), expected);
		});
	}
});

describe("the login gate on a plain-HTTP LAN address", () => {
	it("refuses a sibling origin's originless subresource to the API, for any method, and keeps the app working", async () => {
		const cookie = `${cookieName()}=${mintToken()}`;
		const send = (pathname: string, headers: Record<string, string> = {}, method = "GET") =>
			proxy(new NextRequest(lan + pathname, { method, headers: { cookie, host, ...headers } }));
		for (const pathname of ["/api/stt/token", "/api/whats-new", "/api/chats/chat_1", "/api/jobs?chatId=chat_1", "/api/activity", "/%61pi/stt/token"]) {
			for (const [label, headers] of [["no Referer", {}], ["another port", { referer: `${sibling}/` }], ["another site", { referer: "http://evil.example/" }]] as const) {
				const response = send(pathname, headers);
				assert.equal(response.status, 403, `${pathname}, ${label}`);
				assert.equal(response.headers.get("set-cookie"), null, `${pathname}, ${label}: no renewal`);
			}
		}
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(send("/api/chats", {}, method).status, 403, `${method} with no Origin`);
		// The refusal says what it needs, not "cross-site": a pasted /api URL is refused the same way.
		assert.deepEqual(await send("/api/chats/chat_1/markdown").json(), { error: REFERER_REQUIRED });
		assert.deepEqual(await send("/api/chats", { origin: sibling }, "POST").json(), { error: CROSS_SITE_REFUSED }, "a foreign Origin is cross-site");
		// The app's own requests.
		assert(passes(send("/api/events", { referer: `${lan}/chat/abc` })), "EventSource");
		assert(passes(send("/api/chats", { referer: `${lan}/` })), "a GET fetch");
		assert(passes(send("/api/chats", { origin: lan, referer: `${lan}/` }, "POST")), "a POST fetch");
		assert(passes(send("/api/plugins/x/assets/icon.svg", { referer: `${lan}/plugins/x/y` })), "a plugin asset the page loads");
		// Pages: a navigation, also from another port.
		assert(passes(send("/chat/abc")), "a page");
		assert(passes(send("/chat/abc", { referer: `${sibling}/` })), "a link from another port to a page");
		// Bearer clients (the phone, lh, the desktop window) send no Referer and are unaffected.
		const bearer = { authorization: `Bearer ${mintToken("bearer")}` };
		assert(passes(proxy(new NextRequest(`${lan}/api/stt/token`, { headers: { host, ...bearer } }))), "phone or lh");
		assert(passes(proxy(new NextRequest(`${lan}/api/chats`, { method: "POST", headers: { host, cookie, ...bearer } }))), "desktop window: a refused cookie falls back to its bearer");
	});

	it("the routes that check the session themselves follow the same rule", async () => {
		const cookie = `${cookieName()}=${mintToken()}`;
		const get = (pathname: string, headers: Record<string, string> = {}) => new Request(lan + pathname, { headers: { cookie, host, ...headers } });
		assert.deepEqual(await sessionState(get("/api/auth/session")).json(), { authenticated: false }, "an originless subresource is signed out");
		assert.equal((await sessionState(get("/api/auth/session", { referer: `${lan}/pair` })).json() as { authenticated: boolean }).authenticated, true);
		const refused = listClients(get("/api/auth/clients", { referer: `${sibling}/` }));
		assert.equal(refused.status, 403);
		assert.deepEqual(await refused.json(), { error: REFERER_REQUIRED });
		assert.equal(listClients(get("/api/auth/clients", { referer: `${lan}/settings` })).status, 200);
	});
});

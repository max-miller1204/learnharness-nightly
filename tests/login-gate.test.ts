/**
 * The login gate in proxy.ts (docs/specs/login-pairing.md): every request
 * needs a credential, no localhost bypass, static files and the pairing
 * exchange stay public, signed-out pages render the pairing screen.
 */
import "./helpers/auth-data-dir.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
// Installed Next retains this name for its Proxy matcher test helper.
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";
import { config, proxy } from "../proxy.ts";
import { cookieName, mintToken } from "./helpers/auth-data-dir.ts";
import { COOKIE_LIFETIME_MS, cookieOriginAllowed } from "../src/server/auth.ts";

const origin = "http://localhost:3000";
const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";
const rewrittenToPair = (response: Response) => new URL(response.headers.get("x-middleware-rewrite") ?? "http://x/").pathname === "/pair";

describe("matcher", () => {
	it("covers pages and every API route, but not static files or the streamed documents route", () => {
		const matches = (pathname: string) => unstable_doesProxyMatch({ config, nextConfig: {}, url: origin + pathname });
		for (const p of ["/", "/chat/new", "/chat/abc", "/settings", "/plugins/x/y", "/pair", "/api", "/api/events", "/api/chat", "/api/health", "/api/graph/import", "/oauth/token", "/apix"]) assert.equal(matches(p), true, p);
		for (const p of ["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico", "/fonts/cmunbx.ttf", "/siwc/x.js", "/worklets/a.js", "/plugin-loader.js", "/api/plugins/one/documents/markdown"]) assert.equal(matches(p), false, p);
	});
});

describe("signed out", () => {
	it("API routes answer 401 for every method, from localhost too", () => {
		for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
			const response = proxy(new NextRequest(`${origin}/api/settings`, { method }));
			assert.equal(response.status, 401, method);
			assert.equal(response.headers.get("cache-control"), "no-store");
		}
		assert.equal(proxy(new NextRequest("http://127.0.0.1:3774/api/events")).status, 401);
	});

	it("pages are rewritten to the pairing screen", () => {
		for (const p of ["/", "/chat/abc", "/plugins/x/y"]) assert(rewrittenToPair(proxy(new NextRequest(origin + p))), p);
	});

	it("targets the local HTTP listener behind an HTTPS reverse proxy", () => {
		const response = proxy(new NextRequest("https://localhost:3774/chat/abc?view=one", {
			headers: { "x-forwarded-proto": "https", "x-forwarded-host": "box.tail.ts.net:8443" },
		}));
		assert.equal(response.headers.get("x-middleware-rewrite"), "http://localhost:3774/pair");
		const defaultPort = proxy(new NextRequest("https://localhost:443/", {
			headers: { "x-forwarded-proto": "https", "x-forwarded-host": "box.tail.ts.net:8443" },
		}));
		assert.equal(defaultPort.headers.get("x-middleware-rewrite"), "http://localhost:443/pair");
	});

	it("the pairing screen, the exchanges and health stay public", () => {
		for (const p of ["/pair", "/api/health", "/api/auth/session", "/api/auth/browser-session", "/oauth/token"]) assert(passes(proxy(new NextRequest(origin + p, { method: p.includes("session") || p.includes("token") ? "POST" : "GET" }))), p);
	});

	it("a bad or tampered token is refused", () => {
		const token = mintToken();
		const [payload, signature] = token.split(".") as [string, string];
		const flipped = `${payload}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
		for (const bad of ["nope", flipped, `${payload}x.${signature}`]) {
			assert.equal(proxy(new NextRequest(`${origin}/api/settings`, { headers: { authorization: `Bearer ${bad}` } })).status, 401, bad);
		}
	});
});

describe("signed in", () => {
	it("a bearer token passes on any host, pages and API", () => {
		const token = mintToken();
		for (const url of [`${origin}/api/settings`, "http://box.tail.ts.net:8443/chat/abc", "http://127.0.0.1:3774/api/events"]) {
			assert(passes(proxy(new NextRequest(url, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://elsewhere.example" } }))), url);
		}
	});

	it("a cookie passes same-origin and is refused cross-site (T3's cookie Origin rule)", () => {
		const cookie = `${cookieName()}=${mintToken()}`;
		assert(passes(proxy(new NextRequest(`${origin}/api/chats`, { method: "POST", headers: { cookie, host: "localhost:3000", origin } }))));
		assert(passes(proxy(new NextRequest(`${origin}/api/chats`, { method: "POST", headers: { cookie, origin: "http://other:1", "sec-fetch-site": "same-origin" } }))));
		assert(passes(proxy(new NextRequest(`${origin}/chat/abc`, { headers: { cookie } }))), "a navigation has no Origin");
		const csrf = proxy(new NextRequest(`${origin}/api/chats`, { method: "POST", headers: { cookie, host: "localhost:3000", origin: "https://evil.example", "sec-fetch-site": "cross-site" } }));
		assert.equal(csrf.status, 403);
	});

	it("renews browser cookies during use without reissuing them for bearer requests", () => {
		const token = mintToken();
		const cookie = `${cookieName()}=${token}`;
		const started = Date.now();
		const request = new NextRequest(`${origin}/api/settings`, { headers: { cookie, "x-forwarded-proto": "https" } });
		const response = proxy(request);
		assert.ok(passes(response));
		assert.equal(response.headers.get("cache-control"), "no-store");
		const renewed = response.headers.get("set-cookie") ?? "";
		assert.equal(renewed.split(";")[0], cookie);
		assert.match(renewed, /; Path=\/; Expires=[^;]+; HttpOnly; SameSite=Lax; Secure$/);
		const expires = Date.parse(/Expires=([^;]+)/.exec(renewed)?.[1] ?? "");
		assert.ok(expires >= started + COOKIE_LIFETIME_MS - 1000);
		assert.ok(expires <= Date.now() + COOKIE_LIFETIME_MS);
		assert.equal(proxy(request).headers.get("set-cookie"), null, "last-seen throttle");
		const bearer = proxy(new NextRequest(`${origin}/api/settings`, { headers: { authorization: `Bearer ${mintToken()}` } }));
		assert.ok(passes(bearer));
		assert.equal(bearer.headers.get("set-cookie"), null);
	});

	it("the Host allowlist is gone: any host name works with a credential", () => {
		const cookie = `${cookieName()}=${mintToken()}`;
		assert(passes(proxy(new NextRequest("http://mymac.local:3000/api/settings", { headers: { cookie, host: "mymac.local:3000" } }))));
	});

	it("cookieOriginAllowed follows T3's rule", () => {
		assert.equal(cookieOriginAllowed(new Headers()), true);
		assert.equal(cookieOriginAllowed(new Headers({ origin: "https://a.example", "sec-fetch-site": "same-origin" })), true);
		assert.equal(cookieOriginAllowed(new Headers({ origin: "https://a.example:8443", host: "a.example:8443" })), true);
		assert.equal(cookieOriginAllowed(new Headers({ origin: "https://a.example", host: "b.example" })), false);
		assert.equal(cookieOriginAllowed(new Headers({ origin: "null", host: "b.example" })), false);
	});
});

describe("package scripts", () => {
	it("serve on loopback unless the developer passes a later -H", () => {
		const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: { dev: string; start: string; "desktop:dev": string } };
		assert.match(scripts.dev, /^npm run plugins:build-core && npm run plugins:build-authoring && next dev -H localhost\b/);
		assert.match(scripts.start, /^next start -H localhost\b/);
		assert.match(scripts["desktop:dev"], /"npm run dev"/);
	});
});

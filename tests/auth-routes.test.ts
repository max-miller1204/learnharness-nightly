/** The login and pairing routes (docs/specs/login-pairing.md). */
import "./helpers/auth-data-dir.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createPairingLink, formatCode } from "../selfhost/src/auth-store.ts";
import { browserSession, createPairingToken, listClients, revokeClient, revokeOtherClients, sessionState, tailscaleOrigin, tokenExchange } from "../src/server/auth-routes.ts";
import { clientInfo, inferBrowser, inferDeviceType, inferOs } from "../src/server/auth.ts";
import { printStartupPairingLink } from "../src/server/startup-pairing.ts";
import { AUTH_TEST_DATA_DIR, cookieName } from "./helpers/auth-data-dir.ts";

const origin = "http://localhost:3000";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const post = (pathname: string, body: unknown, headers: Record<string, string> = {}) =>
	new Request(origin + pathname, { method: "POST", headers: { "content-type": "application/json", host: "localhost:3000", ...headers }, body: JSON.stringify(body) });

async function pairBrowser(userAgent = MAC_CHROME, extra: Record<string, string> = {}) {
	const { code } = createPairingLink(AUTH_TEST_DATA_DIR);
	const response = await browserSession(post("/api/auth/browser-session", { credential: code }, { "user-agent": userAgent, ...extra }));
	const setCookie = response.headers.get("set-cookie") ?? "";
	return { response, setCookie, cookie: setCookie.split(";")[0] ?? "" };
}

describe("browser pairing", () => {
	it("sets T3's cookie and spends the code once", async () => {
		const { code } = createPairingLink(AUTH_TEST_DATA_DIR);
		const response = await browserSession(post("/api/auth/browser-session", { credential: formatCode(code) }, { "user-agent": IPHONE, "x-forwarded-for": "10.0.0.1, 100.101.102.103" }));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		const setCookie = response.headers.get("set-cookie") ?? "";
		assert.match(setCookie, new RegExp(`^${cookieName()}=[^;]+; Path=/; Expires=[^;]+; HttpOnly; SameSite=Lax$`));
		assert.doesNotMatch(setCookie, /Secure/, "plain http");
		const again = await browserSession(post("/api/auth/browser-session", { credential: code }));
		assert.equal(again.status, 401);
		assert.match((await again.json() as { error: string }).error, /wrong, expired or already used/);
		const cookie = setCookie.split(";")[0] ?? "";
		const state = await sessionState(new Request(`${origin}/api/auth/session`, { headers: { cookie } })).json() as { authenticated: boolean };
		assert.equal(state.authenticated, true);
		const list = await listClients(new Request(`${origin}/api/auth/clients`, { headers: { cookie } })).json() as { clients: { current: boolean; deviceType: string; os?: string; browser?: string; ip?: string }[] };
		const me = list.clients.find((c) => c.current);
		assert.deepEqual({ deviceType: me?.deviceType, os: me?.os, browser: me?.browser, ip: me?.ip }, { deviceType: "mobile", os: "iOS", browser: "Safari", ip: "100.101.102.103" });
	});

	it("marks the cookie Secure over https (X-Forwarded-Proto counts)", async () => {
		const { setCookie } = await pairBrowser(MAC_CHROME, { "x-forwarded-proto": "https" });
		assert.match(setCookie, /; Secure$/);
	});

	it("signed out, the session route says so", async () => {
		assert.deepEqual(await sessionState(new Request(`${origin}/api/auth/session`)).json(), { authenticated: false });
	});
});

describe("native token exchange", () => {
	const exchange = (fields: Record<string, string>) => tokenExchange(new Request(`${origin}/oauth/token`, {
		method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "LearnHarnessApp/1.0" }, body: new URLSearchParams(fields),
	}));
	const base = { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token_type: "urn:learnharness:params:oauth:token-type:pairing-code", requested_token_type: "urn:ietf:params:oauth:token-type:access_token" };

	it("trades a code for a bearer token with the client's own metadata", async () => {
		const { code } = createPairingLink(AUTH_TEST_DATA_DIR);
		const response = await exchange({ ...base, subject_token: code, client_label: "Max's phone", client_device_type: "mobile", client_os: "Android" });
		const body = await response.json() as { access_token: string; token_type: string; issued_token_type: string; expires_in: number };
		assert.equal(response.status, 200);
		assert.equal(body.token_type, "Bearer");
		assert.equal(body.issued_token_type, "urn:ietf:params:oauth:token-type:access_token");
		assert.ok(body.expires_in > 29 * 24 * 3600 && body.expires_in <= 30 * 24 * 3600);
		const list = await listClients(new Request(`${origin}/api/auth/clients`, { headers: { authorization: `Bearer ${body.access_token}` } })).json() as { clients: { current: boolean; label?: string; deviceType: string; os?: string }[] };
		const me = list.clients.find((c) => c.current);
		assert.deepEqual({ label: me?.label, deviceType: me?.deviceType, os: me?.os }, { label: "Max's phone", deviceType: "mobile", os: "Android" });
		assert.equal((await exchange({ ...base, subject_token: code })).status, 400, "single use");
	});

	it("answers OAuth errors", async () => {
		assert.equal((await (await exchange({ ...base, grant_type: "password", subject_token: "x" })).json() as { error: string }).error, "unsupported_grant_type");
		assert.equal((await (await exchange({ ...base, subject_token: "" })).json() as { error: string }).error, "invalid_request");
		assert.equal((await (await exchange({ ...base, subject_token_type: "other", subject_token: "x" })).json() as { error: string }).error, "invalid_request");
		assert.equal((await (await exchange({ ...base, subject_token: "ABCD-EFGH-JKLM" })).json() as { error: string }).error, "invalid_grant");
	});
});

describe("devices", () => {
	it("creates links, lists devices, revokes one and all others, never yourself", async () => {
		const me = await pairBrowser();
		const other = await pairBrowser(IPHONE);
		const auth = { cookie: me.cookie };
		const unauth = await createPairingToken(post("/api/auth/pairing-token", {}));
		assert.equal(unauth.status, 401);
		const made = await (await createPairingToken(post("/api/auth/pairing-token", { label: "Tablet" }, auth))).json() as { credential: string; label: string; expiresAt: string };
		assert.equal(made.credential.length, 12);
		assert.equal(made.label, "Tablet");
		const ids = async () => (await listClients(new Request(`${origin}/api/auth/clients`, { headers: auth })).json() as { clients: { sessionId: string; current: boolean }[] }).clients;
		const mine = (await ids()).find((c) => c.current)!;
		const theirs = (await ids()).find((c) => !c.current)!;
		const self = await revokeClient(post("/api/auth/clients/revoke", { sessionId: mine.sessionId }, auth));
		assert.equal(self.status, 400);
		assert.deepEqual(await self.json(), { error: "current_session_revoke_not_allowed" });
		assert.deepEqual(await revokeClient(post("/api/auth/clients/revoke", { sessionId: theirs.sessionId }, auth)).then((r) => r.json()), { revoked: true });
		assert.equal((await listClients(new Request(`${origin}/api/auth/clients`, { headers: { cookie: other.cookie } }))).status, 401, "the revoked device is signed out");
		await pairBrowser();
		const count = await (await revokeOtherClients(post("/api/auth/clients/revoke-others", {}, auth))).json() as { revokedCount: number };
		assert.ok(count.revokedCount >= 1);
		assert.deepEqual((await ids()).map((c) => c.current), [true]);
	});

	it("offers the launcher's Tailscale address when there is one", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ts-"));
		try {
			fs.mkdirSync(path.join(home, "userdata"), { recursive: true });
			fs.writeFileSync(path.join(home, "userdata", "config.json"), JSON.stringify({ port: 3774, tailscale: { enabled: true, port: 8443, hostname: "box.tail1234.ts.net" } }));
			assert.equal(tailscaleOrigin({ LH_SELFHOST: "1", LH_HOME: home }), "https://box.tail1234.ts.net:8443");
			assert.equal(tailscaleOrigin({ LH_HOME: home }), undefined, "only self-hosted");
			fs.writeFileSync(path.join(home, "userdata", "config.json"), JSON.stringify({ tailscale: { enabled: false } }));
			assert.equal(tailscaleOrigin({ LH_SELFHOST: "1", LH_HOME: home }), undefined);
		} finally { fs.rmSync(home, { recursive: true, force: true }); }
	});
});

describe("client metadata and the startup link", () => {
	it("parses the User-Agent with T3's rules", () => {
		assert.deepEqual([inferDeviceType(IPHONE), inferOs(IPHONE), inferBrowser(IPHONE)], ["mobile", "iOS", "Safari"]);
		assert.deepEqual([inferDeviceType(MAC_CHROME), inferOs(MAC_CHROME), inferBrowser(MAC_CHROME)], ["desktop", "macOS", "Chrome"]);
		assert.equal(inferDeviceType("curl/8.0"), "bot");
		assert.equal(inferDeviceType(undefined), "unknown");
		assert.equal(clientInfo({ headers: new Headers({ "x-forwarded-for": "not-an-ip" }) }).ip, "127.0.0.1");
	});

	it("prints a hidden one-time link only outside lh and the desktop app", () => {
		const lines: string[] = [];
		printStartupPairingLink({ PORT: "3000", NODE_ENV: "production" }, (line) => lines.push(line));
		assert.match(lines[0] ?? "", /^\[auth\] Pair a browser: http:\/\/localhost:3000\/pair#token=[2-9A-HJ-NP-Z]{12} \(one-time, expires in 5 minutes\)\./);
		printStartupPairingLink({ NODE_ENV: "development" }, (line) => lines.push(line));
		assert.match(lines[1] ?? "", /expires in 24 hours/);
		printStartupPairingLink({ LH_SELFHOST: "1" }, (line) => lines.push(line));
		printStartupPairingLink({ LH_DESKTOP_SERVER: "1" }, (line) => lines.push(line));
		assert.equal(lines.length, 2);
	});
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ChatGPTStatus } from "../src/core/contracts/chatgpt.ts";
import { completedWithin } from "./completion.ts";
const require = createRequire(import.meta.url);
const { createChatGPT, fileStore, allowedAuthEndpoint, SCOPES } = require("../electron/chatgpt.cjs");
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "scratch-key", alg: "RS256", use: "sig" };
const tokenUrl = "https://auth.openai.com/api/accounts/oauth/token";
const initial = () => ({ version: 1, hostId: "urn:uuid:00000000-0000-4000-8000-000000000001", activeId: null as string | null, registrations: [] as any[] });
async function signed(client: string, nonce: string, subject = "scratch-user", overrides: Record<string, unknown> = {}) {
	return new SignJWT({ nonce, email: "dummy@example.invalid", ...overrides }).setProtectedHeader({ alg: "RS256", kid: "scratch-key" }).setIssuer("https://auth.openai.com").setSubject(subject).setAudience(client).setIssuedAt().setExpirationTime("1h").sign(privateKey);
}
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
function fixture(options: { state?: any; expires?: number; timeoutMs?: number; token?: (form: URLSearchParams, url: URL) => Promise<Response>; write?: (next: any) => Promise<void>; read?: () => void; change?: (push: any) => void; provider?: (target: string, init: RequestInit) => Promise<Response | undefined> } = {}) {
	let saved = structuredClone(options.state ?? initial());
	let url!: URL;
	let writeCount = 0;
	const changed = deferred();
	const requests: { url: string; form?: URLSearchParams }[] = [];
	const service = createChatGPT({
		store: { async read() { options.read?.(); return structuredClone(saved); }, async write(next: any) { writeCount++; await options.write?.(next); saved = structuredClone(next); } },
		openExternal: async (value: string) => { url = new URL(value); },
		timeoutMs: options.timeoutMs ?? 5000,
		onChange: (push: any) => { options.change?.(push); if (!push.status.pending) changed.resolve(); },
		fetch: async (target: string, init: RequestInit = {}) => {
			const form = init.body instanceof URLSearchParams ? init.body : undefined;
			requests.push({ url: target, form });
			const response = await options.provider?.(target, init); if (response) return response;
			if (target.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
			if (target === tokenUrl) {
				if (options.token) return options.token(form!, url);
				return Response.json({ access_token: "scratch-oauth-token", refresh_token: "scratch-refresh", id_token: await signed(form!.get("client_id")!, url.searchParams.get("nonce")!), token_type: "Bearer", expires_in: options.expires ?? 3600, scope: SCOPES.join(" ") });
			}
			if (target.endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" });
			if (target.endsWith("/revoke")) return new Response(null, { status: 200 });
			if (target.endsWith("/models")) return Response.json({ models: [{ slug: "gpt-5", display_name: "Scratch model", visibility: "list" }, { slug: "hidden", display_name: "Hidden", visibility: "hide" }] });
			throw new Error("Unexpected network request in scratch fixture");
		},
	});
	const rawLease = service.lease;
	let discovered: Promise<any> | undefined;
	service.lease = async (background: boolean) => {
		discovered ??= service.models();
		const catalog = await discovered;
		return rawLease(background, { expectedAccountId: catalog.accountId ?? saved.activeId ?? "scratch-missing", expectedAuthorityRevision: catalog.authorityRevision, selectedModelId: "gpt-5" });
	};
	return { service, rawLease, requests, changed, get url() { return url; }, get saved() { return saved; }, get writeCount() { return writeCount; }, async callback(params: Record<string, string> = {}) {
		const callback = new URL(url.searchParams.get("redirect_uri")!);
		callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "scratch-code", client_id: "oaiapp_scratch", ...params }).toString();
		return fetch(callback);
	} };
}
async function loggedIn(options: Parameters<typeof fixture>[0] = {}) {
	const f = fixture(options);
	await f.service.login();
	await f.callback();
	await f.changed.promise;
	return f;
}

test("PKCE/state/nonce/host identity and exact ephemeral 127.0.0.1 callback; no secret renderer snapshot", async () => {
	const f = fixture();
	try {
		await f.service.login();
		const params = f.url.searchParams;
		assert.equal(params.get("client_id"), "dynamic_agent_client");
		assert.equal(params.get("agent_name_hint"), "LearnHarness");
		assert.equal(params.get("ext_agent_host_id"), f.saved.hostId);
		assert.equal(new URL(params.get("redirect_uri")!).hostname, "127.0.0.1");
		assert.equal(new URL(params.get("redirect_uri")!).pathname, "/auth/callback");
		assert.equal((await f.callback({ state: "wrong" })).status, 400);
		assert.equal(f.requests.length, 0, "unverified callback must never exchange a code");
		await f.callback(); await f.changed.promise;
		const form = f.requests.find((r) => r.url === tokenUrl)!.form!;
		assert.equal(form.get("redirect_uri"), params.get("redirect_uri"));
		assert.equal(form.get("client_id"), "oaiapp_scratch");
		assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), params.get("code_challenge"));
		assert.equal(form.get("resource"), "https://api.openai.com/v1");
		const status = await f.service.status();
		assert.equal(status.allowBackgroundUse, true);
		assert.equal(f.saved.registrations[0].background, undefined, "new registrations do not store obsolete per-account preferences");
		assert.equal(status.activeId, f.saved.activeId);
		assert(!JSON.stringify(status).includes("scratch-oauth-token"));
		assert(!JSON.stringify(status).includes("scratch-refresh"));
		assert(!JSON.stringify(status).includes("idToken"));
		assert.equal((await f.service.lease(false)).accessToken, "scratch-oauth-token");
		assert.equal((await f.service.lease(true)).accessToken, "scratch-oauth-token");
		await f.service.consent(false);
		await assert.rejects(f.service.lease(true), /background/);
	} finally { f.service.close(); }
});

test("returning sign-in reuses issued client/host and fresh PKCE; rejects account/client mismatch without replacing active credentials", async () => {
	const f = await loggedIn();
	try {
		const first = f.url;
		const status = await f.service.status();
		await f.service.login(status.activeId);
		assert.equal(f.url.searchParams.get("client_id"), "oaiapp_scratch");
		assert.equal(f.url.searchParams.get("agent_name_hint"), null);
		assert(f.url.searchParams.get("id_token_hint"));
		assert.notEqual(f.url.searchParams.get("state"), first.searchParams.get("state"));
		assert.notEqual(f.url.searchParams.get("nonce"), first.searchParams.get("nonce"));
		assert.equal(f.url.searchParams.get("ext_agent_host_id"), first.searchParams.get("ext_agent_host_id"));
		await f.callback({ client_id: "oaiapp_other" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(f.saved.registrations.length, 1);
		assert.equal((await f.service.lease(false)).accessToken, "scratch-oauth-token");
	} finally { f.service.close(); }
});

for (const [label, claims] of [["nonce", { nonce: "wrong" }], ["issuer", { iss: "https://evil.invalid" }], ["audience", { aud: "oaiapp_wrong" }], ["expiry", { exp: 1 }]] as const) {
	test(`rejects invalid ID-token ${label}`, async () => {
		const f = fixture({ token: async (form, url) => {
			const jwt = new SignJWT(Object.assign({ nonce: url.searchParams.get("nonce")!, email: "dummy@example.invalid", iss: "https://auth.openai.com", aud: form.get("client_id")!, sub: "scratch-user", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, claims));
			return Response.json({ access_token: "scratch-access", refresh_token: "scratch-refresh", id_token: await jwt.setProtectedHeader({ alg: "RS256", kid: "scratch-key" }).sign(privateKey), token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") });
		} });
		try { await f.service.login(); await f.callback(); await f.changed.promise; assert.equal(f.saved.activeId, null); assert.equal(f.saved.registrations.length, 0); }
		finally { f.service.close(); }
	});
}

test("cancel and timeout close the listener without exchanging or replacing an active account", async () => {
	const f = fixture({ timeoutMs: 30 });
	try {
		await f.service.login(); const callback = f.url.searchParams.get("redirect_uri")!;
		f.service.cancelLogin();
		await assert.rejects(fetch(callback));
		assert.equal(f.saved.activeId, null);
		const timeout = fixture({ timeoutMs: 15 });
		try {
			await timeout.service.login();
			await timeout.changed.promise;
			assert.equal((await timeout.service.status()).pending, false);
			assert.equal(timeout.requests.length, 0);
		} finally { timeout.service.close(); }
		assert.equal(f.requests.length, 0);
	} finally { f.service.close(); }
});

test("missing plan scope retains verified registration but refuses inference and catalog", async () => {
	const f = await loggedIn({ token: async (form, url) => Response.json({ id_token: await signed(form.get("client_id")!, url.searchParams.get("nonce")!), scope: "openid profile email", token_type: "Bearer" }) });
	try {
		assert.equal(f.saved.registrations.length, 1);
		assert.equal((await f.service.status()).accounts[0].planEnabled, false);
		await assert.rejects(f.service.lease(false), /scope/);
		assert.deepEqual((await f.service.models()).models, []);
	} finally { f.service.close(); }
});

test("durable file save failure never activates a pending login", async () => {
	const f = fixture({ write: async () => { throw new Error("scratch disk failure containing no real data"); } });
	try {
		await f.service.login(); await f.callback(); await f.changed.promise;
		assert.equal(f.saved.activeId, null);
		await assert.rejects(f.service.lease(false), /disconnected/);
	} finally { f.service.close(); }
});

test("rotated-token persistence failure invalidates existing leases and never reloads the stale saved token", async () => {
	let failWrite = false, reads = 0, refreshes = 0;
	const pushes: any[] = [];
	const f = await loggedIn({ read: () => { reads++; }, change: (push) => pushes.push(push),
		write: async () => { if (failWrite) throw Object.assign(new Error("storage"), { code: "storage" }); },
		token: async (form, url) => {
			if (form.get("grant_type") === "refresh_token") {
				refreshes++;
				return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600 });
			}
			return Response.json({ access_token: "old-access", refresh_token: "old-refresh", id_token: await signed(form.get("client_id")!, url.searchParams.get("nonce")!), token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") });
		},
	});
	try {
		const catalog = await f.service.models();
		const expected = { expectedAccountId: catalog.accountId, expectedAuthorityRevision: catalog.authorityRevision, selectedModelId: "gpt-5" };
		await f.rawLease(false, expected);
		// Advance time rather than mutating the service's private state.
		const now = Date.now; Date.now = () => now() + 3600000;
		try {
			failWrite = true;
			await assert.rejects(f.rawLease(false, expected), /storage/);
		} finally { Date.now = now; }
		assert.equal(refreshes, 1);
		assert.equal(f.saved.registrations[0].tokens.refreshToken, "old-refresh", "failed write leaves only the stale predecessor on disk");
		assert(pushes.some((push) => push.invalidate === "all" && push.stamp.epoch > catalog.epoch));
		failWrite = false;
		await f.service.status(); await f.service.models(); f.service.resume(); await f.service.consent(true);
		await assert.rejects(f.rawLease(false, expected)); await assert.rejects(f.rawLease(true, expected));
		assert.equal((await f.service.status()).accounts[0].connected, false);
		assert.equal(reads, 1); assert.equal(refreshes, 1, "no stale-token retry after storage recovers");
	} finally { f.service.close(); }
});

test("serialized concurrent refresh rotates once and persists before leases", async () => {
	let refreshes = 0;
	const f = await loggedIn({ expires: 1, token: async (form, url) => {
		if (form.get("grant_type") === "refresh_token") { refreshes++; assert.equal(form.get("scope"), null); return Response.json({ access_token: "scratch-new-access", refresh_token: "scratch-rotated", token_type: "Bearer", expires_in: 3600 }); }
		return Response.json({ access_token: "scratch-old-access", refresh_token: "scratch-old-refresh", id_token: await signed(form.get("client_id")!, url.searchParams.get("nonce")!), token_type: "Bearer", expires_in: 1, scope: SCOPES.join(" ") });
	} });
	try {
		const leases = await Promise.all([f.service.lease(false), f.service.lease(false), f.service.lease(false)]);
		assert.equal(refreshes, 1);
		assert(leases.every((lease) => lease.accessToken === "scratch-new-access"));
		assert.equal(f.saved.registrations[0].tokens.refreshToken, "scratch-rotated");
	} finally { f.service.close(); }
});

test("logout wins an in-flight refresh and retains only account/client/host mapping", async () => {
	const started = deferred(); const release = deferred();
	const f = await loggedIn({ token: async (form, url) => {
		if (form.get("grant_type") === "refresh_token") { started.resolve(); await release.promise; return Response.json({ access_token: "scratch-late", refresh_token: "scratch-rotated", token_type: "Bearer", expires_in: 3600 }); }
		return Response.json({ access_token: "scratch-old", refresh_token: "scratch-refresh", id_token: await signed(form.get("client_id")!, url.searchParams.get("nonce")!), token_type: "Bearer", expires_in: 1, scope: SCOPES.join(" ") });
	} });
	try {
		const id = f.saved.activeId;
		const refresh = f.service.lease(false); const rejected = assert.rejects(refresh);
		await started.promise;
		const logout = f.service.logout(id);
		await new Promise((resolve) => setImmediate(resolve)); release.resolve();
		await rejected; await logout;
		assert.equal(f.saved.activeId, null);
		assert.equal(f.saved.registrations[0].clientId, "oaiapp_scratch");
		assert.equal(f.saved.registrations[0].tokens, undefined);
		assert(f.requests.some((r) => r.form?.get("token_type_hint") === "refresh_token"));
		await f.service.login(id);
		assert.equal(f.url.searchParams.get("id_token_hint"), null);
		assert.equal(f.url.searchParams.get("client_id"), "oaiapp_scratch");
	} finally { f.service.close(); }
});

test("account catalog is scoped, visibility filtered, and cleared on disconnect", async () => {
	const f = await loggedIn();
	try {
		assert.deepEqual((await f.service.models()).models, [{ id: "gpt-5", name: "Scratch model" }]);
		await f.service.logout(f.saved.activeId);
		assert.deepEqual((await f.service.models()).models, []);
	} finally { f.service.close(); }
});

test("private JSON file round-trips global state; creation and atomic replacement are owner-only", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-chatgpt-storage-"));
	const file = path.join(dir, "private", "chatgpt-credentials.json");
	try {
		const store = fileStore(file);
		assert.equal(await store.read(), null);
		const data = { ...initial(), allowBackgroundUse: false };
		await store.write(data);
		assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), data, "ordinary JSON, not an encrypted envelope");
		assert.deepEqual(await store.read(), data);
		assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
		assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
		await fs.chmod(file, 0o644);
		await store.write({ ...data, allowBackgroundUse: true });
		assert.equal((await fs.stat(file)).mode & 0o777, 0o600, "replacement never inherits a permissive old mode");
		assert.equal((await store.read()).allowBackgroundUse, true);
		assert.deepEqual(await fs.readdir(path.dirname(file)), ["chatgpt-credentials.json"]);
	} finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("revocation endpoint remains restricted to the exact secure issuer", () => {
	assert(allowedAuthEndpoint("https://auth.openai.com/api/accounts/oauth/revoke"));
	assert(!allowedAuthEndpoint("https://auth.openai.com.evil.invalid/revoke"));
	assert(!allowedAuthEndpoint("http://127.0.0.1/revoke"));
	assert(!allowedAuthEndpoint("https://auth.openai.com@evil.invalid/revoke"));
});

for (const holdVerification of [false, true]) test(`invalid rotating replacement is durably revocation-only; verified mapping and prior validated ID survive restart${holdVerification ? " (held JWKS regression)" : ""}`, { timeout: 10000 }, async () => {
	const f = await loggedIn({ expires: 1, token: async (form, url) => form.get("grant_type") === "refresh_token"
		? Response.json({ access_token: "never-save-this-access", refresh_token: "likely-latest-revoke-handle", id_token: "invalid.signature.jwt", token_type: "Bearer", expires_in: 3600 })
		: Response.json({ access_token: "old-verified-access", refresh_token: "old-refresh", id_token: await signed(form.get("client_id")!, url.searchParams.get("nonce")!), token_type: "Bearer", expires_in: 1, scope: SCOPES.join(" ") }) });
	try {
		const before = structuredClone(f.saved.registrations[0]);
		await assert.rejects(f.service.lease(false));
		const restricted = f.saved.registrations[0];
		assert.equal(restricted.reconnectRequired, true);
		for (const field of ["id", "issuer", "subject", "email", "clientId"]) assert.equal(restricted[field], before[field]);
		assert.deepEqual(restricted.tokens, { ...before.tokens, refreshToken: "likely-latest-revoke-handle" });
		assert(!JSON.stringify(f.saved).includes("never-save-this-access"));
		const reconnectComplete = deferred<any>();
		const verificationEntered = deferred(), verificationRelease = deferred();
		let reconnectArmed = false, sawPending = false, completed = false;
		const restarted = fixture({ state: f.saved,
			change: (push) => {
				if (!reconnectArmed) return;
				if (push.status.pending) sawPending = true;
				else if (sawPending) { completed = true; reconnectComplete.resolve(push.status); }
			},
			provider: async (url) => {
				if (holdVerification && reconnectArmed && url.endsWith("jwks.json")) {
					verificationEntered.resolve(); await verificationRelease.promise;
				}
				return undefined;
			},
		});
		try {
			await restarted.service.status();
			await restarted.service.select(restricted.id);
			restarted.service.resume(); await restarted.service.consent(true);
			await assert.rejects(restarted.service.lease(false));
			assert.equal((await restarted.service.status()).accounts[0].connected, false);
			assert.deepEqual((await restarted.service.models()).models, []);
			assert.equal(restarted.requests.filter((r) => r.url === tokenUrl).length, 0, "restricted material cannot refresh for inference/catalog");
			await restarted.service.logout(restricted.id);
			assert.equal(restarted.requests.find((r) => r.form?.has("token_type_hint"))!.form!.get("token"), "likely-latest-revoke-handle");
			assert.equal(restarted.saved.registrations[0].reconnectRequired, true);
			// Earlier select/consent/logout notifications have already settled changed.
			// Arm before this login and await its pending -> terminal transition instead.
			reconnectArmed = true;
			await restarted.service.login(restricted.id);
			assert.equal(sawPending, true);
			await restarted.callback(); // HTTP acknowledgement precedes verification/save.
			if (holdVerification) {
				await verificationEntered.promise;
				assert.equal(completed, false, "the current attempt cannot complete before identity verification");
				const held = await restarted.service.status();
				assert.equal(held.pending, true); assert.equal(held.error, null);
				assert.equal(held.accounts[0].connected, false); assert.equal(held.accounts[0].planEnabled, false);
				assert.equal(restarted.saved.registrations[0].reconnectRequired, true);
				assert.deepEqual((await restarted.service.models()).models, []);
				const expected = { expectedAccountId: restricted.id, expectedAuthorityRevision: restarted.service.stamp().authorityRevision, selectedModelId: "gpt-5" };
				await assert.rejects(restarted.rawLease(false, expected), /disconnected/);
				await assert.rejects(restarted.rawLease(true, expected), /disconnected/);
				assert.equal(completed, false, "status/catalog/lease checks cannot settle the pending attempt");
				verificationRelease.resolve();
			}
			const terminal = await reconnectComplete.promise;
			assert.equal(terminal.pending, false); assert.equal(terminal.error, null);
			assert.equal(terminal.activeId, restricted.id);
			assert.equal(terminal.accounts[0].connected, true);
			assert.equal(restarted.saved.registrations[0].reconnectRequired, undefined);
		} finally { verificationRelease.resolve(); restarted.service.close(); }
	} finally { f.service.close(); }
});

for (const holdVerification of [false, true]) test(`observed file write failure invalidates all work; status, consent and resume cannot reload stale credentials or repair authority${holdVerification ? " (held JWKS regression)" : ""}`, { timeout: 10000 }, async () => {
	let lost = false, reads = 0; const pushes: any[] = [];
	const reconnectComplete = deferred<any>();
	const verificationEntered = deferred(), verificationRelease = deferred();
	let reconnectArmed = false, sawPending = false, completed = false;
	const f = await loggedIn({ read: () => { reads++; }, write: async () => { if (lost) throw Object.assign(new Error("storage"), { code: "storage" }); },
		change: (push) => {
			pushes.push(push);
			if (!reconnectArmed) return;
			if (push.status.pending) sawPending = true;
			else if (sawPending) { completed = true; reconnectComplete.resolve(push.status); }
		},
		provider: async (url) => {
			if (holdVerification && reconnectArmed && url.endsWith("jwks.json")) {
				verificationEntered.resolve(); await verificationRelease.promise;
			}
			return undefined;
		},
	});
	try {
		await f.service.lease(false); const epoch = f.service.stamp().epoch;
		lost = true;
		await assert.rejects(f.service.consent(false), /storage/);
		assert(pushes.some((p) => p.invalidate === "all" && p.stamp.epoch > epoch));
		await assert.rejects(f.service.lease(false)); await assert.rejects(f.service.lease(true));
		lost = false; f.service.resume(); await f.service.consent(true);
		await f.service.status(); await f.service.models();
		await assert.rejects(f.service.lease(false));
		assert.equal((await f.service.status()).accounts[0].connected, false);
		assert.equal(reads, 1, "a recovered disk never causes a stale credential reload");
		const writesBeforeReconnect = f.writeCount;
		// The initial login already settled fixture.changed; observe this attempt instead.
		reconnectArmed = true;
		await f.service.login(f.saved.activeId); assert.equal(sawPending, true); await f.callback();
		if (holdVerification) {
			await verificationEntered.promise;
			assert.equal(completed, false, "HTTP acknowledgement cannot complete a pending identity verification");
			const held = await f.service.status();
			assert.equal(held.pending, true); assert.equal(held.error, null);
			assert.equal(held.accounts[0].connected, false);
			assert.equal(f.writeCount, writesBeforeReconnect, "unverified recovery cannot persist credentials");
		}
		verificationRelease.resolve();
		const terminal = await reconnectComplete.promise;
		assert.equal(terminal.pending, false); assert.equal(terminal.error, null);
		assert.equal(terminal.accounts[0].connected, true, "verified login plus durable save can explicitly reconnect");
		assert.equal(f.writeCount, writesBeforeReconnect + 1, "recovery requires a new durable credential write");
		assert.equal(f.saved.activeId, terminal.activeId);
		assert.equal(reads, 1, "explicit recovery still never reloads stale credentials");
	} finally { verificationRelease.resolve(); f.service.close(); }
});

test("strict JSON schema rejects malformed marker/duplicates/token/active identity without changing original bytes", async () => {
	const f = await loggedIn(); f.service.close();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-chatgpt-corrupt-"));
	const file = path.join(dir, "chatgpt-credentials.json");
	try {
		for (const mutate of [(s: any) => s.registrations[0].reconnectRequired = false, (s: any) => s.registrations[0].reconnectRequired = "true", (s: any) => s.registrations.push(s.registrations[0]), (s: any) => s.activeId = "missing", (s: any) => s.registrations[0].tokens.scopes = "not-array", (s: any) => s.registrations[0].tokens.expiresAt = -1, (s: any) => s.allowBackgroundUse = "true", (s: any) => s.allowBackgroundUse = null, (s: any) => s.registrations[0].background = "false"]) {
			const state = structuredClone(f.saved); mutate(state);
			const bytes = JSON.stringify(state);
			await fs.writeFile(file, bytes);
			const service = createChatGPT({ store: fileStore(file), openExternal: () => assert.fail("no OAuth"), fetch: () => assert.fail("no provider") });
			try { assert.equal((await service.status()).available, false); await assert.rejects(service.login()); assert.equal(await fs.readFile(file, "utf8"), bytes); }
			finally { service.close(); }
		}
	} finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("consent OFF wins an older ON save; foreground catalog authority remains unchanged", async () => {
	let hold = false; const entered = deferred(); const release = deferred();
	const f = await loggedIn({ write: async (next) => { if (hold && next.allowBackgroundUse === true) { entered.resolve(); await release.promise; } } });
	try {
		const catalog = await f.service.models(); const id = f.saved.activeId;
		hold = true;
		const on = f.service.consent(true); await entered.promise;
		const off = f.service.consent(false);
		assert.equal((await f.service.status()).allowBackgroundUse, false);
		release.resolve(); await on; await off;
		assert.equal(f.saved.allowBackgroundUse, false);
		assert.equal(f.service.stamp().authorityRevision, catalog.authorityRevision);
		assert.equal((await f.rawLease(false, { expectedAccountId: id, expectedAuthorityRevision: catalog.authorityRevision, selectedModelId: "gpt-5" })).accountId, id);
		await assert.rejects(f.rawLease(true, { expectedAccountId: id, expectedAuthorityRevision: catalog.authorityRevision, selectedModelId: "gpt-5" }), /background/);
	} finally { f.service.close(); }
});

test("cancellation during verified durable save cannot activate late credentials", async () => {
	const entered = deferred(); const release = deferred(); let blocked = true;
	const f = fixture({ write: async (next) => { if (blocked && next.registrations.length) { entered.resolve(); await release.promise; blocked = false; } } });
	try {
		await f.service.login(); await f.callback(); await entered.promise;
		f.service.cancelLogin(); release.resolve();
		for (let i = 0; i < 30 && f.writeCount < 2; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(f.saved.activeId, null);
		assert.equal((await f.service.status()).accounts.length, 0);
	} finally { f.service.close(); }
});

test("scope-disabled credentials remain revocable and unconfirmed revoke never claims success", async () => {
	const f = await loggedIn({ token: async (form, url) => Response.json({ id_token: await signed(form.get("client_id")!, url.searchParams.get("nonce")!), refresh_token: "scope-disabled-refresh", scope: "openid profile email", token_type: "Bearer" }), provider: async (url) => url.endsWith("/revoke") ? new Response(null, { status: 500 }) : undefined });
	try {
		await assert.rejects(f.service.lease(false));
		const status = await f.service.logout(f.saved.activeId);
		assert.equal(status.error, "Account disconnected locally. Remote revocation could not be confirmed.");
		assert.equal(f.requests.filter((r) => r.form?.get("token") === "scope-disabled-refresh").length, 2);
		assert.equal(f.saved.registrations[0].tokens, undefined);
	} finally { f.service.close(); }
});

for (const holdVerification of [false, true]) test(`repeated real verified sign-in creates one visible account while preserving separately bound registrations until explicit forgetting${holdVerification ? " (held JWKS regression)" : ""}`, { timeout: 10000 }, async () => {
	const repeatComplete = deferred<any>();
	const verificationEntered = deferred(), verificationRelease = deferred();
	let repeatArmed = false, sawPending = false, completed = false;
	const f = await loggedIn({
		change: (push) => {
			if (!repeatArmed) return;
			if (push.status.pending) sawPending = true;
			else if (sawPending) { completed = true; repeatComplete.resolve(push.status); }
		},
		provider: async (url) => {
			if (holdVerification && repeatArmed && url.endsWith("jwks.json")) {
				verificationEntered.resolve(); await verificationRelease.promise;
			}
			return undefined;
		},
	});
	try {
		const original = f.saved.registrations[0];
		const writesBeforeRepeat = f.writeCount;
		// Initial login already settled fixture.changed; arm for this attempt's terminal notification.
		repeatArmed = true;
		await f.service.login(); assert.equal(sawPending, true);
		assert.equal((await f.callback({ client_id: "oaiapp_repeat" })).status, 200);
		if (holdVerification) {
			await verificationEntered.promise;
			assert.equal(completed, false, "HTTP acknowledgement cannot complete pending identity verification");
			const held = await f.service.status();
			assert.equal(held.pending, true); assert.equal(held.error, null);
			assert.equal(held.activeId, original.id); assert.equal(held.accounts.length, 1);
			assert.deepEqual(f.saved.registrations, [original]);
			assert.equal(f.writeCount, writesBeforeRepeat, "unverified repeat sign-in cannot persist credentials");
		}
		verificationRelease.resolve();
		const status = await repeatComplete.promise;
		assert.equal(status.pending, false); assert.equal(status.error, null);
		assert.equal(f.writeCount, writesBeforeRepeat + 1, "repeat sign-in completes after durable credential persistence");
		assert.equal(f.saved.registrations.length, 2); assert.equal(status.accounts.length, 1);
		assert.equal(status.activeId, status.accounts[0].id); assert.notEqual(status.activeId, original.id);
		assert.equal(f.saved.registrations[0].clientId, original.clientId); assert.equal(f.saved.registrations[1].clientId, "oaiapp_repeat");
		await f.service.disconnect(status.activeId);
		assert.deepEqual(f.saved.registrations, []); assert.equal((await f.service.status()).accounts.length, 0);
		assert.equal(f.requests.filter((r) => r.form?.has("token_type_hint")).length, 2);
	} finally { verificationRelease.resolve(); f.service.close(); }
});

test("verified identity grouping hides legacy duplicate registrations without merging client credentials or matching emails", async () => {
	const first = await loggedIn(); first.service.close();
	const state = structuredClone(first.saved);
	const original = state.registrations[0];
	const duplicate = { ...structuredClone(original), id: "legacy-duplicate", clientId: "oaiapp_legacy" };
	duplicate.tokens.idToken = await signed(duplicate.clientId, "legacy-nonce", original.subject);
	const distinct = { ...structuredClone(original), id: "different-subject", clientId: "oaiapp_distinct", subject: "different-verified-subject" };
	distinct.tokens.idToken = await signed(distinct.clientId, "legacy-nonce", distinct.subject);
	state.registrations.push(duplicate, distinct);
	state.activeId = duplicate.id;
	const f = fixture({ state });
	try {
		const status = await f.service.status();
		assert.equal(status.accounts.length, 2, "same issuer+subject groups; equal emails alone do not");
		assert.equal(status.activeId, duplicate.id, "private transport keeps the actual active registration");
		assert(status.accounts.some((a: any) => a.id === duplicate.id));
		assert(status.accounts.some((a: any) => a.id === distinct.id));
		assert.equal(f.saved.registrations.length, 3, "a status read never purges or merges stored credential handles");
		assert.deepEqual(f.saved, state);
		await f.service.select(distinct.id);
		assert.equal((await f.service.status()).activeId, distinct.id);
		assert.equal((await f.service.status()).accounts.length, 2);
	} finally { f.service.close(); }
});

test("explicit disconnect forgets all exact-identity registrations/handles, aborts active leases, and never auto-selects a same-email distinct account", async () => {
	const first = await loggedIn(); first.service.close();
	const state = structuredClone(first.saved), original = state.registrations[0];
	const duplicate = { ...structuredClone(original), id: "duplicate-client", clientId: "oaiapp_duplicate", tokens: { ...original.tokens, refreshToken: "duplicate-refresh" } };
	duplicate.tokens.idToken = await signed(duplicate.clientId, "historical", original.subject);
	const other = { ...structuredClone(original), id: "distinct-account", clientId: "oaiapp_other", subject: "other-subject" };
	other.tokens.idToken = await signed(other.clientId, "historical", other.subject);
	state.registrations.push(duplicate, other);
	const pushes: any[] = [], entered = deferred(), release = deferred();
	let held = false;
	const f = fixture({ state, change: (push) => pushes.push(push), provider: async (url) => {
		if (url.endsWith("/revoke") && !held) { held = true; entered.resolve(); await release.promise; }
		return undefined;
	} });
	try {
		await f.service.status(); const catalog = await f.service.models();
		const expected = { expectedAccountId: state.activeId, expectedAuthorityRevision: catalog.authorityRevision, selectedModelId: "gpt-5" };
		await f.rawLease(false, expected);
		const removing = f.service.disconnect(original.id); await entered.promise;
		assert(pushes.some((push) => push.invalidate === "all"));
		assert.equal((await f.service.status()).accounts.find((a: any) => a.id === original.id).connected, false);
		release.resolve(); const result = await removing;
		assert.equal(result.activeId, null); assert.equal(result.accounts.length, 1); assert.equal(result.accounts[0].id, other.id);
		assert.deepEqual(f.saved.registrations, [other], "all duplicate handles gone; other verified subject untouched");
		const revocations = f.requests.filter((r) => r.form?.has("token_type_hint"));
		assert.equal(revocations.length, 2); assert(revocations.some((r) => r.form!.get("client_id") === duplicate.clientId && r.form!.get("token") === "duplicate-refresh"));
		await assert.rejects(f.rawLease(false, expected));
		await assert.rejects(f.service.select(original.id));
		assert.equal(f.saved.activeId, null, "no automatic account/provider fallback");
	} finally { release.resolve(); f.service.close(); }
});

test("disconnecting an inactive identity preserves the active identity/credentials/catalog authority", async () => {
	const first = await loggedIn(); first.service.close();
	const state = structuredClone(first.saved), original = state.registrations[0];
	const other = { ...structuredClone(original), id: "inactive-account", clientId: "oaiapp_inactive", subject: "inactive-subject" };
	other.tokens.idToken = await signed(other.clientId, "historical", other.subject);
	state.registrations.push(other); const f = fixture({ state });
	try {
		await f.service.status(); const catalog = await f.service.models(); const before = f.service.stamp();
		await f.service.disconnect(other.id);
		assert.equal(f.saved.activeId, original.id); assert.deepEqual(f.saved.registrations, [original]);
		assert.equal(f.service.stamp().epoch, before.epoch); assert.equal(f.service.stamp().authorityRevision, before.authorityRevision);
		assert.equal((await f.rawLease(false, { expectedAccountId: original.id, expectedAuthorityRevision: catalog.authorityRevision, selectedModelId: "gpt-5" })).accountId, original.id);
	} finally { f.service.close(); }
});

test("signed-out legacy registrations can be explicitly forgotten; failed revocation never retains forgotten handles", async () => {
	const first = await loggedIn(); await first.service.logout(first.saved.activeId); first.service.close();
	const state = structuredClone(first.saved), duplicate = { ...structuredClone(state.registrations[0]), id: "signed-out-duplicate", clientId: "oaiapp_old" };
	state.registrations.push(duplicate);
	const f = fixture({ state });
	try {
		const status = await f.service.status(); assert.equal(status.accounts.length, 1); assert.equal(status.accounts[0].connected, false);
		const result = await f.service.disconnect(status.accounts[0].id);
		assert.equal(result.accounts.length, 0); assert.equal(result.activeId, null); assert.equal(f.saved.registrations.length, 0);
		assert.equal(result.error, "Account disconnected locally. Remote revocation could not be confirmed.");
	} finally { f.service.close(); }
	const unconfirmed = await loggedIn({ provider: async (url) => url.endsWith("/revoke") ? new Response(null, { status: 400 }) : undefined });
	try {
		const result = await unconfirmed.service.disconnect(unconfirmed.saved.activeId);
		assert.equal(result.error, "Account disconnected locally. Remote revocation could not be confirmed."); assert.deepEqual(unconfirmed.saved.registrations, []);
		assert.equal(unconfirmed.saved.activeId, null); assert.equal(JSON.stringify(unconfirmed.saved).includes("scratch-refresh"), false);
	} finally { unconfirmed.service.close(); }
});

test("disconnect racing refresh revokes the latest rotated handle before forgetting, never its stale predecessor", async () => {
	const entered = deferred(), release = deferred();
	const f = await loggedIn({ token: async (form, url) => {
		if (form.get("grant_type") === "refresh_token") {
			entered.resolve(); await release.promise;
			return Response.json({ access_token: "latest-access", refresh_token: "latest-refresh", token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") });
		}
		return Response.json({ access_token: "scratch-access", refresh_token: "scratch-refresh", id_token: await signed(form.get("client_id")!, url.searchParams.get("nonce")!), token_type: "Bearer", expires_in: 1, scope: SCOPES.join(" ") });
	} });
	try {
		const lease = f.service.lease(false); const rejected = assert.rejects(lease); await entered.promise;
		const forgetting = f.service.disconnect(f.saved.activeId); release.resolve(); await rejected; await forgetting;
		const revoked = f.requests.filter((r) => r.form?.has("token_type_hint"));
		assert.equal(revoked.length, 1); assert.equal(revoked[0]!.form!.get("token"), "latest-refresh");
		assert.deepEqual(f.saved.registrations, []); assert.equal(f.saved.activeId, null);
	} finally { release.resolve(); f.service.close(); }
});

test("disconnect persistence failure is not reported as local forgetting and leaves stored state fail-closed", async () => {
	let failWrite = false;
	const f = await loggedIn({ write: async () => { if (failWrite) throw Object.assign(new Error("storage"), { code: "storage" }); } });
	try {
		const before = structuredClone(f.saved); failWrite = true;
		await assert.rejects(f.service.disconnect(f.saved.activeId));
		assert.deepEqual(f.saved, before); assert.equal((await f.service.status()).accounts[0].connected, false);
		await assert.rejects(f.service.lease(false));
	} finally { f.service.close(); }
});

for (const holdToken of [false, true]) test(`one app-wide background preference defaults ON over legacy OFF, persists with zero accounts, and never changes on auth/account operations${holdToken ? " (completion held beyond old wait budget)" : ""}`, async () => {
	const first = await loggedIn(); first.service.close();
	const legacy = structuredClone(first.saved); legacy.registrations[0].background = false;
	const tokenEntered = deferred(), releaseToken = deferred();
	let completion = deferred<ChatGPTStatus>();
	const change = ({ status }: { status: ChatGPTStatus }) => { if (!status.pending) completion.resolve(status); };
	const f = fixture({ state: legacy, change, token: async (form, url) => {
		tokenEntered.resolve();
		if (holdToken) await releaseToken.promise;
		return Response.json({ access_token: "scratch-oauth-token", refresh_token: "scratch-refresh", id_token: await signed(form.get("client_id")!, url.searchParams.get("nonce")!), token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") });
	} });
	try {
		assert.equal((await f.service.status()).allowBackgroundUse, true, "absent new setting ignores legacy per-account OFF");
		await f.service.lease(true);
		await f.service.consent(false);
		assert.equal(f.saved.allowBackgroundUse, false); assert.equal(f.saved.registrations[0].background, false);
		await assert.rejects(f.service.lease(true), /background/);
		await f.service.lease(false);
		const id = f.saved.activeId;
		await f.service.select(id); assert.equal((await f.service.status()).allowBackgroundUse, false);
		// A fresh signal per attempt: the fixture's original changed promise
		// was already resolved by earlier account/consent notifications.
		completion = deferred<ChatGPTStatus>();
		await f.service.login(id);
		const response = await f.callback(); assert.equal(response.status, 200); await response.text();
		const waiting = completedWithin(completion.promise, "returning verified sign-in");
		let settled = false; void waiting.then(() => { settled = true; }, () => { settled = true; });
		if (holdToken) {
			await completedWithin(tokenEntered.promise, "held token request");
			// Regression only: exhaust the OLD wait while real completion is
			// explicitly held, rather than relying on machine speed or sleeps.
			for (let i = 0; i < 100 && (await f.service.status()).pending; i++) await new Promise((r) => setImmediate(r));
			assert.equal((await f.service.status()).pending, true);
			assert.equal(f.saved.registrations[0].background, false, "the old assertion would run before replacement was saved");
			assert.equal(settled, false, "the corrected wait must still await completion");
			releaseToken.resolve();
		}
		const status = await waiting;
		assert.equal(status.pending, false); assert.equal(status.error, null, "reconnecting must actually succeed");
		assert.equal(status.activeId, id); assert.equal(status.accounts[0]!.connected, true);
		assert.equal(f.saved.allowBackgroundUse, false, "reconnecting cannot overwrite app preference");
		assert.equal(f.saved.registrations[0].background, undefined, "new verified registrations omit obsolete per-account preference");
		await f.service.disconnect(f.saved.activeId);
		assert.deepEqual(f.saved.registrations, []); assert.equal(f.saved.allowBackgroundUse, false);
		const restarted = fixture({ state: f.saved, change });
		try {
			assert.equal((await restarted.service.status()).allowBackgroundUse, false, "zero-account restart preserves global OFF");
			completion = deferred<ChatGPTStatus>();
			await restarted.service.login();
			const response = await restarted.callback(); assert.equal(response.status, 200); await response.text();
			const status = await completedWithin(completion.promise, "verified sign-in after zero-account restart");
			assert.equal(status.pending, false); assert.equal(status.error, null);
			assert.notEqual(status.activeId, null); assert.equal(status.accounts[0]!.connected, true);
			assert.equal(restarted.saved.allowBackgroundUse, false);
			await restarted.service.consent(true); assert.equal(restarted.saved.allowBackgroundUse, true);
		} finally { restarted.service.close(); }
	} finally { releaseToken.resolve(); f.service.close(); }
});

test("private leases bind active account, authority revision and raw visible model membership", async () => {
	const f = await loggedIn();
	try {
		const catalog = await f.service.models();
		const expected = { expectedAccountId: catalog.accountId, expectedAuthorityRevision: catalog.authorityRevision, selectedModelId: "gpt-5" };
		await assert.rejects(f.rawLease(false));
		for (const mutation of [{ expectedAccountId: "another" }, { expectedAuthorityRevision: catalog.authorityRevision - 1 }, { selectedModelId: "hidden" }]) await assert.rejects(f.rawLease(false, { ...expected, ...mutation }));
		assert.equal((await f.rawLease(false, expected)).accountId, catalog.accountId);
	} finally { f.service.close(); }
});

test("account catalog passes the account's window, input and effort metadata through for the bridge to validate", async () => {
	const f = await loggedIn({ provider: async (target) => target.endsWith("/models") ? Response.json({ models: [
		{ slug: "gpt-new", display_name: "New model", visibility: "list", context_window: 500000, input_modalities: ["text", "image", "audio"], supported_reasoning_levels: [{ effort: "low", description: "" }, { effort: "ultra", description: "" }] },
		{ slug: "gpt-5", display_name: "Scratch model", visibility: "list" },
	] }) : undefined });
	try {
		assert.deepEqual((await f.service.models()).models, [
			{ id: "gpt-new", name: "New model", contextWindow: 500000, input: ["text", "image", "audio"], reasoningLevels: ["low", "ultra"] },
			{ id: "gpt-5", name: "Scratch model" },
		]);
	} finally { f.service.close(); }
});

// Paste-back (docs/specs/chatgpt-remote-signin.md): a browser on another device
// cannot reach the server's 127.0.0.1 listener, so its final address is pasted.
function pasteFor(f: ReturnType<typeof fixture>, params: Record<string, string> = {}) {
	const callback = new URL(f.url.searchParams.get("redirect_uri")!);
	callback.search = new URLSearchParams({ state: f.url.searchParams.get("state")!, code: "scratch-code", client_id: "oaiapp_scratch", ...params }).toString();
	return callback;
}

test("pasted sign-in address completes with the original redirect URI and server-held verifier, then closes the listener", async () => {
	const f = fixture();
	try {
		await f.service.login();
		const params = f.url.searchParams;
		const status = await f.service.completeLogin(`  ${pasteFor(f).toString()}\n`);
		assert.equal(status.pending, false);
		assert.equal(status.error, null);
		assert(status.accounts.some((a: { id: string; connected: boolean }) => a.id === status.activeId && a.connected));
		const form = f.requests.find((r) => r.url === tokenUrl)!.form!;
		assert.equal(form.get("redirect_uri"), params.get("redirect_uri"));
		assert.equal(form.get("client_id"), "oaiapp_scratch");
		assert.equal(form.get("code"), "scratch-code");
		assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), params.get("code_challenge"));
		const visible = JSON.stringify(await f.service.status());
		for (const secret of ["scratch-code", params.get("state")!, form.get("code_verifier")!]) assert(!visible.includes(secret));
		await assert.rejects(fetch(pasteFor(f)), "listener is closed after a paste consumed the attempt");
		await assert.rejects(f.service.completeLogin(pasteFor(f).toString()), /inactive/);
		assert.equal(f.requests.filter((r) => r.url === tokenUrl).length, 1);
	} finally { f.service.close(); }
});

test("wrong pasted addresses are refused without consuming; the real redirect still completes", async () => {
	const f = fixture();
	try {
		await f.service.login();
		const good = pasteFor(f);
		const port = Number(good.port);
		const swap = (edit: (url: URL) => void) => { const url = new URL(good); edit(url); return url.toString(); };
		const bad = [
			"", "not a url", "x".repeat(9000), `${good.toString()}&pad=${"x".repeat(8200)}`,
			pasteFor(f, { state: "wrong" }).toString(),
			swap((url) => { url.port = String(port === 65535 ? port - 1 : port + 1); }),
			swap((url) => { url.hostname = "localhost"; }),
			swap((url) => { url.hostname = "192.168.1.10"; }),
			good.toString().replace("http:", "https:"),
			swap((url) => { url.pathname = "/auth/callback/extra"; }),
			swap((url) => { url.hash = "x"; }),
			swap((url) => { url.username = "u"; url.password = "p"; }),
			`${good.toString()}&code=second`,
			`${good.toString()}&state=${f.url.searchParams.get("state")}`,
			`${good.toString()}&client_id=oaiapp_other`,
			pasteFor(f, { error: "access_denied" }).toString(),
			swap((url) => { url.searchParams.delete("code"); }),
			swap((url) => { url.searchParams.set("code", ""); }),
			swap((url) => { url.searchParams.set("client_id", ""); }),
		];
		for (const value of bad) await assert.rejects(f.service.completeLogin(value), /callback/, value.slice(0, 120));
		assert.equal(f.requests.length, 0, "a refused paste never exchanges a code");
		assert.equal((await f.service.status()).pending, true);
		assert.equal((await f.callback()).status, 200);
		await f.changed.promise;
		assert.equal((await f.service.status()).error, null);
		assert.equal(f.saved.registrations.length, 1);
	} finally { f.service.close(); }
});

test("scheme-less paste is accepted; a listener-completed attempt refuses a later paste", async () => {
	const pasted = fixture();
	try {
		await pasted.service.login();
		const status = await pasted.service.completeLogin(pasteFor(pasted).toString().replace(/^http:\/\//, ""));
		assert.equal(status.error, null);
		assert.equal(pasted.saved.registrations.length, 1);
	} finally { pasted.service.close(); }
	const redirected = fixture();
	try {
		await redirected.service.login();
		const late = pasteFor(redirected).toString();
		await redirected.callback(); await redirected.changed.promise;
		await assert.rejects(redirected.service.completeLogin(late), /inactive/);
		assert.equal(redirected.requests.filter((r) => r.url === tokenUrl).length, 1);
	} finally { redirected.service.close(); }
});

test("a pasted access_denied ends sign-in as cancelled; paste without a pending sign-in is refused", async () => {
	const f = fixture();
	try {
		await assert.rejects(f.service.completeLogin("http://127.0.0.1:1/auth/callback?state=x&code=y"), /inactive/);
		await f.service.login();
		const denied = pasteFor(f); denied.searchParams.delete("code"); denied.searchParams.delete("client_id"); denied.searchParams.set("error", "access_denied");
		const status = await f.service.completeLogin(denied.toString());
		assert.equal(status.pending, false);
		assert.equal(status.error, "ChatGPT sign-in cancelled.");
		assert.equal(f.requests.length, 0);
		f.service.cancelLogin();
		await f.service.login(); f.service.cancelLogin();
		await assert.rejects(f.service.completeLogin(pasteFor(f).toString()), /inactive/);
	} finally { f.service.close(); }
});

test("IPC complete op returns a public error envelope for a wrong address and status for a right one", async () => {
	const { chatGPTControl } = require("../electron/chatgpt-ipc.cjs");
	const f = fixture();
	try {
		await chatGPTControl({ op: "login" }, f.service);
		assert.deepEqual(await chatGPTControl({ op: "complete", url: pasteFor(f, { state: "wrong" }).toString() }, f.service), { error: "This address does not belong to the current ChatGPT sign-in. Copy the full address from the sign-in tab and try again." });
		assert.deepEqual(await chatGPTControl({ op: "complete", url: 42 }, f.service), { error: "Unsupported ChatGPT control." });
		const status = await chatGPTControl({ op: "complete", url: pasteFor(f).toString() }, f.service);
		assert.equal(status.error, null);
		assert.equal(status.pending, false);
	} finally { f.service.close(); }
});

test("while an exchange is in flight, a second paste or a paste after the redirect is refused without a second exchange", async () => {
	for (const first of ["paste", "redirect"] as const) {
		const release = deferred(); const started = deferred();
		let exchanges = 0;
		const f = fixture({ token: async (form, url) => {
			exchanges++; started.resolve(); await release.promise;
			return Response.json({ access_token: "scratch-oauth-token", refresh_token: "scratch-refresh", id_token: await signed(form.get("client_id")!, url.searchParams.get("nonce")!), token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") });
		} });
		try {
			await f.service.login();
			const pasted = first === "paste" ? f.service.completeLogin(pasteFor(f).toString()) : undefined;
			if (first === "redirect") assert.equal((await f.callback()).status, 200);
			await started.promise;
			assert.equal((await f.service.status()).pending, true, "attempt is still pending during the exchange");
			await assert.rejects(f.service.completeLogin(pasteFor(f).toString()), /inactive/, first);
			release.resolve();
			if (pasted) assert.equal((await pasted).error, null); else await f.changed.promise;
			assert.equal(exchanges, 1, first);
			assert.equal(f.saved.registrations.length, 1);
		} finally { release.resolve(); f.service.close(); }
	}
});

test("desktop relay reserves loopback, forwards the exact verified callback once, and exchanges only on the server", async () => {
	const { remoteChatGPTSignIn } = require("../electron/remote-chatgpt.cjs");
	const f = fixture();
	const origin = "https://server.example.test";
	const browserAction = "/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000001";
	const operations: string[] = [];
	let exact = "";
	try {
		await remoteChatGPTSignIn(origin, "fixture-bearer", {
			timeoutMs: 5000,
			request: async (input: URL, options: RequestInit) => {
				assert.equal(input.origin, origin);
				const headers = new Headers(options.headers);
				assert.equal(headers.get("authorization"), "Bearer fixture-bearer");
				assert.equal(headers.get("origin"), origin);
				assert.equal(headers.get("x-learnharness-subscriptions"), "1");
				assert.equal(headers.get("cookie"), null);
				assert.equal(options.credentials, "omit");
				if (input.pathname === "/api/subscriptions/browser") {
					assert.equal(options.redirect, "manual");
					operations.push("browser");
					return new Response(null, { status: 303, headers: { Location: f.url.href } });
				}
				assert.equal(options.redirect, "error");
				const body = JSON.parse(String(options.body));
				operations.push(body.op);
				if (body.op === "login") {
					const value = await f.service.login(undefined, body.desktopRedirectPort);
					return Response.json({ value, browserAction });
				}
				assert.deepEqual(body, { providerId: "chatgpt", op: "complete", url: exact });
				return Response.json({ value: await f.service.completeLogin(body.url) });
			},
			openExternal: async (url: string) => {
				const page = new URL(url);
				const callback = new URL(page.searchParams.get("redirect_uri")!);
				assert.equal(callback.hostname, "127.0.0.1");
				assert.equal(callback.pathname, "/auth/callback");
				const rejected = await fetch(`${callback.href}?state=wrong&code=scratch`);
				assert.equal(rejected.status, 400);
				await rejected.text();
				exact = `${callback.href}?client_id=oaiapp_scratch&code=scratch%2bcode&state=${page.searchParams.get("state")}`;
				const accepted = await fetch(exact);
				assert.equal(accepted.status, 200);
				await accepted.text();
				assert.equal((await fetch(exact)).status, 404, "replay does not reach the server");
			},
		});
		assert.deepEqual(operations, ["login", "browser", "complete"]);
		const exchange = f.requests.filter((r) => r.url === tokenUrl);
		assert.equal(exchange.length, 1);
		assert.equal(exchange[0]?.form?.get("code"), "scratch+code");
		assert.equal(exchange[0]?.form?.get("redirect_uri"), f.url.searchParams.get("redirect_uri"));
		assert.equal(createHash("sha256").update(exchange[0]!.form!.get("code_verifier")!).digest("base64url"), f.url.searchParams.get("code_challenge"));
		assert.equal(f.saved.registrations[0].tokens.accessToken, "scratch-oauth-token");
	} finally { f.service.close(); }
});

test("desktop relay never opens the browser for bind failure, an occupied redirect port, or an unexpected authorization endpoint", async () => {
	const { createServer } = await import("node:http");
	const { remoteChatGPTSignIn } = require("../electron/remote-chatgpt.cjs");
	const occupied = createServer();
	await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
	try {
		const address = occupied.address();
		assert(address && typeof address !== "string");
		const openExternal = async () => assert.fail("must stop before opening a browser");
		await assert.rejects(remoteChatGPTSignIn("https://server.example.test", "fixture", {
			openExternal,
			createListener: () => {
				const listener = createServer();
				const listen = listener.listen.bind(listener);
				listener.listen = ((_port: number, host: string, ready: () => void) => listen(address.port, host, ready)) as typeof listener.listen;
				return listener;
			},
			request: () => assert.fail("bind must happen before login"),
		}), /reserve the local/);
		for (const reason of ["occupied", "endpoint"]) {
			let port = 0;
			await assert.rejects(remoteChatGPTSignIn("https://server.example.test", "fixture", {
				openExternal,
				request: async (input: URL, options: RequestInit) => {
					if (input.pathname === "/api/subscriptions") {
						port = JSON.parse(String(options.body)).desktopRedirectPort;
						assert.notEqual(port, address.port, "the kernel chose a free port");
						return Response.json({ browserAction: "/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000001" });
					}
					const auth = new URL(reason === "endpoint" ? "https://auth.openai.com/wrong-path" : "https://auth.openai.com/api/accounts/authorize");
					auth.searchParams.set("state", "fixture");
					auth.searchParams.set("redirect_uri", `http://127.0.0.1:${reason === "occupied" ? address.port : port}/auth/callback`);
					return new Response(null, { status: 303, headers: { Location: auth.href } });
				},
			}), /unexpected ChatGPT callback/);
		}
	} finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
});

test("desktop relay cancels an acknowledged attempt on abort and timeout using the original origin", async () => {
	const { remoteChatGPTSignIn } = require("../electron/remote-chatgpt.cjs");
	const origin = "https://desktop-sign-in.example.test";
	for (const reason of ["abort", "timeout", "during-login"]) {
		const f = fixture();
		const abort = new AbortController();
		const calls: string[] = [];
		const browserAction = "/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000001";
		try {
			await assert.rejects(remoteChatGPTSignIn(origin, "fixture-bearer", {
				timeoutMs: reason === "timeout" ? 50 : 5000,
				signal: abort.signal,
				openExternal: async () => {
					assert.notEqual(reason, "during-login", "do not open the browser after the user aborts");
					if (reason === "abort") abort.abort();
				},
				request: async (input: URL, options: RequestInit) => {
					assert.equal(input.origin, origin);
					const headers = new Headers(options.headers);
					assert.equal(headers.get("authorization"), "Bearer fixture-bearer");
					assert.equal(headers.get("origin"), origin);
					assert.equal(headers.get("x-learnharness-subscriptions"), "1");
					if (input.pathname.endsWith("/browser")) {
						calls.push("browser");
						return new Response(null, { status: 303, headers: { Location: f.url.href } });
					}
					const body = JSON.parse(String(options.body));
					calls.push(body.op);
					assert.equal(options.signal?.aborted, false);
					if (body.op === "login") {
						const value = await f.service.login(undefined, body.desktopRedirectPort);
						if (reason === "during-login") abort.abort();
						return Response.json({ value, browserAction });
					}
					assert.deepEqual(body, { providerId: "chatgpt", op: "cancel" });
					return Response.json({ value: f.service.cancelLogin() });
				},
			}));
			assert.deepEqual(calls, reason === "during-login" ? ["login", "cancel"] : ["login", "browser", "cancel"]);
			assert.equal((await f.service.status()).pending, false);
			assert.equal((await f.service.login()).pending, true, "can retry immediately");
		} finally { f.service.close(); }
	}
});

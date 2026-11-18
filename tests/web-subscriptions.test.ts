import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { createModels, type OAuthCredential, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-web-sub-"));
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_DATA_DIR = path.join(directory, "data");
delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET;
await fs.writeFile(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
const require = createRequire(import.meta.url);
const { SCOPES } = require("../electron/chatgpt.cjs");
const { createWebSubscriptionOwner, webSubscriptionOwner, webSubscriptionsEnabled } = await import("../src/server/web-subscriptions.ts");
const { subscriptionControlsResponse, subscriptionBrowserResponse, sameOriginNavigation } = await import("../src/server/web-subscription-http.ts");
const chat = await import("../src/agent/chatgpt-bridge.ts");
const native = await import("../src/agent/subscription-bridge.ts");
const { piModels } = await import("../src/agent/models.ts");
const { refreshConnectionCatalog } = await import("../src/server/model-catalog.ts");
const model = piModels().getModels("openai").find((entry) => entry.api === "openai-responses")!;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
	assert.equal(String(input), "https://api.openai.com/v1/models", "unexpected network request forbidden");
	return Response.json({ models: [{ slug: model.id, display_name: "Fixture ChatGPT", visibility: "list" }] });
};
const copilot = githubCopilotProvider().getModels()[0]!;
const credentials = (id: string): OAuthCredential => ({ type: "oauth", access: id === "xai" ? "fixture-xai-access" : "tid=fixture;proxy-ep=proxy.individual.githubcopilot.com;", refresh: "fixture-refresh", expires: Date.now() + 3600000, ...(id === "github-copilot" ? { availableModelIds: [copilot.id] } : {}) });
await fs.writeFile(path.join(directory, "chatgpt-credentials.json"), JSON.stringify({ version: 1, hostId: "fixture-host", allowBackgroundUse: true, activeId: "fixture-account", registrations: [{ id: "fixture-account", clientId: "oaiapp_fixture", issuer: "https://auth.openai.com", subject: "fixture-subject", email: "fixture@example.invalid", tokens: { accessToken: "fixture-chatgpt-access", refreshToken: "fixture-chatgpt-refresh", idToken: "fixture-id-token", scopes: SCOPES, expiresAt: Date.now() + 3600000 } }] }), { mode: 0o600 });
for (const id of ["github-copilot", "xai"]) await fs.writeFile(path.join(directory, `${id}-credentials.json`), JSON.stringify({ version: 1, allowBackgroundUse: true, connectionId: "00000000-0000-4000-8000-000000000001", credential: credentials(id) }), { mode: 0o600 });
function request(command?: Record<string, unknown>, origin = "http://192.168.1.10:3000") {
	return new Request(`${origin}/api/subscriptions`, { method: command ? "POST" : "GET", headers: { host: new URL(origin).host, origin, "sec-fetch-site": "same-origin", "x-learnharness-subscriptions": "1", "content-type": "application/json" }, ...(command ? { body: JSON.stringify(command) } : {}) });
}
after(async () => { webSubscriptionOwner().close(); globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });

test("ordinary web restores configured sibling credentials, private runtime leases work for LAN-owned requests", async () => {
	await refreshConnectionCatalog();
	assert(chat.chatGPTConnected()); assert(native.nativeSubscriptionConnected("github-copilot")); assert(native.nativeSubscriptionConnected("xai"));
	assert.equal((await chat.chatGPTLease(chat.chatGPTScope(model.id), false)).accessToken, "fixture-chatgpt-access");
	const xaiModel = native.nativeSubscriptionModels().find((entry) => entry.provider === "xai-subscription")!;
	assert.equal((await native.subscriptionLease(native.subscriptionScope("xai", xaiModel.id), false)).apiKey, "fixture-xai-access");
	const response = await subscriptionControlsResponse(request());
	assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
	const publicState = await response.text();
	for (const secret of ["fixture-chatgpt-access", "fixture-chatgpt-refresh", "fixture-id-token", "fixture-xai-access", "fixture-refresh"]) assert(!publicState.includes(secret));
	assert(publicState.includes("fixture@example.invalid"));
});

test("web background OFF immediately aborts background streams, retains foreground and rejects private background leases", async () => {
	const foreground = chat.chatGPTAbortController(false), background = chat.chatGPTAbortController(true);
	const nativeForeground = native.subscriptionAbortController("xai", false), nativeBackground = native.subscriptionAbortController("xai", true);
	try {
		assert.equal((await subscriptionControlsResponse(request({ providerId: "chatgpt", op: "consent", enabled: false }))).status, 200);
		assert(background.controller.signal.aborted); assert(!foreground.controller.signal.aborted);
		const scope = chat.chatGPTScope(model.id); await chat.chatGPTLease(scope, false); await assert.rejects(chat.chatGPTLease(scope, true));
		assert.equal((await subscriptionControlsResponse(request({ providerId: "xai", op: "consent", enabled: false }))).status, 200);
		assert(nativeBackground.controller.signal.aborted); assert(!nativeForeground.controller.signal.aborted);
		const xaiModel = native.nativeSubscriptionModels().find((entry) => entry.provider === "xai-subscription")!;
		const nativeScope = native.subscriptionScope("xai", xaiModel.id); await native.subscriptionLease(nativeScope, false); await assert.rejects(native.subscriptionLease(nativeScope, true));
		await subscriptionControlsResponse(request({ providerId: "xai", op: "disconnect" }));
		assert(nativeForeground.controller.signal.aborted); assert(!native.nativeSubscriptionConnected("xai"));
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "xai-credentials.json"), "utf8")), { version: 1, allowBackgroundUse: false });
	} finally { foreground.release(); background.release(); nativeForeground.release(); nativeBackground.release(); }
});

test("HTTP controls reject cross-origin, simple-form and private credential operations; desktop never falls back", async () => {
	const forged = request({ providerId: "chatgpt", op: "consent", enabled: true }); forged.headers.set("origin", "https://unrelated.invalid");
	assert.equal((await subscriptionControlsResponse(forged)).status, 403);
	const noHeader = request(); noHeader.headers.delete("x-learnharness-subscriptions");
	assert.equal((await subscriptionControlsResponse(noHeader)).status, 403);
	const noOrigin = request({ providerId: "chatgpt", op: "cancel" }); noOrigin.headers.delete("origin");
	assert.equal((await subscriptionControlsResponse(noOrigin)).status, 403);
	for (const op of ["lease", "models", "snapshot", "token", "openExternal"]) assert.equal((await subscriptionControlsResponse(request({ providerId: "chatgpt", op }))).status, 400);
	const forgedPaste = request({ providerId: "chatgpt", op: "complete", url: "http://127.0.0.1:1/auth/callback?state=s&code=c" }); forgedPaste.headers.set("origin", "https://unrelated.invalid");
	assert.equal((await subscriptionControlsResponse(forgedPaste)).status, 403);
	const crossSitePaste = request({ providerId: "chatgpt", op: "complete", url: "http://127.0.0.1:1/auth/callback?state=s&code=c" }); crossSitePaste.headers.set("sec-fetch-site", "cross-site");
	assert.equal((await subscriptionControlsResponse(crossSitePaste)).status, 403);
	const bareFormPaste = request({ providerId: "chatgpt", op: "complete", url: "http://127.0.0.1:1/auth/callback?state=s&code=c" }); bareFormPaste.headers.delete("x-learnharness-subscriptions");
	assert.equal((await subscriptionControlsResponse(bareFormPaste)).status, 403);
	const huge = request({ providerId: "chatgpt", op: "cancel", padding: "x".repeat(16384) });
	assert.equal((await subscriptionControlsResponse(huge)).status, 413);
	const browser = new Request("http://localhost:3000/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000001");
	assert.equal((await subscriptionBrowserResponse(browser)).status, 403);
	for (const [marker, secret] of [["1", undefined], [undefined, "fixture-capability"]]) {
		if (marker) process.env.LH_DESKTOP_SERVER = marker; else delete process.env.LH_DESKTOP_SERVER;
		if (secret) process.env.LH_DESKTOP_API_SECRET = secret; else delete process.env.LH_DESKTOP_API_SECRET;
		assert(!webSubscriptionsEnabled());
		assert.equal((await subscriptionControlsResponse(request())).status, 404);
		await assert.rejects(chat.chatGPTRequest("status"), /desktop app/);
	}
	delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET;
});

test("sign-in tab navigation: a missing Sec-Fetch-Site is accepted only on plain-http non-loopback origins", async () => {
	const tab = (origin: string, site?: string) => new Request(`${origin}/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000001`, { headers: { host: new URL(origin).host, ...(site ? { "sec-fetch-site": site } : {}) } });
	for (const origin of ["http://192.168.1.10:3000", "http://100.73.184.115:3000", "http://desktop.tail1234.ts.net:3000"]) {
		assert.equal(sameOriginNavigation(tab(origin), origin), true, `${origin} without Fetch Metadata`);
		assert.equal(sameOriginNavigation(tab(origin, "same-origin"), origin), true);
		for (const site of ["cross-site", "same-site", "none"]) assert.equal(sameOriginNavigation(tab(origin, site), origin), false, `${origin} ${site}`);
	}
	for (const origin of ["http://localhost:3000", "http://app.localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "https://desktop.tail1234.ts.net"]) {
		assert.equal(sameOriginNavigation(tab(origin), origin), false, `${origin} must send Fetch Metadata`);
		assert.equal(sameOriginNavigation(tab(origin, "same-origin"), origin), true);
	}
	// End to end over the real route: a LAN tab without Fetch Metadata reaches OpenAI once; a cross-site one is refused.
	const lan = "http://192.168.1.10:3000";
	const started = await subscriptionControlsResponse(request({ providerId: "chatgpt", op: "login" }, lan));
	const { browserAction } = await started.json() as { browserAction: string };
	const navigate = (site?: string) => subscriptionBrowserResponse(new Request(`${lan}${browserAction}`, { headers: { host: new URL(lan).host, ...(site ? { "sec-fetch-site": site } : {}) } }));
	assert.equal((await navigate("cross-site")).status, 403, "a present cross-site value is still refused and does not spend the action");
	const opened = await navigate();
	assert.equal(opened.status, 303);
	assert.equal(new URL(opened.headers.get("location")!).origin, "https://auth.openai.com");
	assert.equal((await navigate()).status, 410, "still one use");
	await subscriptionControlsResponse(request({ providerId: "chatgpt", op: "cancel" }, lan));
});

function fakeSDK(login: (id: string, interaction: ProviderAuthInteraction) => Promise<OAuthCredential>) {
	const factory = (id: string) => {
		const provider = id === "xai" ? xaiProvider() : githubCopilotProvider();
		return { ...provider, auth: { oauth: { ...provider.auth.oauth!, login: (interaction: ProviderAuthInteraction) => login(id, interaction), refresh: async () => credentials(id) } } };
	};
	return { createModels, githubCopilotProvider: () => factory("github-copilot"), xaiProvider: () => factory("xai") };
}
test("device browser actions preserve complete URLs privately, are origin-bound, one-use and cancellation-bound", async () => {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lh-web-action-"));
	let complete!: (credential: OAuthCredential) => void;
	const pending = new Promise<OAuthCredential>((resolve) => { complete = resolve; });
	let notified!: () => void;
	const notification = new Promise<void>((resolve) => { notified = resolve; });
	const owner = createWebSubscriptionOwner({ directory: scratch, sdk: fakeSDK(async (_id, interaction) => { interaction.notify({ type: "device_code", userCode: "PUBLIC", verificationUri: "https://auth.x.ai/device?user_code=PUBLIC" }); notified(); return pending; }) });
	try {
		const login = owner.control("xai", { op: "login" }, "http://localhost:3000"); await notification;
		const interaction = (await owner.native.status()).find((entry: { providerId: string }) => entry.providerId === "xai")!.interaction;
		const command = { op: "open", attemptId: interaction.attemptId, actionId: interaction.browser.id };
		const opened = await owner.control("xai", command, "http://localhost:3000");
		assert(opened.browserAction); assert(!JSON.stringify(opened).includes("auth.x.ai"));
		const id = new URL(opened.browserAction, "http://localhost:3000").searchParams.get("id")!;
		assert.equal(await owner.takeBrowserAction(id, "http://other.invalid"), undefined);
		assert.equal(await owner.takeBrowserAction(id, "http://localhost:3000"), "https://auth.x.ai/device?user_code=PUBLIC");
		assert.equal(await owner.takeBrowserAction(id, "http://localhost:3000"), undefined);
		const stale = await owner.control("xai", command, "http://localhost:3000");
		await owner.control("xai", { op: "cancel" }, "http://localhost:3000");
		complete(credentials("xai")); await login;
		assert.equal(await owner.takeBrowserAction(new URL(stale.browserAction!, "http://localhost:3000").searchParams.get("id")!, "http://localhost:3000"), undefined);
	} finally { owner.close(); await fs.rm(scratch, { recursive: true, force: true }); }
});

test("web ChatGPT login supplies only an opaque browser action; cancel/replacement invalidates earlier launch", async () => {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lh-web-chat-action-"));
	const owner = createWebSubscriptionOwner({ directory: scratch, sdk: fakeSDK(async (id) => credentials(id)) });
	try {
		const first = await owner.control("chatgpt", { op: "login" }, "http://localhost:3000");
		assert(first.browserAction); assert(!JSON.stringify(first).includes("auth.openai.com"));
		await owner.control("chatgpt", { op: "cancel" }, "http://localhost:3000");
		const second = await owner.control("chatgpt", { op: "login" }, "http://localhost:3000");
		assert(second.browserAction);
		const firstId = new URL(first.browserAction, "http://localhost:3000").searchParams.get("id")!;
		assert.equal(await owner.takeBrowserAction(firstId, "http://localhost:3000"), undefined);
		const secondId = new URL(second.browserAction, "http://localhost:3000").searchParams.get("id")!;
		const target = new URL((await owner.takeBrowserAction(secondId, "http://localhost:3000"))!);
		assert.equal(target.origin, "https://auth.openai.com");
		const callback = new URL(target.searchParams.get("redirect_uri")!);
		assert.equal(callback.hostname, "127.0.0.1"); assert.equal(callback.pathname, "/auth/callback");
		assert(target.searchParams.has("state")); assert(target.searchParams.has("code_challenge"));
	} finally { owner.close(); await fs.rm(scratch, { recursive: true, force: true }); }
});

test("the optional desktop login port requires a bearer and keeps completion on the existing route", async () => {
	const { issueSession } = await import("../selfhost/src/auth-store.ts");
	const { token } = issueSession(process.env.LH_DATA_DIR!, { method: "pairing", client: { deviceType: "desktop" } });
	const origin = "https://desktop.example.test";
	const desktopRequest = (command: Record<string, unknown>, bearer?: string) => {
		const base = request({ providerId: "chatgpt", ...command }, origin);
		if (bearer) base.headers.set("authorization", `Bearer ${bearer}`);
		return base;
	};
	const login = { op: "login", desktopRedirectPort: 42424 };
	assert.equal((await subscriptionControlsResponse(desktopRequest(login))).status, 403);
	assert.equal((await subscriptionControlsResponse(desktopRequest(login, "revoked"))).status, 403);
	for (const invalid of [0, 65536, 2.5, "42424"]) {
		assert.equal((await subscriptionControlsResponse(desktopRequest({ ...login, desktopRedirectPort: invalid }, token))).status, 400);
	}
	assert.equal((await subscriptionControlsResponse(desktopRequest({ ...login, op: "complete" }, token))).status, 400);
	const response = await subscriptionControlsResponse(desktopRequest(login, token));
	assert.equal(response.status, 200);
	const { browserAction } = await response.json();
	const action = () => new Request(`${origin}${browserAction}`, {
		method: "POST", headers: { origin, authorization: `Bearer ${token}`, "x-learnharness-subscriptions": "1" },
	});
	const opened = await subscriptionBrowserResponse(action());
	assert.equal(opened.status, 303);
	const authorization = new URL(opened.headers.get("location")!);
	const callback = new URL(authorization.searchParams.get("redirect_uri")!);
	assert.equal(callback.href, "http://127.0.0.1:42424/auth/callback");
	assert.equal((await subscriptionBrowserResponse(action())).status, 410);
	callback.searchParams.set("state", authorization.searchParams.get("state")!);
	callback.searchParams.set("error", "access_denied");
	const completed = await subscriptionControlsResponse(desktopRequest({ op: "complete", url: callback.href }, token));
	assert.equal(completed.status, 200);
	assert.match((await completed.json()).value.error, /cancelled/);
});

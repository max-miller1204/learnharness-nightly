/**
 * A subscription whose status check fails (a failed snapshot, with the account
 * still configured) is an outage, not missing setup: every path that runs the
 * model answers a retryable 503 subscription_unreachable, never the 422
 * provider_key_missing setup refusal. A snapshot that says the subscription is
 * not connected is real missing setup (422), and the same connection recovers
 * with no settings change.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, test } from "node:test";
import { issueSession } from "../selfhost/src/auth-store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-subscription-outage-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.LH_SELFHOST = "0";
process.env.LH_IGNORE_ENV_KEYS = "1";
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { PATHS } = await import("../config.ts");
const { configureWebSubscriptionRuntime } = await import("../src/agent/subscription-runtime.ts");
const { piModels } = await import("../src/agent/models.ts");
const { providerKeyMissing, subscriptionUnreachable } = await import("../src/core/settings.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { productionEngineFor } = await import("../src/server/side-chat.ts");
const { pluginKeyMissing } = await import("../src/server/plugin-model-refusal.ts");
const { createPluginTransport } = await import("../src/server/plugin-transport.ts");
const { reserveAttachmentRequest, uploadAttachmentRequest, startAttachmentRequest } = await import("../src/server/attachment-routes.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { writeSettings } = await import("../src/store/settings.ts");

const PROVIDER = "github-copilot-subscription";
const MODEL = piModels().getModels("github-copilot")[0]!.id;

// The web subscription owner: a snapshot that fails, or one that reports the
// connection as connected or not.
let snapshot: "fails" | "connected" | "disconnected" = "fails";
let revision = 0;
configureWebSubscriptionRuntime(async <T>(channel: string, op: string): Promise<T> => {
	if (channel === "lh:chatgpt" || op !== "snapshot" || snapshot === "fails") throw new Error("The subscription owner did not answer.");
	const connected = snapshot === "connected";
	return {
		statuses: [{ providerId: "github-copilot", available: true, connected, pending: false, allowBackgroundUse: true, connectionId: connected ? "fixture-copilot" : null, epoch: 1, authorityRevision: 1, revision: ++revision }],
		models: { "github-copilot": connected ? piModels().getModels("github-copilot") : [] },
	} as T;
});
beforeEach(() => { snapshot = "fails"; });

const pinned = (provider: string, id: string) => {
	const chat = chatStore.createChat(`outage ${provider}`);
	chatStore.saveSettings(chat.id, { model: { provider, id } });
	return chat.id;
};
const send = (chatId: string) => handleChatRequest(new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ chatId, input: { type: "text", text: "teach me" } }) }), () => assert.fail("a refused turn builds no agent"));

test("main send: a failed snapshot is a retryable 503, a disconnected subscription is the 422 setup refusal", async () => {
	const chatId = pinned(PROVIDER, MODEL);
	const outage = await send(chatId);
	assert.equal(outage.status, 503);
	assert.deepEqual(await outage.json(), subscriptionUnreachable(PROVIDER));
	assert.equal(isTurnRunning(chatId), false);
	assert.deepEqual(chatStore.getChat(chatId)!.messages, [], "nothing is saved before the gate");

	snapshot = "disconnected";
	const refused = await send(chatId);
	assert.equal(refused.status, 422);
	assert.deepEqual(await refused.json(), providerKeyMissing(PROVIDER, ["strong"]));
});

test("main send: a failed ChatGPT catalog check is a retryable 503", async () => {
	const outage = await send(pinned("chatgpt", "gpt-5.5"));
	assert.equal(outage.status, 503);
	assert.deepEqual(await outage.json(), subscriptionUnreachable("chatgpt"));
});

test("start with files: a failed snapshot is a retryable 503 and creates no chat", async () => {
	const token = issueSession(PATHS.data, { method: "pairing", client: { label: "outage test device", deviceType: "desktop" } }).token;
	const request = (pathname: string, method: string, body?: string) => new Request(new URL(pathname, "http://attachment.test:3000"),
		{ method, body, headers: { Authorization: `Bearer ${token}`, "X-LearnHarness-Protocol": "1" } });
	writeSettings({ version: 1, models: { strong: { model: { provider: PROVIDER, id: MODEL } } } });
	try {
		const draftId = randomUUID();
		const upload = await (await reserveAttachmentRequest(request("/api/attachments", "POST", JSON.stringify({ draftId, name: "fixture.txt", mimeType: "", size: 4 })))).json();
		assert.equal((await uploadAttachmentRequest(request(upload.uploadUrl, "PUT", "test"))).status, 204);
		const body = JSON.stringify({ draftId, sendId: randomUUID(), title: "Open with a file", attachmentUploadIds: [upload.id] });
		const chats = chatStore.listChats().length;
		const outage = await startAttachmentRequest(request("/api/attachments/start", "POST", body));
		assert.equal(outage.status, 503);
		assert.deepEqual(await outage.json(), subscriptionUnreachable(PROVIDER));
		assert.equal(chatStore.listChats().length, chats, "no chat is created");

		snapshot = "disconnected";
		const refused = await startAttachmentRequest(request("/api/attachments/start", "POST", body));
		assert.equal(refused.status, 422);
		assert.deepEqual(await refused.json(), providerKeyMissing(PROVIDER, ["strong"]));
	} finally {
		writeSettings({ version: 1 });
	}
});

test("side chat: a failed snapshot is a retryable 503, and the same connection recovers", async () => {
	const record = chatStore.getChat(pinned(PROVIDER, MODEL))!;
	const outage = await productionEngineFor(record);
	assert.ok(outage instanceof Response);
	assert.equal(outage.status, 503);
	assert.deepEqual(await outage.json(), subscriptionUnreachable(PROVIDER));

	snapshot = "connected";
	assert.ok(!((await productionEngineFor(record)) instanceof Response), "the recovered connection runs with no settings change");
});

test("plugin model refusal: a failed snapshot is a retryable 503, and the same connection recovers", async () => {
	const model = { provider: PROVIDER, id: MODEL };
	const message = `The model ${PROVIDER}/${MODEL} is no longer available. Pick another model in Settings.`;
	const host = {
		list: () => [], conflicts: () => [], refresh: async () => {}, setEnabled: async () => {}, convertDocument: async () => assert.fail("unused"), asset: () => assert.fail("unused"),
		call: async () => { throw Object.assign(new Error(message), { code: "model_unavailable", model }); },
	};
	const transport = createPluginTransport({ getHost: async () => host, directory: path.join(root, "plugins"), keyMissing: pluginKeyMissing });
	const call = () => transport.call("flashcards", new Request("http://localhost/api/plugins", { method: "POST", body: JSON.stringify({ operation: "preflight-file", input: {} }) }));
	const outage = await call();
	assert.equal(outage.status, 503);
	assert.deepEqual(await outage.json(), subscriptionUnreachable(PROVIDER));

	snapshot = "disconnected";
	const refused = await call();
	assert.equal(refused.status, 422);
	assert.deepEqual(await refused.json(), providerKeyMissing(PROVIDER, []));

	snapshot = "connected";
	assert.equal(await pluginKeyMissing(PROVIDER, MODEL), null, "the recovered connection needs no key");
});

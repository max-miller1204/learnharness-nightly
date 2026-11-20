/**
 * A subscription outage is not missing setup. Over desktop IPC, with the reply
 * shapes the Electron owners send: a native snapshot request answered
 * `ok: false`, and a ChatGPT `models` reply whose status carries
 * `catalogError` with an empty catalog. While the latest check (ordered by
 * when it started) failed and the runtime is still connected, every path that
 * runs the model answers a retryable 503 subscription_unreachable. A snapshot
 * that says "not connected", or a lost runtime, is the 422 setup refusal.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { issueSession } from "../selfhost/src/auth-store.ts";
import type { PiEngine } from "../src/agent/models.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-subscription-outage-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
process.env.LH_SELFHOST = "0";
process.env.LH_IGNORE_ENV_KEYS = "1";

const { PATHS } = await import("../config.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { connectionUnreachable, onSubscriptionChange } = await import("../src/agent/subscription-connections.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { isProviderKeyRefusal, providerKeyMissing, ProviderKeyMissingError, subscriptionUnreachable, SubscriptionUnreachableError } = await import("../src/core/settings.ts");
const { extraction, handleChatInput, handleChatRequest } = await import("../src/server/chat-handler.ts");
const { connectionRefusal } = await import("../src/server/connection-refusal.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { catalogProviders, refreshConnectionCatalog } = await import("../src/server/model-catalog.ts");
const { productionEngineFor } = await import("../src/server/side-chat.ts");
const { pluginKeyMissing } = await import("../src/server/plugin-model-refusal.ts");
const { createPluginTransport } = await import("../src/server/plugin-transport.ts");
const { reserveAttachmentRequest, uploadAttachmentRequest, startAttachmentRequest } = await import("../src/server/attachment-routes.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { writeSettings } = await import("../src/store/settings.ts");

const COPILOT = "github-copilot-subscription";
const COPILOT_MODEL = piModels().getModels("github-copilot")[0]!.id;
const GPT = piModels().getModel("openai", "gpt-5")!.id;

// ── the desktop owner, over IPC ─────────────────────────────────────────────
type Ask = { channel: string; id: string; op: string };
type Native = "fails" | "connected" | "disconnected" | "hold";
let native: Native = "fails";
let catalogError: string | null = "The ChatGPT model list could not be loaded.";
let holdChatGPT = false;
let revision = 0;
const held: Ask[] = [];
let snapshotAsks = 0;
let slowNative = false; // answer native asks a macrotask later, as real IPC does
// The ChatGPT owner as Electron runs it: each models() answer comes a macrotask
// later and is preceded by a state push (electron/chatgpt.cjs pushes after every
// failed load and on recovery, before the reply).
let electronChatGPT = false;
let modelAsks = 0;
const ipc = (message: unknown) => (process.emit as (event: string, value: unknown) => boolean)("message", message);
const nativeSnapshot = (connected: boolean) => ({
	statuses: [{ providerId: "github-copilot", available: true, connected, pending: false, allowBackgroundUse: true, connectionId: "fixture-copilot", epoch: 1, authorityRevision: 1, revision: ++revision }],
	models: { "github-copilot": connected ? piModels().getModels("github-copilot") : [] },
});
const chatGPTStatus = () => ({ available: true, pending: false, allowBackgroundUse: true, activeId: "fixture", accounts: [{ id: "fixture", registration: "oaiapp_fixture", email: "fixture@example.invalid", connected: true, planEnabled: true }], error: null, catalogError });
const stamp = () => ({ epoch: 1, authorityRevision: 1, revision: ++revision });
function answer(ask: Ask) {
	if (ask.channel === "lh:subscriptions") {
		const mode = native;
		if (mode === "fails") return ipc({ channel: ask.channel, id: ask.id, op: ask.op, ok: false, error: "Subscription connection failed." });
		return ipc({ channel: ask.channel, id: ask.id, op: ask.op, ok: true, value: nativeSnapshot(mode === "connected") });
	}
	// The ChatGPT owner never throws for a catalog failure: it answers with
	// the error in its status and an empty catalog (electron/chatgpt.cjs models()).
	if (electronChatGPT && ask.op === "models") ipc({ channel: ask.channel, kind: "state", stamp: stamp(), status: chatGPTStatus(), invalidate: "none" });
	ipc({ channel: ask.channel, id: ask.id, op: ask.op, ok: true, value: { ...stamp(), status: chatGPTStatus(), accountId: "fixture", models: catalogError ? [] : [{ id: GPT, name: "Fixture" }] } });
}
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const marker = process.env.LH_DESKTOP_SERVER, secret = process.env.LH_DESKTOP_API_SECRET;
before(() => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, writable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: Ask, callback?: (error: Error | null) => void) => {
		callback?.(null);
		if (message.channel === "lh:subscriptions" && message.op === "snapshot") snapshotAsks++;
		if (message.channel === "lh:chatgpt" && message.op === "models") modelAsks++;
		if ((message.channel === "lh:subscriptions" && native === "hold") || (message.channel === "lh:chatgpt" && holdChatGPT)) held.push(message);
		else if ((slowNative && message.channel === "lh:subscriptions") || (electronChatGPT && message.channel === "lh:chatgpt")) setTimeout(() => answer(message), 1);
		else queueMicrotask(() => answer(message));
		return true;
	} });
});
after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	if (marker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = marker;
	if (secret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = secret;
});
beforeEach(() => { slowNative = false; electronChatGPT = false; native = "fails"; catalogError = "The ChatGPT model list could not be loaded."; holdChatGPT = false; held.length = 0; });
const until = async (ready: () => boolean) => { while (!ready()) await new Promise((resolve) => setImmediate(resolve)); };

// ── the paths ───────────────────────────────────────────────────────────────
const pinned = (provider: string, id: string) => {
	const chat = chatStore.createChat(`outage ${provider}`);
	chatStore.saveSettings(chat.id, { model: { provider, id } });
	return chat.id;
};
const send = (chatId: string) => handleChatRequest(new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ chatId, input: { type: "text", text: "teach me" } }) }), () => assert.fail("a refused turn builds no agent"));
const token = issueSession(PATHS.data, { method: "pairing", client: { label: "outage test device", deviceType: "desktop" } }).token;
const authed = (pathname: string, method: string, body?: string) => new Request(new URL(pathname, "http://attachment.test:3000"),
	{ method, body, headers: { Authorization: `Bearer ${token}`, "X-LearnHarness-Protocol": "1" } });
async function startWithFile(provider: string, id: string) {
	writeSettings({ version: 1, models: { strong: { model: { provider, id } } } });
	try {
		const draftId = randomUUID();
		const upload = await (await reserveAttachmentRequest(authed("/api/attachments", "POST", JSON.stringify({ draftId, name: "fixture.txt", mimeType: "", size: 4 })))).json();
		assert.equal((await uploadAttachmentRequest(authed(upload.uploadUrl, "PUT", "test"))).status, 204);
		const chats = chatStore.listChats().length;
		const response = await startAttachmentRequest(authed("/api/attachments/start", "POST", JSON.stringify({ draftId, sendId: randomUUID(), title: "Open with a file", attachmentUploadIds: [upload.id] })));
		assert.equal(chatStore.listChats().length, chats, "a refused start creates no chat");
		return response;
	} finally {
		writeSettings({ version: 1 });
	}
}
async function sideChat(provider: string, id: string) {
	const engine = await productionEngineFor(chatStore.getChat(pinned(provider, id))!);
	return engine instanceof Response ? engine : null;
}
function plugin(provider: string, id: string) {
	const host = {
		list: () => [], conflicts: () => [], refresh: async () => {}, setEnabled: async () => {}, convertDocument: async () => assert.fail("unused"), asset: () => assert.fail("unused"),
		call: async () => { throw Object.assign(new Error(`The model ${provider}/${id} is no longer available. Pick another model in Settings.`), { code: "model_unavailable", model: { provider, id } }); },
	};
	const transport = createPluginTransport({ getHost: async () => host, directory: path.join(root, "plugins"), keyMissing: pluginKeyMissing });
	return transport.call("flashcards", new Request("http://localhost/api/plugins", { method: "POST", body: JSON.stringify({ operation: "preflight-file", input: {} }) }));
}
async function expect(response: Response | null | Promise<Response | null>, status: number, body: object) {
	const settled = await response;
	assert.ok(settled, "refused");
	assert.equal(settled.status, status);
	assert.deepEqual(await settled.json(), body);
}

test("a failed native snapshot is a retryable 503 on every path; a disconnected one is the 422 setup refusal; the same connection recovers", async () => {
	const unreachable = subscriptionUnreachable(COPILOT);
	const chatId = pinned(COPILOT, COPILOT_MODEL);
	await expect(send(chatId), 503, unreachable);
	assert.deepEqual(chatStore.getChat(chatId)!.messages, [], "nothing is saved before the gate");
	await expect(startWithFile(COPILOT, COPILOT_MODEL), 503, unreachable);
	await expect(sideChat(COPILOT, COPILOT_MODEL), 503, unreachable);
	await expect(plugin(COPILOT, COPILOT_MODEL), 503, unreachable);

	assert.equal(catalogProviders().find((p) => p.id === COPILOT)?.unreachable, true, "the web catalog marks the outage, so the web sends instead of opening setup");

	native = "disconnected";
	await expect(send(chatId), 422, providerKeyMissing(COPILOT, ["strong"]));
	assert.equal(catalogProviders().find((p) => p.id === COPILOT)?.unreachable, undefined, "a real disconnect is setup again");
	await expect(startWithFile(COPILOT, COPILOT_MODEL), 422, providerKeyMissing(COPILOT, ["strong"]));
	await expect(sideChat(COPILOT, COPILOT_MODEL), 422, providerKeyMissing(COPILOT, ["strong"]));
	await expect(plugin(COPILOT, COPILOT_MODEL), 422, providerKeyMissing(COPILOT, []));

	native = "connected";
	assert.equal(await sideChat(COPILOT, COPILOT_MODEL), null, "the recovered connection runs with no settings change");
	assert.equal(await pluginKeyMissing(COPILOT, COPILOT_MODEL), null);
});

test("a ChatGPT catalogError reply is a retryable 503 on every path", async () => {
	const unreachable = subscriptionUnreachable("chatgpt");
	await expect(send(pinned("chatgpt", GPT)), 503, unreachable);
	await expect(startWithFile("chatgpt", GPT), 503, unreachable);
	await expect(sideChat("chatgpt", GPT), 503, unreachable);
	await expect(plugin("chatgpt", GPT), 503, unreachable);
	assert.equal(catalogProviders().find((p) => p.id === "chatgpt")?.unreachable, true);

	catalogError = null;
	assert.equal(await sideChat("chatgpt", GPT), null, "the catalog recovers with no settings change");
});

test("a send's ChatGPT catalog failure stays a 503 while a newer picker refresh is pending", async () => {
	holdChatGPT = true;
	const sending = send(pinned("chatgpt", GPT));
	await until(() => held.length === 1);
	const picker = refreshConnectionCatalog();
	await until(() => held.some((ask) => ask.channel === "lh:chatgpt" && ask !== held[0]));
	answer(held[0]!);
	await expect(sending, 503, subscriptionUnreachable("chatgpt"));
	for (const ask of held.slice(1)) answer(ask);
	await picker;
});

test("a stale native failure never overwrites a newer disconnected snapshot", async () => {
	native = "hold";
	const stale = refreshConnectionCatalog(COPILOT);
	await until(() => held.length === 1);
	ipc({ channel: "lh:subscriptions", op: "changed", snapshot: nativeSnapshot(false) });
	ipc({ channel: "lh:subscriptions", id: held[0]!.id, op: held[0]!.op, ok: false, error: "Subscription connection failed." });
	await stale;
	assert.equal(connectionUnreachable(COPILOT), false, "the newer snapshot wins: not connected, not unreachable");
});

test("a ChatGPT steer during a catalog outage parks on 403 even with cached background consent", async () => {
	ipc({ channel: "lh:chatgpt", kind: "state", stamp: stamp(), status: chatGPTStatus(), invalidate: "none" });
	const steer = { id: "auto", role: "custom" as const, customType: "subagent-steer" as const, content: "Automatic result", details: { jobId: "fixture-job" }, display: true, timestamp: 2 };
	const response = await handleChatInput(pinned("chatgpt", GPT), { type: "steers", steers: [steer] } as Parameters<typeof handleChatInput>[1], () => assert.fail("a parked steer builds no agent"));
	assert.equal(response.status, 403);
});

// The job runner and extraction pipeline get the same gate chat-handler wires.
// The engine resolves against the live catalog like production's, then runs scripted.
const jobRunner = (engine: PiEngine, steers: unknown[], spec = { provider: COPILOT, id: COPILOT_MODEL }) => createJobRunner({
	chatStore, jobStore, deliver: async (steer) => { steers.push(steer); },
	engineFor: () => { piEngineForSpec(spec); return engine; },
	connectionRefusal: (provider, tier) => connectionRefusal(provider, [tier]),
	onConnectionChange: onSubscriptionChange,
});
function copilotEngine(brief: string, provider = COPILOT): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxText(brief)])]);
	return { model: { ...faux.getModel(), provider }, streamFn: faux.streamSimple };
}
const chatGPTJob = (id: string, brief: string, steers: unknown[]) => jobRunner(copilotEngine(brief, "chatgpt"), steers, { provider: "chatgpt", id: GPT }).runJob(id);
function researchJob() {
	const chatId = pinned(COPILOT, COPILOT_MODEL);
	return jobStore.createJob({ kind: "research", chatId, toolCallId: `call-${randomUUID()}`, input: { question: "What is a monad?" } }).id;
}

test("a job spawn during a native outage waits with no setup refusal; a confirmed disconnect refuses; recovery runs it with no settings change", async () => {
	const steers: unknown[] = [];
	const refused = researchJob();
	const parked = jobRunner(copilotEngine("unused"), steers).runJob(refused);
	await until(() => jobStore.getJob(refused)!.activity === "waiting: GitHub Copilot could not be reached");
	assert.equal(jobStore.getJob(refused)!.status, "running");
	assert.equal(jobStore.getJob(refused)!.error, undefined, "the dock and dispatch card have no setup refusal to show");

	native = "disconnected";
	await refreshConnectionCatalog(COPILOT); // the snapshot says "not connected": the parked job wakes
	await parked;
	assert.equal(jobStore.getJob(refused)!.error, providerKeyMissing(COPILOT, ["cheap"]).error);
	assert.equal(isProviderKeyRefusal(jobStore.getJob(refused)!.error), true, "a real disconnect is setup");

	native = "fails";
	await refreshConnectionCatalog(COPILOT);
	const recovered = researchJob();
	const waiting = jobRunner(copilotEngine("The brief after the outage."), steers).runJob(recovered);
	await until(() => jobStore.getJob(recovered)!.activity?.startsWith("waiting:") === true);
	native = "connected";
	await refreshConnectionCatalog(COPILOT); // any check that sees the connection wakes it
	await waiting;
	const done = jobStore.getJob(recovered)!;
	assert.equal(done.status, "done");
	assert.equal((done.result as { brief: string }).brief, "The brief after the outage.");
});

test("an extraction run during an outage defers (retryable), a confirmed disconnect refuses as setup, and recovery runs with no settings change", async () => {
	writeSettings({ version: 1, models: { cheap: { model: { provider: COPILOT, id: COPILOT_MODEL } } } });
	try {
		const chatId = chatStore.createChat("outage extraction").id;
		await assert.rejects(extraction.runExtraction(chatId), (error: unknown) => {
			assert.ok(error instanceof SubscriptionUnreachableError, "an outage, not a setup refusal");
			assert.deepEqual(error.envelope, subscriptionUnreachable(COPILOT));
			return true;
		});
		// The failed check emptied the catalog: still an outage, not a gone model.
		await assert.rejects(extraction.runExtraction(chatId), SubscriptionUnreachableError);
		native = "disconnected";
		await assert.rejects(extraction.runExtraction(chatId), ProviderKeyMissingError);
		native = "connected";
		assert.deepEqual(await extraction.runExtraction(chatId), { nodes: 0, chains: 0 });
	} finally {
		writeSettings({ version: 1 });
	}
});

test("two jobs waiting on the same native outage never wake each other", async () => {
	slowNative = true;
	const steers: unknown[] = [];
	const first = researchJob(), second = researchJob();
	const runs = [jobRunner(copilotEngine("First brief."), steers).runJob(first), jobRunner(copilotEngine("Second brief."), steers).runJob(second)];
	const waiting = (id: string) => jobStore.getJob(id)!.activity?.startsWith("waiting:") === true;
	await until(() => waiting(first) && waiting(second));
	await refreshConnectionCatalog(COPILOT); // another failed check, from a send or the picker
	const asked = snapshotAsks;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(snapshotAsks, asked, "a repeat failed check notifies no one, so no wake refreshes again");

	native = "connected";
	await refreshConnectionCatalog(COPILOT);
	await Promise.all(runs);
	assert.equal(jobStore.getJob(first)!.status, "done");
	assert.equal(jobStore.getJob(second)!.status, "done");
});

test("two jobs waiting on a ChatGPT outage never wake each other, though the owner pushes state after every failed load", async () => {
	electronChatGPT = true;
	await refreshConnectionCatalog("chatgpt");
	const steers: unknown[] = [];
	const first = researchJob(), second = researchJob();
	const runs = [chatGPTJob(first, "First brief.", steers), chatGPTJob(second, "Second brief.", steers)];
	const waiting = (id: string) => jobStore.getJob(id)!.activity === "waiting: ChatGPT could not be reached";
	await until(() => waiting(first) && waiting(second));
	await refreshConnectionCatalog("chatgpt"); // another failed load, from a send or the picker
	const asked = modelAsks;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(modelAsks, asked, "a push that says nothing new notifies no one");

	catalogError = null;
	await refreshConnectionCatalog("chatgpt");
	await Promise.all(runs);
	assert.equal(jobStore.getJob(first)!.status, "done");
	assert.equal(jobStore.getJob(second)!.status, "done");
});

test("on ChatGPT recovery the owner's push wakes both waiting jobs before its reply, and neither finds an empty catalog", async () => {
	electronChatGPT = true;
	await refreshConnectionCatalog("chatgpt");
	const steers: unknown[] = [];
	const first = researchJob(), second = researchJob();
	const runs = [chatGPTJob(first, "First brief.", steers), chatGPTJob(second, "Second brief.", steers)];
	await until(() => [first, second].every((id) => jobStore.getJob(id)!.activity?.startsWith("waiting:") === true));
	catalogError = null;
	void refreshConnectionCatalog("chatgpt"); // its recovery push wakes both jobs; their refreshes supersede each other
	await Promise.all(runs);
	for (const id of [first, second]) {
		const job = jobStore.getJob(id)!;
		assert.equal(job.error, undefined, "never refused as model unavailable");
		assert.equal(job.status, "done");
	}
});

test("a ChatGPT success a newer refresh superseded clears no outage: the newer reply clears it and installs the catalog together", async () => {
	await refreshConnectionCatalog("chatgpt");
	assert.equal(connectionUnreachable("chatgpt"), true);
	holdChatGPT = true;
	catalogError = null;
	const older = refreshConnectionCatalog("chatgpt");
	await until(() => held.length === 1);
	const newer = refreshConnectionCatalog("chatgpt");
	await until(() => held.length === 2);
	answer(held[0]!);
	let olderSettled = false;
	void older.then(() => { olderSettled = true; });
	for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(connectionUnreachable("chatgpt"), true, "the stale success installed no catalog, so the outage stands");
	assert.throws(() => piEngineForSpec({ provider: "chatgpt", id: GPT }));
	assert.equal(olderSettled, false, "the superseded refresh waits for the newer one");
	answer(held[1]!);
	await Promise.all([older, newer]);
	assert.equal(connectionUnreachable("chatgpt"), false);
	assert.doesNotThrow(() => piEngineForSpec({ provider: "chatgpt", id: GPT }), "cleared together with the catalog");
});

// Last: the desktop connection closes for the rest of this process.
test("a lost desktop connection is the 422 setup refusal, not a lasting outage", async () => {
	const chatId = pinned(COPILOT, COPILOT_MODEL);
	await expect(send(chatId), 503, subscriptionUnreachable(COPILOT));
	(process as { connected?: boolean }).connected = false;
	process.emit("disconnect");
	assert.equal(connectionUnreachable(COPILOT), false);
	assert.equal(connectionUnreachable("chatgpt"), false);
	assert.ok(catalogProviders().every((p) => !p.unreachable), "a lost runtime is setup, not an outage");
	await expect(send(chatId), 422, providerKeyMissing(COPILOT, ["strong"]));
	await expect(sideChat(COPILOT, COPILOT_MODEL), 422, providerKeyMissing(COPILOT, ["strong"]));
});

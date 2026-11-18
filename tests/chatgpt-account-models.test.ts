import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import { piModels } from "../src/agent/models.ts";
import { refreshChatGPTModels, chatGPTModels } from "../src/agent/chatgpt-bridge.ts";

const send = Object.getOwnPropertyDescriptor(process, "send"), connected = Object.getOwnPropertyDescriptor(process, "connected");
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
const pending: any[] = [];
const supported = piModels().getModels("openai").filter((m): m is Model<"openai-responses"> => m.api === "openai-responses");
const [known, other] = supported as [Model<"openai-responses">, Model<"openai-responses">];
const status = { available: true, pending: false, allowBackgroundUse: true, activeId: "A", accounts: [{ id: "A", connected: true, background: false, planEnabled: true }], error: null };
let revision = 0;
async function refresh(models: unknown[]) {
	const done = refreshChatGPTModels(supported);
	const request = pending.at(-1);
	revision++;
	(process.emit as (name: string, value: unknown) => boolean)("message", { channel: "lh:chatgpt", id: request.id, op: request.op, ok: true, value: { epoch: 1, authorityRevision: 1, revision, status, accountId: "A", models } });
	await done;
	return chatGPTModels();
}
const asChatGPT = (model: Model<"openai-responses">, name: string) => ({ ...model, provider: "chatgpt", name, headers: undefined, samplingParams: undefined, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

before(() => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (m: unknown, cb?: () => void) => { pending.push(m); cb?.(); return true; } });
});
after(() => {
	if (desktopMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = desktopMarker;
	if (desktopSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = desktopSecret;
	if (send) Object.defineProperty(process, "send", send); else delete process.send;
	if (connected) Object.defineProperty(process, "connected", connected); else delete (process as { connected?: boolean }).connected;
});

test("Pi-known account models keep Pi's entry; unknown ones are built from account metadata and the first Pi-known template, in account order", async () => {
	assert(supported.length >= 2, "Pi's openai catalog has at least two Responses models");
	const models = await refresh([
		{ id: "gpt-unknown", name: "Unknown model", contextWindow: 500000, input: ["text", "image", "audio"], reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
		{ id: known.id, name: "Known model", contextWindow: 1, input: ["text"], reasoningLevels: ["low"] },
		{ id: other.id, name: "Other model" },
	]);
	assert.deepEqual(models.map((m) => m.id), ["gpt-unknown", known.id, other.id]);
	assert.deepEqual(models[1], asChatGPT(known, "Known model"), "account metadata never overrides a Pi-known model");
	assert.deepEqual(models[2], asChatGPT(other, "Other model"));
	assert.deepEqual(models[0], {
		...asChatGPT(known, "Unknown model"),
		id: "gpt-unknown",
		input: ["text", "image"],
		contextWindow: 500000,
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	});
});

test("models Pi doesn't know need the account's own window and input list; effort sets the account omits are disabled", async () => {
	const models = await refresh([
		{ id: known.id, name: "Known model" },
		{ id: "no-efforts", name: "No efforts", contextWindow: 300000, input: ["text"], reasoningLevels: ["ultra"] },
		{ id: "bad-window", name: "Bad window", contextWindow: "500000", input: ["text"], reasoningLevels: ["low"] },
		{ id: "zero-window", name: "Zero window", contextWindow: 0, input: ["text"] },
		{ id: "no-input", name: "No input", contextWindow: 300000 },
		{ id: "no-text", name: "No text", contextWindow: 300000, input: ["image", "audio"], reasoningLevels: ["low"] },
		{ id: "no-metadata", name: "No metadata" },
	]);
	assert.deepEqual(models.map((m) => m.id), [known.id, "no-efforts"]);
	const built = models[1]!;
	assert.equal(built.contextWindow, 300000);
	assert.deepEqual(built.input, ["text"]);
	assert.equal(built.reasoning, false);
	assert.deepEqual(built.thinkingLevelMap, { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null });
});

test("without any Pi-known account model there is no template, so unknown models stay dropped", async () => {
	assert.deepEqual(await refresh([{ id: "gpt-unknown", name: "Unknown", contextWindow: 500000, input: ["text"], reasoningLevels: ["low"] }]), []);
});

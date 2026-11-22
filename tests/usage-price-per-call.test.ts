/**
 * Issue #332: per-call costUsd captured from the dispatched model at record
 * time so catalog price changes (Pi bump or pi.dev model-list refresh,
 * including mid-flight refreshes) never rewrite historical usage costs, while
 * older records without costUsd keep falling back to live catalog lookup then
 * RETIRED_MODELS without modifying files on disk.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { calculateCost, createFauxCore, fauxAssistantMessage, type Api, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AUTH_PROVIDER_ENV_VARS } from "../src/core/auth-keys.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-usage-price-per-call-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n", { mode: 0o600 });
for (const key of AUTH_PROVIDER_ENV_VARS) delete process.env[key];
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { piModels, setModelCatalogOverlay } = await import("../src/agent/models.ts");
const { captureCallUsage, captureJobUsageStep } = await import("../src/agent/pricing.ts");
const { callUsage, createExtractionPipeline } = await import("../src/agent/subagents/extraction.ts");
const { callCost, jobCost, sessionCost, turnCost } = await import("../src/server/pricing.ts");
const { graphCosts } = await import("../src/server/graph.ts");
const { activityFeed } = await import("../src/server/observability.ts");
const { initializeModelCatalog, refreshModelCatalog } = await import("../src/server/remote-model-catalog.ts");
const { ensureCompacted } = await import("../src/server/compaction.ts");
const { createSideChatService } = await import("../src/server/side-chat.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { piTurnResponse } = await import("../src/server/pi/ui-stream.ts");
const { createProberAgent } = await import("../src/agent/teacher-agent.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { createPluginWorkerService } = await import("../src/agent/plugin-workers.ts");
const { createPluginTaskRecordStore } = await import("../src/store/plugin-task-records.ts");
const { createPluginInference } = await import("../src/server/plugin-inference.ts");
const { accumulateJobUsage } = await import("../src/core/contracts/jobs.ts");
const { graphCostSummary } = await import("../src/core/cost-summary.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { GET: getChatRoute } = await import("../app/api/chats/[id]/route.ts");
const { RETIRED_MODELS } = await import("../src/server/retired-models.ts");
const { Type } = await import("typebox");

const piUsage = (input: number, output: number, extra: Partial<Usage> = {}): Usage => ({
	input,
	output,
	cacheRead: extra.cacheRead ?? 0,
	cacheWrite: extra.cacheWrite ?? 0,
	...(extra.cacheWrite1h !== undefined ? { cacheWrite1h: extra.cacheWrite1h } : {}),
	...(extra.reasoning !== undefined ? { reasoning: extra.reasoning } : {}),
	totalTokens: input + output + (extra.cacheRead ?? 0) + (extra.cacheWrite ?? 0),
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

function fixedStream(model: Model<Api>, raw: Usage, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", gate?: Promise<void>) {
	return () => {
		const stream = new AssistantMessageEventStream();
		const msg: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content,
			stopReason,
			timestamp: Date.now(),
			usage: structuredClone(raw),
		};
		void Promise.resolve(gate).then(() => {
			stream.push({ type: "done", reason: stopReason as "stop" | "toolUse", message: msg });
			stream.end(msg);
		});
		return stream;
	};
}

describe("per-call stored costUsd (issue #332)", () => {
	it("keeps historical turn, extraction, job and API costs unchanged after a catalog price change", async () => {
		const model = piModels().getModel("openrouter", "openai/gpt-6.1-sol");
		assert.ok(model, "bundled catalog model exists");
		const modelId = `${model.provider}:${model.id}`;
		const originalCost = structuredClone(model.cost);
		const raw = piUsage(10_000, 1_000, { cacheRead: 70_000 });
		const expectedBefore = calculateCost(model, structuredClone(raw)).total;
		assert.ok(expectedBefore > 0);

		try {
			const chat = chatStore.createChat("price-change-history");
			chatStore.saveMessages(chat.id, [newUserMessage("hello")]);
			const recordedStep = captureCallUsage(raw, model);
			assert.equal(recordedStep.costUsd, expectedBefore);
			chatStore.appendTurnUsage(chat.id, {
				id: "turn_before",
				messageId: "m_before",
				at: "2026-11-21T00:00:00.000Z",
				model: modelId,
				steps: [recordedStep],
			});
			chatStore.appendExtractionUsage(chat.id, {
				startedAt: 1001,
				at: "2026-11-21T00:00:01.000Z",
				durationMs: 500,
				stages: {
					extractor: { model: modelId, steps: [callUsage(raw, model)] },
					auditor: { model: modelId, steps: [callUsage(raw, model)] },
				},
			});
			const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_1" });
			const jobUsage = accumulateJobUsage(undefined, modelId, captureJobUsageStep(raw, model));
			jobStore.updateJob(job.id, { usage: jobUsage });

			const chatFile = path.join(scratch, "chats", `${chat.id}.json`);
			const diskBefore = fs.readFileSync(chatFile, "utf8");

			// Simulate a Pi bump changing the catalog model's rates 10x.
			model.cost.input *= 10;
			model.cost.output *= 10;
			model.cost.cacheRead *= 10;
			model.cost.cacheWrite *= 10;
			const expectedAfter = calculateCost(model, structuredClone(raw)).total;
			assert.notEqual(expectedAfter, expectedBefore);

			// Every historical surface keeps the original recorded cost.
			assert.equal(callCost(recordedStep, modelId), expectedBefore);
			assert.equal(turnCost(chatStore.getChat(chat.id)!.turns![0]!), expectedBefore);
			assert.equal(sessionCost(chatStore.getChat(chat.id)!).cost, expectedBefore);
			assert.equal(jobCost(jobStore.getJob(job.id)!), expectedBefore);
			assert.equal(activityFeed().jobs.find((j) => j.id === job.id)?.costUsd, expectedBefore);

			const graph = graphCosts();
			assert.equal(graph.stages.extraction.dollars, expectedBefore);
			assert.equal(graph.stages.audit.dollars, expectedBefore);
			assert.equal(graph.totalDollars, expectedBefore * 2);

			const res = await getChatRoute(new Request(`http://localhost/api/chats/${chat.id}`), { params: Promise.resolve({ id: chat.id }) });
			assert.equal(res.status, 200);
			const body = await res.json() as { pricing: { cost: number; turnCosts: Record<string, number | null> } };
			assert.equal(body.pricing.cost, expectedBefore);
			assert.equal(body.pricing.turnCosts.turn_before, expectedBefore);
			assert.equal(fs.readFileSync(chatFile, "utf8"), diskBefore, "reading history must not rewrite the file");

			// A new call recorded after the price change uses the new catalog price.
			const afterStep = captureCallUsage(raw, model);
			assert.equal(afterStep.costUsd, expectedAfter);
			chatStore.appendTurnUsage(chat.id, {
				id: "turn_after",
				messageId: "m_after",
				at: "2026-11-21T00:05:00.000Z",
				model: modelId,
				steps: [afterStep],
			});
			const mixed = sessionCost(chatStore.getChat(chat.id)!);
			assert.equal(mixed.turnCosts.turn_before, expectedBefore);
			assert.equal(mixed.turnCosts.turn_after, expectedAfter);
			assert.ok(Math.abs(mixed.cost - (expectedBefore + expectedAfter)) < 1e-12);
		} finally {
			Object.assign(model.cost, originalCost);
		}
	});

	it("falls back to today's catalog lookup for old records without costUsd without rewriting files", async () => {
		const model = piModels().getModel("openrouter", "z-ai/glm-5.3-flash");
		assert.ok(model);
		const modelId = `${model.provider}:${model.id}`;
		const originalCost = structuredClone(model.cost);
		const raw = piUsage(100_000, 20_000, { cacheRead: 10_000 });
		const legacyStep = {
			inputTokens: raw.input,
			outputTokens: raw.output,
			cacheReadTokens: raw.cacheRead,
			cacheWriteTokens: raw.cacheWrite,
			cacheWrite1hTokens: 0,
			reasoningTokens: 0,
		};
		assert.equal("costUsd" in legacyStep, false);

		try {
			const chat = chatStore.createChat("legacy-without-cost");
			chatStore.saveMessages(chat.id, [newUserMessage("old session")]);
			chatStore.appendTurnUsage(chat.id, {
				id: "legacy_turn",
				messageId: "m_legacy",
				at: "2026-09-01T00:00:00.000Z",
				model: modelId,
				steps: [legacyStep],
			});
			const chatFile = path.join(scratch, "chats", `${chat.id}.json`);
			const beforeBytes = fs.readFileSync(chatFile, "utf8");

			const initialExpected = calculateCost(model, structuredClone(raw)).total;
			const firstRes = await getChatRoute(new Request(`http://localhost/api/chats/${chat.id}?view=stats`), { params: Promise.resolve({ id: chat.id }) });
			assert.equal((await firstRes.json() as { pricing: { cost: number } }).pricing.cost, initialExpected);
			assert.equal(fs.readFileSync(chatFile, "utf8"), beforeBytes, "tolerant read never rewrites old files");

			// When catalog price changes, the old record without costUsd follows the live lookup.
			model.cost.input *= 3;
			model.cost.output *= 3;
			const updatedExpected = calculateCost(model, structuredClone(raw)).total;
			assert.notEqual(updatedExpected, initialExpected);
			assert.equal(callCost(legacyStep, modelId), updatedExpected);
			assert.equal(sessionCost(chatStore.getChat(chat.id)!).cost, updatedExpected);
			assert.equal(
				graphCostSummary({
					chats: [{ title: "old", extractions: [{ startedAt: 1, at: "2026-09-01T00:00:00.000Z", durationMs: 1, stages: { extractor: { model: modelId, steps: [legacyStep] }, auditor: { model: modelId, steps: [legacyStep] } } }] }],
					sources: [],
				}, callCost).totalDollars,
				updatedExpected * 2,
			);
			assert.equal(
				jobCost({ usage: { model: modelId, steps: 1, inputTokens: raw.input, outputTokens: raw.output, cacheReadTokens: raw.cacheRead, cacheWriteTokens: raw.cacheWrite, cacheWrite1hTokens: 0, reasoningTokens: 0 } }),
				updatedExpected,
			);
			assert.equal(fs.readFileSync(chatFile, "utf8"), beforeBytes);
		} finally {
			Object.assign(model.cost, originalCost);
		}
	});

	it("keeps retired-model fallback for old records and preserves stored costUsd when a model is later retired", () => {
		const retiredId = "opencode-go:gemini-4-argon-contributor";
		const raw = piUsage(1_000_000, 1_000_000);
		const expectedRetired = calculateCost({ cost: RETIRED_MODELS[retiredId]!.cost } as Parameters<typeof calculateCost>[0], structuredClone(raw)).total;
		const oldRetiredStep = { inputTokens: raw.input, outputTokens: raw.output, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 };
		assert.equal(callCost(oldRetiredStep, retiredId), expectedRetired);

		const base = piModels().getModels("openai")[0]!;
		const transient: Model<Api> = {
			...base,
			id: "test-soon-retired",
			name: "Soon retired",
			cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
		};
		const transientId = `openai:${transient.id}`;
		try {
			setModelCatalogOverlay(new Map([["openai", [transient]]]));
			const recorded = captureCallUsage(raw, transient);
			assert.equal(recorded.costUsd, 8);
			const jobUsage = accumulateJobUsage(undefined, transientId, captureJobUsageStep(raw, transient));

			// Model is dropped from the catalog and is not in RETIRED_MODELS.
			setModelCatalogOverlay(new Map());
			assert.equal(piModels().getModel("openai", transient.id), undefined);
			assert.equal(callCost(recorded, transientId), 8, "recorded call keeps its stored cost after retirement");
			assert.equal(jobCost({ usage: jobUsage }), 8, "recorded job keeps its stored cost after retirement");
			assert.equal(callCost(oldRetiredStep, transientId), null, "an old record without costUsd for an unknown retired model stays unpriced");
		} finally {
			setModelCatalogOverlay(new Map());
		}
	});

	it("preserves recorded costs across pi.dev model-list refreshes that change a model's price", async (t) => {
		initializeModelCatalog();
		const route = piModels().getModels("openrouter").find((m) => m.api === "openai-completions")!;
		assert.ok(route);
		const refreshedId = "test/refreshed-price-model";
		const returnedRetiredId = "openai/gpt-3.5-turbo";
		const makeRow = (id: string, input: number, output: number) => ({
			id,
			name: id,
			provider: "openrouter",
			api: route.api,
			baseUrl: route.baseUrl,
			input: ["text"],
			reasoning: false,
			cost: { input, output, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		});

		let feedRows = [makeRow(refreshedId, 1, 3), makeRow(returnedRetiredId, 2, 5)];
		t.mock.method(globalThis, "fetch", async (url: URL) => Response.json(url.pathname.endsWith("/openrouter") ? feedRows : []));
		process.env.OPENROUTER_API_KEY = "synthetic-openrouter-key";
		const million = piUsage(1_000_000, 1_000_000);

		try {
			// Refresh #1: models arrive at their initial feed prices.
			assert.equal(await refreshModelCatalog(), "updated");
			const model1Refreshed = piModels().getModel("openrouter", refreshedId)!;
			const model1Returned = piModels().getModel("openrouter", returnedRetiredId)!;
			const call1Refreshed = captureCallUsage(million, model1Refreshed);
			const call1Returned = captureCallUsage(million, model1Returned);
			assert.equal(call1Refreshed.costUsd, 4);
			assert.equal(call1Returned.costUsd, 7);

			const chat = chatStore.createChat("refreshed-pricing");
			chatStore.appendTurnUsage(chat.id, {
				id: "t_refresh_1",
				messageId: "m1",
				at: "2026-11-21T01:00:00.000Z",
				model: `openrouter:${refreshedId}`,
				steps: [call1Refreshed],
			});
			chatStore.appendTurnUsage(chat.id, {
				id: "t_returned_1",
				messageId: "m2",
				at: "2026-11-21T01:01:00.000Z",
				model: `openrouter:${returnedRetiredId}`,
				steps: [call1Returned],
			});

			// Refresh #2: pi.dev updates both models' prices.
			feedRows = [makeRow(refreshedId, 10, 30), makeRow(returnedRetiredId, 8, 20)];
			assert.equal(await refreshModelCatalog(), "updated");

			const model2Refreshed = piModels().getModel("openrouter", refreshedId)!;
			const model2Returned = piModels().getModel("openrouter", returnedRetiredId)!;
			const call2Refreshed = captureCallUsage(million, model2Refreshed);
			const call2Returned = captureCallUsage(million, model2Returned);
			assert.equal(call2Refreshed.costUsd, 40);
			assert.equal(call2Returned.costUsd, 28);

			chatStore.appendTurnUsage(chat.id, {
				id: "t_refresh_2",
				messageId: "m3",
				at: "2026-11-21T02:00:00.000Z",
				model: `openrouter:${refreshedId}`,
				steps: [call2Refreshed],
			});

			// Earlier calls keep Refresh #1 prices; new call uses Refresh #2 price.
			const pricing = sessionCost(chatStore.getChat(chat.id)!);
			assert.equal(pricing.turnCosts.t_refresh_1, 4);
			assert.equal(pricing.turnCosts.t_returned_1, 7);
			assert.equal(pricing.turnCosts.t_refresh_2, 40);
			assert.equal(pricing.cost, 51);

			// Old record without costUsd on the returned retired model uses catalog-first (Refresh #2 price).
			assert.equal(callCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, `openrouter:${returnedRetiredId}`), 28);
			// Old record without costUsd on an unlisted retired model keeps RETIRED_MODELS price ($0.25 + $0.75).
			assert.equal(callCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "openrouter:openai/gpt-3.5-turbo:batch"), 1);
		} finally {
			setModelCatalogOverlay(new Map());
			delete process.env.OPENROUTER_API_KEY;
		}
	});

	it("freezes the dispatched model's cost when a catalog refresh lands while a call is in flight", async (t) => {
		initializeModelCatalog();
		const route = piModels().getModels("openrouter").find((m) => m.api === "openai-completions")!;
		assert.ok(route);
		const modelSlug = "test/inflight-price-model";
		const modelId = `openrouter:${modelSlug}`;
		const makeRow = (input: number, output: number) => ({
			id: modelSlug,
			name: "Inflight Price Model",
			provider: "openrouter",
			api: route.api,
			baseUrl: route.baseUrl,
			input: ["text"],
			reasoning: false,
			cost: { input, output, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		});

		let feedRows = [makeRow(1, 3)];
		t.mock.method(globalThis, "fetch", async (url: URL) => Response.json(url.pathname.endsWith("/openrouter") ? feedRows : []));
		process.env.OPENROUTER_API_KEY = "synthetic-openrouter-key";

		// 20k input + 20k output: $0.08 at $1/$3, $0.18 at $3/$6.
		const raw = piUsage(20_000, 20_000);
		const expectedDispatched = 0.08;

		try {
			assert.equal(await refreshModelCatalog(), "updated");
			const dispatched = piModels().getModel("openrouter", modelSlug)!;
			assert.equal(calculateCost(dispatched, structuredClone(raw)).total, expectedDispatched);

			const release = deferred();

			// 1. Main chat turn held in flight while catalog refreshes.
			const chat = chatStore.createChat("inflight-main");
			chatStore.saveSettings(chat.id, { model: { provider: dispatched.provider, id: dispatched.id } });
			const req = new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "Hello", id: "u_inflight_1" } }),
			});
			const turnRes = await handleChatRequest(req, (opts) =>
				createProberAgent(
					{ chatId: chat.id, chatStore, jobStore, spawn: () => {}, deliver: async () => {} },
					{ ...opts, engine: { model: dispatched, streamFn: fixedStream(dispatched, raw, [{ type: "text", text: "Hi!" }], "stop", release.promise) } },
				),
			);
			assert.equal(turnRes.status, 200);
			const turnHandle = runningTurn(chat.id);
			assert.ok(turnHandle);

			// 2. Sub-agent job held in flight.
			const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_inflight", input: { question: "q" } });
			const runner = createJobRunner({
				chatStore,
				jobStore,
				deliver: async () => {},
				engineFor: () => ({ model: dispatched, streamFn: fixedStream(dispatched, raw, [{ type: "text", text: "Brief." }], "stop", release.promise) }),
			});
			const jobPromise = runner.runJob(job.id);

			// 3. Plugin worker wired through createPluginInference held in flight.
			const pluginDir = path.join(scratch, "inflight-plugin");
			const pluginAc = new AbortController();
			const dispatchedSignal = deferred();
			const pluginInference = createPluginInference({ signal: pluginAc.signal, dataDirectory: pluginDir }, {
				catalog: () => ({
					models: [{ provider: dispatched.provider, id: dispatched.id, name: dispatched.name, reasoning: false, input: ["text"], supportedLevels: ["off"], cost: dispatched.cost, contextWindow: 128_000, maxTokens: 4_096 }],
					providers: [{ id: dispatched.provider, envVar: "OPENROUTER_API_KEY", keyPresent: true }],
					defaults: null,
					rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null, sideQuestion: null },
					slots: { strong: null, cheap: null, vision: null },
				}),
				providerKeyPresent: () => true,
				engineForSpec: (pin) => {
					const current = piModels().getModel(pin.provider, pin.id)!;
					return {
						model: current,
						streamFn: () => {
							dispatchedSignal.resolve();
							return fixedStream(current, raw, [{ type: "toolCall", id: "sub_inflight", name: "submit_result", arguments: { result: { ok: true } } }], "toolUse", release.promise)();
						},
					};
				},
			});
			const workers = createPluginWorkerService({
				store: createPluginTaskRecordStore(path.join(pluginDir, "tasks")),
				engineFor: pluginInference.engineFor,
				onUsage: pluginInference.onUsage,
				signal: pluginAc.signal,
			});
			workers.register({
				id: "inflight-worker",
				instructions: "Submit.",
				resultSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
			});
			const workerTask = workers.start("inflight-worker", { prompt: "go", input: {}, model: { provider: dispatched.provider, id: dispatched.id }, requestId: "req_inflight_1", purpose: "background" });
			await dispatchedSignal.promise;

			// Refresh the catalog while all three calls are in flight.
			feedRows = [makeRow(3, 6)];
			assert.equal(await refreshModelCatalog(), "updated");
			const updated = piModels().getModel("openrouter", modelSlug)!;
			const refreshedPrice = calculateCost(updated, structuredClone(raw)).total;
			assert.ok(Math.abs(refreshedPrice - 0.18) < 1e-12);

			// Release the in-flight calls and await settlement.
			release.resolve();
			await piTurnResponse(turnHandle).text();
			await jobPromise;
			const workerOutcome = await workers.wait(workerTask.id);
			assert.equal(workerOutcome.status, "succeeded");
			pluginAc.abort();

			// Every in-flight call must store the dispatched price ($0.08), never the refreshed price ($0.18).
			const savedTurn = chatStore.getChat(chat.id)!.turns!.at(-1)!;
			assert.equal(savedTurn.steps[0]!.costUsd, expectedDispatched);
			assert.equal(sessionCost(chatStore.getChat(chat.id)!).cost, expectedDispatched);

			const savedJob = jobStore.getJob(job.id)!;
			assert.equal(savedJob.usage?.calls?.[0]?.costUsd, expectedDispatched);
			assert.equal(jobCost(savedJob), expectedDispatched);

			const savedWorker = workers.get(workerTask.id);
			assert.equal(savedWorker.usage?.calls?.[0]?.costUsd, expectedDispatched);
			assert.equal(jobCost({ usage: savedWorker.usage }), expectedDispatched);

			// A fresh call dispatched after the refresh records the refreshed price ($0.18).
			assert.equal(captureCallUsage(raw, updated).costUsd, refreshedPrice);
			assert.equal(callCost({ inputTokens: raw.input, outputTokens: raw.output }, modelId), refreshedPrice);
		} finally {
			setModelCatalogOverlay(new Map());
			delete process.env.OPENROUTER_API_KEY;
		}
	});

	it("captures costUsd across real main turns, sub-agent jobs, compaction, side-chat, extraction pipeline (chat + notes + image) and plugin workers", async (t) => {
		const model = piModels().getModel("openrouter", "openai/gpt-6.1-sol")!;
		const modelId = `${model.provider}:${model.id}`;
		const raw = piUsage(10_000, 1_000, { cacheRead: 70_000 });
		const expected = calculateCost(model, structuredClone(raw)).total;
		const visionModel: Model<Api> = { ...model, input: ["text", "image"] };

		// 1. Main chat turn (handleChatRequest) records costUsd on its turn step.
		process.env.OPENROUTER_API_KEY = "synthetic-openrouter-key";
		try {
			const mainChat = chatStore.createChat("main-turn-cost");
			chatStore.saveSettings(mainChat.id, { model: { provider: model.provider, id: model.id } });
			const req = new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chatId: mainChat.id, input: { type: "text", text: "Hello", id: "u_main_1" } }),
			});
			const res = await handleChatRequest(req, (opts) => createProberAgent({ chatId: mainChat.id, chatStore, jobStore, spawn: () => {}, deliver: async () => {} }, { ...opts, engine: { model, streamFn: fixedStream(model, raw, [{ type: "text", text: "Hi!" }]) } }));
			assert.equal(res.status, 200);
			const handle = runningTurn(mainChat.id);
			if (handle) await piTurnResponse(handle).text();
			const mainTurn = chatStore.getChat(mainChat.id)!.turns!.at(-1)!;
			assert.equal(mainTurn.model, modelId);
			assert.equal(mainTurn.steps[0]!.costUsd, expected);

			// 2. Sub-agent job runner records costUsd on its job calls.
			const jobChat = chatStore.createChat("job-runner-cost");
			const job = jobStore.createJob({ kind: "research", chatId: jobChat.id, toolCallId: "tc_runner", input: { question: "q" } });
			const runner = createJobRunner({
				chatStore,
				jobStore,
				deliver: async () => {},
				engineFor: () => ({ model, streamFn: fixedStream(model, raw, [{ type: "text", text: "Researched brief." }]) }),
			});
			await runner.runJob(job.id);
			const savedJob = jobStore.getJob(job.id)!;
			assert.equal(savedJob.usage?.calls?.[0]?.costUsd, expected);
			assert.equal(jobCost(savedJob), expected);
		} finally {
			delete process.env.OPENROUTER_API_KEY;
		}

		// 3. Compaction records costUsd on its appended turn.
		const compactChat = chatStore.createChat("compaction-cost");
		const big = (label: string) => newUserMessage(`${label}: ${"x".repeat(100 * 1024)}`);
		chatStore.saveMessages(compactChat.id, [big("a"), big("b"), big("c"), newUserMessage("recent")]);
		await ensureCompacted({
			chatStore,
			engine: { model } as never,
			modelId,
			kind: "teach",
			thresholdTokens: 1_000,
			systemPromptTokens: 100,
			summarize: async () => ({ summary: "Summary text.", usage: structuredClone(raw) }),
		}, compactChat.id);
		assert.equal(chatStore.getChat(compactChat.id)!.turns!.at(-1)!.steps[0]!.costUsd, expected);

		// 4. Side-chat records costUsd on its appended turn.
		const sideChat = chatStore.createChat("side-cost");
		const anchorMsg = { ...fauxAssistantMessage("First paragraph of explanation."), id: "msg_side_anchor" };
		chatStore.saveMessages(sideChat.id, [newUserMessage("teach me"), anchorMsg as never]);
		const faux = createFauxCore({});
		faux.setResponses([() => ({ ...fauxAssistantMessage("Short side answer."), usage: structuredClone(raw) })]);
		const sideService = createSideChatService({
			chatStore,
			instructions: () => "Be concise.",
			engineFor: async () => ({ model, streamFn: faux.streamSimple }),
		});
		const askRes = await sideService.ask(sideChat.id, {
			text: "why?",
			quotes: [],
			anchor: { messageId: anchorMsg.id, partId: `${anchorMsg.id}-t0`, blockIndex: 0, blockText: "First paragraph of explanation." },
		});
		assert.equal(askRes.status, 200);
		await askRes.text();
		const sideStep = chatStore.getChat(sideChat.id)!.turns!.at(-1)!.steps[0]!;
		assert.ok(typeof sideStep.costUsd === "number" && sideStep.costUsd > 0);
		assert.equal(sideStep.costUsd, callCost({ ...sideStep, costUsd: undefined }, modelId));

		// 5. Real extraction pipeline: chat extraction (extractor + auditor) and notes+image import (imageReader + notesExtractor + auditor).
		const extChat = chatStore.createChat("real-extraction-chat");
		const teachMsg = {
			role: "assistant" as const,
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text" as const, text: "A bounded monotone sequence converges." }],
			stopReason: "stop" as const,
			timestamp: Date.now(),
			usage: structuredClone(raw),
			id: "msg_teach_extract",
		};
		chatStore.saveMessages(extChat.id, [newUserMessage("Explain monotone convergence"), teachMsg]);
		const chatFindings = { propositions: [{ id: "p1", name: "Monotone convergence", statement: "A bounded monotone sequence converges.", aliases: [], messageId: teachMsg.id }], chains: [] };
		const notesFindings = { propositions: [{ id: "p2", name: "Light reactions", statement: "Light reactions produce ATP.", aliases: [] }], chains: [] };

		// Also verify an in-flight extraction call freezes its dispatched model price across a catalog refresh.
		initializeModelCatalog();
		const route = piModels().getModels("openrouter").find((m) => m.api === "openai-completions")!;
		const extSlug = "test/extraction-inflight";
		let extFeed = [{
			id: extSlug, name: "Extraction Inflight", provider: "openrouter", api: route.api, baseUrl: route.baseUrl,
			input: ["text", "image"], reasoning: false, cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000, maxTokens: 4_096,
		}];
		t.mock.method(globalThis, "fetch", async (url: URL) => Response.json(url.pathname.endsWith("/openrouter") ? extFeed : []));
		process.env.OPENROUTER_API_KEY = "synthetic-openrouter-key";
		try {
			assert.equal(await refreshModelCatalog(), "updated");
			const extDispatched = piModels().getModel("openrouter", extSlug)!;
			const extRaw = piUsage(50_000, 10_000);
			const extExpectedBefore = calculateCost(extDispatched, structuredClone(extRaw)).total; // 0.10 + 0.06 = 0.16
			const extRelease = deferred();

			const chatPipeline = createExtractionPipeline({
				chatStore,
				graphStore,
				extractor: {
					model: extDispatched,
					streamFn: fixedStream(extDispatched, extRaw, [{ type: "toolCall", id: "sf_chat", name: "submit_findings", arguments: chatFindings }], "toolUse", extRelease.promise),
				},
				auditor: {
					model: extDispatched,
					streamFn: fixedStream(extDispatched, extRaw, [{ type: "toolCall", id: "sr_chat", name: "submit_review", arguments: { links: [] } }], "toolUse"),
				},
			});
			const chatExtractPromise = chatPipeline.runExtraction(extChat.id);
			// Refresh the catalog while chat extraction is in flight.
			extFeed = [{ ...extFeed[0]!, cost: { input: 20, output: 60, cacheRead: 0, cacheWrite: 0 } }];
			assert.equal(await refreshModelCatalog(), "updated");
			extRelease.resolve();
			await chatExtractPromise;

			const chatExtRun = chatStore.getChat(extChat.id)!.extractions!.at(-1)!;
			assert.equal(chatExtRun.stages.extractor.steps[0]!.costUsd, extExpectedBefore);
			assert.equal(chatExtRun.stages.auditor.steps[0]!.costUsd, extExpectedBefore);
		} finally {
			setModelCatalogOverlay(new Map());
			delete process.env.OPENROUTER_API_KEY;
		}

		// Notes + image import exercises imageReader, notesExtractor, and auditor call sites.
		const samplePng = fs.readFileSync(path.resolve("tests/fixtures/images/sample.png"));
		const notesPipeline = createExtractionPipeline({
			chatStore,
			graphStore,
			imageReader: { model: visionModel, streamFn: fixedStream(visionModel, raw, [{ type: "text", text: "# Photosynthesis\nLight reactions produce ATP." }]) },
			extractor: { model, streamFn: fixedStream(model, raw, [{ type: "toolCall", id: "sf_notes", name: "submit_findings", arguments: notesFindings }], "toolUse") },
			auditor: { model, streamFn: fixedStream(model, raw, [{ type: "toolCall", id: "sr_notes", name: "submit_review", arguments: { links: [] } }], "toolUse") },
		});
		const notesStats = await notesPipeline.importNotes({
			filePath: "Course/board.png",
			text: "",
			image: { bytes: samplePng, mimeType: "image/png" },
		});
		assert.equal(notesStats.nodes, 1);
		const notesSource = graphStore.readSources().find((s) => s.filePath === "Course/board.png")!;
		const notesRun = notesSource.extractions!.at(-1)!;
		assert.equal(notesRun.stages.imageReader!.steps[0]!.costUsd, expected);
		assert.equal(notesRun.stages.extractor.steps[0]!.costUsd, expected);
		assert.equal(notesRun.stages.auditor.steps[0]!.costUsd, expected);

		// 6. Plugin worker records costUsd in its task usage.
		const taskDir = path.join(scratch, "plugin-worker-tasks");
		const ac = new AbortController();
		const workers = createPluginWorkerService({
			store: createPluginTaskRecordStore(taskDir),
			engineFor: async () => ({
				model,
				streamFn: fixedStream(model, raw, [{ type: "toolCall", id: "submit_1", name: "submit_result", arguments: { result: { ok: true } } }], "toolUse"),
			}),
			signal: ac.signal,
		});
		workers.register({
			id: "priced-worker",
			instructions: "Submit result.",
			resultSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
		});
		const started = workers.start("priced-worker", { prompt: "go", input: {}, model: { provider: model.provider, id: model.id }, requestId: "req_price_1", purpose: "background" });
		const outcome = await workers.wait(started.id);
		assert.equal(outcome.status, "succeeded");
		const savedTask = workers.get(started.id);
		assert.equal(savedTask.usage?.calls?.[0]?.costUsd, expected);
		assert.equal(jobCost({ usage: savedTask.usage }), expected);
		ac.abort();
	});

	it("never freezes $0 placeholder prices or unpriced providers, preserves known free models, and rejects invalid costUsd", () => {
		const raw = piUsage(100_000, 50_000);
		const zeroRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		for (const [provider, id] of [
			["chatgpt", "gpt-5"],
			["github-copilot-subscription", "gpt-5"],
			["claude-code", "sonnet"],
			["custom", "local"],
		] as const) {
			const modelId = `${provider}:${id}`;
			const captured = captureCallUsage(raw, { provider, id, cost: { input: 5, output: 10, cacheRead: 0, cacheWrite: 0 } });
			assert.equal(captured.costUsd, undefined, `${modelId} must not store costUsd`);
			assert.equal(callCost({ ...captured, costUsd: 0 }, modelId), null, `${modelId} must stay unpriced even with stray costUsd`);
		}

		// A $0 placeholder model (not known to be free) must NOT freeze costUsd: 0, so a later catalog price can price it at read time.
		const placeholder = piModels().getModel("openrouter", "openrouter/auto")!;
		assert.ok(placeholder, "bundled $0 router placeholder exists");
		const placeholderId = `${placeholder.provider}:${placeholder.id}`;
		const originalPlaceholderCost = structuredClone(placeholder.cost);
		try {
			const capturedPlaceholder = captureCallUsage(raw, placeholder);
			assert.equal(capturedPlaceholder.costUsd, undefined, "$0 placeholder must leave costUsd absent");
			placeholder.cost.input = 2;
			placeholder.cost.output = 6;
			assert.equal(callCost(capturedPlaceholder, placeholderId), calculateCost(placeholder, structuredClone(raw)).total, "placeholder falls back to read-time lookup once priced");
		} finally {
			Object.assign(placeholder.cost, originalPlaceholderCost);
		}

		// Unknown/faux model with $0 rates omits costUsd and stays unpriced at read time.
		const unknownCaptured = captureCallUsage(raw, { provider: "unknown", id: "model", cost: zeroRates });
		assert.equal(unknownCaptured.costUsd, undefined, "unknown $0 placeholder must not store costUsd");
		assert.equal(callCost(unknownCaptured, "unknown:model"), null, "unknown model without costUsd stays unpriced");

		// Known free API models store costUsd: 0 and stay $0 even if later repriced.
		for (const freeId of ["openrouter/free", "recursive/flint-v1.0:free"]) {
			const freeModel = piModels().getModel("openrouter", freeId)!;
			assert.ok(freeModel, `known free model exists: ${freeId}`);
			const originalCost = structuredClone(freeModel.cost);
			try {
				const captured = captureCallUsage(raw, freeModel);
				assert.equal(captured.costUsd, 0, `${freeId} stores known $0 costUsd`);
				freeModel.cost.input = 5;
				freeModel.cost.output = 10;
				assert.equal(callCost(captured, `openrouter:${freeId}`), 0, `recorded free call on ${freeId} stays $0 after reprice`);
			} finally {
				Object.assign(freeModel.cost, originalCost);
			}
		}

		// Invalid stored costUsd is honestly unpriced (null).
		for (const bad of [-1, -0.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.equal(callCost({ inputTokens: 100, outputTokens: 50, costUsd: bad }, "openai:gpt-5"), null);
		}
	});
});

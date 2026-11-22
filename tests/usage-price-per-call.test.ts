/**
 * Issue #332: per-call costUsd captured at record time so catalog price
 * changes (Pi bump or pi.dev model-list refresh) never rewrite historical
 * usage costs, while older records without costUsd keep falling back to
 * live catalog lookup then RETIRED_MODELS without modifying files on disk.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { calculateCost, createFauxCore, fauxAssistantMessage, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
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
const { callUsage } = await import("../src/agent/subagents/extraction.ts");
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
			// Record a turn, an extraction run (chat + notes), and a job at the original price.
			const chat = chatStore.createChat("price-change-history");
			chatStore.saveMessages(chat.id, [newUserMessage("hello")]);
			const recordedStep = captureCallUsage(raw, modelId);
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
					extractor: { model: modelId, steps: [callUsage(raw, modelId)] },
					auditor: { model: modelId, steps: [callUsage(raw, modelId)] },
				},
			});
			const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_1" });
			const jobUsage = accumulateJobUsage(undefined, modelId, captureJobUsageStep(raw, modelId));
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
			const afterStep = captureCallUsage(raw, modelId);
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
		// 1. Old record without costUsd on a model in RETIRED_MODELS falls back to RETIRED_MODELS.
		const retiredId = "opencode-go:gemini-4-argon-contributor";
		const raw = piUsage(1_000_000, 1_000_000);
		const expectedRetired = calculateCost({ cost: RETIRED_MODELS[retiredId]!.cost } as Parameters<typeof calculateCost>[0], structuredClone(raw)).total;
		const oldRetiredStep = { inputTokens: raw.input, outputTokens: raw.output, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 };
		assert.equal(callCost(oldRetiredStep, retiredId), expectedRetired);

		// 2. Call recorded while a model exists in the catalog keeps its costUsd even after the model disappears completely.
		const base = piModels().getModels("openai")[0]!;
		const transient = {
			...base,
			id: "test-soon-retired",
			name: "Soon retired",
			cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
		};
		const transientId = `openai:${transient.id}`;
		try {
			setModelCatalogOverlay(new Map([["openai", [transient]]]));
			const recorded = captureCallUsage(raw, transientId);
			assert.equal(recorded.costUsd, 8);
			const jobUsage = accumulateJobUsage(undefined, transientId, captureJobUsageStep(raw, transientId));

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
			const call1Refreshed = captureCallUsage(million, `openrouter:${refreshedId}`);
			const call1Returned = captureCallUsage(million, `openrouter:${returnedRetiredId}`);
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

			const call2Refreshed = captureCallUsage(million, `openrouter:${refreshedId}`);
			const call2Returned = captureCallUsage(million, `openrouter:${returnedRetiredId}`);
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

	it("captures costUsd in main turns, sub-agent jobs, compaction, side-chat, notes extraction and plugin workers", async () => {
		const model = piModels().getModel("openrouter", "openai/gpt-6.1-sol")!;
		const modelId = `${model.provider}:${model.id}`;
		const raw = piUsage(10_000, 1_000, { cacheRead: 70_000 });
		const expected = calculateCost(model, structuredClone(raw)).total;
		const fixedStream = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") => () => {
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
			void Promise.resolve().then(() => {
				stream.push({ type: "done", reason: stopReason as "stop" | "toolUse", message: msg });
				stream.end(msg);
			});
			return stream;
		};

		// 0. Main chat turn (handleChatRequest) records costUsd on its turn step.
		process.env.OPENROUTER_API_KEY = "synthetic-openrouter-key";
		try {
			const mainChat = chatStore.createChat("main-turn-cost");
			chatStore.saveSettings(mainChat.id, { model: { provider: model.provider, id: model.id } });
			const req = new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chatId: mainChat.id, input: { type: "text", text: "Hello", id: "u_main_1" } }),
			});
			const res = await handleChatRequest(req, (opts) => createProberAgent({ chatId: mainChat.id, chatStore, jobStore, spawn: () => {}, deliver: async () => {} }, { ...opts, engine: { model, streamFn: fixedStream([{ type: "text", text: "Hi!" }]) } }));
			assert.equal(res.status, 200);
			const handle = runningTurn(mainChat.id);
			if (handle) await piTurnResponse(handle).text();
			const mainTurn = chatStore.getChat(mainChat.id)!.turns!.at(-1)!;
			assert.equal(mainTurn.model, modelId);
			assert.equal(mainTurn.steps[0]!.costUsd, expected);

			// 0b. Sub-agent job runner records costUsd on its job calls.
			const jobChat = chatStore.createChat("job-runner-cost");
			const job = jobStore.createJob({ kind: "research", chatId: jobChat.id, toolCallId: "tc_runner", input: { question: "q" } });
			const runner = createJobRunner({
				chatStore,
				jobStore,
				deliver: async () => {},
				engineFor: () => ({ model, streamFn: fixedStream([{ type: "text", text: "Researched brief." }]) }),
			});
			await runner.runJob(job.id);
			const savedJob = jobStore.getJob(job.id)!;
			assert.equal(savedJob.usage?.calls?.[0]?.costUsd, expected);
			assert.equal(jobCost(savedJob), expected);
		} finally {
			delete process.env.OPENROUTER_API_KEY;
		}

		// 1. Compaction records costUsd on its appended turn.
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

		// 2. Side-chat records costUsd on its appended turn.
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

		// 3. Notes-source extraction stores costUsd via callUsage.
		const srcId = "src_price_test";
		graphStore.upsertSource({ id: srcId, filePath: "/fixture/notes-price.md", importedAt: "2026-11-21T00:00:00.000Z" });
		graphStore.appendSourceUsage(srcId, {
			startedAt: 2001,
			at: "2026-11-21T00:00:02.000Z",
			durationMs: 100,
			stages: {
				extractor: { model: modelId, steps: [callUsage(raw, modelId)] },
				auditor: { model: modelId, steps: [callUsage(raw, modelId)] },
			},
		});
		assert.equal(graphStore.readSources().find((s) => s.id === srcId)!.extractions![0]!.stages.extractor.steps[0]!.costUsd, expected);

		// 4. Plugin worker records costUsd in its task usage.
		const taskDir = path.join(scratch, "plugin-worker-tasks");
		const ac = new AbortController();
		const workers = createPluginWorkerService({
			store: createPluginTaskRecordStore(taskDir),
			engineFor: async () => ({
				model,
				streamFn: () => {
					const stream = new AssistantMessageEventStream();
					const msg: AssistantMessage = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						content: [{ type: "toolCall", id: "submit_1", name: "submit_result", arguments: { result: { ok: true } } }],
						stopReason: "toolUse",
						timestamp: Date.now(),
						usage: structuredClone(raw),
					};
					void Promise.resolve().then(() => {
						stream.push({ type: "done", reason: "toolUse", message: msg });
						stream.end(msg);
					});
					return stream;
				},
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

	it("never stores costUsd for subscriptions, CLI, custom or unknown models, preserves $0 free models, and rejects invalid costUsd", () => {
		const raw = piUsage(100_000, 50_000);
		for (const unpriced of ["chatgpt:gpt-5", "github-copilot-subscription:gpt-5", "claude-code:sonnet", "custom:local"]) {
			const captured = captureCallUsage(raw, unpriced);
			assert.equal(captured.costUsd, undefined, `${unpriced} must not store costUsd`);
			assert.equal(callCost({ ...captured, costUsd: 0 }, unpriced), null, `${unpriced} must stay unpriced even with stray costUsd`);
		}
		const unknownCaptured = captureCallUsage(raw, "unknown:model");
		assert.equal(unknownCaptured.costUsd, undefined, "unknown model must not store costUsd");
		assert.equal(callCost(unknownCaptured, "unknown:model"), null, "unknown model without costUsd stays unpriced");

		// Free API model stores costUsd: 0 and stays $0 even if later repriced.
		const freeModel = piModels().getModels("openrouter").find((m) => m.id.endsWith(":free") && m.cost.input === 0 && m.cost.output === 0);
		assert.ok(freeModel, "a free openrouter model exists");
		const freeId = `openrouter:${freeModel.id}`;
		const originalCost = structuredClone(freeModel.cost);
		try {
			const captured = captureCallUsage(raw, freeId);
			assert.equal(captured.costUsd, 0);
			freeModel.cost.input = 5;
			freeModel.cost.output = 10;
			assert.equal(callCost(captured, freeId), 0, "recorded free call stays $0 after reprice");
		} finally {
			Object.assign(freeModel.cost, originalCost);
		}

		// Invalid stored costUsd is honestly unpriced (null).
		for (const bad of [-1, -0.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.equal(callCost({ inputTokens: 100, outputTokens: 50, costUsd: bad }, "openai:gpt-5"), null);
		}
	});
});

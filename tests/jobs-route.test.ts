/**
 * GET /api/jobs, the lesson-view-v1 route (docs/specs/mobile-beta.md): the
 * phone's helper cards read `{ jobs, turnInFlight }` for one chat. Each job
 * is status only (docs/specs/jobs-payload.md): the route never sends
 * `result`, `input`, `usage`, `delivery` or `plugin.input`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { JobsResponse } from "../src/client-protocol/index.ts";
import type { JobUsage } from "../src/core/contracts.ts";
import { isModelsRefusal, modelsNotConfigured } from "../src/core/settings.ts";

// The seam, before any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-jobs-route-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { jobStore } = await import("../src/store/jobs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { setJobRespawn } = await import("../src/server/jobs.ts");
const { GET } = await import("../app/api/jobs/route.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const get = (query: string) => GET(new Request(`http://localhost/api/jobs${query}`));

const DROPPED = ["result", "input", "usage", "delivery"] as const;
const big = (label: string) => `${label} `.repeat(20_000);
const usage: JobUsage = {
	model: "faux:model", inputTokens: 1200, outputTokens: 300, cacheReadTokens: undefined,
	cacheWriteTokens: undefined, reasoningTokens: undefined, steps: 3,
	calls: Array.from({ length: 50 }, () => ({ inputTokens: 400, outputTokens: 100 }) as never),
};

describe("GET /api/jobs", () => {
	it("lists one chat's jobs with the turn state", async () => {
		const job = jobStore.createJob({ kind: "research", chatId: "chat_a", toolCallId: "call_1", activity: "web_search: sets" });
		jobStore.createJob({ kind: "research", chatId: "chat_b", toolCallId: "call_2" });
		const response = await get("?chatId=chat_a");
		assert.equal(response.status, 200);
		const body = (await response.json()) as JobsResponse;
		assert.deepEqual(Object.keys(body).sort(), ["jobs", "turnInFlight"]);
		assert.equal(body.turnInFlight, false);
		assert.deepEqual(body.jobs.map(({ id, status, activity, toolCallId }) => ({ id, status, activity, toolCallId })),
			[{ id: job.id, status: "running", activity: "web_search: sets", toolCallId: "call_1" }]);
	});

	it("sends each job status only and leaves the stored record full", async () => {
		const chatId = "chat_trim";
		const finished = jobStore.createJob({ kind: "demo", chatId, toolCallId: "call_demo", input: { prompt: big("input") } });
		jobStore.updateJob(finished.id, {
			status: "done", activity: "finished", result: { html: big("result") }, usage,
			delivery: { kind: "result", status: "delivered" }, updatedAt: "2026-11-19T00:00:01.000Z",
		});
		const refusal = `${modelsNotConfigured(["vision"]).error} (role: vision)`;
		const failed = jobStore.createJob({ kind: "visual", chatId, toolCallId: "call_visual" });
		jobStore.updateJob(failed.id, { status: "error", activity: "failed", error: refusal, updatedAt: "2026-11-19T00:00:02.000Z" });
		const plugin = jobStore.createJob({
			kind: "plugin", chatId, toolCallId: "call_plugin", activity: "rendering",
			plugin: { pluginId: "p.example", toolName: "render", workerId: "w1", requestId: "r1", taskId: "t1", label: "Renderer", input: { source: big("plugin") } },
		});
		jobStore.updateJob(plugin.id, { updatedAt: "2026-11-19T00:00:03.000Z" });

		const response = await get(`?chatId=${chatId}`);
		assert.equal(response.status, 200);
		const text = await response.text();
		assert.ok(text.length < 4_000, `response is ${text.length} characters`);
		const { jobs } = JSON.parse(text) as JobsResponse;

		const stored = new Map(jobStore.listJobs(chatId).map((job) => [job.id, job]));
		assert.deepEqual(jobs.map((job) => job.id), [plugin.id, failed.id, finished.id]);
		for (const job of jobs) {
			for (const field of DROPPED) assert.equal(field in job, false, `${job.kind} job sends ${field}`);
			const full = stored.get(job.id)!;
			const { id, kind, toolCallId, status, activity, createdAt, updatedAt } = full;
			assert.deepEqual(
				{ id: job.id, kind: job.kind, chatId: job.chatId, toolCallId: job.toolCallId, status: job.status, activity: job.activity, createdAt: job.createdAt, updatedAt: job.updatedAt },
				{ id, kind, chatId, toolCallId, status, activity, createdAt, updatedAt },
			);
		}
		const [pluginView, failedView, finishedView] = jobs;
		assert.deepEqual(pluginView!.plugin, { pluginId: "p.example", toolName: "render", workerId: "w1", requestId: "r1", taskId: "t1", label: "Renderer" });
		assert.equal("error" in pluginView!, false);
		assert.equal(failedView!.error, refusal, "error is sent whole");
		assert.ok(isModelsRefusal(failedView!.error), "the refusal card still recognizes it");
		assert.equal("plugin" in failedView!, false);
		assert.equal(finishedView!.status, "done");

		// The store still holds every full record.
		assert.deepEqual(stored.get(finished.id)!.result, { html: big("result") });
		assert.deepEqual(stored.get(finished.id)!.input, { prompt: big("input") });
		assert.deepEqual(stored.get(finished.id)!.usage, JSON.parse(JSON.stringify(usage)));
		assert.deepEqual(stored.get(finished.id)!.delivery, { kind: "result", status: "delivered" });
		assert.deepEqual(stored.get(plugin.id)!.plugin?.input, { source: big("plugin") });
	});

	it("still reaches the recovery sweep", async () => {
		// The sweep is off under NODE_ENV=test; lift that for this one read.
		const chat = chatStore.createChat("Sweep fixture");
		const orphan = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call_orphan" });
		const respawned: string[] = [];
		setJobRespawn((jobId) => { respawned.push(jobId); });
		const global = globalThis as { __lhWakePipeline?: { lastSweepAt: number } };
		if (global.__lhWakePipeline) global.__lhWakePipeline.lastSweepAt = 0;
		const env = process.env as Record<string, string | undefined>;
		const previous = env.NODE_ENV;
		env.NODE_ENV = "production";
		let response: Response;
		try {
			response = await get(`?chatId=${chat.id}`);
		} finally {
			env.NODE_ENV = previous;
		}
		assert.equal(response.status, 200);
		assert.deepEqual(respawned, [orphan.id]);
		assert.equal(jobStore.getJob(orphan.id)!.activity, "recovering: re-running");
	});

	it("refuses a missing or malformed chat id", async () => {
		assert.equal((await get("")).status, 400);
		assert.equal((await get("?chatId=../x")).status, 400);
	});
});

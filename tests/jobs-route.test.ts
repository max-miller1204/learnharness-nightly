/**
 * GET /api/jobs, the lesson-view-v1 route (docs/specs/mobile-beta.md): the
 * phone's helper cards read `{ jobs, turnInFlight }` for one chat.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { JobsResponse } from "../src/client-protocol/index.ts";

// The seam, before any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-jobs-route-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { jobStore } = await import("../src/store/jobs.ts");
const { GET } = await import("../app/api/jobs/route.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const get = (query: string) => GET(new Request(`http://localhost/api/jobs${query}`));

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

	it("refuses a missing or malformed chat id", async () => {
		assert.equal((await get("")).status, 400);
		assert.equal((await get("?chatId=../x")).status, 400);
	});
});

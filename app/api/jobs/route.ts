import { isTurnRunning, jobStatusOnly, listJobs, type JobsResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * Job status endpoint (contracts.ts "THE ASYNC PROTOCOL" §4): the chat
 * view's jobs fetch lands here — once on mount, per jobs-changed
 * announcement (the store emits post-write, debounced client-side), and
 * on channel resync (push-architecture S4, 2026-10-02 — the old interval
 * poll is retired). It drives the dispatch cards, the sub-agents panel,
 * and the re-sync when a job settles. `turnInFlight` rides along for the
 * settle logic's idle check.
 *
 * Each job is status only (jobStatusOnly, docs/specs/jobs-payload.md): no
 * `result`, `input`, `usage`, `delivery` or `plugin.input`. Results reach
 * clients through the saved transcript. listJobs still runs the recovery
 * sweep and returns full records; only this response is trimmed.
 */
export async function GET(req: Request) {
	const chatId = new URL(req.url).searchParams.get("chatId");
	if (!chatId) {
		return Response.json({ error: "chatId query parameter is required" }, { status: 400 });
	}
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) {
		return Response.json({ error: "Invalid chatId" }, { status: 400 });
	}
	return Response.json({ jobs: listJobs(chatId).map(jobStatusOnly), turnInFlight: isTurnRunning(chatId) } satisfies JobsResponse);
}

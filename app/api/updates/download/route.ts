/**
 * POST /api/updates/download: download the version a check offered
 * ("available"), the Download button. Waits for a check already running
 * first, and a second request while one downloads joins it. Returns the
 * resulting state: "downloaded", or still "available" with the failure.
 */
import { selfUpdater } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
	const updater = selfUpdater();
	await updater.download();
	return Response.json(updater.state(), { headers: { "Cache-Control": "no-store" } });
}

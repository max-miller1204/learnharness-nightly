/**
 * POST /api/updates/install: apply the downloaded version now, even while
 * agents are working ("Restart" in the UI, `lh update --now`). Checks
 * first when nothing is staged. Returns the resulting state.
 */
import { selfUpdater } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
	const updater = selfUpdater();
	await updater.install();
	return Response.json(updater.state(), { headers: { "Cache-Control": "no-store" } });
}

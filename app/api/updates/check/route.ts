/** POST /api/updates/check: check now. A newer version is offered ("available"), not downloaded. Returns the resulting state. */
import { selfUpdater } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
	const updater = selfUpdater();
	await updater.check();
	return Response.json(updater.state(), { headers: { "Cache-Control": "no-store" } });
}

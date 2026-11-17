/** POST /api/updates/notice/dismiss: hide the rollback notice on every browser of this server. Returns the state. */
import { selfUpdater } from "@/src/server";

export const dynamic = "force-dynamic";

export function POST(): Response {
	const updater = selfUpdater();
	updater.dismissNotice();
	return Response.json(updater.state(), { headers: { "Cache-Control": "no-store" } });
}

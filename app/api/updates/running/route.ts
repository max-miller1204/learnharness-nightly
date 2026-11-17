/**
 * GET /api/updates/running: the work an update restart would interrupt
 * (chat turns, compactions, background jobs, plugin workers, extractions),
 * listed by the install confirm dialog. Served on every build, desktop too.
 */
import { runningWork } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(): Response {
	return Response.json({ items: runningWork() }, { headers: { "Cache-Control": "no-store" } });
}

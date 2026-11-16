/**
 * GET /api/updates: the self-hosted updater's current state (the desktop
 * UpdateState vocabulary plus a message). "disabled" outside self-hosted
 * installs. Clients refetch on the "update-changed" event.
 */
import { selfUpdater } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(): Response {
	return Response.json(selfUpdater().state(), { headers: { "Cache-Control": "no-store" } });
}

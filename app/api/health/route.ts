/**
 * GET /api/health: liveness + version + idle state for the self-hosted
 * launcher's health check and `lh status` (self-hosting plan, A3).
 * Read-only; behind the same browser-only guard as every API route.
 */
import { healthSnapshot } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(): Response {
	return Response.json(healthSnapshot(), { headers: { "Cache-Control": "no-store" } });
}

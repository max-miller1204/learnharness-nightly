/**
 * GET /api/health: liveness + version + idle state for the self-hosted
 * launcher's health check and `lh status` (self-hosting plan, A3).
 * Read-only and public (the launcher calls it without a credential), so update
 * error text is only included for a signed-in or paired caller.
 */
import { authenticate, healthSnapshot } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
	return Response.json(healthSnapshot({ details: authenticate(request).ok }), { headers: { "Cache-Control": "no-store" } });
}

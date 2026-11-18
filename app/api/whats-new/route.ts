/**
 * GET /api/whats-new: the one-time "What's new in X" popup for the running
 * version, or null (docs/specs/t3-style-updates.md, section 6). Per server:
 * the record lives in the data folder. Clients refetch on "whats-new-changed".
 */
import { whatsNew } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(): Response {
	return Response.json(whatsNew(process.env.LH_VERSION ?? ""), { headers: { "Cache-Control": "no-store" } });
}

/**
 * GET /api/graph/costs: the graph view's cost pill, folded from chat and
 * notes-source extraction runs. Thin transport over src/server's graphCosts();
 * the fold itself is pure core (core/cost-summary.ts). Each step uses its
 * record-time costUsd when stored, falling back to Pi catalog lookup on older
 * records.
 *
 * Scope: the graph pipeline only; teaching turns and sub-agent jobs have their
 * own cost channels elsewhere.
 */
import { graphCosts } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(graphCosts());
}

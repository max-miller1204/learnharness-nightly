/**
 * POST /api/graph/import/estimate: the folder-pick estimate shown before Extract files runs
 * (docs/specs/extract-more-types.md, "Estimate endpoint"). The browser sends what it measured;
 * nothing is uploaded or stored.
 */
import { importEstimate } from "@/src/server";
import { validEstimateInput } from "@/lib/notes-import-estimate.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try { body = await request.json(); }
	catch { return Response.json({ error: "Invalid estimate request" }, { status: 400 }); }
	if (!validEstimateInput(body)) return Response.json({ error: "Invalid estimate request" }, { status: 400 });
	return Response.json(importEstimate(body));
}

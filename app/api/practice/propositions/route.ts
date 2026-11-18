import { practicePropositions, type PracticePropositionsResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(): Response {
	return Response.json({ propositions: practicePropositions() } satisfies PracticePropositionsResponse, {
		headers: { "Cache-Control": "private, no-store" },
	});
}

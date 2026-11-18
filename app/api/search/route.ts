import { searchPickerStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(await searchPickerStatus(), { headers: { "Cache-Control": "no-store" } });
}

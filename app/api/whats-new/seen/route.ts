/** POST /api/whats-new/seen { version }: mark What's new seen for this server and tell every open client. */
import { emit } from "@/src/core";
import { writeUpdateRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
	const body: unknown = await request.json().catch(() => null);
	const version = typeof body === "object" && body !== null ? (body as { version?: unknown }).version : undefined;
	if (typeof version !== "string" || version === "" || version !== (process.env.LH_VERSION ?? "")) {
		return Response.json({ error: "version must be the running version" }, { status: 400 });
	}
	writeUpdateRecord({ lastSeenVersion: version });
	emit("whats-new-changed", {});
	return new Response(null, { status: 204 });
}

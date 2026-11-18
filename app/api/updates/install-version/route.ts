/**
 * POST /api/updates/install-version { "version": "<exact nightly>" }: the
 * maintenance request "Update everything" sends (roadmap item 23,
 * docs/specs/desktop-server-list.md). Stages exactly that version from its
 * own release on this server's fixed feed, checks its SHA-256, then asks the
 * launcher for the usual snapshot, trial and rollback. Signed-in or paired
 * callers only, like every /api route (proxy.ts). 200 with the update state
 * once the launcher was asked (or the server already runs it), 409 with the
 * reason when refused, 400 for a malformed body.
 */
import { selfUpdater } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request): Promise<Response> {
	let version: unknown;
	try {
		version = ((await request.json()) as { version?: unknown } | null)?.version;
	} catch { /* answered below */ }
	if (typeof version !== "string" || version.length > 64) return Response.json({ error: "Send the exact version to install." }, { status: 400, headers: NO_STORE });
	const updater = selfUpdater();
	const refused = await updater.installVersion(version);
	if (refused) return Response.json({ error: refused }, { status: 409, headers: NO_STORE });
	return Response.json(updater.state(), { headers: NO_STORE });
}

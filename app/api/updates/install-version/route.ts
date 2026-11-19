/**
 * POST /api/updates/install-version { "version": "<exact nightly>" }: the
 * maintenance request "Update everything" sends (roadmap item 23,
 * docs/specs/desktop-server-list.md). Answers at once: 409 with the reason
 * when refused, 400 for a malformed body, else 202 with the update state while
 * the server stages exactly that version from its own release on its fixed
 * feed, checks its SHA-256 and asks the launcher for the usual snapshot,
 * trial and rollback (`pinned` in GET /api/updates follows it). The same
 * request again is harmless. Signed-in or paired callers only, like every
 * /api route (proxy.ts).
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
	const { refused } = updater.startInstallVersion(version);
	if (refused) return Response.json({ error: refused }, { status: 409, headers: NO_STORE });
	return Response.json(updater.state(), { status: 202, headers: NO_STORE });
}

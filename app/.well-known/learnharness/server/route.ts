/**
 * GET /.well-known/learnharness/server: public server info for separately
 * released clients (docs/specs/client-protocol.md). T3 Code's
 * /.well-known/t3/environment. No credential: a client reads it before
 * pairing, to check the protocol version.
 */
import { serverInfo } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(): Response {
	return Response.json(serverInfo(), { headers: { "Cache-Control": "no-store" } });
}

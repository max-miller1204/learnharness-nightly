/** POST /api/auth/clients/revoke: sign one device out. docs/specs/login-pairing.md */
import { revokeClient } from "@/src/server";

export const dynamic = "force-dynamic";

export const POST = (request: Request) => revokeClient(request);

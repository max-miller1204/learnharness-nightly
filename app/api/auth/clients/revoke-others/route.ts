/** POST /api/auth/clients/revoke-others: sign every other device out. docs/specs/login-pairing.md */
import { revokeOtherClients } from "@/src/server";

export const dynamic = "force-dynamic";

export const POST = (request: Request) => revokeOtherClients(request);

/** GET /api/auth/clients: the signed-in devices. docs/specs/login-pairing.md */
import { listClients } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = (request: Request) => listClients(request);

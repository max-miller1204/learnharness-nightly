/** POST /api/auth/pairing-token: make a one-time pairing code. docs/specs/login-pairing.md */
import { createPairingToken } from "@/src/server";

export const dynamic = "force-dynamic";

export const POST = (request: Request) => createPairingToken(request);

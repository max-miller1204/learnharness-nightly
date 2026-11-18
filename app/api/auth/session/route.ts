/** GET /api/auth/session (public): whether this request is signed in. docs/specs/login-pairing.md */
import { sessionState } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = (request: Request) => sessionState(request);

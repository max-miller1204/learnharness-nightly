/** POST /api/auth/browser-session (public): trade a pairing code for the session cookie. docs/specs/login-pairing.md */
import { browserSession } from "@/src/server";

export const dynamic = "force-dynamic";

export const POST = (request: Request) => browserSession(request);

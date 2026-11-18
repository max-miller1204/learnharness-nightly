/** POST /oauth/token (public): T3-style token exchange for native clients and the desktop shell. docs/specs/login-pairing.md */
import { tokenExchange } from "@/src/server";

export const dynamic = "force-dynamic";

export const POST = (request: Request) => tokenExchange(request);

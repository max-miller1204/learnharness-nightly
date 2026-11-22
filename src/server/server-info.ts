/**
 * The public server-info body (docs/specs/client-protocol.md), T3 Code's
 * /.well-known/t3/environment descriptor cut down to what one backend per
 * person needs. Imported by proxy.ts too, so it stays free of the app's
 * heavier modules.
 */
import { hostname } from "node:os";
import { ATTACHMENT_FOLDERS, ATTACHMENT_UPLOADS, BROWSER_HANDOFF_V1, LESSON_VIEW_V1, PRACTICE_CONTROLS_V1, QUESTION_OPTION_ORDER_V1, SESSION_BASICS_V1, CLIENT_PROTOCOL_VERSION, PROTOCOL_HEADER, PROTOCOL_INCOMPATIBLE, PROTOCOL_QUERY_PARAM, PROTOCOL_ROUTES, type ProtocolIncompatibleResponse, type ServerInfo } from "../client-protocol/index.ts";
import { CREDENTIAL_HEADERS, sessionCookieName } from "./auth.ts";

export function serverInfo(env: Record<string, string | undefined> = process.env): ServerInfo {
	return {
		name: hostname() || "LearnHarness",
		// next.config.ts bakes LH_VERSION in only where the code says
		// process.env.LH_VERSION literally, so that is the fallback.
		version: env.LH_VERSION ?? process.env.LH_VERSION ?? "",
		protocolVersion: CLIENT_PROTOCOL_VERSION,
		auth: {
			required: true,
			bootstrapMethods: env.LH_DESKTOP_SERVER === "1" ? ["one-time-token", "desktop-bootstrap"] : ["one-time-token"],
			sessionMethods: ["browser-session-cookie", "bearer-access-token"],
			sessionCookieName: sessionCookieName(env),
			tokenEndpoint: PROTOCOL_ROUTES.token,
		},
		capabilities: [ATTACHMENT_UPLOADS, ATTACHMENT_FOLDERS, PRACTICE_CONTROLS_V1, BROWSER_HANDOFF_V1, LESSON_VIEW_V1, SESSION_BASICS_V1, QUESTION_OPTION_ORDER_V1],
	};
}

/** The protocol version a request names (header first, then the stream query), if any. */
export function requestedProtocol(request: { headers: Headers; url: string }): string | undefined {
	const header = request.headers.get(PROTOCOL_HEADER);
	if (header !== null) return header.trim();
	const url = new URL(request.url);
	if (url.pathname !== PROTOCOL_ROUTES.events && !/^\/api\/chats\/[^/]+\/stream$/.test(url.pathname)) return undefined;
	return url.searchParams.get(PROTOCOL_QUERY_PARAM) ?? undefined;
}

/** T3's 426 for a client that names another protocol version. Requests that
 * name none (the server's own web UI) are never refused. */
export function protocolRefusal(request: { headers: Headers; url: string }): Response | undefined {
	const requested = requestedProtocol(request);
	if (requested === undefined || requested === String(CLIENT_PROTOCOL_VERSION)) return undefined;
	const body: ProtocolIncompatibleResponse = {
		error: `Update this client to one that supports LearnHarness client protocol ${CLIENT_PROTOCOL_VERSION}.`,
		code: PROTOCOL_INCOMPATIBLE,
		protocolVersion: CLIENT_PROTOCOL_VERSION,
	};
	return Response.json(body, { status: 426, headers: CREDENTIAL_HEADERS });
}

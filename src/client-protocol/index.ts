/**
 * The LearnHarness client protocol (roadmap item 21,
 * docs/specs/client-protocol.md): the contract a client released separately
 * from the server (the Expo phone app, the desktop app pointed at a remote
 * server) codes against. Modeled on T3 Code's packages/contracts (MIT,
 * Copyright (c) 2026 T3 Tools Inc.): its environment descriptor, its
 * ORCHESTRATION_PROTOCOL_VERSION and its compatibility messages.
 *
 * THE RULE. Client and server must speak the same CLIENT_PROTOCOL_VERSION
 * exactly. A change that would break a client built against this file
 * (removing or renaming a field, changing a type, changing a route) bumps
 * the version. A change a client can live without (a new route, a new
 * optional field) adds a capability string instead, and clients hide the
 * feature when the server doesn't list it.
 *
 * Dependency-free at runtime: Node built-ins nowhere, imports are type-only,
 * and the TypeScript is erasable, so any client bundler can import it. The
 * record types are the server's own (src/core), re-exported, so the two
 * can't drift apart. tests/client-protocol.test.ts fingerprints this file,
 * every repo declaration it reaches through the type checker, and the
 * pinned pi versions (the turn stream is pi's event shape): when that test fails,
 * decide bump or capability, then update the recorded fingerprint.
 */
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatKind, ChatListItem, ChatRecord, ImageSnapshot, SessionCoverage } from "../core/contracts/chat.ts";
import type { ServerEvents, ServerEventType } from "../core/events.ts";
import type { ChatInput } from "../core/input-events.ts";
import type { AttachmentReference } from "../core/attachments.ts";
import type { GraphContextPick, LhMessage } from "../core/native-messages.ts";
import type { SessionPricing } from "../core/prices.ts";

export type { AttachmentReference, ChatInput, ChatKind, ChatListItem, ChatRecord, GraphContextPick, ImageSnapshot, LhMessage, ServerEvents, ServerEventType, SessionCoverage, SessionPricing };

// ─── Version ────────────────────────────────────────────────────────────────

/** The protocol this build speaks. Bump only for breaking changes. */
export const CLIENT_PROTOCOL_VERSION = 1;
/** Every protocol request carries the client's version here. */
export const PROTOCOL_HEADER = "x-learnharness-protocol";
/** The same, for streams whose client can't set headers (T3's socket query). */
export const PROTOCOL_QUERY_PARAM = "protocol";
/** The `code` of the 426 answer to a client whose version isn't the server's. */
export const PROTOCOL_INCOMPATIBLE = "protocol_incompatible";

/** 426 body: the server speaks a different protocol than the request named. */
export interface ProtocolIncompatibleResponse {
	error: string;
	code: typeof PROTOCOL_INCOMPATIBLE;
	protocolVersion: number;
}

// ─── Server info ────────────────────────────────────────────────────────────

/** Public, no credential. A client reads it before pairing and on every connect. */
export const ATTACHMENT_UPLOADS = "attachment-uploads-v1";
export const ATTACHMENT_FOLDERS = "attachment-folders-v1";

export const SERVER_INFO_PATH = "/.well-known/learnharness/server";

export type AuthBootstrapMethod = "one-time-token" | "desktop-bootstrap";
export type AuthSessionMethod = "browser-session-cookie" | "bearer-access-token";

export interface ServerInfo {
	/** The server machine's host name. */
	name: string;
	/** The server's release version. */
	version: string;
	protocolVersion: number;
	auth: {
		/** Every data route needs a credential (item 6, no localhost bypass). */
		required: true;
		/** How a client gets its first credential. desktop-bootstrap only on the desktop app's own server. */
		bootstrapMethods: AuthBootstrapMethod[];
		sessionMethods: AuthSessionMethod[];
		/** The browser session cookie's name, `lh_session_<port>`. */
		sessionCookieName: string;
		/** Where a native client trades a pairing code for a bearer token. */
		tokenEndpoint: string;
	};
	/** Additive features available on this server. */
	capabilities: string[];
}

export interface ProtocolMismatch {
	reason: "client-too-old" | "server-too-old";
	/** T3's two messages, for the client to show as they are. */
	message: string;
}

/** Null when this client can talk to the server; otherwise why not. */
export function protocolMismatch(info: Pick<ServerInfo, "name" | "protocolVersion">, clientVersion: number = CLIENT_PROTOCOL_VERSION): ProtocolMismatch | null {
	if (info.protocolVersion === clientVersion) return null;
	return info.protocolVersion > clientVersion
		? { reason: "client-too-old", message: `This app is too old for ${info.name}. Update the app to connect.` }
		: { reason: "server-too-old", message: `${info.name} runs an older LearnHarness. Update LearnHarness on ${info.name} to connect.` };
}

export function hasCapability(info: Pick<ServerInfo, "capabilities">, capability: string): boolean {
	return info.capabilities.includes(capability);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const segment = (value: string) => encodeURIComponent(value);

/** The protocol 1 surface. Every other route is internal and may change freely. */
export const PROTOCOL_ROUTES = {
	serverInfo: SERVER_INFO_PATH,
	/** POST, form-encoded: TokenExchangeRequest -> TokenExchangeResponse. */
	token: "/oauth/token",
	/** GET -> SessionStateResponse. */
	session: "/api/auth/session",
	/** GET -> ChatListResponse; POST CreateChatRequest -> CreateChatResponse. */
	chats: "/api/chats",
	/** GET -> ChatResponse. */
	chat: (chatId: string) => `/api/chats/${segment(chatId)}`,
	/** POST SendRequest -> SendResponse. Then attach to turnStream. */
	send: "/api/chat",
	/** GET, server-sent events: `data: <TurnStreamEvent JSON>` frames, then `data: [DONE]`. */
	turnStream: (chatId: string) => `/api/chats/${segment(chatId)}/stream`,
	/** POST AbortTurnRequest -> AbortTurnResponse. */
	abort: "/api/activity/abort",
	/** GET, server-sent events: `event: <ServerEventType>` + `data: <payload JSON>`; `: ping` every 25 s. */
	events: "/api/events",
	/** attachment-uploads-v1 */
	attachments: "/api/attachments",
	removeAttachment: (id: string) => `/api/attachments/${segment(id)}`,
	/** attachment-folders-v1: POST renews grants for a pending folder's missing files. */
	renewAttachmentFolder: (id: string) => `/api/attachments/${segment(id)}`,
	startWithAttachments: "/api/attachments/start",
	/** GET -> ImageSnapshot. */
	image: (chatId: string, snapshotId: string) => `/api/chats/${segment(chatId)}/images/${segment(snapshotId)}`,
} as const;

// ─── Bodies ─────────────────────────────────────────────────────────────────

/** Most refusals: `{ error }`, sometimes with a machine-readable `code`. */
export interface ErrorResponse {
	error: string;
	code?: string;
}

/** POST /oauth/token, form-encoded (RFC 8693 token exchange, item 6). */
export interface TokenExchangeRequest {
	grant_type: "urn:ietf:params:oauth:grant-type:token-exchange";
	subject_token: string;
	subject_token_type: "urn:learnharness:params:oauth:token-type:pairing-code";
	requested_token_type?: "urn:ietf:params:oauth:token-type:access_token";
	client_label?: string;
	client_device_type?: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
	client_os?: string;
}

/** Paired bearer tokens remain active until revoked. */
export interface TokenExchangeResponse {
	access_token: string;
	issued_token_type: "urn:ietf:params:oauth:token-type:access_token";
	token_type: "Bearer";
}

/** OAuth's error body, status 400 (503 `temporarily_unavailable` when the login store is busy). */
export interface OAuthErrorResponse {
	error: string;
	error_description: string;
}

export type SessionStateResponse =
	| { authenticated: false }
	// Paired sessions omit expiresAt. Launcher sessions still expire.
	| { authenticated: true; sessionId: string; expiresAt?: string };

export interface ChatListResponse {
	chats: ChatListItem[];
}

export interface CreateChatRequest {
	title?: string;
	kind?: "practice";
	graphContext?: { propositions: GraphContextPick[] };
}

export interface CreateChatResponse {
	id: string;
	title: string;
}

/** One session: the record with its messages verbatim, plus live state.
 * Optional keys are absent from the JSON when there is nothing to report. */
export type ChatResponse = Omit<ChatRecord, "imageSnapshots"> & {
	pluginQuestionAvailability?: { questionId: string; status: "available" | "unavailable" } | undefined;
	pluginProblemAvailability?: { problemId: string; status: "available" | "unavailable" } | undefined;
	pricing: SessionPricing;
	/** A turn is running: attach to turnStream to watch it. */
	turnInFlight: boolean;
	turnError?: string;
	compacting: boolean;
	unavailableAttachmentIds?: string[];
	coverage: SessionCoverage | null;
};

export type AttachmentTarget = { draftId: string } | { chatId: string };

export type AttachmentGrantRequest = AttachmentTarget & {
	name: string;
	mimeType: string;
	size: number;
};

export interface AttachmentGrantResponse {
	id: string;
	uploadUrl: string;
	expiresAt: number;
}

/** attachment-folders-v1: one folder, POSTed to `attachments`. Each path is
 * relative to the folder root and excludes `name`. */
export type AttachmentFolderRequest = AttachmentTarget & {
	name: string;
	files: { path: string; mimeType: string; size: number }[];
};

/** `files` lists the files still to PUT, each with its own upload URL. The
 * folder's `id` goes in `attachmentUploadIds` like a file's. */
export interface AttachmentFolderGrantResponse {
	id: string;
	expiresAt: number;
	files: { path: string; uploadUrl: string }[];
}

export interface AttachmentSend {
	attachmentUploadIds: string[];
	sendId: string;
}

export type StartWithAttachmentsRequest = CreateChatRequest & AttachmentSend & { draftId: string };

export interface SendRequest {
	chatId: string;
	input: ChatInput;
	attachmentUploadIds?: string[];
	sendId?: string;
}

/** The turn started (or the input was stored): watch it on turnStream. One
 * exception: an answer that leaves a sibling question open starts no turn
 * and is answered with the turn stream's terminal instead
 * (`text/event-stream`: `{"type":"turn-settled"}`, then `[DONE]`). A few
 * failures (input not saved, side-chat budget) are plain text, not JSON. */
export interface SendResponse {
	ok: true;
}

/** One `data:` frame of the turn stream: a pi agent event (its
 * message_update carries only `message`, the full partial), a loop-level
 * error, or the terminal `turn-settled` when no turn is running (refetch
 * the record). */
export type TurnStreamEvent =
	| AgentEvent
	| { type: "message_update"; message: AgentMessage }
	| { type: "error"; errorText: string }
	| { type: "turn-settled" };

export interface AbortTurnRequest {
	kind: "turn";
	/** The chat ID. */
	id: string;
}

export type AbortTurnResponse = { ok: true } | { ok: false; reason: "not_running" };

/** One frame of the events stream: its `event:` name and `data:` payload. */
export type EventFrame = { [T in ServerEventType]: { event: T; data: ServerEvents[T] } }[ServerEventType];


/** Optional protocol 1 extensions. Check the descriptor before using them. */
export const PRACTICE_CONTROLS_V1 = "practice-controls-v1";
export const BROWSER_HANDOFF_V1 = "browser-handoff-v1";

export const PRACTICE_CONTROL_ROUTES = {
	propositions: "/api/practice/propositions",
	dismiss: (chatId: string) => `/api/chats/${segment(chatId)}/dismiss`,
} as const;

export interface PracticePropositionsResponse {
	propositions: GraphContextPick[];
}

export interface PracticeDismissRequest {
	input: { type: "dismiss-problem"; problemCallId: string };
}

/** 200 when saved, 202 when parked for the active turn's settlement. */
export type PracticeDismissResponse = { ok: true; parked?: true };

export const BROWSER_HANDOFF_ROUTES = {
	/** POST PairingTokenRequest -> PairingTokenResponse. Requires a session. */
	pairingToken: "/api/auth/pairing-token",
	/** A relative browser route, never a client-supplied redirect destination. */
	chat: (chatId: string) => `/chat/${segment(chatId)}`,
	pair: (chatId: string, credential: string) => `/pair#token=${segment(credential)}&chat=${segment(chatId)}`,
} as const;

export interface PairingTokenRequest {
	label?: string;
}

export interface PairingTokenResponse {
	id: string;
	credential: string;
	expiresAt: string;
	label?: string;
	tailscaleOrigin?: string;
}

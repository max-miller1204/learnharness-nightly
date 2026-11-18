import { compactionInFlight, createChat, isTurnRunning, listChats, stores, titleFromPrompt, initialChatSettings, initialGraphContext } from "@/src/server";
import type { ChatListItem } from "@/src/core";
import type { ChatListResponse, CreateChatResponse } from "@/src/server";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats } satisfies ChatListResponse);
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; graphContext?: unknown };
	const title = typeof body.title === "string" ? body.title : "";
	// Practice sessions (owner, 2026-10-04): kind "practice" marks the
	// record — the practice agent + its tools from turn 1, no extraction.
	const kind = body.kind === "practice" ? ("practice" as const) : undefined;
	const chat = createChat(titleFromPrompt(title || "Untitled session"), kind);
	const settings = initialChatSettings();
	if (settings) stores.chatStore.saveSettings(chat.id, settings);
	const graphContext = initialGraphContext(body.graphContext);
	if (graphContext) stores.chatStore.saveMessages(chat.id, [graphContext]);
	return Response.json({ id: chat.id, title: chat.title } satisfies CreateChatResponse);
}

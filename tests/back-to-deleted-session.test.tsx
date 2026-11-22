/**
 * Issue #328: pressing Back after deleting a session (single Delete, folder
 * Delete, or graph source Delete with deleteSessions) must never show a deleted
 * session's cached transcript or 404 its stats request. Deleting drops older
 * entries from Next's client router cache via router.refresh(), SessionGate
 * blocks a cached deleted view from mounting, and Chat refreshes on an external
 * stats 404 so the server's not-found decides without blanking a live session.
 */
import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { installModalDom } from "./modal-dom.ts";
import { AppShell, SidebarProvider } from "../components/sidebar.tsx";
import { ChainTableOverlay } from "../components/chain-table.tsx";
import { ActivityProvider } from "../components/activity-dock.tsx";
import { AppearanceProvider } from "../components/settings/appearance.tsx";
import { PluginsProvider } from "../components/plugins.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import { SessionGate } from "../components/session-gate.tsx";
import { Chat } from "../components/chat.tsx";
import { beginSessionDelete, isSessionDeleted, sessionReadHold } from "../components/session-deletion.ts";
import { DEFAULT_THEME } from "../src/core/themes.ts";
import type { ChatListItem, LhMessage } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
const storage = new Map<string, string>();
Object.assign(globalThis, {
	window: dom.window,
	self: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	Event: dom.window.Event,
	MouseEvent: dom.window.MouseEvent,
	CustomEvent: dom.window.CustomEvent,
	localStorage: {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	},
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
Object.assign(dom.window, {
	location: new URL("http://localhost/"),
	localStorage: globalThis.localStorage,
	ResizeObserver: globalThis.ResizeObserver,
	matchMedia: globalThis.matchMedia,
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
Object.defineProperty(dom.window.HTMLElement.prototype, "getAnimations", { configurable: true, value: () => [] });
// linkedom does not toggle checkbox.checked on click; mirror browser behavior.
const nativeInputClick = dom.window.HTMLInputElement.prototype.click;
dom.window.HTMLInputElement.prototype.click = function () {
	if (this.type === "checkbox") this.checked = !this.checked;
	nativeInputClick.call(this);
};
const restoreModalDom = installModalDom(dom);
after(() => restoreModalDom());

const originalFetch = globalThis.fetch;
const roots: Root[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
	document.body.innerHTML = "";
	storage.clear();
	globalThis.fetch = originalFetch;
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const quietEvents = () => ({ close() {}, onOpen() {}, onEvent() {} });

function makeChatItem(id: string, title: string): ChatListItem {
	return {
		id, title, kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 1, phase: "teach", pendingQuestion: false, pendingProblem: false, busy: false, compacting: false,
	};
}

function makeMessages(text: string): LhMessage[] {
	return [{ id: `u_${text}`, role: "user", content: text, timestamp: 1 }];
}

/** Minimal session view inside SessionGate that hits the real stats endpoint on
 *  mount, so a cached render of a deleted session triggers both a stale
 *  transcript and a 404 stats request unless blocked or cache-evicted. */
function CachedSessionView({ chatId, transcript }: { chatId: string; transcript: string }) {
	React.useEffect(() => {
		void fetch(`/api/chats/${encodeURIComponent(chatId)}?view=stats`);
	}, [chatId]);
	return <div data-testid={`transcript-${chatId}`}>{transcript}</div>;
}

/** Harness that runs the real AppShell + SessionsSidebar + delete dialogs
 *  against a Next-like history stack and client back/forward cache:
 *  - push/replace store visited pages in bfcache
 *  - refresh() invalidates bfcache and re-renders the current route from the server
 *  - back() restores from bfcache on a hit, or calls the server on a miss. */
async function mountShellWithRouter(config: {
	sessions: Map<string, { item: ChatListItem; transcript: string }>;
	folder?: { id: string; name: string; chatIds: string[] };
	initialHistory: string[];
	homeNode?: React.ReactNode;
	onDeleteSources?: (body: { sourceIds?: string[]; deleteSessions?: boolean }) => Response | undefined;
}) {
	const statsRequests: Array<{ url: string; status: number }> = [];
	let refreshCalls = 0;

	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = (init?.method ?? "GET").toUpperCase();
		if (url === "/api/chats") {
			return Response.json({ chats: [...config.sessions.values()].map((s) => s.item) });
		}
		if (url === "/api/graph/sources" && method === "DELETE") {
			const body = JSON.parse(String(init?.body ?? "{}")) as { sourceIds?: string[]; deleteSessions?: boolean };
			const custom = config.onDeleteSources?.(body);
			if (custom) return custom;
			if (body.deleteSessions) {
				for (const id of body.sourceIds ?? []) config.sessions.delete(id);
			}
			return Response.json({
				organization: { version: 1, folders: [], placements: {} },
				sources: [...config.sessions.values()].map((s) => ({ id: s.item.id, kind: "chat", label: s.item.title, createdAt: s.item.createdAt })),
				graphRevision: 3,
			});
		}
		if (url === "/api/graph/sources") {
			const folder = config.folder;
			const existing = folder ? folder.chatIds.filter((id) => config.sessions.has(id)) : [];
			return Response.json({
				organization: {
					version: 1,
					folders: folder && existing.length > 0 ? [{ id: folder.id, name: folder.name, parentId: null, createdAt: "2026-01-01T00:00:00.000Z" }] : [],
					placements: Object.fromEntries(existing.map((id) => [id, { folderId: folder!.id }])),
				},
				sources: [...config.sessions.values()].map((s) => ({ id: s.item.id, kind: "chat", label: s.item.title, createdAt: s.item.createdAt })),
			});
		}
		if (url.startsWith("/api/chats/") && method === "DELETE") {
			const id = url.slice("/api/chats/".length).split("?")[0] ?? "";
			config.sessions.delete(id);
			return Response.json({ ok: true, graphRevision: 1 });
		}
		if (url.startsWith("/api/graph/sources/folders/") && method === "DELETE") {
			const body = JSON.parse(String(init?.body ?? "{}")) as { chatIds?: string[] };
			const deletedChatIds = (body.chatIds ?? []).filter((id) => config.sessions.delete(id));
			return Response.json({ ok: true, deletedChatIds, graphRevision: 2 });
		}
		if (url.includes("?view=stats")) {
			const id = url.slice("/api/chats/".length).split("?")[0] ?? "";
			const ok = config.sessions.has(id);
			const status = ok ? 200 : 404;
			statsRequests.push({ url, status });
			return ok ? Response.json({ turns: [] }) : Response.json({ error: "Not found" }, { status: 404 });
		}
		if (url === "/api/plugins") return Response.json({ plugins: [], directory: "", conflicts: [] });
		if (url === "/api/activity") return Response.json({ jobs: [], turns: [], extractions: [] });
		if (url === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
		if (url === "/api/updates" || url === "/api/whats-new" || url === "/api/settings") {
			return Response.json({});
		}
		return Response.json({});
	}) as typeof fetch;

	const renderServerPage = (path: string): React.ReactNode => {
		if (path === "/") return config.homeNode ?? <div data-testid="home-page">Home</div>;
		if (path.startsWith("/chat/")) {
			const id = path.slice("/chat/".length);
			const session = config.sessions.get(id);
			if (!session) return <div data-testid="not-found-page">404 This page could not be found.</div>;
			return <CachedSessionView key={id} chatId={id} transcript={session.transcript} />;
		}
		return <div data-testid="not-found-page">404 This page could not be found.</div>;
	};

	// Client back/forward cache matching Next.js segment-cache/bfcache.js:
	// every visited entry is keyed by pathname and stamped with bfcacheVersion;
	// router.refresh() increments bfcacheVersion so Back misses the cache.
	let bfcacheVersion = 0;
	const bfcache = new Map<string, { version: number; node: React.ReactNode }>();
	const history = [...config.initialHistory];
	let index = history.length - 1;
	for (const path of history) {
		bfcache.set(path, { version: bfcacheVersion, node: renderServerPage(path) });
	}

	let updateView!: (next: { pathname: string; node: React.ReactNode }) => void;

	const router = {
		bfcacheId: "test",
		push(href: string) {
			history.splice(index + 1);
			history.push(href);
			index = history.length - 1;
			const node = renderServerPage(href);
			bfcache.set(href, { version: bfcacheVersion, node });
			updateView({ pathname: href, node });
		},
		replace(href: string) {
			history[index] = href;
			const node = renderServerPage(href);
			bfcache.set(href, { version: bfcacheVersion, node });
			updateView({ pathname: href, node });
		},
		refresh() {
			refreshCalls++;
			bfcacheVersion++;
			const current = history[index]!;
			const node = renderServerPage(current);
			bfcache.set(current, { version: bfcacheVersion, node });
			updateView({ pathname: current, node });
		},
		back() {
			if (index <= 0) return;
			index--;
			const target = history[index]!;
			const cached = bfcache.get(target);
			const node = cached && cached.version === bfcacheVersion ? cached.node : renderServerPage(target);
			if (!cached || cached.version !== bfcacheVersion) bfcache.set(target, { version: bfcacheVersion, node });
			updateView({ pathname: target, node });
		},
		forward() {},
		hmrRefresh() {},
		async prefetch() {},
	};

	function Harness() {
		const initialPath = history[index]!;
		const [view, setView] = useState<{ pathname: string; node: React.ReactNode }>(() => ({
			pathname: initialPath,
			node: bfcache.get(initialPath)!.node,
		}));
		updateView = setView;
		return (
			<AppRouterContext.Provider value={router}>
			<PathnameContext.Provider value={view.pathname}>
			<ServerEventsProvider connect={quietEvents}>
				<PluginsProvider>
					<AppearanceProvider initialAppearance={undefined} initialTheme={DEFAULT_THEME}>
						<SidebarProvider>
							<ActivityProvider>
								<AppShell>{view.node}</AppShell>
							</ActivityProvider>
						</SidebarProvider>
					</AppearanceProvider>
				</PluginsProvider>
			</ServerEventsProvider>
			</PathnameContext.Provider>
			</AppRouterContext.Provider>
		);
	}

	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => { root.render(<Harness />); });
	await flush();

	return {
		router,
		get history() { return [...history]; },
		get pathname() { return history[index]; },
		get refreshCalls() { return refreshCalls; },
		statsRequests,
		back: async () => { await act(async () => { router.back(); }); await flush(); },
	};
}

describe("Back to a deleted session (#328)", () => {
	it("folder Delete while viewing B invalidates the router cache so Back to A renders not-found, not A's transcript", async () => {
		const sessions = new Map([
			["chat_folder_back_a", { item: makeChatItem("chat_folder_back_a", "Session A"), transcript: "Secret transcript of A" }],
			["chat_folder_back_b", { item: makeChatItem("chat_folder_back_b", "Session B"), transcript: "Transcript of B" }],
		]);
		const app = await mountShellWithRouter({
			sessions,
			folder: { id: "folder_ab", name: "Unit 1", chatIds: ["chat_folder_back_a", "chat_folder_back_b"] },
			initialHistory: ["/", "/chat/chat_folder_back_a", "/chat/chat_folder_back_b"],
		});

		assert.ok(document.querySelector("[data-testid='transcript-chat_folder_back_b']"), "starts on session B");

		// Right-click folder -> Delete -> confirm
		const folderBtn = document.querySelector<HTMLElement>("[data-testid='sidebar-folder-folder_ab']");
		assert.ok(folderBtn, "folder row rendered");
		await act(async () => { folderBtn.dispatchEvent(new Event("contextmenu", { bubbles: true, cancelable: true })); });
		await flush();
		const delMenuItem = document.querySelector<HTMLElement>("[data-testid='folder-ctx-delete']");
		assert.ok(delMenuItem, "folder context menu Delete");
		await act(async () => { delMenuItem.click(); });
		await flush();
		const confirm = document.querySelector<HTMLElement>("[data-testid='delete-confirm']");
		assert.ok(confirm, "folder delete confirm button");
		await act(async () => { confirm.click(); });
		await flush();

		assert.equal(app.pathname, "/", "deleting while viewing B replaces with home");
		assert.deepEqual(app.history, ["/", "/chat/chat_folder_back_a", "/"], "B's history entry was replaced, not pushed");
		assert.ok(app.refreshCalls >= 1, "folder Delete calls router.refresh() to drop bfcache entries");

		// Press Back -> older history entry for session A
		const statsBeforeBack = app.statsRequests.length;
		await app.back();

		assert.equal(app.pathname, "/chat/chat_folder_back_a");
		assert.equal(document.querySelector("[data-testid='transcript-chat_folder_back_a']"), null, "A's stale transcript must not render");
		assert.ok(document.querySelector("[data-testid='not-found-page']"), "shows normal not-found state");
		assert.deepEqual(app.statsRequests.slice(statsBeforeBack), [], "no 404 stats request for A");
	});

	it("single-session Delete of A while viewing B invalidates the router cache so Back to A renders not-found", async () => {
		const sessions = new Map([
			["chat_single_back_a", { item: makeChatItem("chat_single_back_a", "Session A"), transcript: "Stale transcript of A" }],
			["chat_single_back_b", { item: makeChatItem("chat_single_back_b", "Session B"), transcript: "Transcript of B" }],
		]);
		const app = await mountShellWithRouter({
			sessions,
			initialHistory: ["/", "/chat/chat_single_back_a", "/chat/chat_single_back_b"],
		});

		const rowA = document.querySelector<HTMLElement>("[data-session-id='chat_single_back_a']");
		assert.ok(rowA, "session A row rendered");
		await act(async () => { rowA.dispatchEvent(new Event("contextmenu", { bubbles: true, cancelable: true })); });
		await flush();
		const delMenuItem = document.querySelector<HTMLElement>("[data-testid='ctx-delete']");
		assert.ok(delMenuItem, "session context menu Delete");
		await act(async () => { delMenuItem.click(); });
		await flush();
		const confirm = document.querySelector<HTMLElement>("[data-testid='delete-confirm']");
		assert.ok(confirm, "session delete confirm button");
		await act(async () => { confirm.click(); });
		await flush();

		assert.equal(app.pathname, "/chat/chat_single_back_b", "stays on B when deleting A");
		assert.ok(app.refreshCalls >= 1, "single-session Delete calls router.refresh() to drop bfcache entries");

		const statsBeforeBack = app.statsRequests.length;
		await app.back();

		assert.equal(app.pathname, "/chat/chat_single_back_a");
		assert.equal(document.querySelector("[data-testid='transcript-chat_single_back_a']"), null, "A's stale transcript must not render");
		assert.ok(document.querySelector("[data-testid='not-found-page']"), "shows normal not-found state");
		assert.deepEqual(app.statsRequests.slice(statsBeforeBack), [], "no 404 stats request for A");
	});

	it("single-session Delete of A while viewing A replaces current entry and invalidates older A in history", async () => {
		const sessions = new Map([
			["chat_revisited_a", { item: makeChatItem("chat_revisited_a", "Session A"), transcript: "Old transcript of A" }],
			["chat_revisited_b", { item: makeChatItem("chat_revisited_b", "Session B"), transcript: "Transcript of B" }],
		]);
		const app = await mountShellWithRouter({
			sessions,
			initialHistory: ["/", "/chat/chat_revisited_a", "/chat/chat_revisited_b", "/chat/chat_revisited_a"],
		});

		const rowA = document.querySelector<HTMLElement>("[data-session-id='chat_revisited_a']");
		assert.ok(rowA, "session A row rendered");
		await act(async () => { rowA.dispatchEvent(new Event("contextmenu", { bubbles: true, cancelable: true })); });
		await flush();
		await act(async () => { document.querySelector<HTMLElement>("[data-testid='ctx-delete']")?.click(); });
		await flush();
		await act(async () => { document.querySelector<HTMLElement>("[data-testid='delete-confirm']")?.click(); });
		await flush();

		assert.equal(app.pathname, "/", "current entry replaced with home");
		assert.deepEqual(app.history, ["/", "/chat/chat_revisited_a", "/chat/chat_revisited_b", "/"]);

		await app.back();
		assert.equal(app.pathname, "/chat/chat_revisited_b", "first Back lands on surviving session B");
		assert.ok(document.querySelector("[data-testid='transcript-chat_revisited_b']"), "B still renders");

		const statsBeforeSecondBack = app.statsRequests.length;
		await app.back();
		assert.equal(app.pathname, "/chat/chat_revisited_a", "second Back lands on older deleted A");
		assert.equal(document.querySelector("[data-testid='transcript-chat_revisited_a']"), null, "older A transcript never renders");
		assert.ok(document.querySelector("[data-testid='not-found-page']"), "older A shows not-found");
		assert.deepEqual(app.statsRequests.slice(statsBeforeSecondBack), [], "no 404 stats request for older A");
	});

	it("graph source Delete with deleteSessions marks deleted sessions and refreshes so Back to A renders not-found", async () => {
		const id = "chat_graph_source_a";
		const sessions = new Map([
			[id, { item: makeChatItem(id, "Graph Session A"), transcript: "Transcript of graph A" }],
		]);
		const app = await mountShellWithRouter({
			sessions,
			initialHistory: [`/chat/${id}`, "/"],
			homeNode: <ChainTableOverlay open nodes={[]} chains={[]} sessions={{ [id]: "Graph Session A" }} fileSources={{}} onClose={() => {}} />,
		});

		const rowBox = document.querySelector<HTMLElement>(`[data-testid='cluster-checkbox-${id}']`);
		assert.ok(rowBox, "source row checkbox rendered in ChainTableOverlay");
		await act(async () => { rowBox.click(); });
		await flush();
		await act(async () => { document.querySelector<HTMLElement>("[data-testid='chain-delete']")?.click(); });
		await flush();
		const delSessionsBox = document.querySelector<HTMLInputElement>("[data-testid='delete-source-sessions']");
		assert.ok(delSessionsBox, "deleteSessions checkbox rendered");
		await act(async () => { delSessionsBox.click(); });
		await flush();
		await act(async () => { document.querySelector<HTMLElement>("[data-testid='source-delete-confirm']")?.click(); });
		await flush();

		assert.equal(isSessionDeleted(id), true, "deleted session is marked via beginSessionDeletes");
		assert.ok(app.refreshCalls >= 1, "graph source delete with deleteSessions refreshes the router cache");

		const statsBeforeBack = app.statsRequests.length;
		await app.back();
		assert.equal(app.pathname, `/chat/${id}`);
		assert.equal(document.querySelector(`[data-testid='transcript-${id}']`), null, "A's stale transcript must not render");
		assert.ok(document.querySelector("[data-testid='not-found-page']"), "shows normal not-found state");
		assert.deepEqual(app.statsRequests.slice(statsBeforeBack), [], "no 404 stats request for A");
	});

	it("graph source Delete with a truncated OK body keeps the view alive, does not guess deleted ids, and refreshes so Back hits the server", async () => {
		const id = "chat_graph_truncated_a";
		const keptId = "chat_graph_truncated_b";
		const sessions = new Map([
			[id, { item: makeChatItem(id, "Truncated A"), transcript: "Transcript of truncated A" }],
			[keptId, { item: makeChatItem(keptId, "Truncated B"), transcript: "Transcript of truncated B" }],
		]);
		const app = await mountShellWithRouter({
			sessions,
			initialHistory: [`/chat/${id}`, "/"],
			homeNode: <ChainTableOverlay open nodes={[]} chains={[]} sessions={{ [id]: "Truncated A", [keptId]: "Truncated B" }} fileSources={{}} onClose={() => {}} />,
			onDeleteSources: (body) => {
				if (body.deleteSessions) sessions.delete(id);
				return new Response('{"sources": [', { status: 200, headers: { "Content-Type": "application/json" } });
			},
		});

		await act(async () => { document.querySelector<HTMLElement>(`[data-testid='cluster-checkbox-${id}']`)?.click(); });
		await flush();
		await act(async () => { document.querySelector<HTMLElement>("[data-testid='chain-delete']")?.click(); });
		await flush();
		await act(async () => { document.querySelector<HTMLInputElement>("[data-testid='delete-source-sessions']")?.click(); });
		await flush();
		await act(async () => { document.querySelector<HTMLElement>("[data-testid='source-delete-confirm']")?.click(); });
		await flush();

		assert.ok(document.querySelector(`[data-testid='cluster-checkbox-${keptId}']`), "surviving directory still renders without crashing");
		assert.equal(isSessionDeleted(id), false, "unreadable body does not guess deleted ids client-side");
		assert.equal(sessionReadHold(id), null, "holds are released when the body cannot be read");
		assert.ok(app.refreshCalls >= 1, "refreshes the router cache so the server decides on Back");

		const statsBeforeBack = app.statsRequests.length;
		await app.back();
		assert.equal(app.pathname, `/chat/${id}`);
		assert.equal(document.querySelector(`[data-testid='transcript-${id}']`), null, "deleted A does not show a stale transcript");
		assert.ok(document.querySelector("[data-testid='not-found-page']"), "server renders not-found on Back");
		assert.deepEqual(app.statsRequests.slice(statsBeforeBack), [], "no 404 stats request for A");
	});

	it("graph source Delete partial failure marks and refreshes only the reported deletedChatIds", async () => {
		const goneId = "chat_graph_partial_gone";
		const keptId = "chat_graph_partial_kept";
		const sessions = new Map([
			[goneId, { item: makeChatItem(goneId, "Partial Gone"), transcript: "Transcript of partial gone" }],
			[keptId, { item: makeChatItem(keptId, "Partial Kept"), transcript: "Transcript of partial kept" }],
		]);
		const app = await mountShellWithRouter({
			sessions,
			initialHistory: [`/chat/${goneId}`, "/"],
			homeNode: <ChainTableOverlay open nodes={[]} chains={[]} sessions={{ [goneId]: "Partial Gone", [keptId]: "Partial Kept" }} fileSources={{}} onClose={() => {}} />,
			onDeleteSources: () => {
				sessions.delete(goneId);
				return Response.json({ error: "Could not delete second session.", code: "error", deletedChatIds: [goneId] }, { status: 500 });
			},
		});

		await act(async () => { document.querySelector<HTMLElement>(`[data-testid='cluster-checkbox-${goneId}']`)?.click(); });
		await act(async () => { document.querySelector<HTMLElement>(`[data-testid='cluster-checkbox-${keptId}']`)?.click(); });
		await flush();
		await act(async () => { document.querySelector<HTMLElement>("[data-testid='chain-delete']")?.click(); });
		await flush();
		await act(async () => { document.querySelector<HTMLInputElement>("[data-testid='delete-source-sessions']")?.click(); });
		await flush();
		await act(async () => { document.querySelector<HTMLElement>("[data-testid='source-delete-confirm']")?.click(); });
		await flush();

		assert.equal(isSessionDeleted(goneId), true, "removed session is marked deleted");
		assert.equal(isSessionDeleted(keptId), false, "surviving session is not marked deleted");
		assert.equal(sessionReadHold(keptId), null, "surviving session's reads are released");
		assert.ok(app.refreshCalls >= 1, "partial failure refreshes router cache for deletedChatIds");

		const statsBeforeBack = app.statsRequests.length;
		await app.back();
		assert.equal(app.pathname, `/chat/${goneId}`);
		assert.equal(document.querySelector(`[data-testid='transcript-${goneId}']`), null, "removed session transcript never renders");
		assert.ok(document.querySelector("[data-testid='not-found-page']"), "removed session renders not-found on Back");
		assert.deepEqual(app.statsRequests.slice(statsBeforeBack), [], "no 404 stats request for removed session");
	});

	it("SessionGate renders nothing and calls router.refresh() for a marked id, and renders children for an unmarked id", async () => {
		const deletedId = "chat_gate_deleted";
		const liveId = "chat_gate_live";
		const settle = beginSessionDelete(deletedId);
		settle(true);
		let refreshed = 0;
		const fetched: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			fetched.push(String(input));
			return Response.json({ turns: [] });
		}) as typeof fetch;

		const router = {
			bfcacheId: "test",
			back() {}, forward() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {},
			refresh() { refreshed++; },
		};
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		roots.push(root);

		// Marked (deleted) id: renders nothing, makes no fetches, refreshes router.
		await act(async () => {
			root.render(
				<AppRouterContext.Provider value={router}>
					<SessionGate key={deletedId} chatId={deletedId}>
						<CachedSessionView chatId={deletedId} transcript="Must never mount" />
					</SessionGate>
				</AppRouterContext.Provider>,
			);
		});
		await flush();

		assert.equal(document.querySelector(`[data-testid='transcript-${deletedId}']`), null, "cached transcript never mounted");
		assert.deepEqual(fetched, [], "no API fetches ran for the deleted session");
		assert.equal(refreshed, 1, "SessionGate asks Next to refresh into not-found");

		// Unmarked (live) id: renders children normally and does not refresh.
		await act(async () => {
			root.render(
				<AppRouterContext.Provider value={router}>
					<SessionGate key={liveId} chatId={liveId}>
						<CachedSessionView chatId={liveId} transcript="Live transcript" />
					</SessionGate>
				</AppRouterContext.Provider>,
			);
		});
		await flush();

		assert.equal(document.querySelector(`[data-testid='transcript-${liveId}']`)?.textContent, "Live transcript", "unmarked session renders its children");
		assert.equal(refreshed, 1, "unmarked session does not trigger router.refresh()");
	});

	it("a transient stats 404 followed by 200 refreshes without marking or blanking a live session", async () => {
		const id = "chat_transient_404";
		let statsCalls = 0;
		let refreshed = 0;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === `/api/chats/${id}?view=stats`) {
				statsCalls++;
				if (statsCalls === 1) return Response.json({ error: "Not found" }, { status: 404 });
				return Response.json({ turns: [] });
			}
			if (url === "/api/plugins") return Response.json({ plugins: [], directory: "", conflicts: [] });
			if (url === "/api/activity") return Response.json({ jobs: [], turns: [], extractions: [] });
			if (url === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
			if (url === "/api/settings") return Response.json({});
			if (url === `/api/chats/${id}/side-chats`) return Response.json({ threads: [] });
			if (url === `/api/jobs?chatId=${id}`) return Response.json({ jobs: [], turnInFlight: false });
			return Response.json({});
		}) as typeof fetch;

		const router = {
			bfcacheId: "test",
			back() {}, forward() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {},
			refresh() { refreshed++; },
		};
		const renderChat = (key: string) => (
			<AppRouterContext.Provider value={router}>
			<PathnameContext.Provider value={`/chat/${id}`}>
			<ServerEventsProvider connect={quietEvents}>
				<PluginsProvider>
					<AppearanceProvider initialAppearance={undefined} initialTheme={DEFAULT_THEME}>
						<SidebarProvider>
							<ActivityProvider>
								<InteractionLayersProvider>
									<SettingsDialogProvider>
										<SessionGate key={key} chatId={id}>
											<Chat chatId={id} title="Live session" initialMessages={makeMessages("Visible message")} />
										</SessionGate>
									</SettingsDialogProvider>
								</InteractionLayersProvider>
							</ActivityProvider>
						</SidebarProvider>
					</AppearanceProvider>
				</PluginsProvider>
			</ServerEventsProvider>
			</PathnameContext.Provider>
			</AppRouterContext.Provider>
		);
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		roots.push(root);

		await act(async () => { root.render(renderChat("first")); });
		await flush();

		assert.equal(statsCalls, 1, "first stats call returned 404");
		assert.equal(refreshed, 1, "Chat calls router.refresh() so the server decides");
		assert.equal(isSessionDeleted(id), false, "transient 404 never marks the session deleted");
		assert.equal(sessionReadHold(id), null, "later reads are not hung by a deletion hold");
		assert.ok(document.querySelector("[data-session-surface]"), "live session surface stays visible after a single 404");

		// Simulate navigating away and back (remounting through SessionGate) when stats now returns 200.
		await act(async () => { root.render(renderChat("second")); });
		await flush();

		assert.equal(statsCalls, 2, "second stats call ran and returned 200");
		assert.equal(refreshed, 1, "no further refresh after 200");
		assert.ok(document.querySelector("[data-session-surface]"), "session stays visible on subsequent visit");
	});

	it("external delete: a stats 404 refreshes the route so the server renders not-found", async () => {
		const id = "chat_external_deleted";
		let refreshed = 0;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === `/api/chats/${id}?view=stats`) return Response.json({ error: "Not found" }, { status: 404 });
			if (url === "/api/plugins") return Response.json({ plugins: [], directory: "", conflicts: [] });
			if (url === "/api/activity") return Response.json({ jobs: [], turns: [], extractions: [] });
			if (url === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
			if (url === "/api/settings") return Response.json({});
			if (url === `/api/chats/${id}/side-chats`) return Response.json({ threads: [] });
			if (url === `/api/jobs?chatId=${id}`) return Response.json({ jobs: [], turnInFlight: false });
			return Response.json({});
		}) as typeof fetch;

		let setServerFound!: (found: boolean) => void;
		const router = {
			bfcacheId: "test",
			back() {}, forward() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {},
			refresh() {
				refreshed++;
				// Server re-renders /chat/<id>: getChat(id) is null -> notFound().
				setServerFound(false);
			},
		};

		function RouteHost() {
			const [serverFound, updateServerFound] = useState(true);
			setServerFound = updateServerFound;
			return (
				<AppRouterContext.Provider value={router}>
				<PathnameContext.Provider value={`/chat/${id}`}>
				<ServerEventsProvider connect={quietEvents}>
					<PluginsProvider>
						<AppearanceProvider initialAppearance={undefined} initialTheme={DEFAULT_THEME}>
							<SidebarProvider>
								<ActivityProvider>
									<InteractionLayersProvider>
										<SettingsDialogProvider>
											{serverFound ? (
												<SessionGate chatId={id}>
													<Chat chatId={id} title="Externally deleted" initialMessages={makeMessages("Stale message")} />
												</SessionGate>
											) : (
												<div data-testid="not-found-page">404 This page could not be found.</div>
											)}
										</SettingsDialogProvider>
									</InteractionLayersProvider>
								</ActivityProvider>
							</SidebarProvider>
						</AppearanceProvider>
					</PluginsProvider>
				</ServerEventsProvider>
				</PathnameContext.Provider>
				</AppRouterContext.Provider>
			);
		}

		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		roots.push(root);
		await act(async () => { root.render(<RouteHost />); });
		await flush();

		assert.equal(refreshed, 1, "stats 404 triggered router.refresh()");
		assert.equal(document.querySelector("[data-session-surface]"), null, "server refresh replaced stale Chat with not-found");
		assert.ok(document.querySelector("[data-testid='not-found-page']"), "renders server not-found page");
	});
});

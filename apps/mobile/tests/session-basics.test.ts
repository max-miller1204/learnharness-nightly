import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SESSION_BASICS_V1, type ChatListItem } from "../../../src/client-protocol/index.ts";
import { resolveTheme } from "../../../src/core/themes.ts";
import { apiClient } from "../src/protocol.ts";
import { RENAME_EMPTY, deleteFlow, deleteSession, exportFileName, exportFolderName, renameSession, staleExportFolders } from "../src/session-actions.ts";
import { KIND_FILTERS, KIND_FILTER_KEY, emptyListText, menuPressGuard, readKindFilter, sessionActions, shownSessions } from "../src/session-list.ts";
import { freshView, workspaceView } from "../src/workspace-view.ts";

const origin = "https://test.learnharness.example";
const signal = new AbortController().signal;

type Call = { url: string; method: string; body?: string; headers: Record<string, string> };

/** An API client whose server answers each request with the next response. */
function server(...answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const api = apiClient(async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    const answer = answers.shift();
    if (!answer || answer instanceof Error) throw answer ?? new Error("no answer left");
    return answer;
  }, origin, "example-native-token");
  return { api, calls };
}

const chat = (id: string, title: string, kind?: ChatListItem["kind"]) => ({ id, title, kind });

test("search ranks titles by fuzzyScore like the web sidebar, after the kind switch", () => {
  const chats = [
    chat("c1", "Linear algebra basics"),
    chat("c2", "Algebra", "practice"),
    chat("c3", "Intro to algebraic geometry", "teach"),
    chat("c4", "Calculus"),
    chat("c5", "Algebra I"),
    chat("c6", "Algebra II"),
  ];
  const ids = (list: { id: string }[]) => list.map(({ id }) => id);
  // Exact 150, two prefixes 110 in list order, then substrings 73 and 71; Calculus is out.
  assert.deepEqual(ids(shownSessions(chats, "  algebra ", "all")), ["c2", "c5", "c6", "c1", "c3"]);
  assert.deepEqual(ids(shownSessions(chats, "algebra", "teach")), ["c5", "c6", "c1", "c3"]);
  assert.deepEqual(ids(shownSessions(chats, "algebra", "practice")), ["c2"]);
  // An empty query keeps list order; a missing kind reads as teaching.
  assert.deepEqual(ids(shownSessions(chats, " ", "all")), ["c1", "c2", "c3", "c4", "c5", "c6"]);
  assert.deepEqual(ids(shownSessions(chats, "", "teach")), ["c1", "c3", "c4", "c5", "c6"]);
  assert.deepEqual(ids(shownSessions(chats, "geometry calculus", "all")), []);
});

test("the switch reads Teaching, Practice, All and its stored choice is one per phone", () => {
  assert.deepEqual(KIND_FILTERS.map(({ label }) => label), ["Teaching", "Practice", "All"]);
  assert.equal(readKindFilter(null), "all");
  assert.equal(readKindFilter("practice"), "practice");
  assert.equal(readKindFilter("teach"), "teach");
  assert.equal(readKindFilter("Practice"), "all");
  assert.doesNotMatch(KIND_FILTER_KEY, /https?:|bearer/);
});

test("empty states follow the web", () => {
  assert.equal(emptyListText("alg", true), "No sessions match.");
  assert.equal(emptyListText("  ", true), "No sessions yet.");
  assert.equal(emptyListText("", false), "Loading sessions…");
});

test("the long-press menu needs session-basics-v1 and keeps the web's order with Delete last", () => {
  assert.deepEqual(sessionActions({ capabilities: ["lesson-view-v1"] }), []);
  const actions = sessionActions({ capabilities: [SESSION_BASICS_V1] });
  assert.deepEqual(actions.map(({ title }) => title), ["Rename", "Export as Markdown…", "Delete…"]);
  assert.deepEqual(actions.map(({ label }) => label), ["Rename", "Export as Markdown", "Delete"]);
  assert.deepEqual(actions.map(({ destructive }) => !!destructive), [false, false, true]);
});

test("the query survives opening a session and coming back; a new server's workspace starts empty", () => {
  let view = workspaceView(freshView(), { type: "search", query: "alg" });
  for (const page of [{ type: "session", id: "c1" }, { type: "new", kind: "practice" }] as const) {
    view = workspaceView(view, { type: "open", page });
    assert.deepEqual(view.page, page);
    view = workspaceView(view, { type: "back" });
    assert.deepEqual(view, { page: { type: "list" }, query: "alg" });
  }
  // App.tsx mounts a new Workspace for each server connection.
  assert.deepEqual(freshView(), { page: { type: "list" }, query: "" });
});

test("the release after a hold that opened the menu does not open the session", () => {
  const guard = menuPressGuard();
  guard.pressIn();
  assert.equal(guard.released(), true, "a tap opens the session");
  guard.pressIn();
  guard.menuOpened();
  assert.equal(guard.released(), false, "the hold's release leaves the menu up");
  guard.menuClosed();
  guard.pressIn();
  assert.equal(guard.released(), true, "the next tap opens the session again");
  // A screen reader activates without a press-in; a menu dismissed without a release resets too.
  guard.pressIn();
  guard.menuOpened();
  guard.menuClosed();
  assert.equal(guard.released(), true);
});

test("rename sends the trimmed text and keeps the server's title", async () => {
  const { api, calls } = server(Response.json({ title: "Sets, renamed" }));
  assert.deepEqual(await renameSession(api, "chat 1", "Sets", "  Sets, renamed  ", signal), { kind: "renamed", title: "Sets, renamed" });
  assert.deepEqual(calls.map(({ url, method, body }) => ({ url, method, body })), [{ url: `${origin}/api/chats/chat%201`, method: "PUT", body: JSON.stringify({ title: "Sets, renamed" }) }]);
  assert.equal(calls[0]!.headers["Content-Type"], "application/json");
  assert.equal(calls[0]!.headers.Authorization, "Bearer example-native-token");
});

test("a blank or unchanged title sends nothing; a failure shows the server's message", async () => {
  const { api, calls } = server(Response.json({ error: "Not found" }, { status: 404 }), new TypeError("Network request failed"));
  assert.deepEqual(await renameSession(api, "c1", "Sets", "   ", signal), { kind: "failed", message: RENAME_EMPTY });
  assert.equal(RENAME_EMPTY, "Session title cannot be empty.");
  assert.deepEqual(await renameSession(api, "c1", "Sets", " Sets ", signal), { kind: "unchanged" });
  assert.equal(calls.length, 0);
  const missing = await renameSession(api, "c1", "Sets", "Unions", signal);
  assert.equal(missing.kind === "failed" && missing.message, "Not found");
  const offline = await renameSession(api, "c1", "Sets", "Unions", signal);
  assert.equal(offline.kind === "failed" && offline.message, "Couldn't reach the LearnHarness server.");
  assert.equal(calls.length, 2);
});

test("delete sends the mode the checkbox shows at each press, Try again included", async () => {
  const busy = { error: "A turn is running in this session, try again when it finishes", code: "turn_in_flight" };
  const { api, calls } = server(
    Response.json(busy, { status: 409 }),
    Response.json({ error: "The session's extraction is still winding down", code: "extraction_winding_down" }, { status: 503 }),
    Response.json({ ok: true, mode: "delete-nodes", stats: {}, jobsRemoved: 0, graphRevision: 1 }),
  );
  const first = await deleteSession(api, "c1", false, false, signal);
  assert.equal(!first.deleted && first.message, busy.error);
  const second = await deleteSession(api, "c1", false, true, signal);
  assert.equal(!second.deleted && second.message, "The session's extraction is still winding down");
  // The learner checked the box before the last Try again.
  assert.deepEqual(await deleteSession(api, "c1", true, true, signal), { deleted: true });
  assert.deepEqual(calls.map(({ url, method }) => `${method} ${url}`), [
    `DELETE ${origin}/api/chats/c1?mode=preserve-graph`,
    `DELETE ${origin}/api/chats/c1?mode=preserve-graph`,
    `DELETE ${origin}/api/chats/c1?mode=delete-nodes`,
  ]);
});

test("the delete box sends nothing until Delete, then one request at a time with the checkbox's mode", async () => {
  const { api, calls } = server(
    Response.json({ error: "Background jobs are still running in this session", code: "jobs_running" }, { status: 409 }),
    Response.json({ ok: true, mode: "preserve-graph", stats: {}, jobsRemoved: 0, graphRevision: 1 }),
  );
  const states: { traces: boolean; busy: boolean; failure: string }[] = [];
  const box = deleteFlow(api, "c1", (state) => states.push(state));
  box.toggle();
  assert.deepEqual(box.state, { traces: true, busy: false, failure: "" });
  assert.equal(calls.length, 0, "opening the box and ticking the checkbox send nothing");

  const first = box.press(signal);
  assert.equal(box.state.busy, true);
  box.toggle(); // the checkbox is locked while a press is in flight
  assert.equal(await box.press(signal), undefined, "a second press while busy sends nothing");
  const refused = await first;
  assert.equal(refused && !refused.deleted && refused.message, "Background jobs are still running in this session");
  assert.deepEqual(box.state, { traces: true, busy: false, failure: "Background jobs are still running in this session" });

  box.toggle(); // unticked before Try again
  assert.deepEqual(await box.press(signal), { deleted: true });
  assert.deepEqual(calls.map(({ method, url }) => `${method} ${url}`), [
    `DELETE ${origin}/api/chats/c1?mode=delete-nodes`,
    `DELETE ${origin}/api/chats/c1?mode=preserve-graph`,
  ]);
  assert.equal(states.at(-1)!.failure, "", "Try again clears the old message");
});

test("a network failure keeps the box; 404 counts as deleted only on Try again", async () => {
  const { api } = server(
    new TypeError("Network request failed"),
    Response.json({ error: "No such session", code: "not_found" }, { status: 404 }),
    Response.json({ error: "No such session", code: "not_found" }, { status: 404 }),
  );
  const lost = await deleteSession(api, "c1", true, false, signal);
  assert.equal(!lost.deleted && lost.message, "Couldn't reach the LearnHarness server.");
  // The lost answer may have been a success.
  assert.deepEqual(await deleteSession(api, "c1", true, true, signal), { deleted: true });
  const gone = await deleteSession(api, "c2", false, false, signal);
  assert.equal(!gone.deleted && gone.message, "No such session");
});

test("export downloads the server's exact bytes and its file name", async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("# Sets ∪ unions\n\nCafé\n")]);
  const { api, calls } = server(
    new Response(bytes, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": 'attachment; filename="sets-unions.md"' } }),
    Response.json({ error: "Unknown chat" }, { status: 404 }),
  );
  const file = await api.download("/api/chats/c1/markdown", signal);
  assert.deepEqual(file.bytes, bytes);
  assert.equal(exportFileName(file.disposition), "sets-unions.md");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.headers.Authorization, "Bearer example-native-token");
  await assert.rejects(api.download("/api/chats/c9/markdown", signal), { status: 404, message: "Unknown chat" });
});

test("export names are cut to 100 characters before .md", () => {
  const long = "a".repeat(150);
  assert.equal(exportFileName(`attachment; filename="${long}.md"`), "a".repeat(100) + ".md");
  assert.equal(exportFileName('attachment; filename="session.md"'), "session.md");
  assert.equal(exportFileName('attachment; filename=".md"'), "session.md");
  assert.equal(exportFileName(null), "session.md");
  assert.equal(exportFileName('attachment; filename="../x/y.md"'), "..-x-y.md");
});

test("each export gets its own folder, and folders older than a day are removed", () => {
  const now = Date.UTC(2026, 10, 19, 12);
  const fresh = exportFolderName(now - 60_000, "b");
  const old = exportFolderName(now - 25 * 60 * 60 * 1000, "a");
  assert.notEqual(exportFolderName(now, "x"), exportFolderName(now, "y"));
  assert.deepEqual(staleExportFolders([old, fresh, "stray"], now), [old, "stray"]);
});

test("the launch screen follows the phone's setting with the app's palette", () => {
  const config = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")) as { expo: { plugins: unknown[] } };
  const splash = config.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === "expo-splash-screen") as [string, { backgroundColor: string; dark: { backgroundColor: string } }];
  assert.equal(splash[1].backgroundColor, resolveTheme("ivory").colors.background);
  assert.equal(splash[1].dark.backgroundColor, resolveTheme("default").colors.background);
});

test("the Android menu uses the web menu's palette in both themes", () => {
  const config = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")) as { expo: { plugins: unknown[] } };
  const menu = config.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === "./plugins/android-menu-theme.js") as
    [string, Record<"light" | "dark", { surface: string; border: string; text: string }>];
  for (const [mode, theme] of [["light", "ivory"], ["dark", "default"]] as const) {
    const { colors } = resolveTheme(theme);
    assert.deepEqual(menu[1][mode], { surface: colors.surface, border: colors.border, text: colors.text }, mode);
  }
});

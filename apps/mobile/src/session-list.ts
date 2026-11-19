import { SESSION_BASICS_V1, hasCapability, type ChatListItem, type ServerInfo } from "../../../src/client-protocol/index.ts";
import { fuzzyScore } from "../../../src/core/fuzzy.ts";

/** The web sidebar's kind switch (components/sidebar.tsx), in its order. */
export type SessionKindFilter = "teach" | "practice" | "all";
export const KIND_FILTERS: readonly { value: SessionKindFilter; label: string }[] = [
  { value: "teach", label: "Teaching" },
  { value: "practice", label: "Practice" },
  { value: "all", label: "All" },
];

/** One stored choice per phone, for every server. */
export const KIND_FILTER_KEY = "learnharness.session-kind-filter";

export function readKindFilter(stored: string | null | undefined): SessionKindFilter {
  return stored === "teach" || stored === "practice" || stored === "all" ? stored : "all";
}

/** The web sidebar's list: the kind switch, then titles ranked by fuzzyScore.
 *  An empty query keeps list order. */
export function shownSessions<T extends { title: string; kind?: ChatListItem["kind"] }>(chats: readonly T[], query: string, kind: SessionKindFilter): T[] {
  const list = kind === "all" ? [...chats] : chats.filter((chat) => (chat.kind ?? "teach") === kind);
  const q = query.trim();
  if (!q) return list;
  return list
    .map((chat) => ({ chat, score: fuzzyScore(q, chat.title) }))
    .filter((row): row is { chat: T; score: number } => row.score !== null)
    .sort((a, b) => b.score - a.score)
    .map(({ chat }) => chat);
}

export function emptyListText(query: string, loaded: boolean): string {
  if (!loaded) return "Loading sessions…";
  return query.trim() ? "No sessions match." : "No sessions yet.";
}

export type SessionAction = "rename" | "export" | "delete";

/** The long-press menu, in the web's order with Delete last. `label` is the
 *  screen reader action. */
export const SESSION_ACTIONS: readonly { id: SessionAction; title: string; label: string; destructive?: true }[] = [
  { id: "rename", title: "Rename", label: "Rename" },
  { id: "export", title: "Export as Markdown…", label: "Export as Markdown" },
  { id: "delete", title: "Delete…", label: "Delete", destructive: true },
];

/** No menu on a server without the session basics routes. */
export const sessionActions = (info: Pick<ServerInfo, "capabilities">) => hasCapability(info, SESSION_BASICS_V1) ? SESSION_ACTIONS : [];

/** The long-press menu's native view sees the same touch as the row, so the
 *  release after a hold that opened the menu would also open the session.
 *  The menu reports opening while the finger is still down; that press is
 *  then not a tap. */
export function menuPressGuard() {
  let menuShown = false;
  return {
    pressIn() { menuShown = false; },
    menuOpened() { menuShown = true; },
    menuClosed() { menuShown = false; },
    /** True when this press should open the session. */
    released() {
      const tap = !menuShown;
      menuShown = false;
      return tap;
    },
  };
}

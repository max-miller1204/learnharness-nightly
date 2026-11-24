import type { ChatKind } from "../../../src/client-protocol/index.ts";

export type Page = { type: "list" } | { type: "new"; kind: ChatKind } | { type: "session"; id: string; draft?: string; sendDraft?: boolean };

/** One server's workspace: the page on screen and the list's search query.
 *  The query lives beside the page, so opening a session and coming back keeps
 *  it. Each server connection mounts a new workspace (App.tsx keys it by the
 *  connection), which starts from `freshView`. */
export interface WorkspaceView { page: Page; query: string }

/** For the iPhone simulator driver only (docs/specs/ios-simulator-ci.md): AXe's
 *  touches don't reach session rows inside the long-press menu on the simulator,
 *  so the driver's Metro dev bundle sets EXPO_PUBLIC_CI_OPEN_SESSIONS="id,id" and each new
 *  connection opens the next listed session. Only dev bundles read it: a release
 *  or update bundle drops the branch even when the variable is set (CI's Mobile
 *  job exports with it set and checks). */
const ciOpenSessions = __DEV__ ? (process.env.EXPO_PUBLIC_CI_OPEN_SESSIONS ?? "").split(",").filter(Boolean) : [];

export const freshView = (openNext: string[] = ciOpenSessions): WorkspaceView => {
  const id = openNext.shift();
  return { page: id ? { type: "session", id } : { type: "list" }, query: "" };
};

export type ViewAction = { type: "open"; page: Page } | { type: "back" } | { type: "search"; query: string };

export function workspaceView(view: WorkspaceView, action: ViewAction): WorkspaceView {
  switch (action.type) {
    case "open": return { ...view, page: action.page };
    case "back": return { ...view, page: { type: "list" } };
    case "search": return { ...view, query: action.query };
  }
}

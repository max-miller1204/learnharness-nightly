import type { ChatKind } from "../../../src/client-protocol/index.ts";

export type Page = { type: "list" } | { type: "new"; kind: ChatKind } | { type: "session"; id: string; draft?: string; sendDraft?: boolean };

/** One server's workspace: the page on screen and the list's search query.
 *  The query lives beside the page, so opening a session and coming back keeps
 *  it. Each server connection mounts a new workspace (App.tsx keys it by the
 *  connection), which starts from `freshView`. */
export interface WorkspaceView { page: Page; query: string }

export const freshView = (): WorkspaceView => ({ page: { type: "list" }, query: "" });

export type ViewAction = { type: "open"; page: Page } | { type: "back" } | { type: "search"; query: string };

export function workspaceView(view: WorkspaceView, action: ViewAction): WorkspaceView {
  switch (action.type) {
    case "open": return { ...view, page: action.page };
    case "back": return { ...view, page: { type: "list" } };
    case "search": return { ...view, query: action.query };
  }
}

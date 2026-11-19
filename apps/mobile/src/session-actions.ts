import { SESSION_BASICS_ROUTES, type RenameSessionResponse } from "../../../src/client-protocol/index.ts";
import { ApiError, type MobileApi } from "./protocol";
import { errorText } from "./use-session";

export const RENAME_FAILED = "Could not rename session";
export const RENAME_EMPTY = "Session title cannot be empty.";

export type RenameOutcome =
  | { kind: "unchanged" }
  | { kind: "renamed"; title: string }
  | { kind: "failed"; message: string; error?: unknown };

/** The phone sends the trimmed text and keeps the title the server answers with. */
export async function renameSession(api: MobileApi, id: string, current: string, input: string, signal: AbortSignal): Promise<RenameOutcome> {
  const title = input.trim();
  if (!title) return { kind: "failed", message: RENAME_EMPTY };
  if (title === current) return { kind: "unchanged" };
  try {
    const answer = await api.put<RenameSessionResponse>(SESSION_BASICS_ROUTES.rename(id), { title }, signal);
    return { kind: "renamed", title: answer.title };
  } catch (error) {
    return { kind: "failed", message: errorText(error), error };
  }
}

export type DeleteOutcome = { deleted: true } | { deleted: false; message: string; error: unknown };

/** One press of Delete or Try again. The checkbox at that moment picks the
 *  mode. A 404 on Try again counts as deleted: the earlier answer may have
 *  been lost after the server deleted the session. */
export async function deleteSession(api: MobileApi, id: string, traces: boolean, retry: boolean, signal: AbortSignal): Promise<DeleteOutcome> {
  try {
    await api.remove(SESSION_BASICS_ROUTES.remove(id, traces ? "delete-nodes" : "preserve-graph"), signal);
    return { deleted: true };
  } catch (error) {
    if (retry && error instanceof ApiError && error.status === 404) return { deleted: true };
    return { deleted: false, message: errorText(error), error };
  }
}

const EXPORT_NAME_LIMIT = 100;

/** The server's Content-Disposition name, cut to 100 characters before `.md`. */
export function exportFileName(disposition: string | null): string {
  const quoted = disposition?.match(/filename="([^"]*)"/i)?.[1];
  const plain = disposition?.match(/filename=([^;]+)/i)?.[1]?.trim();
  const name = (quoted ?? plain ?? "").replace(/[/\\\0]/g, "-").replace(/\.md$/i, "");
  return (name.slice(0, EXPORT_NAME_LIMIT) || "session") + ".md";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Each export's cache folder starts with its creation time. */
export const exportFolderName = (now: number, unique: string) => `${now}-${unique}`;

/** Export folders older than one day (T3's attachment cache retention). */
export function staleExportFolders(names: readonly string[], now: number): string[] {
  return names.filter((name) => {
    const made = Number(/^(\d+)-/.exec(name)?.[1]);
    return !Number.isFinite(made) || now - made > DAY_MS;
  });
}

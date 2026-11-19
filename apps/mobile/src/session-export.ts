import { uuid } from "expo";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { SESSION_BASICS_ROUTES } from "../../../src/client-protocol/index.ts";
import type { MobileApi } from "./protocol";
import { exportFileName, exportFolderName, staleExportFolders } from "./session-actions";

/** Writes the server's Markdown to its own cache folder and opens the share sheet
 *  (T3, lib/attachmentDownload.ts). Exports older than a day go first. */
export async function shareSessionMarkdown(api: MobileApi, id: string, signal: AbortSignal): Promise<void> {
  const { bytes, disposition } = await api.download(SESSION_BASICS_ROUTES.markdown(id), signal);
  const root = new Directory(Paths.cache, "session-exports");
  root.create({ intermediates: true, idempotent: true });
  const now = Date.now();
  const stale = new Set(staleExportFolders(root.list().map(({ name }) => name), now));
  for (const entry of root.list()) {
    if (stale.has(entry.name)) entry.delete();
  }
  const folder = new Directory(root, exportFolderName(now, uuid.v4()));
  folder.create();
  const file = new File(folder, exportFileName(disposition));
  file.create();
  await file.write(bytes);
  if (signal.aborted) return;
  await Sharing.shareAsync(file.uri, { mimeType: "text/markdown", UTI: "net.daringfireball.markdown", dialogTitle: file.name });
}

// Uploads through attachment-uploads-v1, as the web composer does
// (components/attachment-draft.tsx). No React Native imports, so tests run in Node.
import {
  PROTOCOL_ROUTES, type AttachmentGrantResponse, type AttachmentSend, type AttachmentTarget,
} from "../../../src/client-protocol/index.ts";
import { attachmentLimitError } from "../../../src/core/attachment-limits.ts";
import { ApiError, type MobileApi } from "./protocol";

/** A photo or file on the phone, ready to upload. `size` is exact: the server checks it. */
export interface PickedFile {
  name: string;
  uri: string;
  mimeType: string;
  size: number;
  /** A copy the app made for this pick (a file or a folder), deleted once the file leaves the draft. */
  cleanup?: string;
}

export interface DraftFile extends PickedFile {
  key: string;
  /** `deadline` is the upload start deadline on this phone's clock. */
  grant?: { id: string; uploadUrl: string; deadline: number };
  progress: number;
  ready: boolean;
  error?: string;
  work?: Promise<void>;
  cancel: AbortController;
}

/** Streams one file's bytes with PUT. Resolves with the response, whatever its status. */
export type PutFile = (file: PickedFile, url: string, headers: Record<string, string>,
  progress: (sent: number) => void, signal: AbortSignal) => Promise<{ status: number; body: string }>;

const pad = (value: number) => String(value).padStart(2, "0");

const PHOTO_EXTENSIONS: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" };

/** photo-YYYYMMDD-HHMMSS.jpg (local time); the second photo of one pick adds -2, and so on. */
export function photoName(date: Date, mimeType = "image/jpeg", index = 1): string {
  return `photo-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `${index > 1 ? `-${index}` : ""}${PHOTO_EXTENSIONS[mimeType] ?? ".jpg"}`;
}

const SAME_EXTENSION: Record<string, RegExp> = { "image/jpeg": /\.jpe?g$/i, "image/png": /\.png$/i, "image/gif": /\.gif$/i, "image/webp": /\.webp$/i };

/** One pick's photo names. `mimeType` is the type of the bytes actually
 *  written, which can differ from the source (a HEIC, GIF or WebP photo
 *  re-encoded as JPEG). Camera photos, and Android library photos (whose
 *  names are internal IDs such as "18.jpg"), are timestamped. With
 *  `keepNames` (the iPhone library) a real name stays, with an extension
 *  that matches its bytes. */
export function photoNames(assets: readonly { fileName?: string | null; mimeType: string }[], date: Date, keepNames: boolean): string[] {
  let stamped = 0;
  return assets.map(({ fileName, mimeType }) => {
    if (!keepNames || !fileName) return photoName(date, mimeType, ++stamped);
    const extension = PHOTO_EXTENSIONS[mimeType];
    if (!extension || SAME_EXTENSION[mimeType]!.test(fileName)) return fileName;
    return fileName.replace(/\.[^./]*$/, "") + extension;
  });
}

/** Converts each photo on its own, so one the phone can't decode (Android
 *  has no decoder for 12-bit HEIC) is skipped with a note naming it while the
 *  rest still attach. Every original copy is released, converted or not. */
export async function convertEach<T extends { uri: string; fileName?: string | null }>(assets: readonly T[],
  convert: (asset: T) => Promise<string>, release: (uri: string) => void): Promise<{ converted: T[]; notice?: string }> {
  const converted: T[] = [];
  const failed: string[] = [];
  for (const asset of assets) {
    try {
      converted.push({ ...asset, uri: await convert(asset) });
    } catch {
      failed.push(`${asset.fileName || "A photo"} couldn't be converted on this phone. Attach it from Files instead.`);
    } finally {
      try { release(asset.uri); } catch { /* The system clears its cache too. */ }
    }
  }
  return { converted, ...(failed.length ? { notice: failed.join("\n") } : {}) };
}

/** The server's `expiresAt` on this phone's clock, from the response's Date
 * header. Date has one-second resolution: allow that second. */
export function localDeadline(expiresAt: number, serverDate: string | null, now = Date.now()): number {
  const server = Date.parse(serverDate ?? "");
  return expiresAt - 1000 + (Number.isFinite(server) ? now - server : 0);
}

function uploadFailure(body: string): string {
  try {
    const error = JSON.parse(body)?.error;
    if (typeof error === "string" && error) return error;
  } catch { /* A proxy can answer in plain text. */ }
  return "Upload failed. Try again.";
}

export class AttachmentDraft {
  rows: DraftFile[] = [];
  notice?: string;
  private lastSend: { identity: string; id: string } | null = null;
  private lifetime = new AbortController();
  private opening: string | null = null;

  /** Without `chatId`, the files belong to an opening draft that has no session yet. */
  constructor(private readonly deps: {
    api: MobileApi;
    chatId?: string;
    put: PutFile;
    newId: () => string;
    changed: () => void;
    /** Deletes a pick's `cleanup` copy. */
    release?: (path: string) => void;
    now?: () => number;
  }) {}

  private release(files: readonly PickedFile[]) {
    for (const { cleanup } of files) {
      if (!cleanup) continue;
      try { this.deps.release?.(cleanup); } catch { /* The system clears its cache too. */ }
    }
  }

  /** The opening draft's ID, made on first use. */
  draftId(): string {
    return this.opening ??= this.deps.newId();
  }

  private target(): AttachmentTarget {
    return this.deps.chatId ? { chatId: this.deps.chatId } : { draftId: this.draftId() };
  }

  private live(row: DraftFile) { return this.rows.includes(row) && !this.lifetime.signal.aborted; }
  private now() { return this.deps.now?.() ?? Date.now(); }

  private async discard(id: string) {
    try { await this.deps.api.remove(PROTOCOL_ROUTES.removeAttachment(id), new AbortController().signal); }
    catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
  }

  private async upload(row: DraftFile): Promise<boolean> {
    const { api, put } = this.deps;
    if (!row.grant || row.grant.deadline <= this.now()) {
      if (row.grant) {
        await this.discard(row.grant.id);
        row.grant = undefined;
      }
      if (!this.live(row)) return false;
      const { body, date } = await api.postDated<AttachmentGrantResponse>(PROTOCOL_ROUTES.attachments,
        { ...this.target(), name: row.name, mimeType: row.mimeType, size: row.size }, row.cancel.signal);
      row.grant = { id: body.id, uploadUrl: body.uploadUrl, deadline: localDeadline(body.expiresAt, date, this.now()) };
    }
    if (!this.live(row)) return false;
    const { url, headers } = api.upload(row.grant.uploadUrl);
    let result;
    try {
      result = await put(row, url, headers, (sent) => {
        row.progress = row.size ? Math.min(100, Math.round(sent * 100 / row.size)) : 0;
        this.deps.changed();
      }, row.cancel.signal);
    } catch (error) {
      if (row.cancel.signal.aborted) throw error;
      throw new Error("Upload interrupted. Try again.");
    }
    if (result.status !== 204) throw new Error(uploadFailure(result.body));
    return true;
  }

  private start(row: DraftFile) {
    if (row.work || !this.live(row)) return;
    row.ready = false;
    row.error = undefined;
    row.progress = 0;
    row.work = (async () => {
      try {
        if (await this.upload(row)) row.ready = true;
      } catch (error) {
        if (this.live(row)) row.error = error instanceof Error ? error.message : "Upload failed. Try again.";
      } finally {
        row.work = undefined;
        this.deps.changed();
      }
    })();
    this.deps.changed();
  }

  /** Adds the picks and starts uploading, or refuses them all with the limit they exceed. */
  add(picked: readonly PickedFile[]): boolean {
    const error = attachmentLimitError([...this.rows, ...picked]);
    this.notice = error;
    if (!error) {
      const rows = picked.map((file) => ({ ...file, key: this.deps.newId(), progress: 0, ready: false, cancel: new AbortController() }));
      this.rows = [...this.rows, ...rows];
      for (const row of rows) this.start(row);
    } else {
      this.release(picked);
    }
    this.deps.changed();
    return !error;
  }

  /** A note above the chips, such as a refused camera permission. */
  say(notice: string | undefined) {
    this.notice = notice;
    this.deps.changed();
  }

  retry(row: DraftFile) {
    this.start(row);
  }

  remove(row: DraftFile) {
    this.rows = this.rows.filter((file) => file !== row);
    // Like the web, let a running step finish rather than cancel it: the server
    // refuses to release a file it is still receiving, and a reservation in
    // flight has no ID yet. Its next step sees the row is gone.
    void (async () => {
      await row.work;
      this.release([row]);
      if (row.grant) await this.discard(row.grant.id);
    })().catch(() => { /* The server also expires abandoned uploads. */ });
    this.notice = undefined;
    this.deps.changed();
  }

  /** Waits for every upload. Null when one failed or the draft changed meanwhile.
   * The same message and files reuse one send ID, so a retried send never duplicates. */
  async prepare(identity: string): Promise<AttachmentSend | null> {
    const selected = this.rows;
    await Promise.all(selected.map((row) => row.work));
    if (this.rows !== selected || selected.some((row) => !row.ready || !row.grant)) {
      if (this.rows.some((row) => row.error)) this.say("Some files didn't upload. Retry or remove them, then send again.");
      return null;
    }
    const attachmentUploadIds = selected.map((row) => row.grant!.id);
    const key = JSON.stringify([identity, attachmentUploadIds]);
    if (this.lastSend?.identity !== key) this.lastSend = { identity: key, id: this.deps.newId() };
    return { attachmentUploadIds, sendId: this.lastSend.id };
  }

  /** The server saved the send: its files leave the draft. */
  accept(send: AttachmentSend) {
    const sent = (row: DraftFile) => !!row.grant && send.attachmentUploadIds.includes(row.grant.id);
    this.release(this.rows.filter(sent));
    this.rows = this.rows.filter((row) => !sent(row));
    this.notice = undefined;
    this.deps.changed();
  }

  /** Mounted again (a development remount): accept work once more. */
  open() {
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
  }

  /** The composer closed: stop uploading and delete the draft's copies. The
   *  server expires the reservations. */
  dispose() {
    this.lifetime.abort();
    const rows = this.rows;
    this.rows = [];
    for (const row of rows) row.cancel.abort();
    void Promise.all(rows.map((row) => row.work)).then(() => this.release(rows));
  }
}

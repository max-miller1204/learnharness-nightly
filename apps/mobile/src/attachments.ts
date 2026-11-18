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

/** A photo the camera or picker gave no name: photo-YYYYMMDD-HHMMSS.jpg (local time). */
export function photoName(date: Date): string {
  return `photo-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.jpg`;
}

/** A converted HEIC photo keeps its name but is JPEG, so its extension follows. */
export function photoFileName(name: string | null | undefined, mimeType: string, date: Date): string {
  if (!name) return photoName(date);
  return mimeType === "image/jpeg" ? name.replace(/\.(?:heic|heif)$/i, ".jpg") : name;
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
    now?: () => number;
  }) {}

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
    row.cancel.abort();
    // Let a running step settle before releasing the reservation.
    void (async () => {
      await row.work;
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
    this.rows = this.rows.filter((row) => !row.grant || !send.attachmentUploadIds.includes(row.grant.id));
    this.notice = undefined;
    this.deps.changed();
  }

  /** Mounted again (React's development double mount): accept work once more. */
  open() {
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
  }

  dispose() {
    this.lifetime.abort();
    for (const row of this.rows) row.cancel.abort();
  }
}

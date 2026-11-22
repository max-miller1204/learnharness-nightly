/**
 * A session's unsent attachments (issue #367), kept beside its text draft
 * (lib/composer-drafts.ts, #347) after T3 Code's composer drafts
 * (pingdotgg/t3code, MIT, at f9b19a7f): apps/web/src/composerDraftStore.ts
 * saves a file attachment as metadata plus the id of its finished upload, not
 * its bytes (the persisted row, :303-324, written at :2443-2456 and read back
 * at :2741-2752), and reads a stored draft entry by entry, dropping any that
 * don't parse (:2155-2163).
 *
 * Only an upload that has finished is saved: the stored row is the server's
 * pending upload id and what the chip needs to show and to count against the
 * message limits. A restored chip is checked against the server before it is
 * kept (attachmentStatus), and dropped quietly on a 404, as T3 marks a stored
 * upload that is gone as missing (apps/web/src/lib/attachmentUploadQueue.ts
 * :219-235, markFileUploadMissing at composerDraftStore.ts:3854), and T3
 * checks again when it sends (attachmentUploadQueue.ts:555). The server
 * expires a pending upload after 24 hours (:533); a stored row older than
 * that is never restored.
 *
 * T3 lets an upload still running when the learner leaves finish in a queue
 * that outlives the composer and saves the result with the draft
 * (attachmentUploadQueue.ts:124-132). Here the upload belongs to the
 * composer that started it: leaving cancels it and releases its reservation,
 * so no second composer can ever pick up a half-finished upload.
 *
 * Each session has its own key. Reads are tolerant (AGENTS.md): a missing,
 * unparsable or other-shape value, one malformed row among good ones, or
 * storage that throws, reads as the good rows only. Writes change one
 * session's key and never throw. A deleted session's rows are cleared for
 * good, and later writes for it are ignored (as lib/composer-drafts.ts does,
 * #347): an upload that finishes after the delete is confirmed saves nothing.
 */

import { folderFilesAsAttachments, isAttachmentId } from "@/src/core";

export const ATTACHMENT_DRAFT_KEY_PREFIX = "lh:composer-attachments:v1:";
/** The server's pending expiry (src/store/attachments.ts PENDING_MS). */
const PENDING_MS = 24 * 60 * 60_000;
const MAX_ROWS = 100;

/** One file's media type and size, or a folder's manifest. */
export type StoredAttachment = { id: string; name: string; at: number } & (
	| { mimeType: string; size: number; files?: undefined }
	| { files: { path: string; mimeType: string; size: number }[] }
);

function storage(): Storage | null {
	try { return typeof window !== "undefined" && window.localStorage ? window.localStorage : null; } catch { return null; }
}

const isSize = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseRow(value: unknown, now: number): StoredAttachment | undefined {
	if (!value || typeof value !== "object") return;
	const { id, name, at, mimeType, size, files } = value as Record<string, unknown>;
	if (!isAttachmentId(id) || typeof name !== "string" || !name || name.length > 255) return;
	if (typeof at !== "number" || !Number.isFinite(at) || at + PENDING_MS <= now) return;
	if (files === undefined) return typeof mimeType === "string" && isSize(size) ? { id, name, at, mimeType, size } : undefined;
	if (!Array.isArray(files) || !files.length || files.length > MAX_ROWS) return;
	const manifest: { path: string; mimeType: string; size: number }[] = [];
	for (const file of files) {
		if (!file || typeof file !== "object") return;
		const { path, mimeType: type, size: bytes } = file as Record<string, unknown>;
		if (typeof path !== "string" || typeof type !== "string" || !isSize(bytes)) return;
		manifest.push({ path, mimeType: type, size: bytes });
	}
	return { id, name, at, files: manifest };
}

/** The rows a stored value holds that are still good, with no duplicate ids. */
function parseRows(raw: string | null, now: number): StoredAttachment[] {
	if (!raw) return [];
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { return []; }
	const rows = (parsed as { rows?: unknown } | null)?.rows;
	if (!Array.isArray(rows)) return [];
	const seen = new Set<string>();
	const good: StoredAttachment[] = [];
	for (const value of rows.slice(0, MAX_ROWS)) {
		const row = parseRow(value, now);
		if (row && !seen.has(row.id)) { seen.add(row.id); good.push(row); }
	}
	return good;
}

function read(store: Storage, chatId: string, now = Date.now()): StoredAttachment[] {
	return parseRows(store.getItem(ATTACHMENT_DRAFT_KEY_PREFIX + chatId), now);
}

/** Remove the keys that hold no good row: a deleted session's, or one whose
 *  uploads all expired. Bounded by the server's own expiry. */
function prune(store: Storage, now: number, except: string): void {
	const keys: string[] = [];
	for (let i = 0; i < store.length; i++) {
		const key = store.key(i);
		if (key?.startsWith(ATTACHMENT_DRAFT_KEY_PREFIX) && key !== except) keys.push(key);
	}
	for (const key of keys) if (!parseRows(store.getItem(key), now).length) store.removeItem(key);
}

/** Sessions this window deleted: never saved or read again (ids are never reused). */
const forgotten = new Set<string>();

/** Whether this window deleted the session. */
export const isForgotten = (chatId: string): boolean => forgotten.has(chatId);

function change(chatId: string, apply: (rows: StoredAttachment[]) => StoredAttachment[]): void {
	const store = storage();
	if (!store || forgotten.has(chatId)) return;
	try {
		const now = Date.now();
		const rows = apply(read(store, chatId, now)).slice(0, MAX_ROWS);
		const key = ATTACHMENT_DRAFT_KEY_PREFIX + chatId;
		// Expired keys go first, so their space can hold this write.
		prune(store, now, key);
		if (rows.length) store.setItem(key, JSON.stringify({ rows }));
		else store.removeItem(key);
	} catch { /* blocked or full: the chip is simply not kept across a visit */ }
}

/** The session's stored rows that are still good; [] when none or unreadable. */
export function readStoredAttachments(chatId: string): StoredAttachment[] {
	const store = storage();
	if (!store || forgotten.has(chatId)) return [];
	try { return read(store, chatId); } catch { return []; }
}

/** Keep a finished upload with the session's draft. */
export function storeAttachment(chatId: string, row: StoredAttachment): void {
	change(chatId, rows => [...rows.filter(({ id }) => id !== row.id), row]);
}

const dropListeners = new Set<(chatId: string, ids: readonly string[]) => void>();

/** Stop keeping these uploads (sent, removed or gone). A composer showing the
 *  session also drops them, so a send accepted after the learner left and
 *  came back doesn't leave its chip behind. */
export function dropStoredAttachments(chatId: string, ids: readonly string[]): void {
	change(chatId, rows => rows.filter(({ id }) => !ids.includes(id)));
	for (const listener of [...dropListeners]) listener(chatId, ids);
}

export function onStoredAttachmentsDropped(listener: (chatId: string, ids: readonly string[]) => void): () => void {
	dropListeners.add(listener);
	return () => { dropListeners.delete(listener); };
}

/** Its session was deleted: remove its key whatever it holds (also a corrupt
 *  or expired value), ignore later writes, and tell a composer still showing
 *  its chips. */
export function forgetStoredAttachments(chatId: string): void {
	const ids = readStoredAttachments(chatId).map(({ id }) => id);
	forgotten.add(chatId);
	try { storage()?.removeItem(ATTACHMENT_DRAFT_KEY_PREFIX + chatId); } catch { /* blocked: nothing to clear */ }
	for (const listener of [...dropListeners]) listener(chatId, ids);
}

/** What the message limits count for a stored row. */
export const storedLimitInputs = (row: StoredAttachment) =>
	row.files ? folderFilesAsAttachments(row.files) : [{ name: row.name, mimeType: row.mimeType, size: row.size }];

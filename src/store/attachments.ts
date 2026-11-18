import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { AttachmentGrantRequest, AttachmentGrantResponse, AttachmentTarget } from "../client-protocol/index.ts";
import { attachmentLimitError, MAX_CLAIMED_ATTACHMENT_BYTES, MAX_STAGED_ATTACHMENT_BYTES } from "../core/attachment-limits.ts";
import { isAttachmentId, type AttachmentReference } from "../core/attachments.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { attachmentDigest, AttachmentSizeMismatch, writeAttachmentBytes } from "./attachment-bytes.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const GRANT_MS = 10 * 60_000;
const PENDING_MS = 24 * 60 * 60_000;
const PARTIAL_MS = 60 * 60_000;

interface PendingAttachment extends AttachmentReference {
	owner: string;
	target: AttachmentTarget;
	mimeType: string;
	size: number;
	expiresAt: number;
}

export class AttachmentError extends Error {
	constructor(public status: number, message: string) { super(message); }
}

const active = (globalThis as typeof globalThis & { lhActiveAttachmentUploads?: Map<string, number> });
const uploads = active.lhActiveAttachmentUploads ??= new Map();

const staging = path.join(/* turbopackIgnore: true */ PATHS.attachments, "pending");
const claimed = path.join(/* turbopackIgnore: true */ PATHS.attachments, "claimed");
const removals = path.join(/* turbopackIgnore: true */ PATHS.attachments, "cleanup");

function entries(directory: string): string[] {
	try { return fs.readdirSync(/* turbopackIgnore: true */ directory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function checkDirectory(directory: string): void {
	fs.mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true, mode: 0o700 });
	if (!fs.lstatSync(/* turbopackIgnore: true */ directory).isDirectory()) throw new Error("Invalid attachment storage directory");
}

const pendingFile = (id: string, suffix: string) => path.join(/* turbopackIgnore: true */ staging, id + suffix);
const claimedFile = (id: string) => path.join(/* turbopackIgnore: true */ claimed, id);
const removalFile = (id: string) => path.join(/* turbopackIgnore: true */ removals, id);

function stat(file: string): fs.Stats | undefined {
	const info = fs.lstatSync(/* turbopackIgnore: true */ file, { throwIfNoEntry: false });
	return info?.isFile() ? info : undefined;
}

function unlink(file: string): void {
	try { fs.unlinkSync(/* turbopackIgnore: true */ file); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function pending(id: string): PendingAttachment | undefined {
	if (!isAttachmentId(id)) return;
	const file = pendingFile(id, ".json");
	if (stat(file)) return JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")) as PendingAttachment;
}

function sameTarget(left: AttachmentTarget, right: AttachmentTarget): boolean {
	return "chatId" in left
		? "chatId" in right && left.chatId === right.chatId
		: "draftId" in right && left.draftId === right.draftId;
}

function stagedBytes(): number {
	// Every pending upload reserves its declared bytes. A duplicate retry
	// reserves a second copy until its temporary comparison file is removed.
	let total = 0;
	for (const entry of entries(staging)) {
		const id = entry.slice(0, -5);
		if (entry.endsWith(".json")) total += pending(id)?.size ?? 0;
		else if (entry.endsWith(".part") && (stat(pendingFile(id, ".body")) || !pending(id))) {
			total += uploads.get(id) ?? stat(path.join(/* turbopackIgnore: true */ staging, entry))?.size ?? 0;
		}
	}
	for (const [id, size] of uploads) {
		if (size && !stat(pendingFile(id, ".part"))) total += size;
	}
	return total;
}

function signingKey(): Buffer {
	checkDirectory(PATHS.attachments);
	const file = path.join(/* turbopackIgnore: true */ PATHS.attachments, "signing-key");
	if (!stat(file)) fs.writeFileSync(/* turbopackIgnore: true */ file, randomBytes(32), { flag: "wx", mode: 0o600 });
	return fs.readFileSync(/* turbopackIgnore: true */ file);
}

function signature(upload: PendingAttachment): Buffer {
	return createHmac("sha256", signingKey()).update(JSON.stringify(upload)).digest();
}

export function reserveAttachment(owner: string, request: AttachmentGrantRequest): AttachmentGrantResponse {
	const error = attachmentLimitError([request]);
	if (error) throw new AttachmentError(413, error);
	checkDirectory(PATHS.attachments);
	checkDirectory(staging);
	if (stagedBytes() + request.size > MAX_STAGED_ATTACHMENT_BYTES) {
		throw new AttachmentError(413, "The server's 512 MiB pending attachment limit was reached.");
	}
	const { name, mimeType, size } = request;
	const target = "chatId" in request ? { chatId: request.chatId } : { draftId: request.draftId };
	const upload = { id: randomUUID(), owner, target, name, mimeType, size, expiresAt: Date.now() + GRANT_MS };
	const grant = signature(upload).toString("base64url");
	writeFileAtomicSync(pendingFile(upload.id, ".json"), JSON.stringify(upload), { mode: 0o600 });
	return {
		id: upload.id,
		uploadUrl: `/api/attachments/upload?id=${upload.id}&grant=${grant}`,
		expiresAt: upload.expiresAt,
	};
}

export async function receiveAttachment(
	id: string, grant: string, owner: string, request: Request, currentOwner: () => void,
): Promise<void> {
	const upload = pending(id);
	if (!upload || upload.owner !== owner || upload.expiresAt <= Date.now() || !/^[A-Za-z0-9_-]{43}$/.test(grant) ||
		!timingSafeEqual(signature(upload), Buffer.from(grant, "base64url"))) {
		throw new AttachmentError(403, "Invalid or expired attachment upload grant.");
	}
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null && contentLength !== String(upload.size)) throw new AttachmentError(400, new AttachmentSizeMismatch().message);
	if (uploads.has(id)) throw new AttachmentError(409, "This file is already uploading.");
	const body = pendingFile(id, ".body");
	const part = pendingFile(id, ".part");
	const retry = Boolean(stat(body));
	if (retry && stagedBytes() + upload.size > MAX_STAGED_ATTACHMENT_BYTES) {
		throw new AttachmentError(413, "The server's 512 MiB pending attachment limit was reached.");
	}
	uploads.set(id, retry ? upload.size : 0);
	try {
		unlink(part);
		await writeAttachmentBytes(request.body, part, upload.size, request.signal);
		if (retry) {
			const [oldDigest, newDigest] = await Promise.all([attachmentDigest(body), attachmentDigest(part)]);
			if (oldDigest !== newDigest) throw new AttachmentError(409, "Different bytes were already uploaded with this grant.");
		}
		currentOwner();
		if (upload.expiresAt <= Date.now()) throw new AttachmentError(403, "The attachment upload grant expired.");
		if (!retry) fs.renameSync(/* turbopackIgnore: true */ part, /* turbopackIgnore: true */ body);
	} catch (error) {
		if (error instanceof AttachmentSizeMismatch) throw new AttachmentError(400, error.message);
		throw error;
	} finally {
		try { unlink(part); }
		finally { uploads.delete(id); }
	}
}

function removePending(id: string): void {
	// Remove metadata last so sweep can retry interrupted cleanup.
	unlink(pendingFile(id, ".part"));
	unlink(pendingFile(id, ".body"));
	unlink(pendingFile(id, ".json"));
}

export function discardAttachment(id: string, owner: string): void {
	const upload = pending(id);
	if (!upload || upload.owner !== owner) throw new AttachmentError(404, "Pending attachment not found.");
	if (uploads.has(id)) throw new AttachmentError(409, "This file is still uploading.");
	removePending(id);
}

export function attachmentReferences(messages: readonly LhMessage[]): AttachmentReference[] {
	return messages.flatMap(message => message.role === "user" ? message.attachments ?? [] : []);
}

export function claimedAttachmentPath(id: string): string | undefined {
	if (!isAttachmentId(id)) return;
	const file = claimedFile(id);
	if (stat(file)) return file;
}

export function unavailableAttachmentIds(messages: readonly LhMessage[]): string[] | undefined {
	const missing = [...new Set(attachmentReferences(messages).map(({ id }) => id))].filter(id => !claimedAttachmentPath(id));
	return missing.length ? missing : undefined;
}

export function claimAttachments(
	ids: readonly string[], owner: string, target: AttachmentTarget, messages: readonly LhMessage[],
	save: (refs: AttachmentReference[]) => void,
): void {
	const current = new Set(attachmentReferences(messages).map(({ id }) => id));
	const pendingUploads = ids.map(id => {
		const upload = pending(id);
		const bytes = stat(pendingFile(id, ".body"));
		if (!upload || upload.owner !== owner || !sameTarget(upload.target, target) || current.has(id) ||
			uploads.has(id) || !bytes || bytes.size !== upload.size || bytes.mtimeMs + PENDING_MS <= Date.now()) {
			throw new AttachmentError(409, "A file is unavailable for this draft or chat. Attach it again to use it.");
		}
		return upload;
	});
	const limitError = attachmentLimitError(pendingUploads);
	if (limitError) throw new AttachmentError(413, limitError);
	let bytes = 0;
	for (const id of current) {
		const file = claimedAttachmentPath(id);
		if (file) bytes += stat(file)?.size ?? 0;
	}
	if (bytes + pendingUploads.reduce((total, upload) => total + upload.size, 0) > MAX_CLAIMED_ATTACHMENT_BYTES) {
		throw new AttachmentError(413, "This chat's 1 GiB attachment limit was reached.");
	}
	checkDirectory(PATHS.attachments);
	checkDirectory(claimed);
	const copied: string[] = [];
	try {
		for (const { id } of pendingUploads) {
			const file = claimedFile(id);
			if (stat(file)) continue; // A previous process stopped after copying this immutable upload.
			const part = claimedFile(id + ".part");
			try {
				unlink(part);
				fs.copyFileSync(/* turbopackIgnore: true */ pendingFile(id, ".body"), /* turbopackIgnore: true */ part, fs.constants.COPYFILE_FICLONE);
				const fd = fs.openSync(/* turbopackIgnore: true */ part, "r+");
				try { fs.fsyncSync(fd); }
				finally { fs.closeSync(fd); }
				fs.renameSync(/* turbopackIgnore: true */ part, /* turbopackIgnore: true */ file);
				copied.push(file);
			} finally { unlink(part); }
		}
		save(pendingUploads.map(({ id, name }) => ({ id, name })));
	} catch (error) {
		for (const file of copied) {
			try { unlink(file); } catch { /* Pending metadata lets sweep collect an interrupted copy. */ }
		}
		throw error;
	}
	for (const { id } of pendingUploads) {
		try { removePending(id); }
		catch (error) { console.warn("[attachments] Could not release a committed pending upload:", error); }
	}
}

/** Schedule before deleting a chat record. A surviving record protects its
 * files if deletion fails or the process exits before the record is removed. */
export function scheduleAttachmentRemoval(attachments: readonly AttachmentReference[]): void {
	const ids = attachments.map(({ id }) => id).filter(isAttachmentId);
	if (!ids.length) return;
	checkDirectory(PATHS.attachments);
	checkDirectory(removals);
	for (const id of ids) fs.writeFileSync(/* turbopackIgnore: true */ removalFile(id), "", { mode: 0o600 });
}

function liveReferences(): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries(PATHS.chats)) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(/* turbopackIgnore: true */ PATHS.chats, entry);
		const record = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")) as { messages: LhMessage[] };
		for (const { id } of attachmentReferences(record.messages)) ids.add(id);
	}
	return ids;
}

export function sweepAttachments(now: number = Date.now()): void {
	const pendingEntries = entries(staging);
	const deleteIds = entries(removals).filter(isAttachmentId);
	const refs = pendingEntries.length || deleteIds.length ? liveReferences() : new Set<string>();
	for (const entry of pendingEntries) {
		const id = entry.slice(0, -5);
		if (!isAttachmentId(id) || uploads.has(id)) continue;
		if (entry.endsWith(".part")) {
			const part = pendingFile(id, ".part");
			if ((stat(part)?.mtimeMs ?? now) + PARTIAL_MS <= now) unlink(part);
		} else if (entry.endsWith(".json")) {
			const upload = pending(id);
			const body = stat(pendingFile(id, ".body"));
			if (refs.has(id)) removePending(id); // A chat write committed before a restart.
			else if ((body ? body.mtimeMs + PENDING_MS : upload?.expiresAt ?? Infinity) <= now && !stat(pendingFile(id, ".part"))) {
				unlink(claimedFile(id)); // Copy left behind by a pre-commit interruption.
				removePending(id);
			}
		}
	}
	for (const entry of entries(claimed)) {
		if (entry.endsWith(".part") && isAttachmentId(entry.slice(0, -5))) {
			const file = claimedFile(entry);
			if ((stat(file)?.mtimeMs ?? now) + PARTIAL_MS <= now) unlink(file);
		}
	}
	for (const id of deleteIds) {
		if (refs.has(id)) continue;
		unlink(claimedFile(id));
		unlink(removalFile(id));
	}
}

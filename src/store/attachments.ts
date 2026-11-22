import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { AttachmentFolderGrantResponse, AttachmentFolderRequest, AttachmentGrantRequest, AttachmentGrantResponse, AttachmentTarget } from "../client-protocol/index.ts";
import { folderFilesAsAttachments, folderLimitError, folderPathError, type FolderFile } from "../core/attachment-folders.ts";
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
	/** A folder's file: claimable and removable only through its folder. */
	folder?: string;
}

/** Bytes live in ordinary pending uploads, one per file, so receiving,
 * staging limits and expiry stay PR 1's. The folder lives while any of them does. */
interface PendingFolder {
	id: string;
	owner: string;
	target: AttachmentTarget;
	name: string;
	files: (FolderFile & { member: string })[];
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

const folderFile = (id: string) => path.join(/* turbopackIgnore: true */ staging, id + ".folder.json");

function stat(file: string): fs.Stats | undefined {
	const info = fs.lstatSync(/* turbopackIgnore: true */ file, { throwIfNoEntry: false });
	return info?.isFile() ? info : undefined;
}

function entryStat(file: string): fs.Stats | undefined {
	return fs.lstatSync(/* turbopackIgnore: true */ file, { throwIfNoEntry: false });
}

/** A claimed copy is a file or a folder's directory tree. */
function removeClaimed(file: string): void {
	fs.rmSync(/* turbopackIgnore: true */ file, { recursive: true, force: true });
}

function claimedSize(file: string): number {
	const info = entryStat(file);
	if (info?.isFile()) return info.size;
	if (!info?.isDirectory()) return 0;
	return entries(file).reduce((total, entry) => total + claimedSize(path.join(/* turbopackIgnore: true */ file, entry)), 0);
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
	if (!stat(file)) return;
	let upload: PendingAttachment;
	try { upload = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")); }
	catch (error) {
		if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (upload?.id !== id || typeof upload.owner !== "string" || typeof upload.name !== "string" ||
		typeof upload.mimeType !== "string" || !Number.isSafeInteger(upload.size) || upload.size < 0 ||
		!Number.isFinite(upload.expiresAt) || !upload.target || typeof upload.target !== "object") return;
	if ("chatId" in upload.target ? typeof upload.target.chatId !== "string" : !isAttachmentId(upload.target.draftId)) return;
	if (upload.folder !== undefined && !isAttachmentId(upload.folder)) return;
	return upload;
}

function pendingFolder(id: string): PendingFolder | undefined {
	if (!isAttachmentId(id)) return;
	const file = folderFile(id);
	if (!stat(file)) return;
	let folder: PendingFolder;
	try { folder = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")); }
	catch (error) {
		if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (folder?.id !== id || typeof folder.owner !== "string" || typeof folder.name !== "string" || !Array.isArray(folder.files) ||
		!folder.target || typeof folder.target !== "object" || !folder.files.every(file => isAttachmentId(file?.member) && typeof file.path === "string")) return;
	return folder;
}

function folderIds(files: readonly string[]): string[] {
	return files.filter(file => file.endsWith(".folder.json")).map(file => file.slice(0, -12)).filter(isAttachmentId);
}

function sameTarget(left: AttachmentTarget, right: AttachmentTarget): boolean {
	return "chatId" in left
		? "chatId" in right && left.chatId === right.chatId
		: "draftId" in right && left.draftId === right.draftId;
}

function pendingIds(files: readonly string[]): Set<string> {
	return new Set(files.filter(file => /\.(?:json|body|part)$/.test(file)).map(file => file.slice(0, -5)).filter(isAttachmentId));
}

function stagedBytes(): number {
	// A healthy reservation accounts for its upload. Count bytes on disk
	// even if the reservation is corrupt, plus a duplicate retry's copy.
	let total = 0;
	const ids = pendingIds(entries(staging));
	for (const id of uploads.keys()) ids.add(id);
	for (const id of ids) {
		const reserved = pending(id)?.size ?? 0;
		const body = stat(pendingFile(id, ".body"));
		const part = Math.max(stat(pendingFile(id, ".part"))?.size ?? 0, uploads.get(id) ?? 0);
		total += body ? Math.max(reserved, body.size) + part : Math.max(reserved, part);
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

const STAGING_LIMIT = "The server's 512 MiB pending attachment limit was reached.";

function targetOf(request: AttachmentTarget): AttachmentTarget {
	return "chatId" in request ? { chatId: request.chatId } : { draftId: request.draftId };
}

/** Write a pending upload's metadata and return its signed URL. */
function grantUpload(upload: PendingAttachment): string {
	const grant = signature(upload).toString("base64url");
	writeFileAtomicSync(pendingFile(upload.id, ".json"), JSON.stringify(upload), { mode: 0o600 });
	return `/api/attachments/upload?id=${upload.id}&grant=${grant}`;
}

export function reserveAttachment(owner: string, request: AttachmentGrantRequest): AttachmentGrantResponse {
	const error = attachmentLimitError([request]);
	if (error) throw new AttachmentError(413, error);
	checkDirectory(PATHS.attachments);
	checkDirectory(staging);
	if (stagedBytes() + request.size > MAX_STAGED_ATTACHMENT_BYTES) throw new AttachmentError(413, STAGING_LIMIT);
	const { name, mimeType, size } = request;
	const upload = { id: randomUUID(), owner, target: targetOf(request), name, mimeType, size, expiresAt: Date.now() + GRANT_MS };
	return { id: upload.id, uploadUrl: grantUpload(upload), expiresAt: upload.expiresAt };
}

/** Validate the whole manifest and reserve every file's bytes before any
 * upload starts. */
export function reserveAttachmentFolder(owner: string, request: AttachmentFolderRequest): AttachmentFolderGrantResponse {
	const pathError = folderPathError(request.name, request.files);
	if (pathError) throw new AttachmentError(400, pathError);
	const limitError = folderLimitError(request.name, request.files);
	if (limitError) throw new AttachmentError(413, limitError);
	checkDirectory(PATHS.attachments);
	checkDirectory(staging);
	const folder: PendingFolder = {
		id: randomUUID(), owner, target: targetOf(request), name: request.name,
		files: request.files.map(({ path, mimeType, size }) => ({ path, mimeType, size, member: "" })),
	};
	return grantFolder(folder, true);
}

/** Fresh grants for a pending folder's files that have not arrived, so a slow
 * or failed upload can resume without sending finished files again. */
export function renewAttachmentFolder(id: string, owner: string): AttachmentFolderGrantResponse {
	const folder = pendingFolder(id);
	if (!folder || folder.owner !== owner) throw new AttachmentError(404, "Pending attachment not found.");
	return grantFolder(folder, false);
}

function grantFolder(folder: PendingFolder, created: boolean): AttachmentFolderGrantResponse {
	const expiresAt = Date.now() + GRANT_MS;
	const needed = folder.files.filter(file => {
		if (created) return true;
		const body = stat(pendingFile(file.member, ".body"));
		return !uploads.has(file.member) && !(body && body.size === file.size && pending(file.member));
	});
	// A file whose upload record still exists keeps its reservation. Only
	// records that expired and were swept need capacity again.
	const added = needed.filter(file => created || !pending(file.member)).reduce((total, file) => total + file.size, 0);
	if (added && stagedBytes() + added > MAX_STAGED_ATTACHMENT_BYTES) throw new AttachmentError(413, STAGING_LIMIT);
	const files = needed.map(file => {
		const current = created ? undefined : pending(file.member);
		if (!current) file.member = randomUUID();
		const name = file.path.slice(file.path.lastIndexOf("/") + 1);
		const upload = { id: file.member, owner: folder.owner, target: folder.target, name, mimeType: file.mimeType, size: file.size, expiresAt, folder: folder.id };
		return { path: file.path, uploadUrl: grantUpload(upload) };
	});
	// Members first: an interrupted reservation leaves only expiring uploads.
	writeFileAtomicSync(folderFile(folder.id), JSON.stringify(folder), { mode: 0o600 });
	return { id: folder.id, expiresAt, files };
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
	uploads.set(id, upload.size);
	try {
		unlink(part);
		await writeAttachmentBytes(request.body, part, upload.size, request.signal);
		if (retry) {
			const [oldDigest, newDigest] = await Promise.all([attachmentDigest(body), attachmentDigest(part)]);
			if (oldDigest !== newDigest) throw new AttachmentError(409, "Different bytes were already uploaded with this grant.");
		}
		currentOwner();
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

function discardFolder(folder: PendingFolder): void {
	if (folder.files.some(file => uploads.has(file.member))) throw new AttachmentError(409, "This file is still uploading.");
	const copy = claimedFile(folder.id);
	if (entryStat(copy)) {
		const { ids, complete } = liveReferences();
		if (!ids.has(folder.id)) {
			if (!complete) throw new AttachmentError(503, "Could not check attachment references. Try removal again.");
			removeClaimed(copy);
		}
	}
	removeFolder(folder);
}

function removeFolder(folder: PendingFolder): void {
	for (const file of folder.files) removePending(file.member);
	unlink(folderFile(folder.id));
}

export function discardAttachment(id: string, owner: string): void {
	const folder = pendingFolder(id);
	if (folder) {
		if (folder.owner !== owner) throw new AttachmentError(404, "Pending attachment not found.");
		discardFolder(folder);
		return;
	}
	const upload = pending(id);
	if (!upload || upload.owner !== owner || upload.folder) throw new AttachmentError(404, "Pending attachment not found.");
	if (uploads.has(id)) throw new AttachmentError(409, "This file is still uploading.");
	// A crash can leave a copy and its pending metadata side by side. Keep
	// the metadata until the copy is either referenced or removed.
	const copy = claimedFile(id);
	if (stat(copy)) {
		const { ids, complete } = liveReferences();
		if (!ids.has(id)) {
			if (!complete) throw new AttachmentError(503, "Could not check attachment references. Try removal again.");
			unlink(copy);
		}
	}
	removePending(id);
}

export function attachmentReferences(messages: readonly LhMessage[]): AttachmentReference[] {
	return messages.flatMap(message => message.role === "user" ? message.attachments ?? [] : []);
}

/** A claimed file, or the root directory of a claimed folder. */
export function claimedAttachmentPath(id: string): string | undefined {
	if (!isAttachmentId(id)) return;
	const file = claimedFile(id);
	const info = entryStat(file);
	if (info?.isFile() || info?.isDirectory()) return file;
}

export function unavailableAttachmentIds(messages: readonly LhMessage[]): string[] | undefined {
	const missing = [...new Set(attachmentReferences(messages).map(({ id }) => id))].filter(id => !claimedAttachmentPath(id));
	return missing.length ? missing : undefined;
}

/** A pending file whose bytes have all arrived, for this owner and target.
 *  The id is validated and the owner and target are checked before any stat. */
function uploadedPending(id: string, owner: string, target: AttachmentTarget, folder?: string): PendingAttachment | undefined {
	const upload = pending(id);
	if (!upload || upload.owner !== owner || !sameTarget(upload.target, target) || upload.folder !== folder || uploads.has(id)) return;
	const bytes = stat(pendingFile(id, ".body"));
	if (!bytes || bytes.size !== upload.size || bytes.mtimeMs + PENDING_MS <= Date.now()) return;
	return upload;
}

/** A pending folder whose files have all arrived, for this owner and target. */
function uploadedFolder(folder: PendingFolder, owner: string, target: AttachmentTarget): boolean {
	return folder.owner === owner && sameTarget(folder.target, target) && folder.files.every(file => {
		const member = uploadedPending(file.member, owner, target, folder.id);
		return member && member.size === file.size && member.mimeType === file.mimeType;
	});
}

/** Whether a send could claim this pending file or folder right now: a
 *  restored draft chip asks this before it keeps a stored upload. */
export function attachmentSendable(id: string, owner: string, target: AttachmentTarget): boolean {
	if (!isAttachmentId(id)) return false;
	const folder = pendingFolder(id);
	return folder ? uploadedFolder(folder, owner, target) : !!uploadedPending(id, owner, target);
}

export function claimAttachments(
	ids: readonly string[], owner: string, target: AttachmentTarget, messages: readonly LhMessage[],
	save: (refs: AttachmentReference[]) => void,
): void {
	const current = new Set(attachmentReferences(messages).map(({ id }) => id));
	const unavailable = () => new AttachmentError(409, "A file is unavailable for this draft or chat. Attach it again to use it.");
	const items = ids.map(id => {
		if (current.has(id)) throw unavailable();
		const folder = pendingFolder(id);
		if (!folder) {
			const upload = uploadedPending(id, owner, target);
			if (!upload) throw unavailable();
			return { upload, folder: undefined };
		}
		if (!uploadedFolder(folder, owner, target)) throw unavailable();
		return { folder };
	});
	const limitError = attachmentLimitError(items.flatMap(item => item.folder ? folderFilesAsAttachments(item.folder.files) : [item.upload]));
	if (limitError) throw new AttachmentError(413, limitError);
	let bytes = 0;
	for (const id of current) {
		const file = claimedAttachmentPath(id);
		if (file) bytes += claimedSize(file);
	}
	const adding = items.reduce((total, item) => total + (item.folder ? item.folder.files.reduce((sum, file) => sum + file.size, 0) : item.upload.size), 0);
	if (bytes + adding > MAX_CLAIMED_ATTACHMENT_BYTES) throw new AttachmentError(413, "This chat's 1 GiB attachment limit was reached.");
	checkDirectory(PATHS.attachments);
	checkDirectory(claimed);
	const copied: string[] = [];
	try {
		for (const item of items) {
			const id = item.folder ? item.folder.id : item.upload.id;
			const file = claimedFile(id);
			if (entryStat(file)) continue; // A previous process stopped after copying this immutable upload.
			const part = claimedFile(id + ".part");
			try {
				removeClaimed(part);
				if (item.folder) copyFolder(item.folder, part);
				else copyBytes(pendingFile(id, ".body"), part);
				fs.renameSync(/* turbopackIgnore: true */ part, /* turbopackIgnore: true */ file);
				copied.push(file);
			} finally { removeClaimed(part); }
		}
		save(items.map(item => item.folder
			? { id: item.folder.id, name: item.folder.name, fileCount: item.folder.files.length }
			: { id: item.upload.id, name: item.upload.name }));
	} catch (error) {
		for (const file of copied) {
			try { removeClaimed(file); } catch { /* Pending metadata lets sweep collect an interrupted copy. */ }
		}
		throw error;
	}
	for (const item of items) {
		try {
			if (item.folder) removeFolder(item.folder);
			else removePending(item.upload.id);
		} catch (error) { console.warn("[attachments] Could not release a committed pending upload:", error); }
	}
}

function copyBytes(source: string, destination: string): void {
	fs.copyFileSync(/* turbopackIgnore: true */ source, /* turbopackIgnore: true */ destination, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
	const fd = fs.openSync(/* turbopackIgnore: true */ destination, "r+");
	try { fs.fsyncSync(fd); }
	finally { fs.closeSync(fd); }
}

/** Only regular files and directories, all inside the folder's own root.
 * The manifest was validated at reservation; check again before writing. */
function copyFolder(folder: PendingFolder, root: string): void {
	if (folderPathError(folder.name, folder.files)) throw new AttachmentError(409, "A file is unavailable for this draft or chat. Attach it again to use it.");
	fs.mkdirSync(/* turbopackIgnore: true */ root, { mode: 0o700 });
	for (const file of folder.files) {
		const destination = path.join(/* turbopackIgnore: true */ root, ...file.path.split("/"));
		// A real ".." segment, not a name such as "..notes.txt".
		const relative = path.relative(root, destination);
		if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Invalid folder attachment path");
		fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(destination), { recursive: true, mode: 0o700 });
		copyBytes(pendingFile(file.member, ".body"), destination);
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

function liveReferences(): { ids: Set<string>; complete: boolean } {
	const ids = new Set<string>();
	let complete = true;
	for (const entry of entries(PATHS.chats)) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(/* turbopackIgnore: true */ PATHS.chats, entry);
		try {
			const record = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")) as { messages: LhMessage[] };
			for (const { id } of attachmentReferences(record.messages)) ids.add(id);
		} catch {
			// A damaged record may still own a claimed copy. Defer only
			// removals that need proof that no live chat references it.
			complete = false;
		}
	}
	return { ids, complete };
}

export function sweepAttachments(now: number = Date.now()): void {
	const staged = pendingIds(entries(staging));
	const deleteIds = entries(removals).filter(isAttachmentId);
	const refs = staged.size || deleteIds.length || folderIds(entries(staging)).length ? liveReferences() : { ids: new Set<string>(), complete: true };
	for (const id of staged) {
		if (uploads.has(id)) continue;
		const partial = pendingFile(id, ".part");
		const part = stat(partial);
		if (part && part.mtimeMs + PARTIAL_MS <= now) unlink(partial);
		else if (part) continue;

		if (refs.ids.has(id)) {
			removePending(id); // A chat write committed before a restart.
			continue;
		}
		const body = stat(pendingFile(id, ".body"));
		const metadata = stat(pendingFile(id, ".json"));
		const expiresAt = body ? body.mtimeMs + PENDING_MS : pending(id)?.expiresAt ?? (metadata ? metadata.mtimeMs + GRANT_MS : now);
		if (expiresAt > now) continue;
		const copy = claimedFile(id);
		if (stat(copy)) {
			if (!refs.complete) continue;
			unlink(copy); // Copy left behind by a pre-commit interruption.
		}
		removePending(id);
	}
	for (const id of folderIds(entries(staging))) {
		const folder = pendingFolder(id);
		if (!folder) {
			// Corrupt metadata reserves nothing; its files expire on their own.
			if ((stat(folderFile(id))?.mtimeMs ?? now) + PENDING_MS <= now) unlink(folderFile(id));
			continue;
		}
		if (refs.ids.has(id)) {
			removeFolder(folder); // A chat write committed before a restart.
			continue;
		}
		if (folder.files.some(file => uploads.has(file.member) || stat(pendingFile(file.member, ".json")) || stat(pendingFile(file.member, ".body")))) continue;
		if ((stat(folderFile(id))?.mtimeMs ?? now) + GRANT_MS > now) continue;
		if (entryStat(claimedFile(id))) {
			if (!refs.complete) continue;
			removeClaimed(claimedFile(id)); // Copy left behind by a pre-commit interruption.
		}
		removeFolder(folder);
	}
	for (const entry of entries(claimed)) {
		if (entry.endsWith(".part") && isAttachmentId(entry.slice(0, -5))) {
			const file = claimedFile(entry);
			if ((entryStat(file)?.mtimeMs ?? now) + PARTIAL_MS <= now) removeClaimed(file);
		}
	}
	if (!refs.complete) return;
	for (const id of deleteIds) {
		if (refs.ids.has(id)) continue;
		removeClaimed(claimedFile(id));
		unlink(removalFile(id));
	}
}

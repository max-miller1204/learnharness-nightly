"use client";

import { useEffect, useRef, useState } from "react";
import { FolderIcon, PaperclipIcon } from "lucide-react";
import { ATTACHMENT_FOLDERS, ATTACHMENT_STATUS, ATTACHMENT_UPLOADS, hasCapability, PROTOCOL_ROUTES, type AttachmentFolderGrantResponse, type AttachmentGrantResponse, type AttachmentSend, type AttachmentTarget, type ServerInfo } from "@/src/core";
import { attachmentLimitError, ATTACHMENT_UNAVAILABLE, folderFilesAsAttachments, folderLimitError, folderPathError, randomUuid, skippedFolderNotice } from "@/src/core";
import type { AttachmentReference } from "@/src/core";
import { dropStoredAttachments, onStoredAttachmentsDropped, readStoredAttachments, storeAttachment, storedLimitInputs, type StoredAttachment } from "@/lib/attachment-drafts";
import { droppedAttachments, folderFromFiles, type FolderPick, type PickedFolder } from "./attachment-folder";

/** Dispatched by the page drop zone on an uploading composer's chips. */
export const ATTACHMENT_DROP_EVENT = "lh:attachment-drop";

/** A file or a whole folder. A folder's grant id is its folder id. */
interface DraftFile {
	key: string;
	name: string;
	file?: File;
	folder?: PickedFolder;
	/** A finished upload restored from the session's draft: no bytes here, only what its chip and the limits need. */
	stored?: StoredAttachment;
	/** `deadline` is the upload start deadline on this device's clock. */
	grant?: { id: string; deadline: number; uploadUrl?: string };
	uploads: Set<XMLHttpRequest>;
	work?: Promise<void>;
	progress: number;
	ready: boolean;
	error?: string;
}

const FOLDER_UPLOADS_AT_ONCE = 3;

function folderManifest(folder: PickedFolder) {
	return folder.files.map(({ file, path }) => ({ path, mimeType: file.type, size: file.size }));
}

function limitInputs(rows: readonly DraftFile[]) {
	return rows.flatMap(row => row.folder
		? folderFilesAsAttachments(folderManifest(row.folder))
		: row.stored ? storedLimitInputs(row.stored)
		: [{ name: row.file!.name, mimeType: row.file!.type, size: row.file!.size }]);
}

export async function attachmentResponseError(response: Response): Promise<string> {
	const body = await response.text().catch(() => "");
	try {
		const error = JSON.parse(body)?.error;
		if (typeof error === "string" && error) return error;
	} catch { /* The send handler can also return plain text. */ }
	return body || "The attachment operation failed. Try again.";
}

async function deleteGrant(id: string): Promise<void> {
	const response = await fetch(PROTOCOL_ROUTES.removeAttachment(id), { method: "DELETE" });
	if (!response.ok && response.status !== 404) throw new Error(await attachmentResponseError(response));
}

/** Wait for running puts to settle before asking the server to release the
 * reservation. A released folder starts no further files. */
function releaseGrant(row: DraftFile): void {
	void (async () => {
		await row.work;
		if (row.grant) await deleteGrant(row.grant.id);
	})().catch(() => { /* The server also expires abandoned grants. */ });
}

/** The number of files in a folder row; undefined for a single file. */
const folderCount = (row: DraftFile): number | undefined => row.folder?.files.length ?? row.stored?.files?.length;

function putBytes(row: DraftFile, file: File, url: string, progress: (loaded: number) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const upload = new XMLHttpRequest();
		row.uploads.add(upload);
		const settle = () => { row.uploads.delete(upload); };
		upload.open("PUT", url);
		upload.upload.onprogress = event => { progress(event.lengthComputable ? event.loaded : 0); };
		upload.onload = () => {
			settle();
			if (upload.status === 204) { resolve(); return; }
			let message = "Upload failed. Try again.";
			try { message = JSON.parse(upload.responseText).error || message; } catch { /* Non-JSON proxy error. */ }
			reject(new Error(message));
		};
		upload.onerror = upload.onabort = () => { settle(); reject(new Error("Upload interrupted. Try again.")); };
		upload.send(file);
	});
}

class RequestError extends Error {
	constructor(public status: number, message: string) { super(message); }
}

/** The server's `expiresAt` on this device's clock. The response's Date
 * header gives the server's time, so a skewed device clock doesn't matter.
 * Date has one-second resolution: allow that second. */
export function localDeadline(expiresAt: number, serverDate: string | null, now = Date.now()): number {
	const server = Date.parse(serverDate ?? "");
	return expiresAt - 1000 + (Number.isFinite(server) ? now - server : 0);
}

async function postGrant<T extends { expiresAt: number }>(url: string, body?: unknown): Promise<T & { deadline: number }> {
	const response = await fetch(url, body === undefined ? { method: "POST" } : {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	});
	if (!response.ok) throw new RequestError(response.status, await attachmentResponseError(response));
	const grant = await response.json() as T;
	return { ...grant, deadline: localDeadline(grant.expiresAt, response.headers.get("date")) };
}

export function useAttachmentDraft(chatId?: string) {
	const [enabled, setEnabled] = useState(false);
	const [folders, setFolders] = useState(false);
	const [statusChecks, setStatusChecks] = useState(false);
	const [validation, setValidation] = useState<string>();
	const [, redraw] = useState(0);
	const files = useRef<DraftFile[]>([]);
	const openingDraft = useRef<string>(null);
	const lastSend = useRef<{ identity: string; id: string }>(null);
	const changed = () => redraw(n => n + 1);
	useEffect(() => {
		if (window.lh?.getPathForFile) return;
		const controller = new AbortController();
		void fetch(PROTOCOL_ROUTES.serverInfo, { signal: controller.signal })
			.then(async response => response.ok ? response.json() as Promise<ServerInfo> : undefined)
			.then(info => {
				if (!info || !Array.isArray(info.capabilities)) return;
				setEnabled(hasCapability(info, ATTACHMENT_UPLOADS));
				setFolders(hasCapability(info, ATTACHMENT_FOLDERS));
				setStatusChecks(hasCapability(info, ATTACHMENT_STATUS));
			})
			.catch(() => {});
		return () => {
			controller.abort();
			// Leaving with an upload still running cancels it and releases its
			// reservation: it is never half kept. Finished uploads stay with the
			// session's draft (lib/attachment-drafts.ts), and Back restores them.
			const leaving = files.current.filter(row => !row.ready);
			files.current = files.current.filter(row => row.ready);
			for (const row of leaving) {
				for (const upload of row.uploads) upload.abort();
				releaseGrant(row);
			}
		};
	}, []);

	const target = (): AttachmentTarget => chatId ? { chatId } : { draftId: openingDraft.current ??= randomUuid() };
	const live = (row: DraftFile) => files.current.includes(row);
	/** Keep a finished upload with the session's draft. */
	const keep = (row: DraftFile) => {
		if (!chatId || !row.grant) return;
		const base = { id: row.grant.id, name: row.name, at: Date.now() };
		storeAttachment(chatId, row.folder ? { ...base, files: folderManifest(row.folder) } : { ...base, mimeType: row.file!.type, size: row.file!.size });
	};
	const uploadFile = async (row: DraftFile) => {
		if (!row.grant?.uploadUrl || row.grant.deadline <= Date.now()) {
			if (row.grant) {
				await deleteGrant(row.grant.id);
				row.grant = undefined;
			}
			if (!live(row)) return;
			row.grant = await postGrant<AttachmentGrantResponse>(PROTOCOL_ROUTES.attachments, {
				...target(), name: row.file!.name, mimeType: row.file!.type, size: row.file!.size,
			});
		}
		if (!live(row)) return;
		await putBytes(row, row.file!, row.grant.uploadUrl!, loaded => {
			row.progress = row.file!.size ? Math.round(loaded * 100 / row.file!.size) : 0;
			changed();
		});
		return true;
	};
	// Renew grants for the files that have not arrived, a few uploads at a
	// time, until all are in. A folder whose reservation is gone starts over.
	const uploadFolder = async (row: DraftFile) => {
		const folder = row.folder!;
		const total = folder.files.reduce((sum, { file }) => sum + file.size, 0);
		const byPath = new Map(folder.files.map(({ file, path }) => [path, file]));
		// Each round finishes at least one file, so this bounds a misbehaving server.
		for (let round = 0; round <= folder.files.length + 1; round++) {
			if (!live(row)) return;
			let grants: (AttachmentFolderGrantResponse & { deadline: number }) | undefined;
			if (row.grant) {
				try { grants = await postGrant<AttachmentFolderGrantResponse>(PROTOCOL_ROUTES.renewAttachmentFolder(row.grant.id)); }
				catch (error) {
					if (!(error instanceof RequestError && error.status === 404)) throw error;
					row.grant = undefined; // Expired and collected: reserve the folder again.
					continue;
				}
			} else {
				grants = await postGrant<AttachmentFolderGrantResponse>(PROTOCOL_ROUTES.attachments, { ...target(), name: folder.name, files: folderManifest(folder) });
				row.grant = { id: grants.id, deadline: grants.deadline };
			}
			if (!grants.files.length) return true;
			const loaded = new Map<string, number>();
			const base = total - grants.files.reduce((sum, { path }) => sum + (byPath.get(path)?.size ?? 0), 0);
			const report = () => {
				row.progress = total ? Math.round((base + [...loaded.values()].reduce((sum, value) => sum + value, 0)) * 100 / total) : 0;
				changed();
			};
			const queue = [...grants.files];
			let failure: unknown;
			let finished = 0;
			await Promise.all(Array.from({ length: FOLDER_UPLOADS_AT_ONCE }, async () => {
				for (let next = queue.shift(); next && failure === undefined && live(row) && Date.now() < grants.deadline - 30_000; next = queue.shift()) {
					const file = byPath.get(next.path);
					if (!file) { failure = new Error("Upload failed. Try again."); return; }
					try {
						await putBytes(row, file, next.uploadUrl, value => { loaded.set(next!.path, value); report(); });
						loaded.set(next.path, file.size);
						finished++;
					} catch (error) { failure ??= error; }
				}
			}));
			if (failure !== undefined) throw failure;
			if (!finished && live(row)) break;
		}
		throw new Error("Upload failed. Try again.");
	};
	const start = (row: DraftFile) => {
		if (row.work || !live(row)) return;
		row.ready = false;
		row.error = undefined;
		row.progress = 0;
		row.work = (async () => {
			try {
				if (await (row.folder ? uploadFolder(row) : uploadFile(row))) {
					row.ready = true;
					if (live(row)) keep(row);
				}
			} catch (error) {
				row.error = error instanceof Error ? error.message : "Upload failed. Try again.";
			} finally {
				row.work = undefined;
				changed();
			}
		})();
		changed();
	};
	const add = (rows: DraftFile[]) => {
		files.current = [...files.current, ...rows];
		for (const row of rows) start(row);
	};
	/** Add the files, or return the limit they exceed. */
	const addFiles = (selected: File[]): string | undefined => {
		const error = attachmentLimitError([...limitInputs(files.current), ...selected.map(file => ({ name: file.name, mimeType: file.type, size: file.size }))]);
		if (!error) add(selected.map(file => ({ key: randomUuid(), name: file.name, file, uploads: new Set(), ready: false, progress: 0 })));
		return error;
	};
	/** Reject the whole folder before any bytes upload; keep the rest of the draft. */
	const addFolder = (pick: FolderPick): string | undefined => {
		if ("error" in pick) return pick.error;
		const manifest = folderManifest(pick);
		const error = folderPathError(pick.name, manifest) ?? folderLimitError(pick.name, manifest) ??
			attachmentLimitError([...limitInputs(files.current), ...folderFilesAsAttachments(manifest)]);
		if (!error) add([{ key: randomUuid(), name: pick.name, folder: pick, uploads: new Set(), ready: false, progress: 0 }]);
		return error;
	};
	const select = (selected: File[]) => { setValidation(addFiles(selected)); };
	const selectFolder = (selected: File[]) => { if (selected.length) setValidation(addFolder(folderFromFiles(selected))); };
	// One line per rejected item, so a later accepted folder hides none.
	const drop = async (entries: readonly FileSystemEntry[], plain: readonly File[]) => {
		let dropped: Awaited<ReturnType<typeof droppedAttachments>>;
		try { dropped = await droppedAttachments(entries); }
		catch { setValidation("Upload failed. Try again."); return; }
		const loose = [...dropped.files, ...plain];
		const errors = [loose.length ? addFiles(loose) : undefined, ...dropped.folders.map(addFolder)].filter(error => error !== undefined);
		setValidation(errors.length ? errors.join("\n") : undefined);
	};
	const remove = (row: DraftFile) => {
		files.current = files.current.filter(file => file !== row);
		if (chatId && row.grant) dropStoredAttachments(chatId, [row.grant.id]);
		releaseGrant(row);
		setValidation(undefined);
		changed();
	};
	const prepare = async (identity: string, onUnavailable?: () => void): Promise<AttachmentSend | null> => {
		const selected = files.current;
		await Promise.all(selected.map(row => row.work));
		if (files.current !== selected || selected.some(row => !row.ready || !row.grant)) {
			onUnavailable?.();
			return null;
		}
		const attachmentUploadIds = selected.map(row => row.grant!.id);
		const key = JSON.stringify([identity, attachmentUploadIds]);
		if (lastSend.current?.identity !== key) lastSend.current = { identity: key, id: randomUuid() };
		return { attachmentUploadIds, sendId: lastSend.current.id };
	};
	const accept = (send: AttachmentSend) => {
		files.current = files.current.filter(row => !row.grant || !send.attachmentUploadIds.includes(row.grant.id));
		if (chatId) dropStoredAttachments(chatId, send.attachmentUploadIds);
		setValidation(undefined);
		changed();
	};
	// Restore the session's finished uploads when Back returns to it. Each
	// chip shows at once and Send waits for the server's answer, like for a
	// running upload: a 404 (expired, removed, sent meanwhile) drops the chip
	// quietly and a send waiting on it stops, keeping the draft. Any other
	// failure keeps the chip; the send checks it again.
	const restorable = enabled && statusChecks;
	useEffect(() => {
		if (!chatId || !restorable) return;
		const restored = readStoredAttachments(chatId)
			.filter(stored => !files.current.some(row => row.grant?.id === stored.id))
			.map((stored): DraftFile => ({ key: randomUuid(), name: stored.name, stored, grant: { id: stored.id, deadline: 0 }, uploads: new Set(), ready: true, progress: 100 }));
		if (!restored.length) return;
		files.current = [...files.current, ...restored];
		for (const row of restored) {
			row.work = (async () => {
				try {
					const response = await fetch(PROTOCOL_ROUTES.attachmentStatus(row.grant!.id, chatId));
					if (response.status !== 404 || !live(row)) return;
					files.current = files.current.filter(file => file !== row);
					dropStoredAttachments(chatId, [row.grant!.id]);
				} catch { /* Offline: keep the chip. */ }
				finally { row.work = undefined; changed(); }
			})();
		}
		changed();
	}, [chatId, restorable]);
	// A send accepted after the learner left and came back dropped these.
	useEffect(() => onStoredAttachmentsDropped((id, ids) => {
		if (id !== chatId || !files.current.some(row => row.grant && ids.includes(row.grant.id))) return;
		files.current = files.current.filter(row => !row.grant || !ids.includes(row.grant.id));
		changed();
	}), [chatId]);
	return {
		enabled, folders: enabled && folders, files: files.current, validation, getDraftId: () => openingDraft.current ??= randomUuid(),
		select, selectFolder, drop, remove, retry: start, prepare, accept,
	};
}

export type AttachmentDraft = ReturnType<typeof useAttachmentDraft>;

function folderLabel(name: string, count: number): string {
	return `${name} · ${count} ${count === 1 ? "file" : "files"}`;
}

/** Always mounted while uploads are enabled: the page drop zone hands
 * dropped files and folders to this element. */
export function DraftAttachmentChips({ draft, disabled = false }: { draft: AttachmentDraft; disabled?: boolean }) {
	const root = useRef<HTMLDivElement>(null);
	const { drop, enabled } = draft;
	useEffect(() => {
		const element = root.current;
		if (!element || disabled) return; // Like the paperclip while a turn runs.
		const receive = (event: Event) => {
			const { entries, files } = (event as CustomEvent<{ entries: FileSystemEntry[]; files: File[] }>).detail;
			void drop(entries, files);
		};
		element.addEventListener(ATTACHMENT_DROP_EVENT, receive);
		return () => element.removeEventListener(ATTACHMENT_DROP_EVENT, receive);
	}, [drop, enabled, disabled]);
	if (!draft.enabled && !draft.files.length && !draft.validation) return null;
	const empty = !draft.files.length && !draft.validation;
	return (
		<div ref={root} data-attachment-upload={disabled ? "busy" : ""} className={empty ? "w-full" : "w-full space-y-1 px-2.5 pt-2"}>
			{!empty && <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
				{draft.files.map(row => {
					const count = folderCount(row);
					const Icon = count === undefined ? PaperclipIcon : FolderIcon;
					const label = count === undefined ? row.name : folderLabel(row.name, count);
					return (
						<div key={row.key} className="flex min-w-0 items-center gap-2 rounded border px-2 py-1 text-xs">
							<Icon className="size-3 shrink-0" aria-hidden="true" />
							<span className="max-w-64 truncate" title={label}>{label}</span>
							{row.error ? (
								<>
									<span role="alert" className="text-destructive">{row.error}</span>
									<button type="button" className="underline" onClick={() => draft.retry(row)}>Retry</button>
								</>
							) : !row.ready && <progress aria-label={`Uploading ${row.name}`} max={100} value={row.progress} className="w-16" />}
							<button type="button" className="underline" aria-label={`Remove ${row.name}`} onClick={() => draft.remove(row)}>Remove</button>
						</div>
					);
				})}
			</div>}
			{draft.files.map(row => row.folder?.skippedCount
				? <p key={row.key} role="status" className="text-xs text-muted-foreground">{skippedFolderNotice(row.name, row.folder.skippedCount, row.folder.skippedNames)}</p>
				: null)}
			{draft.validation?.split("\n").map((line, index) => <p key={index} role="alert" className="text-xs text-destructive">{line}</p>)}
		</div>
	);
}

export function SavedAttachmentChips({ files, unavailable }: { files: readonly AttachmentReference[]; unavailable: ReadonlySet<string> }) {
	return (
		<div className="flex flex-wrap gap-1 py-1">
			{files.map(({ id, name, fileCount }) => {
				const Icon = fileCount === undefined ? PaperclipIcon : FolderIcon;
				return (
					<div key={id} className="flex min-w-0 items-center gap-2 rounded border px-2 py-1">
						<Icon className="size-3 shrink-0" aria-hidden="true" />
						<span className="break-all">{fileCount === undefined ? name : folderLabel(name, fileCount)}</span>
						{unavailable.has(id) && <span className="text-muted-foreground">{ATTACHMENT_UNAVAILABLE}</span>}
					</div>
				);
			})}
		</div>
	);
}

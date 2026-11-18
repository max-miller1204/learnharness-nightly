"use client";

import { useEffect, useRef, useState } from "react";
import { PaperclipIcon } from "lucide-react";
import { ATTACHMENT_UPLOADS, hasCapability, PROTOCOL_ROUTES, type AttachmentGrantResponse, type AttachmentSend, type AttachmentTarget, type ServerInfo } from "@/src/core";
import { attachmentLimitError, ATTACHMENT_UNAVAILABLE } from "@/src/core";
import type { AttachmentReference } from "@/src/core";

interface DraftFile {
	key: string;
	file: File;
	grant?: AttachmentGrantResponse;
	upload?: XMLHttpRequest;
	work?: Promise<void>;
	progress: number;
	ready: boolean;
	error?: string;
}

function uuid(): string {
	// getRandomValues also works on paired HTTP origins without randomUUID().
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6]! & 15) | 64;
	bytes[8] = (bytes[8]! & 63) | 128;
	const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
	return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
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

function putBytes(row: DraftFile, url: string, changed: () => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const upload = new XMLHttpRequest();
		row.upload = upload;
		upload.open("PUT", url);
		upload.upload.onprogress = event => {
			row.progress = event.lengthComputable && event.total ? Math.round(event.loaded * 100 / event.total) : 0;
			changed();
		};
		upload.onload = () => {
			if (upload.status === 204) { resolve(); return; }
			let message = "Upload failed. Try again.";
			try { message = JSON.parse(upload.responseText).error || message; } catch { /* Non-JSON proxy error. */ }
			reject(new Error(message));
		};
		upload.onerror = upload.onabort = () => reject(new Error("Upload interrupted. Try again."));
		upload.send(row.file);
	});
}

export function useAttachmentDraft(chatId?: string) {
	const [enabled, setEnabled] = useState(false);
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
			.then(info => { if (info && Array.isArray(info.capabilities)) setEnabled(hasCapability(info, ATTACHMENT_UPLOADS)); })
			.catch(() => {});
		return () => {
			controller.abort();
			for (const row of files.current) row.upload?.abort();
		};
	}, []);

	const target = (): AttachmentTarget => chatId ? { chatId } : { draftId: openingDraft.current ??= uuid() };
	const start = (row: DraftFile) => {
		if (row.work || !files.current.includes(row)) return;
		row.ready = false;
		row.error = undefined;
		row.progress = 0;
		row.work = (async () => {
			try {
				if (!row.grant || row.grant.expiresAt <= Date.now()) {
					if (row.grant) {
						await deleteGrant(row.grant.id);
						row.grant = undefined;
					}
					if (!files.current.includes(row)) return;
					const response = await fetch(PROTOCOL_ROUTES.attachments, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ ...target(), name: row.file.name, mimeType: row.file.type, size: row.file.size }),
					});
					if (!response.ok) throw new Error(await attachmentResponseError(response));
					row.grant = await response.json() as AttachmentGrantResponse;
				}
				if (!files.current.includes(row)) return;
				await putBytes(row, row.grant.uploadUrl, changed);
				row.ready = true;
			} catch (error) {
				row.error = error instanceof Error ? error.message : "Upload failed. Try again.";
			} finally {
				row.upload = undefined;
				row.work = undefined;
				changed();
			}
		})();
		changed();
	};
	const select = (selected: File[]) => {
		const error = attachmentLimitError([...files.current.map(row => row.file), ...selected].map(file => ({
			name: file.name, mimeType: file.type, size: file.size,
		})));
		setValidation(error);
		if (error) return;
		const added = selected.map(file => ({ key: uuid(), file, ready: false, progress: 0 }));
		files.current = [...files.current, ...added];
		for (const row of added) start(row);
	};
	const remove = (row: DraftFile) => {
		files.current = files.current.filter(file => file !== row);
		// Wait for a running put to settle before asking the server to release
		// its reservation. View teardown can still interrupt the upload.
		void (async () => {
			await row.work;
			if (row.grant) await deleteGrant(row.grant.id);
		})().catch(() => { /* The server also expires abandoned grants. */ });
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
		if (lastSend.current?.identity !== key) lastSend.current = { identity: key, id: uuid() };
		return { attachmentUploadIds, sendId: lastSend.current.id };
	};
	const accept = (send: AttachmentSend) => {
		files.current = files.current.filter(row => !row.grant || !send.attachmentUploadIds.includes(row.grant.id));
		setValidation(undefined);
		changed();
	};
	return { enabled, files: files.current, validation, getDraftId: () => openingDraft.current ??= uuid(), select, remove, retry: start, prepare, accept };
}

export type AttachmentDraft = ReturnType<typeof useAttachmentDraft>;

export function DraftAttachmentChips({ draft }: { draft: AttachmentDraft }) {
	if (!draft.files.length && !draft.validation) return null;
	return (
		<div className="w-full space-y-1 px-2.5 pt-2">
			<div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
				{draft.files.map(row => (
					<div key={row.key} className="flex min-w-0 items-center gap-2 rounded border px-2 py-1 text-xs">
						<PaperclipIcon className="size-3 shrink-0" aria-hidden="true" />
						<span className="max-w-64 truncate" title={row.file.name}>{row.file.name}</span>
						{row.error ? (
							<>
								<span role="alert" className="text-destructive">{row.error}</span>
								<button type="button" className="underline" onClick={() => draft.retry(row)}>Retry</button>
							</>
						) : !row.ready && <progress aria-label={`Uploading ${row.file.name}`} max={100} value={row.progress} className="w-16" />}
						<button type="button" className="underline" aria-label={`Remove ${row.file.name}`} onClick={() => draft.remove(row)}>Remove</button>
					</div>
				))}
			</div>
			{draft.validation && <p role="alert" className="text-xs text-destructive">{draft.validation}</p>}
		</div>
	);
}

export function SavedAttachmentChips({ files, unavailable }: { files: readonly AttachmentReference[]; unavailable: ReadonlySet<string> }) {
	return (
		<div className="flex flex-wrap gap-1 py-1">
			{files.map(({ id, name }) => (
				<div key={id} className="flex min-w-0 items-center gap-2 rounded border px-2 py-1">
					<PaperclipIcon className="size-3 shrink-0" aria-hidden="true" />
					<span className="break-all">{name}</span>
					{unavailable.has(id) && <span className="text-muted-foreground">{ATTACHMENT_UNAVAILABLE}</span>}
				</div>
			))}
		</div>
	);
}

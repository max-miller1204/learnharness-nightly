import { isImportable, MAX_IMPORT_BYTES, validNotesPath } from "@/lib/notes-import-limits";
import { convertHeicToJpeg, heicFailureMessage, isHeicImageFile } from "@/lib/heic";
import type { NotesImportResult } from "./notes-import";
import { extensionLabel } from "./notes-import-folder";

export const notesPath = (file: File): string => file.webkitRelativePath || file.name;
/** Folder imports silently exclude dot-prefixed files and directories below
 * the chosen root. The root is segment 0 and stays importable even when hidden. */
const hiddenInFolder = (file: File): boolean => file.webkitRelativePath.split("/").slice(1).some((part) => part.startsWith("."));
/** One line per reason for a whole pick, so a big folder cannot flood the error list. */
export const unsupportedSummary = (extensions: readonly string[]): string =>
	`Skipped ${extensions.length} ${extensions.length === 1 ? "file that isn't" : "files that aren't"} a supported type (${[...new Set(extensions)].join(", ")}).`;
export const unsafeSummary = (count: number): string =>
	`Skipped ${count} ${count === 1 ? "file with a name" : "files with names"} the import can't use (e.g. a ':' in the name).`;
export interface ImportQueueSnapshot {
	importing: boolean;
	errors: string[];
	notices: string[];
	completion: number;
}
export const EMPTY_IMPORT_QUEUE: ImportQueueSnapshot = { importing: false, errors: [], notices: [], completion: 0 };

/** PR198's refill-on-completion, one-request-per-file transport, extended to
 * accept later selections. One instance per page, NOT three workers per click.
 * Only pending/in-flight Files are retained; no retry or persisted upload queue. */
export function createNotesImportQueue(post: (files: readonly File[], group?: string) => Promise<NotesImportResult[]>) {
	const listeners = new Set<() => void>();
	/** One file, or one folder's grouped code (item 26). */
	const pending: ({ file: File; index: number } | { group: string; label: string; files: File[]; index: number })[] = [];
	const failures = new Map<number, string>();
	const notices = new Map<number, string>();
	let active = 0, sequence = 0;
	let snapshot = EMPTY_IMPORT_QUEUE;
	const ordered = (map: Map<number, string>) => [...map].sort(([a], [b]) => a - b).map(([, text]) => text);
	const publish = (completed = false) => {
		snapshot = { importing: active > 0 || pending.length > 0, errors: ordered(failures), notices: ordered(notices), completion: snapshot.completion + Number(completed) };
		for (const listener of [...listeners]) listener();
	};
	// Normalize a synchronously throwing transport to the same async settlement.
	// HEIC photos become JPEG here, just before upload (T3's attachment flow).
	const send = async (file: File) => {
		if (!isHeicImageFile(file)) return post([file]);
		const converted = await convertHeicToJpeg(file);
		if (!converted.ok) throw new Error(heicFailureMessage(converted.reason));
		// Keep the folder-relative identity: the server matches the path to the uploaded name.
		if (file.webkitRelativePath) Object.defineProperty(converted.file, "webkitRelativePath", { value: file.webkitRelativePath });
		return post([converted.file]);
	};
	function pump(): void {
		while (active < 3 && pending.length > 0) {
			const item = pending.shift()!;
			const { index } = item;
			// A group's lines read "my-app (48 code files): ..." like its dock row.
			const label = "group" in item ? item.label : notesPath(item.file);
			active++;
			void (async () => {
				try {
					const [r] = "group" in item ? await post(item.files, item.group) : await send(item.file);
					if (!r) throw new Error("Invalid import response. Check the graph before retrying.");
					if (!r.ok) {
						const details = [r.provider, r.missing?.join(", "), r.slots?.join(", ")].filter(Boolean);
						failures.set(index, `${"group" in item ? label : r.filePath}: ${r.error}${r.code ? `\n${[r.code, ...details].join(" — ")}` : ""}`);
					} else if (r.notice) notices.set(index, `${"group" in item ? label : r.filePath}: ${r.notice}`);
				} catch (error) {
					// Never retry an ambiguous response: the merge may have committed.
					failures.set(index, `${label}: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					active--;
					pump();
					publish(active === 0 && pending.length === 0);
				}
			})();
		}
	}
	return {
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		append(files: readonly File[]) {
			if (files.length === 0) return;
			if (!snapshot.importing) { failures.clear(); notices.clear(); sequence = 0; }
			// Unsafe names and unsupported types are summed up per pick; each summary sits where its first file was.
			const unsafe: number[] = [], unsupported: { index: number; extension: string }[] = [];
			for (const file of files) {
				const index = sequence++;
				const path = notesPath(file);
				if (file.webkitRelativePath && hiddenInFolder(file)) continue;
				if (!validNotesPath(path, file.name)) unsafe.push(index);
				else if (!isImportable(file.name)) unsupported.push({ index, extension: extensionLabel(file.name) });
				else if (file.size > MAX_IMPORT_BYTES) failures.set(index, `${path}: Too big. Max 25 MB.`);
				else pending.push({ file, index });
			}
			if (unsafe.length > 0) failures.set(unsafe[0]!, unsafeSummary(unsafe.length));
			if (unsupported.length > 0) failures.set(unsupported[0]!.index, unsupportedSummary(unsupported.map(({ extension }) => extension)));
			const hadWork = active > 0 || pending.length > 0;
			pump();
			publish(!hadWork);
		},
		/** A folder's code as one source (item 26): one request with every file. */
		appendGroup(group: string, files: readonly File[]) {
			if (files.length === 0) return;
			if (!snapshot.importing) { failures.clear(); notices.clear(); sequence = 0; }
			pending.push({ group, label: `${group} (${files.length} code ${files.length === 1 ? "file" : "files"})`, files: [...files], index: sequence++ });
			pump();
			publish();
		},
		/** Lines a folder review already worked out (skips, caps), placed in selection order. */
		report(lines: readonly string[]) {
			if (lines.length === 0) return;
			if (!snapshot.importing) { failures.clear(); notices.clear(); sequence = 0; }
			for (const line of lines) failures.set(sequence++, line);
			publish();
		},
	};
}

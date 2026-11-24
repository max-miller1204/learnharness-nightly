import { createGitignoreFilter, parseIgnoreFile, type IgnoreFile } from "@/lib/ignore-patterns";
import {
	CODE_CAP_MESSAGE, EXCLUDED_FOLDERS, excludedFileName, extensionLabel, importKind, MAX_CODE_FILE_BYTES, MAX_CODE_FILES,
	MAX_CODE_TOTAL_BYTES, MAX_IMPORT_BYTES, notesPath as relativePath, unsafeSummary, unsupportedSummary, validNotesPath,
} from "@/lib/notes-import-limits";
import type { ImportEstimateInput } from "@/lib/notes-import-estimate";

export { extensionLabel, relativePath };

/** The browser's measures for the estimate endpoint (docs/specs/extract-more-types.md, "Folder picks"). */
export type FolderMeasures = ImportEstimateInput;

/** A folder pick, sorted: what each source will be, what was skipped, and the estimate inputs. */
export interface FolderPlan {
	/** The picked folder's name (segment 0 of every relative path). */
	root: string;
	/** One source per file: notes, PDFs, documents, images. */
	files: File[];
	/** The folder's code, one grouped source (empty when there is none or it is over the caps). */
	code: File[];
	/** Set when the folder had code but it is over the caps. */
	codeSkipped?: string;
	/** Hidden, .gitignore'd and default-excluded paths. */
	ignored: number;
	/** Paths of files over 25 MB. */
	oversized: string[];
	/** Code files over 100 KB (usually generated). */
	codeTooLarge: number;
	/** Code files with a NUL byte in their first 8 KB (binary, or UTF-16): the server would refuse the group. */
	codeNotText: number;
	/** Extensions (or "no extension") of files no kind takes. */
	unsupported: string[];
	/** Names the import can't use (e.g. a ':' in the name). */
	unsafe: number;
	measures: FolderMeasures;
}

/** Hidden (dot-prefixed) segments and default-excluded folders below the picked root, or an excluded file name.
 * The root is segment 0 and stays importable even when hidden. */
function excluded(path: string): boolean {
	const parts = path.split("/");
	const below = parts.slice(1);
	return below.some((part) => part.startsWith(".")) || below.slice(0, -1).some((part) => EXCLUDED_FOLDERS.has(part)) || excludedFileName(parts.at(-1)!);
}

/** Sort a folder pick into sources. Reads every `.gitignore` first (the hidden rule would drop them), then the
 * text of notes and code files to measure them. */
export async function planFolder(picked: readonly File[]): Promise<FolderPlan> {
	const root = relativePath(picked[0]!).split("/")[0]!;
	const ignoreFiles = new Map<string, IgnoreFile>();
	for (const file of picked) {
		const path = relativePath(file);
		if (file.name !== ".gitignore" || excluded(path.split("/").slice(0, -1).join("/") + "/x")) continue;
		// git ignores a leading UTF-8 byte order mark.
		ignoreFiles.set(path.split("/").slice(0, -1).join("/"), parseIgnoreFile((await file.text()).replace(/^\uFEFF/, "")));
	}
	const gitignored = createGitignoreFilter(ignoreFiles);
	const plan: FolderPlan = { root, files: [], code: [], ignored: 0, oversized: [], codeTooLarge: 0, codeNotText: 0, unsupported: [], unsafe: 0,
		measures: { sources: 0, notesChars: 0, codeChars: 0, images: 0, pdfBytes: 0, documentBytes: 0 } };
	let codeBytes = 0;
	for (const file of [...picked].sort((a, b) => relativePath(a).localeCompare(relativePath(b)))) {
		const path = relativePath(file);
		if (excluded(path) || gitignored(path)) { plan.ignored++; continue; }
		if (!validNotesPath(path, file.name)) { plan.unsafe++; continue; }
		const kind = importKind(file.name);
		if (!kind) { plan.unsupported.push(extensionLabel(file.name)); continue; }
		if (file.size > MAX_IMPORT_BYTES) { plan.oversized.push(path); continue; }
		if (kind === "code" && file.size > MAX_CODE_FILE_BYTES) { plan.codeTooLarge++; continue; }
		if (kind === "code") {
			// The server's binary check, run here so one unreadable file can't fail the whole group (owner, 2026-11-17).
			if (new Uint8Array(await file.slice(0, 8192).arrayBuffer()).includes(0)) { plan.codeNotText++; continue; }
			plan.code.push(file);
			codeBytes += file.size;
			continue;
		}
		plan.files.push(file);
		if (kind === "notes") plan.measures.notesChars += (await file.text()).length;
		else if (kind === "image") plan.measures.images++;
		else if (kind === "pdf") plan.measures.pdfBytes += file.size;
		else plan.measures.documentBytes += file.size;
	}
	if (plan.code.length > MAX_CODE_FILES || codeBytes > MAX_CODE_TOTAL_BYTES) {
		plan.code = [];
		plan.codeSkipped = CODE_CAP_MESSAGE;
	}
	for (const file of plan.code) plan.measures.codeChars += (await file.text()).length;
	plan.measures.sources = plan.files.length + (plan.code.length > 0 ? 1 : 0);
	return plan;
}

/** The error-list lines a confirmed folder adds, as the queue words them for file picks. */
export function planSummaries(plan: FolderPlan): string[] {
	return [
		...plan.oversized.map((path) => `${path}: Too big. Max 25 MB.`),
		...(plan.unsupported.length > 0 ? [unsupportedSummary(plan.unsupported)] : []),
		...(plan.unsafe > 0 ? [unsafeSummary(plan.unsafe)] : []),
		...(plan.codeTooLarge > 0 ? [`Skipped ${plan.codeTooLarge} code ${plan.codeTooLarge === 1 ? "file" : "files"} over 100 KB.`] : []),
		...(plan.codeNotText > 0 ? [`Skipped ${plan.codeNotText} code ${plan.codeNotText === 1 ? "file that isn't" : "files that aren't"} plain text.`] : []),
		...(plan.codeSkipped ? [`${plan.root}: ${plan.codeSkipped}`] : []),
	];
}

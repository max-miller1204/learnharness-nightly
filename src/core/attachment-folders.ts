import { attachmentLimitError } from "./attachment-limits.ts";

const MiB = 1024 * 1024;

export const MAX_FOLDER_FILES = 100;
export const MAX_FOLDER_BYTES = 256 * MiB;

export const FOLDER_PICK_UNSUPPORTED = "This browser can't attach folders. Attach individual files instead.";

/** One file of a folder manifest. `path` is relative to the folder root and
 * excludes the folder's own name. */
export interface FolderFile {
	path: string;
	mimeType: string;
	size: number;
}

const JUNK_FILES = new Set(["thumbs.db", "desktop.ini"]);
const JUNK_FOLDERS = new Set(["__macosx"]);

/** Index of the first hidden or OS junk segment below the folder root, or -1.
 * The composer skips these before counting; the server accepts them. */
export function skippedFolderSegment(segments: readonly string[]): number {
	return segments.findIndex((segment, index) => segment.startsWith(".") ||
		(index < segments.length - 1 ? JUNK_FOLDERS.has(segment.toLowerCase()) : JUNK_FILES.has(segment.toLowerCase())));
}

/** Windows device names, also with spaces or dots before an extension
 * ("CON .txt"), which Windows trims back to the device. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])[ .]*(?:\..*)?$/i;

function unsafeSegment(segment: string): boolean {
	return !segment || segment === "." || segment === ".." || /[<>:"|?*\\\x00-\x1f\x7f-\x9f]/.test(segment) ||
		/[. ]$/.test(segment) || DEVICE_NAME.test(segment) || new TextEncoder().encode(segment).length > 255;
}

/** Absolute paths, traversal, malformed separators, device names and other
 * names a server filesystem could misread. */
export function unsafeFolderPath(path: string): boolean {
	return !path || path.length > 1024 || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").some(unsafeSegment);
}

export function unsafeFolderPathError(folder: string, path: string): string {
	return `${JSON.stringify(`${folder}/${path}`)} is not a safe file path. Rename it or attach a different folder.`;
}

/** Whole-folder rejection before any bytes: unsafe paths, then duplicate
 * destinations and file/folder collisions, compared ignoring case. */
export function folderPathError(folder: string, files: readonly FolderFile[]): string | undefined {
	if (!files.length) return `${folder} has no files to attach.`;
	const filesSeen = new Set<string>();
	const folders = new Set<string>();
	for (const { path } of files) {
		if (unsafeFolderPath(path)) return unsafeFolderPathError(folder, path);
		const key = path.normalize("NFC").toLowerCase();
		const parents = key.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));
		if (filesSeen.has(key) || folders.has(key) || parents.some(parent => filesSeen.has(parent))) return unsafeFolderPathError(folder, path);
		filesSeen.add(key);
		for (const parent of parents) folders.add(parent);
	}
}

export function folderFileCountError(folder: string): string {
	return `${folder} has more than 100 files. Attach up to 100 files per folder.`;
}

export function folderLimitError(folder: string, files: readonly FolderFile[]): string | undefined {
	if (files.length > MAX_FOLDER_FILES) return folderFileCountError(folder);
	if (files.reduce((total, { size }) => total + size, 0) > MAX_FOLDER_BYTES) return `${folder} exceeds the 256 MiB per-folder limit.`;
	return attachmentLimitError(folderFilesAsAttachments(files));
}

/** Each contained file counts toward PR 1's per-file and per-message limits. */
export function folderFilesAsAttachments(files: readonly FolderFile[]): { name: string; mimeType: string; size: number }[] {
	return files.map(({ path, mimeType, size }) => ({ name: path.slice(path.lastIndexOf("/") + 1), mimeType, size }));
}

export function skippedFolderNotice(folder: string, count: number, names: readonly string[]): string {
	const shown = names.slice(0, 5).join(", ");
	const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
	return `Skipped ${count} hidden or system ${count === 1 ? "file" : "files"} in ${folder}: ${shown}${more}`;
}

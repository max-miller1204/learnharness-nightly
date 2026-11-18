import { FOLDER_PICK_UNSUPPORTED, skippedFolderSegment } from "@/src/core";

/** A folder ready for its manifest: every path is relative to the folder
 * root, without the folder's name. Hidden and OS junk entries are already out. */
export interface PickedFolder {
	name: string;
	files: { file: File; path: string }[];
	skippedCount: number;
	/** First hidden or junk entry per skipped branch, e.g. ".git/" or "sub/Thumbs.db". */
	skippedNames: string[];
}

export type FolderPick = PickedFolder | { error: string };

/** The one place a picked or dropped folder becomes a PickedFolder. Each
 * relative path starts with the folder's own name. A browser that accepts
 * the folder input but returns plain files (iOS before 18.4, Android Chrome
 * before 132) gives no relative paths, so nothing uploads. */
export function folderFromPick(picked: readonly { file: File; relativePath: string }[]): FolderPick {
	const name = picked[0]?.relativePath.split("/")[0];
	if (!name || picked.some(({ relativePath }) => !relativePath.includes("/") || relativePath.split("/")[0] !== name)) {
		return { error: FOLDER_PICK_UNSUPPORTED };
	}
	const files: PickedFolder["files"] = [];
	const skipped = new Set<string>();
	let skippedCount = 0;
	for (const { file, relativePath } of picked) {
		const below = relativePath.split("/").slice(1);
		const index = skippedFolderSegment(below);
		if (index === -1) { files.push({ file, path: below.join("/") }); continue; }
		skippedCount++;
		skipped.add(below.slice(0, index + 1).join("/") + (index < below.length - 1 ? "/" : ""));
	}
	files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	return { name, files, skippedCount, skippedNames: [...skipped] };
}

/** A folder input's pick (`<input webkitdirectory>`). */
export function folderFromFiles(files: readonly File[]): FolderPick {
	return folderFromPick(files.map(file => ({ file, relativePath: file.webkitRelativePath ?? "" })));
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
	return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
	return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Walk a dropped directory. A reader returns entries in batches, so read
 * until an empty batch. */
async function walk(entry: FileSystemDirectoryEntry, out: { file: File; relativePath: string }[]): Promise<void> {
	const reader = entry.createReader();
	for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
		for (const child of batch) {
			if (child.isDirectory) await walk(child as FileSystemDirectoryEntry, out);
			else if (child.isFile) out.push({ file: await entryFile(child as FileSystemFileEntry), relativePath: child.fullPath.replace(/^\//, "") });
		}
	}
}

/** Dropped items, read from `DataTransferItem.webkitGetAsEntry()` during the
 * drop event: plain files, and each directory as its own folder. */
export async function droppedAttachments(entries: readonly FileSystemEntry[]): Promise<{ files: File[]; folders: FolderPick[] }> {
	const files: File[] = [];
	const folders: FolderPick[] = [];
	for (const entry of entries) {
		if (entry.isFile) files.push(await entryFile(entry as FileSystemFileEntry));
		else if (entry.isDirectory) {
			const picked: { file: File; relativePath: string }[] = [];
			await walk(entry as FileSystemDirectoryEntry, picked);
			folders.push(picked.length ? folderFromPick(picked) : { error: `${entry.name} has no files to attach.` });
		}
	}
	return { files, folders };
}

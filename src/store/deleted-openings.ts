import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const directory = path.join(/* turbopackIgnore: true */ PATHS.data, "deleted-openings");
const markerFile = (id: string) => path.join(/* turbopackIgnore: true */ directory, id);
const openingId = (id: string) => /^chat_[a-f0-9]{64}$/.test(id);

export function markDeletedOpening(id: string): void {
	if (!openingId(id)) return;
	fs.mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true, mode: 0o700 });
	writeFileAtomicSync(/* turbopackIgnore: true */ markerFile(id), "1", { mode: 0o600 });
}

export function wasOpeningDeleted(id: string): boolean {
	if (!openingId(id)) return false;
	try {
		const info = fs.lstatSync(/* turbopackIgnore: true */ markerFile(id));
		if (!info.isFile()) throw new Error("Invalid deleted opening marker");
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

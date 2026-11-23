import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const directory = path.join(PATHS.data, "deleted-openings");
const openingId = (id: string) => /^chat_[a-f0-9]{64}$/.test(id);

export function markDeletedOpening(id: string): void {
	if (!openingId(id)) return;
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileAtomicSync(path.join(directory, id), "1", { mode: 0o600 });
}

export function wasOpeningDeleted(id: string): boolean {
	return openingId(id) && fs.existsSync(path.join(directory, id));
}

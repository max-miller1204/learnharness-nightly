/**
 * Log bounding (T3 Code's boundServiceLog). The service manager and the
 * server child hold their log files open for appending, so a big log is
 * copied aside to `<log>.1` and emptied in place rather than renamed. The
 * copy is best effort: on a full disk, emptying the file is what frees space.
 */
import * as fs from "node:fs";

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_CHECK_INTERVAL_MS = 10 * 60 * 1000;

export function boundLog(logPath: string, maxBytes: number = LOG_MAX_BYTES): void {
	let size = 0;
	try {
		size = fs.statSync(logPath).size;
	} catch {
		return;
	}
	if (size <= maxBytes) return;
	const archive = `${logPath}.1`;
	const pending = `${archive}.tmp`;
	try {
		fs.copyFileSync(logPath, pending);
		fs.renameSync(pending, archive);
	} catch {
		fs.rmSync(pending, { force: true });
	}
	try {
		fs.truncateSync(logPath, 0);
	} catch {
		/* nothing else to free */
	}
}

/** Append one timestamped line; never throws (a full disk must not stop the launcher). */
export function appendLog(logPath: string, line: string): void {
	try {
		fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		/* best effort */
	}
}

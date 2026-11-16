/**
 * Locks and markers (T3 Code's serviceLauncher.ts / serviceProtocol.ts).
 *
 * Locks are exclusive SQLite transactions through node:sqlite, copied from
 * T3's tryAcquireSqliteLock: the OS drops the lock when its holder dies, so
 * a crash never leaves a stale lock behind.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Lock {
	close(): void;
}

/** Take an exclusive lock; undefined when another process holds it. */
export function tryAcquireLock(lockPath: string, busyTimeoutMs = 0): Lock | undefined {
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	const db = new DatabaseSync(lockPath);
	try {
		db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}; BEGIN EXCLUSIVE;`);
		return db;
	} catch (cause) {
		db.close();
		if (cause instanceof Error && "errcode" in cause && (cause as { errcode?: number }).errcode === 5) return undefined;
		throw cause;
	}
}

/** True when some process holds the lock right now. */
export function lockIsHeld(lockPath: string): boolean {
	if (!fs.existsSync(lockPath)) return false;
	const probe = tryAcquireLock(lockPath);
	if (!probe) return true;
	probe.close();
	return false;
}

/** Synchronous so a signal handler can write it before the child is told to stop. */
export function writeMarker(file: string, contents = ""): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, contents);
}

export function clearMarker(file: string): void {
	fs.rmSync(file, { force: true });
}

export function markerExists(file: string): boolean {
	return fs.existsSync(file);
}

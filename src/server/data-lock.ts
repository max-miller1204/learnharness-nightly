/**
 * ONE SERVER PER DATA FOLDER (self-hosting plan, modeled on T3 Code's
 * owner lock). Every LearnHarness server (self-hosted, `npm start`, dev,
 * desktop) takes an exclusive lock on <data>/.server.lock at startup and
 * holds it for its whole life. Subscription refresh serialization is
 * process-local ("use one server per credential directory",
 * docs/development.md), so two servers on one folder must fail fast
 * instead of risking corrupt records or credentials.
 *
 * The lock is an exclusive SQLite transaction through node:sqlite, exactly
 * like T3's tryAcquireSqliteLock: the OS drops it when the holder dies, so
 * there is never a stale lock file to clean up. A second server exits with
 * code 78, which the `lh` launcher answers by waiting instead of
 * restarting in a loop.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { EXIT_DATA_DIR_IN_USE } from "../../selfhost/src/protocol.ts";

type LockHandle = { close(): void };
type DatabaseSyncCtor = new (file: string) => { exec(sql: string): void; close(): void };

const KEY = Symbol.for("learnharness.data-lock");
const store = globalThis as typeof globalThis & { [KEY]?: LockHandle };

/** Try to take the exclusive lock; undefined when another process holds it. */
export async function tryAcquireDataLock(lockPath: string): Promise<LockHandle | undefined> {
	const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: DatabaseSyncCtor };
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	const db = new DatabaseSync(lockPath);
	try {
		db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
		return db;
	} catch (cause) {
		db.close();
		// SQLITE_BUSY: another server holds the folder.
		if (cause instanceof Error && "errcode" in cause && (cause as { errcode?: number }).errcode === 5) return undefined;
		throw cause;
	}
}

export function dataLockPath(dataDir: string = PATHS.data): string {
	return path.join(/* turbopackIgnore: true */ dataDir, ".server.lock");
}

/**
 * Called once from instrumentation.ts. Holds the lock in a process global
 * (Next can evaluate modules more than once). Exits with 78 when another
 * server owns the folder. An unavailable node:sqlite (not expected: Node
 * 26 and Electron 44's Node 24 both ship it) logs and continues rather
 * than blocking the app.
 */
export async function holdDataLock(dataDir: string = PATHS.data): Promise<void> {
	if (store[KEY]) return;
	const lockPath = dataLockPath(dataDir);
	let handle: LockHandle | undefined;
	try {
		handle = await tryAcquireDataLock(lockPath);
	} catch (error) {
		console.error(`[data-lock] Could not lock ${lockPath}; continuing without the one-server guard:`, error);
		return;
	}
	if (!handle) {
		console.error(`[data-lock] Another LearnHarness server is using this data folder (${dataDir}). Stop it first, or point LH_DATA_DIR somewhere else.`);
		process.exit(EXIT_DATA_DIR_IN_USE);
	}
	store[KEY] = handle;
}

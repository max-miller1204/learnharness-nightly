/**
 * Userdata snapshots taken before every version switch.
 *
 * FULL COPIES, never hard links: the app appends to some files in place
 * (graph ledgers, provider-event logs, usage.jsonl), so a hard-linked
 * snapshot would change along with the live data. On ext4 there are no
 * copy-on-write clones, so a copy costs the data's size; the launcher checks
 * free space before stopping anything (see spaceForSnapshot).
 *
 * A snapshot holds everything in userdata/ except backups/ and logs/:
 * data/, auth.json and the subscription credential files the app writes
 * beside auth.json. config.json comes along too, which is harmless.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { layout } from "./paths.ts";

export const KEEP_BACKUPS = 3;
const EXCLUDED = new Set(["backups", "logs"]);
/** Extra headroom on top of the snapshot itself (trial writes, logs). */
export const SNAPSHOT_HEADROOM_BYTES = 256 * 1024 * 1024;

function entriesToCopy(userdata: string): string[] {
	try {
		return fs.readdirSync(userdata).filter((name) => !EXCLUDED.has(name));
	} catch {
		return [];
	}
}

export function directorySize(target: string): number {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(target);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) return stat.size;
	let total = 0;
	for (const name of fs.readdirSync(target)) total += directorySize(path.join(target, name));
	return total;
}

export function snapshotSize(home: string): number {
	const { userdata } = layout(home);
	return entriesToCopy(userdata).reduce((sum, name) => sum + directorySize(path.join(userdata, name)), 0);
}

export function freeBytes(target: string): number {
	let dir = target;
	while (!fs.existsSync(dir)) dir = path.dirname(dir);
	const stats = fs.statfsSync(dir);
	return Number(stats.bavail) * Number(stats.bsize);
}

/** undefined when the snapshot fits; otherwise the reason it doesn't. */
export function spaceForSnapshot(home: string, free: (dir: string) => number = freeBytes): string | undefined {
	const needed = Math.ceil(snapshotSize(home) * 1.05) + SNAPSHOT_HEADROOM_BYTES;
	const available = free(layout(home).userdata);
	if (available >= needed) return undefined;
	const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
	return `Not enough disk space to back up your data before updating: ${mb(needed)} needed, ${mb(available)} free. The server was not stopped.`;
}

/** Copy userdata into backups/<name>/ and return its path. */
export function snapshot(home: string, name: string): string {
	const { userdata, backups } = layout(home);
	const target = path.join(backups, name);
	const temp = `${target}.tmp`;
	fs.rmSync(temp, { recursive: true, force: true });
	fs.mkdirSync(temp, { recursive: true });
	for (const entry of entriesToCopy(userdata)) {
		fs.cpSync(path.join(userdata, entry), path.join(temp, entry), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
	}
	fs.rmSync(target, { recursive: true, force: true });
	fs.renameSync(temp, target);
	return target;
}

/** Replace live userdata (except backups/ and logs/) with a snapshot. The server must be stopped. */
export function restore(home: string, backupDir: string): void {
	const { userdata } = layout(home);
	if (!fs.existsSync(backupDir)) throw new Error(`Backup not found: ${backupDir}`);
	for (const entry of entriesToCopy(userdata)) fs.rmSync(path.join(userdata, entry), { recursive: true, force: true });
	for (const entry of fs.readdirSync(backupDir)) {
		fs.cpSync(path.join(backupDir, entry), path.join(userdata, entry), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
	}
}

export function listBackups(home: string): string[] {
	const { backups } = layout(home);
	try {
		return fs.readdirSync(backups)
			.filter((name) => !name.endsWith(".tmp"))
			.map((name) => path.join(backups, name))
			.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
	} catch {
		return [];
	}
}

/** Keep the newest `keep` snapshots (and any in `protect`). */
export function pruneBackups(home: string, keep: number = KEEP_BACKUPS, protect: readonly string[] = []): void {
	const all = listBackups(home);
	const excess = all.slice(0, Math.max(0, all.length - keep));
	for (const dir of excess) if (!protect.includes(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

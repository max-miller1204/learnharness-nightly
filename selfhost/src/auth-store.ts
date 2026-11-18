/**
 * The login and pairing store (docs/specs/login-pairing.md), shared by the
 * LearnHarness server and the `lh` launcher, which writes pairing links
 * straight into it like `t3 pair` does. Node built-ins and erasable
 * TypeScript only: Node runs this file directly (type stripping) and Next
 * bundles it into the server.
 *
 * The model is T3 Code's (github.com/pingdotgg/t3code, MIT, Copyright (c)
 * 2026 T3 Tools Inc.): PairingGrantStore.ts (12-character one-time codes,
 * rejection sampling, 5 minute life) and SessionStore.ts (HMAC-signed
 * session tokens checked against a stored record, 30 day life). T3 keeps
 * these in SQLite; LearnHarness keeps files in <data folder>/auth/:
 *
 *   signing-key    32 random bytes (0600)
 *   sessions.json  { version: 1, sessions: SessionRecord[] }
 *   pairing.json   { version: 1, links: PairingLinkRecord[] } (codes hashed)
 *   .lock          held during every read-modify-write
 *
 * All file work is synchronous, so writers inside one process never
 * interleave; the lock keeps the server and `lh` apart.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 12;
export const PAIRING_TTL_MS = 5 * 60_000;
/** T3's dev-mode startup link lasts a day. */
export const DEV_STARTUP_TTL_MS = 24 * 60 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const CLI_SESSION_TTL_MS = 5 * 60_000;
export const LAST_SEEN_INTERVAL_MS = 60_000;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000;
const LOCK_STALE_MS = 10_000;
/** Longer than LOCK_STALE_MS, so a writer always outlasts a crashed one's lock. */
const LOCK_WAIT_MS = 12_000;

export type DeviceType = "desktop" | "mobile" | "tablet" | "bot" | "unknown";
export type SessionMethod = "pairing" | "desktop" | "cli";

export interface ClientInfo {
	label?: string;
	deviceType: DeviceType;
	os?: string;
	browser?: string;
	ip?: string;
	userAgent?: string;
}

export interface SessionRecord extends ClientInfo {
	id: string;
	method: SessionMethod;
	hidden?: boolean;
	issuedAt: string;
	expiresAt: string;
	lastSeenAt?: string;
	revokedAt?: string;
}

export interface PairingLinkRecord {
	id: string;
	codeHash: string;
	label?: string;
	hidden?: boolean;
	createdAt: string;
	expiresAt: string;
	consumedAt?: string;
}

interface SessionsFile { version: 1; sessions: SessionRecord[] }
interface PairingFile { version: 1; links: PairingLinkRecord[] }

export function authDir(dataDir: string): string {
	return path.join(dataDir, "auth");
}

function files(dataDir: string) {
	const dir = authDir(dataDir);
	return {
		dir,
		key: path.join(dir, "signing-key"),
		sessions: path.join(dir, "sessions.json"),
		pairing: path.join(dir, "pairing.json"),
		lock: path.join(dir, ".lock"),
	};
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// files: cached reads (keyed on inode, mtime and size; every write renames a
// new file into place, so the inode changes) and atomic writes

const cache = new Map<string, { stamp: string; value: unknown }>();

function stampOf(file: string): string | undefined {
	try {
		const stat = fs.statSync(file);
		return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function readCached<T>(file: string, parse: (raw: Buffer) => T, empty: () => T): T {
	const stamp = stampOf(file);
	if (stamp === undefined) { cache.delete(file); return empty(); }
	const hit = cache.get(file);
	if (hit && hit.stamp === stamp) return hit.value as T;
	const value = parse(fs.readFileSync(file));
	cache.set(file, { stamp, value });
	return value;
}

function writeAtomic(file: string, contents: string): void {
	const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	const fd = fs.openSync(temp, "wx", 0o600);
	try {
		fs.writeSync(fd, contents);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(temp, file);
	cache.delete(file);
}

const parseSessions = (raw: Buffer): SessionsFile => {
	const value = JSON.parse(raw.toString("utf8")) as Partial<SessionsFile>;
	return { version: 1, sessions: Array.isArray(value.sessions) ? value.sessions : [] };
};
const parsePairing = (raw: Buffer): PairingFile => {
	const value = JSON.parse(raw.toString("utf8")) as Partial<PairingFile>;
	return { version: 1, links: Array.isArray(value.links) ? value.links : [] };
};

function readSessionsFile(dataDir: string): SessionsFile {
	return readCached(files(dataDir).sessions, parseSessions, () => ({ version: 1, sessions: [] }));
}
function readPairingFile(dataDir: string): PairingFile {
	return readCached(files(dataDir).pairing, parsePairing, () => ({ version: 1, links: [] }));
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Take over a stale lock: move it aside under a unique name, and put it
 * back if it turned out to be a fresh one another writer just took. */
function breakStaleLock(lock: string): void {
	const aside = `${lock}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.stale`;
	try { fs.renameSync(lock, aside); } catch { return; }
	try {
		if (Date.now() - fs.statSync(aside).mtimeMs <= LOCK_STALE_MS) {
			try { fs.linkSync(aside, lock); } catch { /* another writer holds it now */ }
		}
	} finally {
		fs.rmSync(aside, { force: true });
	}
}

/** Thrown with `wait: false` when another writer holds the lock. The server
 * retries asynchronously (src/server/auth-routes.ts) instead of blocking its
 * event loop; `lh` and scripts wait synchronously. */
export class LockBusy extends Error {
	constructor() { super("The login store is busy."); }
}

/** Write options every store write takes. */
export type WriteOptions = { now?: number; wait?: boolean };

/** Run `fn` holding auth/.lock. A lock older than 10 seconds is stale. With
 * `wait: false` it throws LockBusy at once when the lock is held. */
function withLock<T>(dataDir: string, fn: () => T, options: { wait?: boolean } = {}): T {
	const f = files(dataDir);
	ensureDir(f.dir);
	const deadline = Date.now() + LOCK_WAIT_MS;
	let fd: number | undefined;
	while (fd === undefined) {
		try {
			fd = fs.openSync(f.lock, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let age = 0;
			try { age = Date.now() - fs.statSync(f.lock).mtimeMs; } catch { continue; }
			if (age > LOCK_STALE_MS) { breakStaleLock(f.lock); continue; }
			if (options.wait === false) throw new LockBusy();
			if (Date.now() > deadline) throw new Error(`The login store is locked (${f.lock}).`);
			sleepSync(15);
		}
	}
	const held = fs.fstatSync(fd).ino;
	try {
		fs.writeSync(fd, `${process.pid}\n`);
		return fn();
	} finally {
		fs.closeSync(fd);
		// Only remove our own lock, never one a later writer took over.
		try { if (fs.statSync(f.lock).ino === held) fs.rmSync(f.lock, { force: true }); } catch { /* already gone */ }
	}
}

function writeSessions(dataDir: string, sessions: SessionRecord[], now: number): void {
	const kept = sessions.filter((s) => {
		const ended = Math.min(Date.parse(s.expiresAt), s.revokedAt ? Date.parse(s.revokedAt) : Infinity);
		return now - ended < PRUNE_AFTER_MS;
	});
	writeAtomic(files(dataDir).sessions, `${JSON.stringify({ version: 1, sessions: kept }, null, "\t")}\n`);
}

function writePairing(dataDir: string, links: PairingLinkRecord[], now: number): void {
	const kept = links.filter((l) => Date.parse(l.expiresAt) > now);
	writeAtomic(files(dataDir).pairing, `${JSON.stringify({ version: 1, links: kept }, null, "\t")}\n`);
}

// ---------------------------------------------------------------------------
// signing key

/** The 32-byte HMAC key, created on first use. */
export function signingKey(dataDir: string): Buffer {
	const f = files(dataDir);
	const read = () => readCached(f.key, (raw) => raw, () => Buffer.alloc(0));
	const existing = read();
	if (existing.length >= 32) return existing;
	ensureDir(f.dir);
	const temp = `${f.key}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(temp, crypto.randomBytes(32), { mode: 0o600, flag: "wx" });
	try {
		fs.linkSync(temp, f.key); // fails when another process created it first
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		fs.rmSync(temp, { force: true });
	}
	const created = read();
	if (created.length < 32) throw new Error(`The login signing key ${f.key} is damaged.`);
	return created;
}

// ---------------------------------------------------------------------------
// pairing codes (T3: PairingGrantStore.ts)

/** 12 characters from the alphabet, by rejection sampling over random bytes. */
export function generatePairingCode(): string {
	const limit = Math.floor(256 / PAIRING_CODE_ALPHABET.length) * PAIRING_CODE_ALPHABET.length;
	let code = "";
	while (code.length < PAIRING_CODE_LENGTH) {
		for (const byte of crypto.randomBytes(PAIRING_CODE_LENGTH * 2)) {
			if (byte >= limit) continue;
			code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
			if (code.length === PAIRING_CODE_LENGTH) break;
		}
	}
	return code;
}

/** Case-insensitive; spaces and dashes are ignored. undefined when it can't be a code. */
export function normalizeCode(input: string): string | undefined {
	const code = input.replace(/[\s-]+/g, "").toUpperCase();
	if (code.length !== PAIRING_CODE_LENGTH) return undefined;
	for (const ch of code) if (!PAIRING_CODE_ALPHABET.includes(ch)) return undefined;
	return code;
}

/** ABCD-EFGH-JKLM */
export function formatCode(code: string): string {
	return code.match(/.{1,4}/g)?.join("-") ?? code;
}

const hashCode = (code: string) => crypto.createHash("sha256").update(code).digest("hex");

export function pairingUrl(origin: string, code: string): string {
	const url = new URL(origin);
	url.pathname = "/pair";
	url.search = "";
	url.hash = new URLSearchParams([["token", code]]).toString();
	return url.toString();
}

export function createPairingLink(
	dataDir: string,
	options: { label?: string; hidden?: boolean; ttlMs?: number } & WriteOptions = {},
): { id: string; code: string; label?: string; expiresAt: string } {
	const now = options.now ?? Date.now();
	const code = generatePairingCode();
	const label = options.label?.trim().slice(0, 80) || undefined;
	const link: PairingLinkRecord = {
		id: crypto.randomUUID(),
		codeHash: hashCode(code),
		...(label ? { label } : {}),
		...(options.hidden ? { hidden: true } : {}),
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + (options.ttlMs ?? PAIRING_TTL_MS)).toISOString(),
	};
	withLock(dataDir, () => writePairing(dataDir, [...readPairingFile(dataDir).links, link], now), { wait: options.wait });
	return { id: link.id, code, ...(label ? { label } : {}), expiresAt: link.expiresAt };
}

// ---------------------------------------------------------------------------
// sessions (T3: SessionStore.ts)

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const sign = (key: Buffer, payload: string) => crypto.createHmac("sha256", key).update(payload).digest();

function mintToken(dataDir: string, session: SessionRecord): string {
	const claims = { v: 1, kind: "session", sid: session.id, iat: Date.parse(session.issuedAt), exp: Date.parse(session.expiresAt) };
	const payload = b64url(JSON.stringify(claims));
	return `${payload}.${b64url(sign(signingKey(dataDir), payload))}`;
}

function newSession(method: SessionMethod, client: ClientInfo, now: number, ttlMs: number, hidden?: boolean): SessionRecord {
	return {
		id: crypto.randomUUID(),
		method,
		...(hidden ? { hidden: true } : {}),
		...client,
		issuedAt: new Date(now).toISOString(),
		expiresAt: new Date(now + ttlMs).toISOString(),
	};
}

export type ClaimResult =
	| { ok: true; token: string; session: SessionRecord }
	| { ok: false; reason: "invalid" | "expired" | "used" };

/** Spend a one-time code and create its session, in one locked write. */
export function claimPairingCode(dataDir: string, input: string, client: ClientInfo, options: WriteOptions = {}): ClaimResult {
	const now = options.now ?? Date.now();
	const code = normalizeCode(input);
	if (!code) return { ok: false, reason: "invalid" };
	const hash = hashCode(code);
	return withLock(dataDir, () => {
		const links = readPairingFile(dataDir).links;
		// Read sessions first: a damaged sessions.json must not burn the code.
		const sessions = readSessionsFile(dataDir).sessions;
		const link = links.find((l) => l.codeHash.length === hash.length && crypto.timingSafeEqual(Buffer.from(l.codeHash), Buffer.from(hash)));
		if (!link) return { ok: false, reason: "invalid" } as const;
		if (link.consumedAt) return { ok: false, reason: "used" } as const;
		if (Date.parse(link.expiresAt) <= now) return { ok: false, reason: "expired" } as const;
		writePairing(dataDir, links.map((l) => (l === link ? { ...l, consumedAt: new Date(now).toISOString() } : l)), now);
		const label = client.label ?? link.label;
		const session = newSession("pairing", { ...client, ...(label ? { label } : {}) }, now, SESSION_TTL_MS);
		writeSessions(dataDir, [...sessions, session], now);
		return { ok: true, token: mintToken(dataDir, session), session } as const;
	}, { wait: options.wait });
}

/** A session without a pairing code: the desktop shell's (replacing the
 * previous desktop session, T3's replaceActiveForSubjectAndMethod) or a
 * hidden short-lived one for `lh`. */
export function issueSession(
	dataDir: string,
	options: { method: SessionMethod; client: ClientInfo; hidden?: boolean; ttlMs?: number; replaceMethod?: boolean } & WriteOptions,
): { token: string; session: SessionRecord } {
	const now = options.now ?? Date.now();
	return withLock(dataDir, () => {
		const stamp = new Date(now).toISOString();
		const sessions = readSessionsFile(dataDir).sessions.map((s) =>
			options.replaceMethod && s.method === options.method && !s.revokedAt ? { ...s, revokedAt: stamp } : s);
		const session = newSession(options.method, options.client, now, options.ttlMs ?? SESSION_TTL_MS, options.hidden);
		writeSessions(dataDir, [...sessions, session], now);
		return { token: mintToken(dataDir, session), session };
	}, { wait: options.wait });
}

const active = (s: SessionRecord, now: number) => !s.revokedAt && Date.parse(s.expiresAt) > now;

/** The session a token names, when its signature, expiry and record all check out. */
export function verifyToken(dataDir: string, token: string, options: { now?: number } = {}): SessionRecord | undefined {
	const now = options.now ?? Date.now();
	const parts = token.split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
	const [payload, signature] = parts as [string, string];
	let key: Buffer;
	try {
		if (stampOf(files(dataDir).key) === undefined) return undefined;
		key = signingKey(dataDir);
	} catch { return undefined; }
	const expected = sign(key, payload);
	const supplied = Buffer.from(signature, "base64url");
	if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return undefined;
	let claims: { v?: unknown; kind?: unknown; sid?: unknown; exp?: unknown };
	try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return undefined; }
	if (claims.v !== 1 || claims.kind !== "session" || typeof claims.sid !== "string" || typeof claims.exp !== "number" || claims.exp <= now) return undefined;
	let sessions: SessionRecord[];
	try { sessions = readSessionsFile(dataDir).sessions; } catch { return undefined; }
	const session = sessions.find((s) => s.id === claims.sid);
	return session && active(session, now) ? session : undefined;
}

/** Signed-in devices, newest first. Hidden (`lh`) sessions are left out. */
export function listSessions(dataDir: string, options: { now?: number } = {}): SessionRecord[] {
	const now = options.now ?? Date.now();
	return readSessionsFile(dataDir).sessions
		.filter((s) => !s.hidden && active(s, now))
		.sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt));
}

export function revokeSession(dataDir: string, id: string, options: WriteOptions = {}): boolean {
	const now = options.now ?? Date.now();
	return withLock(dataDir, () => {
		const sessions = readSessionsFile(dataDir).sessions;
		const target = sessions.find((s) => s.id === id && active(s, now));
		if (!target) return false;
		writeSessions(dataDir, sessions.map((s) => (s === target ? { ...s, revokedAt: new Date(now).toISOString() } : s)), now);
		return true;
	}, { wait: options.wait });
}

/** Revoke every listed session except `currentId`. Hidden sessions are left alone. */
export function revokeOthers(dataDir: string, currentId: string, options: WriteOptions = {}): number {
	const now = options.now ?? Date.now();
	return withLock(dataDir, () => {
		const sessions = readSessionsFile(dataDir).sessions;
		let count = 0;
		const next = sessions.map((s) => {
			if (s.id === currentId || s.hidden || !active(s, now)) return s;
			count++;
			return { ...s, revokedAt: new Date(now).toISOString() };
		});
		if (count > 0) writeSessions(dataDir, next, now);
		return count;
	}, { wait: options.wait });
}

/** Record that a session was used, at most once a minute. On the request
 * path, so it never waits for the lock: a busy store just skips this time. */
export function touchLastSeen(dataDir: string, id: string, options: { now?: number } = {}): void {
	const now = options.now ?? Date.now();
	const fresh = (s: SessionRecord | undefined) => !s || (s.lastSeenAt !== undefined && now - Date.parse(s.lastSeenAt) < LAST_SEEN_INTERVAL_MS);
	if (fresh(readSessionsFile(dataDir).sessions.find((s) => s.id === id))) return;
	try { withLock(dataDir, () => {
		const sessions = readSessionsFile(dataDir).sessions;
		const target = sessions.find((s) => s.id === id);
		if (fresh(target) || !target || !active(target, now)) return;
		writeSessions(dataDir, sessions.map((s) => (s === target ? { ...s, lastSeenAt: new Date(now).toISOString() } : s)), now);
	}, { wait: false }); } catch (error) {
		if (!(error instanceof LockBusy)) throw error;
	}
}

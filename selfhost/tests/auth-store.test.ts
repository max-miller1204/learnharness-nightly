/** The login store shared by the server and `lh` (docs/specs/login-pairing.md). */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	authDir, claimPairingCode, createPairingLink, formatCode, generatePairingCode, issueSession, listSessions, normalizeCode,
	PAIRING_CODE_ALPHABET, pairingUrl, revokeOthers, revokeSession, SESSION_TTL_MS, touchLastSeen, verifyToken,
} from "../src/auth-store.ts";
import { restore, snapshot } from "../src/backup.ts";
import { layout } from "../src/paths.ts";

let home: string;
let data: string;
const client = { deviceType: "mobile" as const, os: "iOS", browser: "Safari", ip: "100.64.0.9" };
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-auth-"));
	data = layout(home).data;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("pairing codes", () => {
	it("are 12 characters from T3's alphabet", () => {
		for (let i = 0; i < 200; i++) {
			const code = generatePairingCode();
			assert.equal(code.length, 12);
			for (const ch of code) assert.ok(PAIRING_CODE_ALPHABET.includes(ch), ch);
		}
		assert.equal(PAIRING_CODE_ALPHABET.length, 32);
		assert.doesNotMatch(PAIRING_CODE_ALPHABET, /[01IO]/);
	});

	it("are typed case-insensitively, ignoring spaces and dashes", () => {
		assert.equal(normalizeCode("abcd-efgh-jklm"), "ABCDEFGHJKLM");
		assert.equal(normalizeCode(" ABCD EFGH JKLM "), "ABCDEFGHJKLM");
		assert.equal(normalizeCode("ABCDEFGHJKL"), undefined);
		assert.equal(normalizeCode("ABCDEFGHJKL0"), undefined, "0 isn't in the alphabet");
		assert.equal(formatCode("ABCDEFGHJKLM"), "ABCD-EFGH-JKLM");
		assert.equal(pairingUrl("http://127.0.0.1:3774", "ABCDEFGHJKLM"), "http://127.0.0.1:3774/pair#token=ABCDEFGHJKLM");
	});

	it("work once, within 5 minutes", () => {
		const now = Date.parse("2026-11-17T12:00:00Z");
		const link = createPairingLink(data, { label: "Phone", now });
		assert.equal(Date.parse(link.expiresAt) - now, 5 * 60_000);
		const claimed = claimPairingCode(data, formatCode(link.code).toLowerCase(), client, { now: now + 1000 });
		assert.ok(claimed.ok);
		assert.equal(claimed.session.label, "Phone", "the link's label names the device");
		assert.equal(Date.parse(claimed.session.expiresAt) - (now + 1000), SESSION_TTL_MS);
		assert.deepEqual(claimPairingCode(data, link.code, client, { now: now + 2000 }), { ok: false, reason: "used" });
		const late = createPairingLink(data, { now });
		assert.deepEqual(claimPairingCode(data, late.code, client, { now: now + 5 * 60_000 }), { ok: false, reason: "expired" });
		assert.deepEqual(claimPairingCode(data, generatePairingCode(), client, { now }), { ok: false, reason: "invalid" });
	});

	it("are stored hashed, in a 0700 folder with a 0600 key", () => {
		const link = createPairingLink(data);
		claimPairingCode(data, createPairingLink(data).code, client);
		const stored = fs.readFileSync(path.join(authDir(data), "pairing.json"), "utf8");
		assert.ok(!stored.includes(link.code));
		assert.equal(fs.statSync(authDir(data)).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(authDir(data), "signing-key")).mode & 0o777, 0o600);
		assert.equal(fs.existsSync(path.join(authDir(data), ".lock")), false, "the lock is released");
	});
});

describe("sessions", () => {
	it("verify by signature, expiry and record", () => {
		const now = Date.now();
		const { token, session } = issueSession(data, { method: "pairing", client, now });
		assert.equal(verifyToken(data, token)?.id, session.id);
		const [payload, signature] = token.split(".") as [string, string];
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
		assert.deepEqual(Object.keys(claims).sort(), ["exp", "iat", "kind", "sid", "v"]);
		const forged = Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 1 })).toString("base64url");
		assert.equal(verifyToken(data, `${forged}.${signature}`), undefined, "changed claims break the signature");
		assert.equal(verifyToken(data, token, { now: now + SESSION_TTL_MS + 1 }), undefined, "expired");
		assert.equal(verifyToken(data, "garbage"), undefined);
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "lh-auth-other-"));
		try { assert.equal(verifyToken(path.join(other, "data"), token), undefined, "another store's key"); } finally { fs.rmSync(other, { recursive: true, force: true }); }
		assert.ok(revokeSession(data, session.id));
		assert.equal(verifyToken(data, token), undefined, "revoked");
	});

	it("revoke-others keeps the current and hidden sessions", () => {
		const current = issueSession(data, { method: "pairing", client });
		const other = issueSession(data, { method: "pairing", client });
		const cli = issueSession(data, { method: "cli", hidden: true, client: { deviceType: "unknown" } });
		assert.deepEqual(listSessions(data).map((s) => s.id).sort(), [current.session.id, other.session.id].sort(), "hidden sessions aren't listed");
		assert.equal(revokeOthers(data, current.session.id), 1);
		assert.ok(verifyToken(data, current.token));
		assert.equal(verifyToken(data, other.token), undefined);
		assert.ok(verifyToken(data, cli.token));
	});

	it("desktop sessions replace each other", () => {
		const first = issueSession(data, { method: "desktop", client, replaceMethod: true });
		const second = issueSession(data, { method: "desktop", client, replaceMethod: true });
		assert.equal(verifyToken(data, first.token), undefined);
		assert.ok(verifyToken(data, second.token));
	});

	it("last seen is written at most once a minute", () => {
		const now = Date.now();
		const { session } = issueSession(data, { method: "pairing", client, now });
		touchLastSeen(data, session.id, { now });
		const seen = () => listSessions(data, { now })[0]?.lastSeenAt;
		assert.equal(seen(), new Date(now).toISOString());
		touchLastSeen(data, session.id, { now: now + 30_000 });
		assert.equal(seen(), new Date(now).toISOString());
		touchLastSeen(data, session.id, { now: now + 61_000 });
		assert.equal(seen(), new Date(now + 61_000).toISOString());
	});

	it("a stale lock from a crashed writer doesn't block", () => {
		fs.mkdirSync(authDir(data), { recursive: true });
		const lock = path.join(authDir(data), ".lock");
		fs.writeFileSync(lock, "999999\n");
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, old, old);
		assert.ok(createPairingLink(data).code);
	});
});

describe("lock and damage handling", () => {
	it("last-seen never waits on a held lock (it's on the request path)", () => {
		const { session } = issueSession(data, { method: "pairing", client });
		fs.writeFileSync(path.join(authDir(data), ".lock"), "999999\n");
		const started = Date.now();
		touchLastSeen(data, session.id);
		assert.ok(Date.now() - started < 1000, "returned at once");
		assert.equal(listSessions(data)[0]?.lastSeenAt, undefined, "skipped this time");
		fs.rmSync(path.join(authDir(data), ".lock"));
	});

	it("a damaged sessions.json fails closed without burning the code", () => {
		const link = createPairingLink(data);
		fs.writeFileSync(path.join(authDir(data), "sessions.json"), "{ not json");
		assert.throws(() => claimPairingCode(data, link.code, client));
		fs.rmSync(path.join(authDir(data), "sessions.json"));
		assert.ok(claimPairingCode(data, link.code, client).ok, "the code still works once the file is fixed");
	});
});

describe("backups and the login store", () => {
	it("snapshots skip data/auth and a restore keeps the live one", () => {
		const dirs = layout(home);
		fs.mkdirSync(path.join(dirs.data, "chats"), { recursive: true });
		fs.writeFileSync(path.join(dirs.data, "chats", "a.json"), "old\n");
		const before = issueSession(data, { method: "pairing", client });
		const snap = snapshot(home, "v1-a");
		assert.equal(fs.existsSync(path.join(snap, "data", "auth")), false, "not snapshotted");
		assert.ok(fs.existsSync(path.join(snap, "data", "chats", "a.json")));
		fs.writeFileSync(path.join(dirs.data, "chats", "a.json"), "new\n");
		const after = issueSession(data, { method: "pairing", client });
		revokeSession(data, before.session.id);
		restore(home, snap);
		assert.equal(fs.readFileSync(path.join(dirs.data, "chats", "a.json"), "utf8"), "old\n", "learning data restored");
		assert.ok(verifyToken(data, after.token), "today's devices stay signed in");
		assert.equal(verifyToken(data, before.token), undefined, "a revoked device stays revoked");
	});
});

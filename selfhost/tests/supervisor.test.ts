/**
 * The launcher state machine (selfhost/src/supervisor.ts) driven with a
 * fake server child and fake timers: request validation, trial, commit,
 * rollback, resume, exit-78 waiting, deliberate stop, and the
 * launcher-protocol relaunch.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { EXIT_DATA_DIR_IN_USE, EXIT_RELAUNCH, LAUNCHER_PROTOCOL, type ParentMessage } from "../src/protocol.ts";
import { layout } from "../src/paths.ts";
import type { ServiceState } from "../src/release.ts";
import { HANDOFF_DELAY_MS, HEALTH_RETRY_MS, PREPARED_TIMEOUT_MS, Supervisor, type ChildHandle, type ChildRole, type SupervisorDeps } from "../src/supervisor.ts";

const V1 = "0.6.1-nightly.20261116.1";
const V2 = "0.6.1-nightly.20261117.2";
const V3 = "0.6.1-nightly.20261118.3";

class FakeChild implements ChildHandle {
	version: string;
	role: ChildRole;
	trialUpdateId: string | undefined;
	sent: ParentMessage[] = [];
	stopped = false;
	#message: Array<(m: unknown) => void> = [];
	#exit: Array<(code: number | null, signal: string | null) => void> = [];
	constructor(version: string, role: ChildRole, trialUpdateId?: string) {
		this.version = version;
		this.role = role;
		this.trialUpdateId = trialUpdateId;
	}
	send(message: ParentMessage) { this.sent.push(message); }
	onMessage(cb: (m: unknown) => void) { this.#message.push(cb); }
	onExit(cb: (code: number | null, signal: string | null) => void) { this.#exit.push(cb); }
	async stop() { this.stopped = true; this.exit(null, "SIGTERM"); }
	emit(message: unknown) { for (const cb of this.#message) cb(message); }
	exit(code: number | null, signal: string | null = null) { const cbs = this.#exit.splice(0); for (const cb of cbs) cb(code, signal); }
}

interface Harness {
	deps: SupervisorDeps;
	state: () => ServiceState;
	children: FakeChild[];
	last: () => FakeChild;
	timers: Array<{ cb: () => void; ms: number; id: number }>;
	runTimer: (ms?: number) => void;
	repointed: string[];
	snapshots: string[];
	restored: string[];
	exits: number[];
	logs: string[];
	setHealth: (h: { ok: boolean; idle?: boolean; version?: string }) => void;
	setFree: (n: number) => void;
	setSpace: (reason: string | undefined) => void;
	setDataFolderFree: (free: boolean) => void;
	setMinProtocol: (n: number) => void;
	setSelftest: (ok: boolean) => void;
}

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sup-")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function harness(initial: ServiceState, installed: string[] = [V1, V2, V3]): Harness {
	let state = structuredClone(initial);
	let health = { ok: true, idle: true } as { ok: boolean; idle?: boolean; version?: string };
	let free = 10 * 1024 ** 3;
	let space: string | undefined;
	let dataFree = true;
	let minProtocol = 1;
	let selftest = true;
	let nextId = 1;
	const h: Harness = {
		children: [],
		timers: [],
		repointed: [],
		snapshots: [],
		restored: [],
		exits: [],
		logs: [],
		state: () => state,
		last: () => { const c = h.children.at(-1); assert.ok(c, "a child was spawned"); return c; },
		runTimer: (ms) => {
			const index = ms === undefined ? 0 : h.timers.findIndex((t) => t.ms === ms);
			assert.ok(index >= 0 && h.timers[index], `a timer${ms === undefined ? "" : ` of ${ms}ms`} is pending`);
			const [timer] = h.timers.splice(index, 1);
			timer!.cb();
		},
		setHealth: (next) => { health = next; },
		setFree: (n) => { free = n; },
		setSpace: (reason) => { space = reason; },
		setDataFolderFree: (f) => { dataFree = f; },
		setMinProtocol: (n) => { minProtocol = n; },
		setSelftest: (ok) => { selftest = ok; },
		deps: undefined as unknown as SupervisorDeps,
	};
	h.deps = {
		home,
		readState: () => structuredClone(state),
		writeState: (next) => { state = structuredClone(next); },
		isInstalled: (v) => installed.includes(v),
		spawnChild: (version, role, trialUpdateId) => { const c = new FakeChild(version, role, trialUpdateId); h.children.push(c); return c; },
		health: async () => health,
		freeBytes: () => free,
		spaceForSnapshot: () => space,
		snapshot: (name) => {
			const dir = path.join(layout(home).backups, name);
			fs.mkdirSync(dir, { recursive: true });
			h.snapshots.push(dir);
			return dir;
		},
		restore: (dir) => { h.restored.push(dir); },
		repoint: (v) => { h.repointed.push(v); return undefined; },
		prune: () => {},
		minLauncherProtocolOf: () => minProtocol,
		selftestLauncher: async () => selftest,
		dataFolderFree: () => dataFree,
		log: (line) => { h.logs.push(line); },
		now: () => 1_000_000,
		setTimeout: (cb, ms) => {
			const id = nextId++;
			// The retry sleep inside the post-prepared health loop resolves at once.
			if (ms === HEALTH_RETRY_MS) { queueMicrotask(cb); return id; }
			h.timers.push({ cb, ms, id });
			return id;
		},
		clearTimeout: (id) => { const i = h.timers.findIndex((t) => t.id === id); if (i >= 0) h.timers.splice(i, 1); },
		exit: (code) => { h.exits.push(code); },
		runningLauncherVersion: V1,
	};
	return h;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const base: ServiceState = { protocol: 1, activeVersion: V1, badVersions: [] };

async function acceptedUpdate(h: Harness, s: Supervisor) {
	await s.start();
	const active = h.last();
	active.emit({ type: "request-update", targetVersion: V2 });
	await flush();
	return active;
}

describe("launcher supervisor", () => {
	it("starts the active version", async () => {
		const h = harness(base);
		await new Supervisor(h.deps).start();
		assert.equal(h.last().version, V1);
		assert.equal(h.last().role, "active");
	});

	it("waits for disk space instead of starting", async () => {
		const h = harness(base);
		h.setFree(10 * 1024 * 1024);
		await new Supervisor(h.deps).start();
		assert.equal(h.children.length, 0);
		assert.ok(h.logs.some((l) => l.includes("needs at least")));
		h.setFree(10 * 1024 ** 3);
		h.runTimer(30_000);
		assert.equal(h.children.length, 1);
	});

	for (const [label, target, setup, expected] of [
		["an older version", "0.6.0-nightly.20261110.9", () => {}, /newer version/],
		["a version that isn't installed", "0.6.1-nightly.20261119.4", () => {}, /missing/],
		["a version marked bad", V2, (h: Harness) => { h.deps.writeState({ ...base, badVersions: [V2] }); }, /failed to start earlier/],
		["an update without disk space for the snapshot", V2, (h: Harness) => h.setSpace("Not enough disk space"), /Not enough disk space/],
	] as const) {
		it(`rejects ${label} and keeps the old server running`, async () => {
			const h = harness(base);
			setup(h);
			const s = new Supervisor(h.deps);
			await s.start();
			const active = h.last();
			active.emit({ type: "request-update", targetVersion: target });
			await flush();
			const reply = active.sent.at(-1);
			assert.equal(reply?.type, "update-rejected");
			assert.match((reply as { reason: string }).reason, expected);
			assert.equal(active.stopped, false);
			assert.equal(h.state().update, undefined);
		});
	}

	it("accepts, snapshots, trials and commits; the unit is repointed only after commit", async () => {
		const h = harness(base);
		const s = new Supervisor(h.deps);
		const active = await acceptedUpdate(h, s);
		const accepted = active.sent.at(-1);
		assert.equal(accepted?.type, "update-accepted");
		assert.equal(h.state().update?.status, "pending");
		assert.deepEqual(h.repointed, [], "not repointed while pending");

		h.runTimer(HANDOFF_DELAY_MS);
		await flush();
		assert.equal(active.stopped, true);
		assert.equal(h.snapshots.length, 1);
		const trial = h.last();
		assert.equal(trial.role, "trial");
		assert.equal(trial.version, V2);
		assert.equal(trial.trialUpdateId, h.state().update?.id);
		assert.deepEqual(h.repointed, [], "not repointed during the trial");

		h.setHealth({ ok: true, version: V2 });
		trial.emit({ type: "prepared", updateId: h.state().update!.id });
		await flush(); await flush();
		assert.equal(h.state().update?.status, "committed");
		assert.equal(h.state().activeVersion, V2);
		assert.equal(h.state().previousVersion, V1);
		assert.equal(trial.role, "active");
		assert.equal(trial.sent.at(-1)?.type, "committed");
		assert.deepEqual(h.repointed, [V2]);
		assert.ok(fs.existsSync(layout(home).restartPending), "a newer launcher waits for the next restart");
	});

	for (const [label, act] of [
		["the trial exits", (t: FakeChild) => t.exit(1)],
		["the trial reports a mismatched update ID", (t: FakeChild) => t.emit({ type: "prepared", updateId: "not-it" })],
	] as const) {
		it(`rolls back when ${label}`, async () => {
			const h = harness(base);
			const s = new Supervisor(h.deps);
			await acceptedUpdate(h, s);
			h.runTimer(HANDOFF_DELAY_MS);
			await flush();
			const trial = h.last();
			act(trial);
			await flush(); await flush();
			const st = h.state();
			assert.equal(st.update?.status, "rolled-back");
			assert.equal(st.activeVersion, V1);
			assert.ok(st.badVersions.includes(V2));
			assert.deepEqual(h.restored, [h.snapshots[0]], "the snapshot is restored");
			const restarted = h.last();
			assert.equal(restarted.version, V1);
			assert.equal(restarted.role, "active");
		});
	}

	it("rolls back when the trial never reports prepared (30 min timeout)", async () => {
		const h = harness(base);
		const s = new Supervisor(h.deps);
		await acceptedUpdate(h, s);
		h.runTimer(HANDOFF_DELAY_MS);
		await flush();
		h.runTimer(PREPARED_TIMEOUT_MS);
		await flush(); await flush();
		assert.equal(h.state().update?.status, "rolled-back");
		assert.equal(h.state().update?.reason, "prepared-timeout");
		assert.equal(h.last().version, V1);
	});

	it("rejects a second request while one is pending", async () => {
		const h = harness(base);
		const s = new Supervisor(h.deps);
		const active = await acceptedUpdate(h, s);
		active.emit({ type: "request-update", targetVersion: V3 });
		await flush();
		assert.equal(active.sent.at(-1)?.type, "update-rejected");
	});

	it("resumes a pending trial after a launcher restart", async () => {
		const backup = path.join(layout(home).backups, "pre");
		fs.mkdirSync(backup, { recursive: true });
		const h = harness({ ...base, update: { id: "u1", fromVersion: V1, targetVersion: V2, status: "pending", at: 1, backup } });
		await new Supervisor(h.deps).start();
		const trial = h.last();
		assert.equal(trial.role, "trial");
		assert.equal(trial.version, V2);
		assert.equal(trial.trialUpdateId, "u1");
		assert.equal(h.snapshots.length, 0, "the existing snapshot is reused");
	});

	it("a deliberate stop during a trial leaves the update pending", async () => {
		const h = harness(base);
		const s = new Supervisor(h.deps);
		await acceptedUpdate(h, s);
		h.runTimer(HANDOFF_DELAY_MS);
		await flush();
		await s.stop();
		assert.equal(h.state().update?.status, "pending");
		assert.equal(h.children.filter((c) => c.role === "active" && !c.stopped).length, 0, "nothing restarts");
	});

	it("waits on exit 78 instead of restarting in a loop", async () => {
		const h = harness(base);
		await new Supervisor(h.deps).start();
		h.setDataFolderFree(false);
		h.last().exit(EXIT_DATA_DIR_IN_USE);
		assert.equal(h.children.length, 1);
		h.runTimer(5_000);
		assert.equal(h.children.length, 1, "still busy: keep waiting");
		h.setDataFolderFree(true);
		h.runTimer(5_000);
		assert.equal(h.children.length, 2);
	});

	it("restarts a crashed active server with backoff and never rolls back", async () => {
		const h = harness({ ...base, previousVersion: "0.6.1-nightly.20261115.0" });
		await new Supervisor(h.deps).start();
		h.last().exit(1);
		assert.equal(h.timers[0]?.ms, 1_000);
		h.runTimer(1_000);
		h.last().exit(1);
		assert.equal(h.timers[0]?.ms, 2_000);
		assert.equal(h.state().activeVersion, V1);
	});

	it("starts a requested version from the update-request marker (lh use / rollback)", async () => {
		const h = harness({ ...base, activeVersion: V2, previousVersion: V1 });
		const restoreDir = path.join(layout(home).backups, `${V1}-x`);
		fs.mkdirSync(restoreDir, { recursive: true });
		await new Supervisor(h.deps).start({ targetVersion: V1, allowBad: true, restoreBackup: restoreDir });
		assert.equal(h.snapshots.length, 1, "current data is snapshotted first");
		assert.deepEqual(h.restored, [restoreDir]);
		const trial = h.last();
		assert.equal(trial.role, "trial");
		assert.equal(trial.version, V1);
	});

	it("does not relaunch when the running launcher protocol is high enough", async () => {
		const h = harness(base);
		h.setMinProtocol(LAUNCHER_PROTOCOL);
		const s = new Supervisor(h.deps);
		await acceptedUpdate(h, s);
		h.runTimer(HANDOFF_DELAY_MS);
		await flush();
		h.setHealth({ ok: true, idle: true, version: V2 });
		h.last().emit({ type: "prepared", updateId: h.state().update!.id });
		await flush(); await flush(); await flush();
		assert.deepEqual(h.exits, []);
	});

	it("relaunches at the next idle moment when a version needs a newer launcher", async () => {
		const h = harness(base);
		h.setMinProtocol(LAUNCHER_PROTOCOL + 1);
		const s = new Supervisor(h.deps);
		await acceptedUpdate(h, s);
		h.runTimer(HANDOFF_DELAY_MS);
		await flush();
		h.setHealth({ ok: true, idle: false, version: V2 });
		const trial = h.last();
		trial.emit({ type: "prepared", updateId: h.state().update!.id });
		await flush(); await flush(); await flush();
		assert.equal(h.state().update?.status, "committed");
		assert.deepEqual(h.exits, [], "busy: wait");
		h.setHealth({ ok: true, idle: true, version: V2 });
		h.runTimer(30_000);
		await flush(); await flush();
		assert.deepEqual(h.exits, [EXIT_RELAUNCH]);
		assert.equal(trial.stopped, true);
		assert.equal(h.state().activeVersion, V2, "same committed version, new launcher");
	});

	it("keeps the old launcher when the new launcher's self-test fails", async () => {
		const h = harness(base);
		h.setMinProtocol(LAUNCHER_PROTOCOL + 1);
		h.setSelftest(false);
		const s = new Supervisor(h.deps);
		await acceptedUpdate(h, s);
		h.runTimer(HANDOFF_DELAY_MS);
		await flush();
		h.setHealth({ ok: true, idle: true, version: V2 });
		h.last().emit({ type: "prepared", updateId: h.state().update!.id });
		await flush(); await flush(); await flush();
		assert.deepEqual(h.exits, []);
		assert.ok(h.logs.some((l) => l.includes("launcher update failed")));
	});
});

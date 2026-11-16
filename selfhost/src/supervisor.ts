/**
 * `lh __service`: the long-lived launcher, modeled on T3 Code's
 * apps/server/src/serviceLauncher.ts.
 *
 * - It supervises one server child. It stays running across updates: a new
 *   version is started as a TRIAL child by this same process, and only a
 *   commit repoints the systemd unit, so a newer launcher takes over on the
 *   next service start, never mid-update.
 * - The server asks for an update ("request-update"). The launcher checks
 *   everything BEFORE stopping anything (newer, installed, not bad, disk
 *   space for the snapshot), snapshots userdata, runs the trial, and
 *   commits when the trial says "prepared" (and /api/health answers) or
 *   rolls back when it exits, misbehaves or times out (30 min, like T3).
 * - No rollback outside a trial. A crashing active server is restarted
 *   with backoff; exit 78 (data folder in use) waits instead.
 * - A deliberate stop writes .service-stopping first; a stop during a trial
 *   leaves the update pending and the next start resumes it.
 *
 * Every side effect goes through SupervisorDeps so tests drive the state
 * machine with a fake child.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { EXIT_DATA_DIR_IN_USE, EXIT_RELAUNCH, LAUNCHER_PROTOCOL, parseChildMessage, type ParentMessage } from "./protocol.ts";
import { compareVersions, isExactVersion, writeFileDurably, type ServiceState, type UpdateRecord } from "./release.ts";
import { layout } from "./paths.ts";

export const HANDOFF_DELAY_MS = 2_000;
export const PREPARED_TIMEOUT_MS = 30 * 60_000;
export const HEALTH_AFTER_PREPARED_MS = 30_000;
export const HEALTH_RETRY_MS = 500;
export const MIN_START_FREE_BYTES = 64 * 1024 * 1024;
export const DISK_SPACE_RETRY_MS = 30_000;
export const DATA_DIR_RETRY_MS = 5_000;
export const IDLE_RELAUNCH_POLL_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const STABLE_RUN_MS = 60_000;

export type ChildRole = "active" | "trial";

export interface ChildHandle {
	readonly version: string;
	role: ChildRole;
	send(message: ParentMessage): void;
	onMessage(cb: (message: unknown) => void): void;
	onExit(cb: (code: number | null, signal: string | null) => void): void;
	/** SIGTERM, then SIGKILL after a grace period. Resolves on exit. */
	stop(): Promise<void>;
}

export interface UpdateRequestMarker {
	targetVersion: string;
	/** Restore this snapshot (a backups/ path) before starting the target. */
	restoreBackup?: string;
	/** `lh use` may pick a version previously marked bad. */
	allowBad?: boolean;
	reason?: string;
}

export interface SupervisorDeps {
	home: string;
	readState(): ServiceState;
	writeState(state: ServiceState): void;
	isInstalled(version: string): boolean;
	spawnChild(version: string, role: ChildRole, trialUpdateId?: string): ChildHandle;
	health(): Promise<{ ok: boolean; idle?: boolean; version?: string }>;
	freeBytes(dir: string): number;
	spaceForSnapshot(): string | undefined;
	snapshot(name: string): string;
	restore(backupDir: string): void;
	repoint(version: string): string | undefined;
	prune(state: ServiceState): void;
	minLauncherProtocolOf(version: string): number;
	selftestLauncher(version: string): Promise<boolean>;
	/** True once no other server holds the data folder lock. */
	dataFolderFree(): boolean;
	log(line: string): void;
	now(): number;
	setTimeout(cb: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	exit(code: number): void;
	/** Version of the launcher code this process is running. */
	runningLauncherVersion: string;
}

export class Supervisor {
	#deps: SupervisorDeps;
	#state: ServiceState;
	#child: ChildHandle | undefined;
	#timer: unknown;
	#stopping = false;
	#failures = 0;
	#startedAt = 0;
	#relaunchArmed = false;

	constructor(deps: SupervisorDeps) {
		this.#deps = deps;
		this.#state = deps.readState();
	}

	get state(): ServiceState { return this.#state; }
	get child(): ChildHandle | undefined { return this.#child; }

	#save(next: ServiceState): void {
		this.#deps.writeState(next);
		this.#state = next;
	}

	#setTimer(cb: () => void, ms: number): void {
		this.#clearTimer();
		this.#timer = this.#deps.setTimeout(() => { this.#timer = undefined; cb(); }, ms);
	}

	#clearTimer(): void {
		if (this.#timer !== undefined) this.#deps.clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** Entry point after the home lock is held and markers are cleared. */
	async start(request?: UpdateRequestMarker): Promise<void> {
		const pending = this.#state.update?.status === "pending" ? this.#state.update : undefined;
		if (pending) {
			this.#deps.log(`[launcher] Resuming the pending update to ${pending.targetVersion}.`);
			await this.#resumeTrial(pending);
			return;
		}
		if (request) {
			await this.#startFromRequest(request);
			return;
		}
		this.#startActive();
	}

	// -- active child ---------------------------------------------------------

	#startActive(): void {
		if (this.#stopping) return;
		const free = this.#deps.freeBytes(layout(this.#deps.home).userdata);
		if (free < MIN_START_FREE_BYTES) {
			this.#deps.log(`[launcher] LearnHarness needs at least ${MIN_START_FREE_BYTES} bytes free before starting the server; ${free} available. Retrying in ${DISK_SPACE_RETRY_MS / 1000}s.`);
			this.#setTimer(() => this.#startActive(), DISK_SPACE_RETRY_MS);
			return;
		}
		const version = this.#state.activeVersion;
		const child = this.#deps.spawnChild(version, "active");
		this.#child = child;
		this.#startedAt = this.#deps.now();
		child.onMessage((raw) => void this.#onMessage(child, raw));
		child.onExit((code, signal) => this.#onExit(child, code, signal));
		this.#deps.log(`[launcher] Started LearnHarness ${version}.`);
	}

	#restartActiveWithBackoff(reason: string): void {
		if (this.#deps.now() - this.#startedAt > STABLE_RUN_MS) this.#failures = 0;
		const delay = BACKOFF_MS[Math.min(this.#failures, BACKOFF_MS.length - 1)] ?? 30_000;
		this.#failures += 1;
		this.#deps.log(`[launcher] Server exited (${reason}). Restarting in ${delay / 1000}s.`);
		this.#setTimer(() => this.#startActive(), delay);
	}

	#waitForDataFolder(): void {
		if (this.#stopping) return;
		if (this.#deps.dataFolderFree()) {
			this.#deps.log("[launcher] The data folder is free again. Starting the server.");
			this.#startActive();
			return;
		}
		this.#setTimer(() => this.#waitForDataFolder(), DATA_DIR_RETRY_MS);
	}

	#onExit(child: ChildHandle, code: number | null, signal: string | null): void {
		if (this.#child !== child) return;
		this.#child = undefined;
		if (this.#stopping) return;
		if (child.role === "trial") {
			void this.#rollback(`candidate-exited:${String(code ?? signal ?? "unknown")}`);
			return;
		}
		if (code === EXIT_DATA_DIR_IN_USE) {
			this.#deps.log("[launcher] Another LearnHarness server owns this data folder. This service starts again once it stops.");
			this.#setTimer(() => this.#waitForDataFolder(), DATA_DIR_RETRY_MS);
			return;
		}
		this.#restartActiveWithBackoff(String(code ?? signal ?? "unknown"));
	}

	async #onMessage(child: ChildHandle, raw: unknown): Promise<void> {
		const message = parseChildMessage(raw);
		if (!message || this.#child !== child) return;
		if (message.type === "request-update") await this.#handleRequest(child, message.targetVersion);
		else if (message.type === "prepared") await this.#handlePrepared(child, message.updateId);
	}

	// -- request validation (before stopping anything) ------------------------

	#validate(target: string, options: { requireNewer: boolean; allowBad: boolean }): string | undefined {
		if (this.#state.update?.status === "pending") return "Another server update is already pending.";
		if (!isExactVersion(target)) return "The requested target is not an exact version.";
		if (options.requireNewer && compareVersions(target, this.#state.activeVersion) <= 0) return "Updates must select a newer version.";
		if (!this.#deps.isInstalled(target)) return `Version ${target} is missing or incompletely installed.`;
		if (!options.allowBad && this.#state.badVersions.includes(target)) return `Version ${target} failed to start earlier and is skipped.`;
		return this.#deps.spaceForSnapshot();
	}

	async #handleRequest(child: ChildHandle, target: string): Promise<void> {
		const reject = (reason: string) => {
			this.#deps.log(`[launcher] Update to ${target} rejected: ${reason}`);
			child.send({ type: "update-rejected", reason });
		};
		if (child.role !== "active" || child.version !== this.#state.activeVersion) {
			reject("Only the active server can request an update.");
			return;
		}
		const problem = this.#validate(target, { requireNewer: true, allowBad: false });
		if (problem) { reject(problem); return; }
		const update: UpdateRecord = { id: randomUUID(), fromVersion: this.#state.activeVersion, targetVersion: target, status: "pending", at: this.#deps.now() };
		try {
			this.#save({ ...this.#state, update });
		} catch (error) {
			reject(error instanceof Error ? error.message : String(error));
			return;
		}
		child.send({ type: "update-accepted", updateId: update.id });
		this.#deps.log(`[launcher] Update ${update.id}: ${update.fromVersion} -> ${target} accepted.`);
		this.#setTimer(() => void this.#beginTrial(), HANDOFF_DELAY_MS);
	}

	async #startFromRequest(request: UpdateRequestMarker): Promise<void> {
		const target = request.targetVersion;
		if (target === this.#state.activeVersion && !request.restoreBackup) {
			this.#startActive();
			return;
		}
		const problem = this.#validate(target, { requireNewer: false, allowBad: request.allowBad === true });
		if (problem) {
			this.#deps.log(`[launcher] Requested switch to ${target} refused: ${problem}`);
			this.#startActive();
			return;
		}
		const update: UpdateRecord = { id: randomUUID(), fromVersion: this.#state.activeVersion, targetVersion: target, status: "pending", at: this.#deps.now() };
		this.#save({ ...this.#state, update });
		update.backup = this.#deps.snapshot(`${update.fromVersion}-${update.id}`);
		this.#save({ ...this.#state, update });
		if (request.restoreBackup) {
			this.#deps.log(`[launcher] Restoring ${request.restoreBackup} before starting ${target}.`);
			this.#deps.restore(request.restoreBackup);
		}
		this.#startTrial(update);
	}

	// -- trial ----------------------------------------------------------------

	async #beginTrial(): Promise<void> {
		const update = this.#state.update;
		if (!update || update.status !== "pending" || this.#stopping) return;
		const active = this.#child;
		this.#child = undefined;
		if (active) await active.stop();
		const backup = this.#deps.snapshot(`${update.fromVersion}-${update.id}`);
		const withBackup: UpdateRecord = { ...update, backup };
		this.#save({ ...this.#state, update: withBackup });
		this.#startTrial(withBackup);
	}

	async #resumeTrial(update: UpdateRecord): Promise<void> {
		if (!update.backup || !fs.existsSync(update.backup)) {
			const backup = this.#deps.snapshot(`${update.fromVersion}-${update.id}`);
			update = { ...update, backup };
			this.#save({ ...this.#state, update });
		}
		this.#startTrial(update);
	}

	#startTrial(update: UpdateRecord): void {
		if (this.#stopping) return;
		const child = this.#deps.spawnChild(update.targetVersion, "trial", update.id);
		this.#child = child;
		this.#startedAt = this.#deps.now();
		child.onMessage((raw) => void this.#onMessage(child, raw));
		child.onExit((code, signal) => this.#onExit(child, code, signal));
		this.#deps.log(`[launcher] Trial of ${update.targetVersion} started (update ${update.id}).`);
		this.#setTimer(() => void this.#rollback("prepared-timeout"), PREPARED_TIMEOUT_MS);
	}

	async #handlePrepared(child: ChildHandle, updateId: string): Promise<void> {
		const update = this.#state.update;
		if (child.role !== "trial" || update?.status !== "pending" || update.id !== updateId || update.targetVersion !== child.version) {
			if (child.role === "trial") await this.#rollback("invalid-prepared");
			return;
		}
		this.#clearTimer();
		const deadline = this.#deps.now() + HEALTH_AFTER_PREPARED_MS;
		let healthy = false;
		while (!healthy && this.#deps.now() <= deadline && this.#child === child) {
			try {
				const health = await this.#deps.health();
				healthy = health.ok && (!health.version || health.version === update.targetVersion);
			} catch { /* retry */ }
			if (!healthy) await new Promise<void>((resolve) => this.#deps.setTimeout(resolve, HEALTH_RETRY_MS));
		}
		if (this.#child !== child) return;
		if (!healthy) {
			await this.#rollback("health-check-failed");
			return;
		}
		this.#commit(child, update);
	}

	#commit(child: ChildHandle, update: UpdateRecord): void {
		const committed: UpdateRecord = { ...update, status: "committed", at: this.#deps.now() };
		delete committed.reason;
		const next: ServiceState = {
			...this.#state,
			previousVersion: update.fromVersion,
			activeVersion: update.targetVersion,
			badVersions: this.#state.badVersions.filter((v) => v !== update.targetVersion),
			update: committed,
		};
		this.#save(next);
		child.role = "active";
		this.#failures = 0;
		child.send({ type: "committed", updateId: update.id });
		this.#deps.log(`[launcher] Update ${update.id} committed: now running ${update.targetVersion}.`);
		const repointError = this.#deps.repoint(update.targetVersion);
		if (repointError) this.#deps.log(`[launcher] Could not repoint the service at ${update.targetVersion}: ${repointError}`);
		if (update.targetVersion !== this.#deps.runningLauncherVersion) {
			try { writeFileDurably(layout(this.#deps.home).restartPending, `${update.targetVersion}\n`); } catch { /* informational */ }
		}
		try { this.#deps.prune(next); } catch (error) { this.#deps.log(`[launcher] Pruning failed: ${String(error)}`); }
		void this.#maybeRelaunch(update.targetVersion);
	}

	async #rollback(reason: string): Promise<void> {
		const update = this.#state.update;
		if (!update || update.status !== "pending") return;
		this.#clearTimer();
		const trial = this.#child;
		this.#child = undefined;
		if (trial) await trial.stop();
		if (update.backup && fs.existsSync(update.backup)) {
			try { this.#deps.restore(update.backup); }
			catch (error) { this.#deps.log(`[launcher] Restoring ${update.backup} failed: ${String(error)}`); }
		}
		const badVersions = this.#state.badVersions.includes(update.targetVersion) ? this.#state.badVersions : [...this.#state.badVersions, update.targetVersion];
		this.#save({ ...this.#state, badVersions, update: { ...update, status: "rolled-back", reason, at: this.#deps.now() } });
		this.#deps.log(`[launcher] Update ${update.id} to ${update.targetVersion} rolled back: ${reason}.`);
		const repointError = this.#deps.repoint(this.#state.activeVersion);
		if (repointError) this.#deps.log(`[launcher] Could not repoint the service at ${this.#state.activeVersion}: ${repointError}`);
		this.#startActive();
	}

	// -- launcher protocol: relaunch only when a version requires it ----------

	async #maybeRelaunch(version: string): Promise<void> {
		if (this.#relaunchArmed) return;
		const required = this.#deps.minLauncherProtocolOf(version);
		if (required <= LAUNCHER_PROTOCOL) return;
		this.#relaunchArmed = true;
		this.#deps.log(`[launcher] ${version} needs launcher protocol ${required}; this launcher speaks ${LAUNCHER_PROTOCOL}. Testing the new launcher.`);
		if (!(await this.#deps.selftestLauncher(version))) {
			this.#deps.log("[launcher] launcher update failed: the new launcher's self-test failed. Keeping this launcher running.");
			return;
		}
		const poll = async () => {
			if (this.#stopping) return;
			let idle = false;
			try { idle = (await this.#deps.health()).idle === true; } catch { idle = false; }
			if (!idle) { this.#setTimer(() => void poll(), IDLE_RELAUNCH_POLL_MS); return; }
			this.#deps.log("[launcher] Idle: handing off to the new launcher.");
			this.#stopping = true;
			this.#clearTimer();
			const child = this.#child;
			this.#child = undefined;
			if (child) await child.stop();
			this.#deps.exit(EXIT_RELAUNCH);
		};
		await poll();
	}

	// -- deliberate stop -------------------------------------------------------

	/** SIGTERM/SIGINT: the caller writes .service-stopping first (synchronously). */
	async stop(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		this.#clearTimer();
		const child = this.#child;
		this.#child = undefined;
		if (child) await child.stop();
		this.#deps.log(this.#state.update?.status === "pending"
			? "[launcher] Stopped during an update; it stays pending and resumes on the next start."
			: "[launcher] Stopped.");
	}
}

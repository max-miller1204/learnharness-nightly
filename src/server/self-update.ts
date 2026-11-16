/**
 * IN-APP UPDATER for self-hosted installs (self-hosting plan, part A2;
 * the T3 Code split: the server checks, downloads, stages and decides
 * WHEN; the `lh` launcher validates, snapshots, trials, commits or rolls
 * back). Active only when the launcher started this server
 * (LH_SELFHOST=1 plus an IPC channel). Under `npm run dev`, `npm start`
 * and the desktop app it reports "disabled" and does nothing.
 *
 * State uses the desktop's UpdateState vocabulary
 * (components/settings/update-settings.tsx) with the same revision rule,
 * so the existing banner and Settings row render it unchanged. Changes are
 * announced on the event bus ("update-changed"); clients fetch
 * GET /api/updates (notify, then fetch).
 *
 * Applying: once a version is downloaded, apply it the first time the app
 * is idle (no turn, no compaction, no running job, plugin worker or
 * extraction), checked every 30 s. "Restart" in the UI applies at once.
 * Applying = asking the launcher over IPC ("request-update"). The launcher
 * owns runtime/service-state.json; this module only reads it.
 */
import { emit } from "../core/events.ts";
import { readSettings } from "../store/settings.ts";
import { listChats } from "./chats.ts";
import { compactionInFlight } from "./compaction.ts";
import { activityFeed } from "./observability.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { ENV, parseParentMessage, type ChildMessage } from "../../selfhost/src/protocol.ts";
import {
	compareVersions,
	currentArch,
	DEFAULT_FEED_URL,
	fetchLatest,
	isExactVersion,
	isInstalled,
	readState,
	stageVersion,
	type LatestFeed,
	type ServiceState,
} from "../../selfhost/src/release.ts";

export type SelfUpdateStatus = "idle" | "checking" | "downloading" | "up-to-date" | "downloaded" | "error" | "disabled";

/** The outcome of the last switch, shown once by the banner. */
export interface UpdateNotice {
	kind: "updated" | "rolled-back";
	version: string;
	text: string;
	at: number;
}

/** Wire shape of GET /api/updates; a superset of the desktop UpdateState. */
export interface SelfUpdateState {
	status: SelfUpdateStatus;
	version: string | null;
	revision: number;
	/** Detail for the Settings row (errors, rejections, progress). */
	message: string | null;
	/** Outcome of the last switch for the banner; "updated" expires after UPDATED_NOTICE_MS. */
	notice: UpdateNotice | null;
}

export const CHECK_INTERVAL_MS = 15 * 60 * 1000;
export const IDLE_POLL_MS = 30 * 1000;
/** "Updated to X" shows for this long after a commit, then clears. */
export const UPDATED_NOTICE_MS = 15 * 60 * 1000;

export interface SelfUpdaterDeps {
	enabled: boolean;
	currentVersion: string;
	home: string;
	feedUrl: string;
	trialUpdateId?: string;
	send(message: ChildMessage): void;
	onParentMessage(cb: (message: unknown) => void): void;
	isIdle(): boolean;
	autoUpdateEnabled(): boolean;
	fetchLatest(feedUrl: string): Promise<LatestFeed>;
	stage(feed: LatestFeed, badVersions: readonly string[]): Promise<void>;
	isInstalled(version: string): boolean;
	readState(): ServiceState | undefined;
	/** Resolves once this server answers its own /api/health. */
	waitUntilServing(): Promise<void>;
	notify(): void;
	now(): number;
	setTimeout(cb: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export function createSelfUpdater(deps: SelfUpdaterDeps) {
	let state: SelfUpdateState = { status: deps.enabled ? "idle" : "disabled", version: null, revision: 0, message: null, notice: null };
	let checkTimer: unknown;
	let idleTimer: unknown;
	let checking: Promise<void> | undefined;
	let requested = false;
	let started = false;

	const set = (next: Partial<SelfUpdateState>) => {
		state = { ...state, ...next, revision: state.revision + 1 };
		deps.notify();
	};

	const clearIdle = () => {
		if (idleTimer !== undefined) deps.clearTimeout(idleTimer);
		idleTimer = undefined;
	};

	const requestUpdate = (version: string) => {
		if (requested) return;
		requested = true;
		clearIdle();
		set({ status: "downloaded", version, message: `Restarting to install version ${version}…` });
		try {
			deps.send({ type: "request-update", targetVersion: version });
		} catch (error) {
			requested = false;
			set({ status: "error", message: `Couldn't reach the launcher: ${error instanceof Error ? error.message : String(error)}` });
		}
	};

	const scheduleIdleApply = (version: string) => {
		clearIdle();
		const tick = () => {
			idleTimer = undefined;
			if (state.status !== "downloaded" || state.version !== version || requested) return;
			if (deps.isIdle()) requestUpdate(version);
			else idleTimer = deps.setTimeout(tick, IDLE_POLL_MS);
		};
		idleTimer = deps.setTimeout(tick, 0);
	};

	const runCheck = async (): Promise<void> => {
		if (!deps.enabled) return;
		if (state.status === "downloaded" || requested) return;
		set({ status: "checking", message: null });
		try {
			const feed = await deps.fetchLatest(deps.feedUrl);
			const known = isExactVersion(deps.currentVersion);
			if (known && compareVersions(feed.version, deps.currentVersion) <= 0) {
				set({ status: "up-to-date", version: null, message: null });
				return;
			}
			const bad = deps.readState()?.badVersions ?? [];
			if (bad.includes(feed.version)) {
				set({ status: "up-to-date", version: null, message: `Version ${feed.version} failed to start earlier and is skipped.` });
				return;
			}
			if (!deps.isInstalled(feed.version)) {
				set({ status: "downloading", version: feed.version });
				await deps.stage(feed, bad);
			}
			set({ status: "downloaded", version: feed.version, message: null });
			scheduleIdleApply(feed.version);
		} catch (error) {
			set({ status: "error", message: error instanceof Error ? error.message : String(error) });
		}
	};

	const check = (): Promise<void> => {
		checking ??= runCheck().finally(() => { checking = undefined; });
		return checking;
	};

	const scheduleChecks = () => {
		const loop = () => {
			checkTimer = deps.setTimeout(() => {
				if (deps.autoUpdateEnabled()) void check();
				loop();
			}, CHECK_INTERVAL_MS);
		};
		loop();
	};

	const onParent = (raw: unknown) => {
		const message = parseParentMessage(raw);
		if (!message) return;
		if (message.type === "update-accepted") {
			set({ message: state.version ? `Installing version ${state.version}…` : "Installing the update…" });
		} else if (message.type === "update-rejected") {
			requested = false;
			set({ status: "error", message: message.reason });
		} else if (message.type === "committed") {
			const text = `Updated to version ${deps.currentVersion}.`;
			set({ status: "up-to-date", version: null, message: text, notice: { kind: "updated", version: deps.currentVersion, text, at: deps.now() } });
		}
	};

	/** Reflect the launcher's last decision (read once at boot). */
	const adoptServiceState = () => {
		const update = deps.readState()?.update;
		if (!update) return;
		if (update.status === "rolled-back" && update.fromVersion === deps.currentVersion) {
			const text = `Update to version ${update.targetVersion} failed to start and was rolled back.${update.reason ? ` (${update.reason})` : ""}`;
			set({ status: "error", version: null, message: text, notice: { kind: "rolled-back", version: update.targetVersion, text, at: update.at } });
		} else if (update.status === "committed" && update.targetVersion === deps.currentVersion && deps.now() - update.at < UPDATED_NOTICE_MS) {
			const text = `Updated to version ${deps.currentVersion}.`;
			set({ status: "up-to-date", version: null, message: text, notice: { kind: "updated", version: deps.currentVersion, text, at: update.at } });
		}
	};

	return {
		state: (): SelfUpdateState =>
			state.notice?.kind === "updated" && deps.now() - state.notice.at > UPDATED_NOTICE_MS ? { ...state, notice: null } : state,
		check,
		/** "Restart" / POST /api/updates/install: apply now, checking first if nothing is staged. */
		async install(): Promise<void> {
			if (!deps.enabled) return;
			if (state.status !== "downloaded") await check();
			if (state.status === "downloaded" && state.version) requestUpdate(state.version);
		},
		start(): void {
			if (!deps.enabled || started) return;
			started = true;
			deps.onParentMessage(onParent);
			adoptServiceState();
			if (deps.trialUpdateId) {
				const id = deps.trialUpdateId;
				void deps.waitUntilServing().then(
					() => deps.send({ type: "prepared", updateId: id }),
					() => { /* never serving: the launcher's trial timeout rolls back */ },
				);
			} else if (deps.autoUpdateEnabled()) {
				void check();
			}
			scheduleChecks();
		},
		stop(): void {
			if (checkTimer !== undefined) deps.clearTimeout(checkTimer);
			clearIdle();
		},
	};
}

export type SelfUpdater = ReturnType<typeof createSelfUpdater>;

// ---------------------------------------------------------------------------
// The process singleton (globalThis: Next can evaluate modules twice).

/** True when nothing is running that an update restart would interrupt. */
export function appIsIdle(): boolean {
	for (const chat of listChats()) {
		if (isTurnRunning(chat.id) || compactionInFlight(chat.id)) return false;
	}
	const feed = activityFeed();
	return feed.jobs.length === 0 && feed.pluginWorkers.length === 0 && feed.extractions.length === 0;
}

const KEY = Symbol.for("learnharness.self-updater");
const store = globalThis as typeof globalThis & { [KEY]?: SelfUpdater };

function selfhostEnabled(): boolean {
	return process.env[ENV.selfhost] === "1" && typeof process.send === "function" && typeof process.env[ENV.home] === "string";
}

async function waitUntilServing(): Promise<void> {
	const port = process.env.PORT ?? "3000";
	const deadline = Date.now() + 10 * 60 * 1000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
			if (response.ok) return;
		} catch { /* not listening yet */ }
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error("server never answered /api/health");
}

export function selfUpdater(): SelfUpdater {
	const existing = store[KEY];
	if (existing) return existing;
	const enabled = selfhostEnabled();
	const home = process.env[ENV.home] ?? "";
	const arch = currentArch();
	const updater = createSelfUpdater({
		enabled: enabled && arch !== undefined,
		currentVersion: process.env.LH_VERSION ?? "",
		home,
		feedUrl: process.env[ENV.feedUrl] || DEFAULT_FEED_URL,
		trialUpdateId: process.env[ENV.trialUpdateId] || undefined,
		send: (message) => {
			if (!process.send) throw new Error("no launcher IPC channel");
			process.send(message);
		},
		onParentMessage: (cb) => { process.on("message", cb); },
		isIdle: appIsIdle,
		autoUpdateEnabled: () => readSettings()?.general?.autoUpdate !== false,
		fetchLatest: (url) => fetchLatest(url),
		stage: async (feed, badVersions) => {
			if (!arch) throw new Error("This platform has no self-hosted builds.");
			await stageVersion(home, feed, arch, { badVersions });
		},
		isInstalled: (version) => isInstalled(home, version),
		readState: () => {
			try { return readState(home); } catch { return undefined; }
		},
		waitUntilServing,
		notify: () => emit("update-changed", {}),
		now: () => Date.now(),
		setTimeout: (cb, ms) => {
			const handle = setTimeout(cb, ms);
			handle.unref?.();
			return handle;
		},
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	});
	store[KEY] = updater;
	return updater;
}

/** GET /api/health: what the launcher's health check and `lh status` read. */
export function healthSnapshot(): { ok: true; version: string; selfhost: boolean; idle: boolean; update: SelfUpdateState } {
	return {
		ok: true,
		version: process.env.LH_VERSION ?? "",
		selfhost: selfhostEnabled(),
		idle: appIsIdle(),
		update: selfUpdater().state(),
	};
}

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
 * T3 style (docs/specs/t3-style-updates.md): check at start and every 4
 * hours, download in the background, and apply ONLY when the user clicks
 * Install (the confirm dialog lists runningWork()). Checks keep running
 * while a version is ready, so a newer nightly replaces it; install()
 * re-checks first. Applying = asking the launcher over IPC
 * ("request-update"). The launcher owns runtime/service-state.json; this
 * module only reads it.
 */
import { emit } from "../core/events.ts";
import type { ReleaseNoteGroup } from "../core/release-notes.ts";
import { feedNotesToGroups, groupsBetween, mergeNotesCache, readUpdateRecord, writeUpdateRecord } from "./update-records.ts";
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

/** A rolled-back switch, shown by the sidebar pill until dismissed (per server). */
export interface UpdateNotice {
	kind: "rolled-back";
	version: string;
	text: string;
	at: number;
}

/** Wire shape of GET /api/updates; a superset of the desktop UpdateState. */
export interface SelfUpdateState {
	status: SelfUpdateStatus;
	version: string | null;
	revision: number;
	/** This server process. A restarted server counts revisions from 0 again, so clients reset their revision guard when it changes. */
	instance: string;
	/** Detail for the Settings row (errors, rejections, progress). */
	message: string | null;
	/** A rolled-back switch until dismissed. */
	notice: UpdateNotice | null;
	/** Versions newer than the running one up to the offered one, newest first, at most 6. */
	releaseNotes: ReleaseNoteGroup[];
	omittedReleaseCount: number;
}

export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export const noticeId = (notice: UpdateNotice) => `${notice.kind}:${notice.version}:${notice.at}`;

export interface SelfUpdaterDeps {
	enabled: boolean;
	currentVersion: string;
	home: string;
	feedUrl: string;
	trialUpdateId?: string;
	send(message: ChildMessage): void;
	onParentMessage(cb: (message: unknown) => void): void;
	autoUpdateEnabled(): boolean;
	fetchLatest(feedUrl: string): Promise<LatestFeed>;
	stage(feed: LatestFeed, badVersions: readonly string[]): Promise<void>;
	isInstalled(version: string): boolean;
	readState(): ServiceState | undefined;
	/** Merge the feed's notes into the data folder's notes cache (What's new reads it). */
	mergeNotes(groups: ReleaseNoteGroup[]): void;
	dismissedNotice(): string | undefined;
	recordDismissedNotice(id: string): void;
	/** Resolves once this server answers its own /api/health. */
	waitUntilServing(): Promise<void>;
	notify(): void;
	now(): number;
	setTimeout(cb: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export function createSelfUpdater(deps: SelfUpdaterDeps) {
	let state: SelfUpdateState = {
		status: deps.enabled ? "idle" : "disabled", version: null, revision: 0, instance: globalThis.crypto.randomUUID(), message: null, notice: null, releaseNotes: [], omittedReleaseCount: 0,
	};
	let checkTimer: unknown;
	let checking: Promise<void> | undefined;
	let requested = false;
	let started = false;

	const set = (next: Partial<SelfUpdateState>) => {
		state = { ...state, ...next, revision: state.revision + 1 };
		deps.notify();
	};

	const requestUpdate = (version: string) => {
		if (requested) return;
		requested = true;
		set({ status: "downloaded", version, message: `Restarting to install version ${version}…` });
		try {
			deps.send({ type: "request-update", targetVersion: version });
		} catch (error) {
			requested = false;
			set({ status: "error", message: `Couldn't reach the launcher: ${error instanceof Error ? error.message : String(error)}` });
		}
	};

	const notesFor = (feed: LatestFeed) => {
		const groups = feedNotesToGroups(feed.notes ?? []);
		try { deps.mergeNotes(groups); } catch { /* the cache is a convenience; never fail a check */ }
		const known = isExactVersion(deps.currentVersion);
		return groupsBetween(groups, known ? deps.currentVersion : undefined, feed.version);
	};

	const runCheck = async (): Promise<void> => {
		if (!deps.enabled || requested) return;
		// A ready version stays offered (no "checking" flicker) while a newer one is looked for and staged.
		const ready = state.status === "downloaded" && state.version ? state.version : null;
		if (!ready) set({ status: "checking", message: null });
		try {
			const feed = await deps.fetchLatest(deps.feedUrl);
			if (requested) return;
			const known = isExactVersion(deps.currentVersion);
			if (known && compareVersions(feed.version, deps.currentVersion) <= 0) {
				if (!ready) set({ status: "up-to-date", version: null, message: null, releaseNotes: [], omittedReleaseCount: 0 });
				return;
			}
			if (ready && compareVersions(feed.version, ready) <= 0) {
				set(notesFor(feed));
				return;
			}
			const bad = deps.readState()?.badVersions ?? [];
			if (bad.includes(feed.version)) {
				if (!ready) set({ status: "up-to-date", version: null, message: `Version ${feed.version} failed to start earlier and is skipped.`, releaseNotes: [], omittedReleaseCount: 0 });
				return;
			}
			const notes = notesFor(feed);
			if (!deps.isInstalled(feed.version)) {
				if (!ready) set({ status: "downloading", version: feed.version, ...notes });
				await deps.stage(feed, bad);
				if (requested) return;
			}
			set({ status: "downloaded", version: feed.version, message: null, ...notes });
		} catch (error) {
			// A failed look for something newer keeps the ready version offered.
			if (!ready) set({ status: "error", message: error instanceof Error ? error.message : String(error) });
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
			set({ status: "up-to-date", version: null, message: `Updated to version ${deps.currentVersion}.`, releaseNotes: [], omittedReleaseCount: 0 });
		}
	};

	/** Reflect the launcher's last decision (read once at boot). */
	const adoptServiceState = () => {
		const update = deps.readState()?.update;
		if (!update) return;
		if (update.status === "rolled-back" && update.fromVersion === deps.currentVersion) {
			const text = `Update to version ${update.targetVersion} failed to start and was rolled back.${update.reason ? ` (${update.reason})` : ""}`;
			const notice: UpdateNotice = { kind: "rolled-back", version: update.targetVersion, text, at: update.at };
			let dismissed: string | undefined;
			try { dismissed = deps.dismissedNotice(); } catch { dismissed = undefined; }
			// A notice dismissed on any browser of this server stays gone, text included.
			if (dismissed === noticeId(notice)) return;
			set({ status: "error", version: null, message: text, notice });
		}
	};

	return {
		state: (): SelfUpdateState => state,
		check,
		/** Install / POST /api/updates/install: re-check first (a download can be hours old), then apply the ready version. */
		async install(): Promise<void> {
			if (!deps.enabled || requested) return;
			await check();
			if (state.status === "downloaded" && state.version) requestUpdate(state.version);
		},
		/** POST /api/updates/notice/dismiss: hide the rollback notice on every browser of this server. */
		dismissNotice(): void {
			if (!state.notice) return;
			try { deps.recordDismissedNotice(noticeId(state.notice)); } catch { /* still hide it for this run */ }
			const text = state.notice.text;
			set({ notice: null, ...(state.message === text ? { message: null } : {}), ...(state.status === "error" && state.message === text ? { status: "idle" as const } : {}) });
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
		},
	};
}

export type SelfUpdater = ReturnType<typeof createSelfUpdater>;

// ---------------------------------------------------------------------------
// The process singleton (globalThis: Next can evaluate modules twice).

/** One piece of running work an update restart would interrupt (GET /api/updates/running). */
export interface RunningWork {
	kind: "turn" | "compaction" | "job" | "plugin-worker" | "extraction";
	title: string;
}

export function runningWork(): RunningWork[] {
	const items: RunningWork[] = [];
	for (const chat of listChats()) {
		const title = chat.title ?? chat.id;
		if (isTurnRunning(chat.id)) items.push({ kind: "turn", title });
		if (compactionInFlight(chat.id)) items.push({ kind: "compaction", title });
	}
	const feed = activityFeed();
	for (const job of feed.jobs) items.push({ kind: "job", title: job.title });
	for (const worker of feed.pluginWorkers) items.push({ kind: "plugin-worker", title: worker.title });
	for (const extraction of feed.extractions) items.push({ kind: "extraction", title: extraction.title });
	return items;
}

/** True when nothing is running that an update restart would interrupt. */
export function appIsIdle(): boolean {
	return runningWork().length === 0;
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
		mergeNotes: (groups) => mergeNotesCache(groups),
		dismissedNotice: () => readUpdateRecord().dismissedNotice,
		recordDismissedNotice: (id) => { writeUpdateRecord({ dismissedNotice: id }); },
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

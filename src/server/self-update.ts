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
 * T3 style (docs/specs/t3-style-updates.md): check 15 s after start and
 * every 4 hours. A check that finds a newer version offers it ("available", with its
 * notes); it downloads only when the user clicks Download (download(), POST
 * /api/updates/download) and applies ONLY when the user clicks Install. A
 * server started by an update checks 15 s after the launcher commits it
 * instead.
 * Checks keep running while a version is offered or ready, and a newer
 * nightly replaces it; install() re-checks first, downloading a newer offer
 * itself. Applying = asking the launcher over IPC ("request-update"). The
 * launcher owns runtime/service-state.json; this module only reads it.
 */
import { emit } from "../core/events.ts";
import type { ReleaseNoteGroup } from "../core/release-notes.ts";
import { feedNotesToGroups, groupsBetween, mergeNotesCache, readUpdateRecord, writeUpdateRecord } from "./update-records.ts";
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
	fetchRelease,
	isExactVersion,
	isInstalled,
	readState,
	stageVersion,
	stagedAssetSha256,
	type DownloadBytes,
	type LatestFeed,
	type ServiceState,
	type StageOptions,
} from "../../selfhost/src/release.ts";

export type SelfUpdateStatus = "idle" | "checking" | "available" | "downloading" | "up-to-date" | "downloaded" | "error" | "disabled";

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
	/** The version this server runs. A page built from an older one offers a reload (the sidebar update control). */
	runningVersion: string;
	/** False while this server is the launcher's trial, until the launcher commits it. A trial
	 *  answers /api/health before that, so Update everything waits for this (roadmap item 23). */
	committed: boolean;
	/** The exact version Update everything asked this server for, why it failed (null while it
	 *  goes on), and the attempt's id: the desktop trusts only the error of the attempt it started. */
	pinned: { version: string; error: string | null; id: string } | null;
	/** How far the download is while "downloading", 0 to 100; null when the size is unknown
	 *  or nothing downloads (the sidebar's progress ring, docs/specs/update-control.md). */
	downloadPercent: number | null;
	/** True while "downloading" once every byte is in: the archive is checked and unpacked
	 *  ("Preparing update", owner decision 2026-11-19). Install waits for "downloaded" as before. */
	preparing: boolean;
	/** Detail for the Settings row (errors, rejections, progress). */
	message: string | null;
	/** The version a check offered ("available"), kept while it downloads and once it is ready;
	 *  null with nothing offered (T3's availableVersion). */
	availableVersion: string | null;
	/** "download" while an offer stays "available" after its download failed, so the button
	 *  retries it ("Download failed for X. Click to retry.", T3's errorContext); else null. */
	errorContext: "download" | null;
	/** A rolled-back switch until dismissed. */
	notice: UpdateNotice | null;
	/** Versions newer than the running one up to the offered one, newest first, at most 6. */
	releaseNotes: ReleaseNoteGroup[];
	omittedReleaseCount: number;
}

export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** The first check runs this long after start (T3's 15 s after launch), or for a server
 *  started by an update, this long after the launcher commits it. */
export const CHECK_AFTER_START_MS = 15_000;
export const CHECK_AFTER_COMMIT_MS = CHECK_AFTER_START_MS;

/** T3's shouldBroadcastDownloadProgress (apps/desktop/src/updates/DesktopUpdates.ts:325-341 at
 *  3ce21458), for a state already "downloading": report the first known percent, then each
 *  whole 10% and 100%. An unknown size never reports (the ring stays empty). */
export function shouldReportDownloadProgress(current: number | null, next: number | null): boolean {
	if (next === null) return false;
	if (current === null) return true;
	return Math.floor(next / 10) !== Math.floor(current / 10) || next === 100;
}

export const noticeId = (notice: UpdateNotice) => `${notice.kind}:${notice.version}:${notice.at}`;

export interface SelfUpdaterDeps {
	enabled: boolean;
	currentVersion: string;
	home: string;
	feedUrl: string;
	trialUpdateId?: string;
	send(message: ChildMessage): void;
	onParentMessage(cb: (message: unknown) => void): void;
	fetchLatest(feedUrl: string): Promise<LatestFeed>;
	/** One exact version's own feed entry (selfhost/src/release.ts fetchRelease). */
	fetchRelease(version: string, feedUrl: string): Promise<LatestFeed>;
	stage(feed: LatestFeed, badVersions: readonly string[], onBytes?: DownloadBytes, onPhase?: StageOptions["onProgress"]): Promise<void>;
	isInstalled(version: string): boolean;
	/** True when `version` is on disk from another archive than the one `feed` names (a
	 *  republished build): that copy is stale, and staging replaces it. */
	isStale(feed: LatestFeed): boolean;
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
		status: deps.enabled ? "idle" : "disabled", version: null, revision: 0, instance: globalThis.crypto.randomUUID(), runningVersion: deps.currentVersion, committed: !deps.trialUpdateId, pinned: null, downloadPercent: null, preparing: false, message: null, availableVersion: null, errorContext: null, notice: null, releaseNotes: [], omittedReleaseCount: 0,
	};
	let checkTimer: unknown;
	let firstCheckTimer: unknown;
	let checking: Promise<void> | undefined;
	let requested = false;
	// The `pinned` attempt whose request-update the launcher is answering, if any.
	let pinnedRequest: string | null = null;
	let started = false;
	/** The feed entry of the version on offer ("available"), what Download stages: always the
	 *  one the last successful check read, asset included. */
	let offer: LatestFeed | null = null;
	/** Every version staged on disk this run, with the notes it was offered with, and whether a
	 *  feed went below it since (withdrawn): Install's fallback when a newer one its own check
	 *  found fails to stage. */
	const staged = new Map<string, Pick<SelfUpdateState, "releaseNotes" | "omittedReleaseCount"> & { withdrawn: boolean }>();
	/** Checks started, and the last one that read the feed: Install falls back only after its own. */
	let checkRuns = 0;
	let lastReadRun = 0;
	/** A Download queued or running: a second click joins it. */
	let downloading: Promise<void> | undefined;

	const set = (next: Partial<SelfUpdateState>) => {
		state = { ...state, ...next, revision: state.revision + 1 };
		if (state.status !== "downloading") state = { ...state, downloadPercent: null, preparing: false };
		// The download retry belongs to an offer only ("available" with `offer`, what Download
		// stages): any other state shows Check, never a Download that would do nothing.
		if (state.status !== "available") state = { ...state, errorContext: null };
		deps.notify();
	};

	/** Stage `feed`, moving the progress ring while this download is the one shown. A new
	 *  state (and update event) only at each whole 10% and at 100%, as T3 broadcasts it.
	 *  Once the bytes are in (the checksum, then the unpack) the ring is full: "Preparing update". */
	const stage = (feed: LatestFeed, bad: readonly string[]) => {
		const shown = () => state.status === "downloading" && state.version === feed.version;
		return deps.stage(feed, bad, (received, total) => {
			if (!shown() || state.preparing) return;
			const percent = total ? Math.min(100, (received / total) * 100) : null;
			if (shouldReportDownloadProgress(state.downloadPercent, percent)) set({ downloadPercent: percent });
		}, (phase) => {
			if (phase !== "downloading" && shown() && !state.preparing) set({ downloadPercent: 100, preparing: true });
		});
	};

	const requestUpdate = (version: string, shown: Partial<SelfUpdateState> = {}) => {
		if (requested) return;
		requested = true;
		set({ status: "downloaded", version, message: `Restarting to install version ${version}…`, ...shown });
		try {
			deps.send({ type: "request-update", targetVersion: version });
		} catch (error) {
			requested = false;
			set({ status: "error", message: `Couldn't reach the launcher: ${error instanceof Error ? error.message : String(error)}` });
		}
	};

	const notesFor = (feed: LatestFeed) => {
		const groups = feedNotesToGroups(feed.notes ?? [], { version: feed.version, releasedAt: feed.publishedAt });
		try { deps.mergeNotes(groups); } catch { /* the cache is a convenience; never fail a check */ }
		const known = isExactVersion(deps.currentVersion);
		return groupsBetween(groups, known ? deps.currentVersion : undefined, feed.version);
	};

	const runCheck = async (): Promise<void> => {
		if (!deps.enabled || requested) return;
		const run = ++checkRuns;
		// A ready or offered version stays on screen (no "checking" flicker) while the feed is read.
		const ready = state.status === "downloaded" && state.version ? state.version : null;
		const kept = ready ?? (state.status === "available" && offer ? offer.version : null);
		if (!kept) set({ status: "checking", message: null });
		try {
			const feed = await deps.fetchLatest(deps.feedUrl);
			if (requested) return;
			lastReadRun = run;
			// A staged version the feed went below is withdrawn: never a fallback again, unless the
			// feed names it again.
			for (const [version, entry] of staged) {
				if (version === feed.version) entry.withdrawn = false;
				else if (compareVersions(version, feed.version) > 0) entry.withdrawn = true;
			}
			const known = isExactVersion(deps.currentVersion);
			const bad = deps.readState()?.badVersions ?? [];
			// Nothing newer to offer (the release was pulled, or the feed rolled back): T3's
			// reduceOnNoUpdate clears an offer that isn't downloaded. A version shown as downloaded
			// stays shown (T3 keeps a download through "no update"); Install's own check is what
			// decides what it installs, and this answer never makes it fall back.
			const skipped = bad.includes(feed.version);
			if ((known && compareVersions(feed.version, deps.currentVersion) <= 0) || (skipped && !ready)) {
				if (ready) return;
				offer = null;
				set({ status: "up-to-date", version: null, availableVersion: null, message: skipped ? `Version ${feed.version} failed to start earlier and is skipped.` : null, releaseNotes: [], omittedReleaseCount: 0 });
				return;
			}
			// A staged copy built from another archive than the feed names (a republished build) is stale.
			const stale = deps.isStale(feed);
			if (ready && ((feed.version === ready && !stale) || skipped)) {
				if (!skipped) set(notesFor(feed));
				return;
			}
			// Otherwise the feed's version is what shows, with its own notes, even below a ready one
			// (T3's reduceDesktopUpdateStateOnUpdateAvailable, apps/desktop/src/updates/updateMachine.ts:89-111
			// at df09ced7: "downloaded" only when the downloaded version is that version). A ready
			// version the feed went below is withdrawn (marked above), never Install's fallback.
			const notes = notesFor(feed);
			// Already on disk (staged before a restart): ready at once. Otherwise offered exactly as the
			// feed now names it, asset included (T3's reduceOnUpdateAvailable), never downloaded here.
			if (deps.isInstalled(feed.version) && !stale) {
				offer = null;
				staged.set(feed.version, { ...notes, withdrawn: false });
				set({ status: "downloaded", version: feed.version, availableVersion: feed.version, message: null, ...notes });
			} else {
				staged.delete(feed.version);
				offer = feed;
				set({ status: "available", version: feed.version, availableVersion: feed.version, message: null, errorContext: null, ...notes });
			}
		} catch (error) {
			// A failed look for something newer keeps the offered or ready version.
			if (!kept) set({ status: "error", message: error instanceof Error ? error.message : String(error) });
		}
	};

	/** Stage the offered version (the Download click). A failure keeps the offer with the
	 *  download context, so the button retries it (T3's reduceOnDownloadFailure). */
	const runDownload = async (): Promise<void> => {
		if (!deps.enabled || requested) return;
		const feed = offer;
		if (state.status !== "available" || !feed || feed.version !== state.version) return;
		set({ status: "downloading", message: null, errorContext: null, downloadPercent: null, preparing: false });
		try {
			await stage(feed, deps.readState()?.badVersions ?? []);
		} catch (error) {
			if (!requested) set({ status: "available", message: error instanceof Error ? error.message : String(error), errorContext: "download" });
			return;
		}
		if (requested) return;
		if (offer === feed) offer = null;
		staged.set(feed.version, { releaseNotes: state.releaseNotes, omittedReleaseCount: state.omittedReleaseCount, withdrawn: false });
		set({ status: "downloaded", version: feed.version, availableVersion: feed.version, message: null });
	};

	/** One check, download or pinned staging at a time: a check while one runs joins it. */
	const check = (): Promise<void> => {
		if (!checking) {
			const pending: Promise<void> = runCheck().finally(() => { if (checking === pending) checking = undefined; });
			checking = pending;
		}
		return checking;
	};

	/** A download queues behind whatever runs, so a click during a check downloads what it
	 *  offers. A second click while one is queued or running joins it: one attempt, whatever
	 *  its result. */
	const download = (): Promise<void> => {
		if (downloading) return downloading;
		const pending: Promise<void> = (checking ?? Promise.resolve()).then(runDownload, runDownload).finally(() => {
			if (checking === pending) checking = undefined;
			if (downloading === pending) downloading = undefined;
		});
		checking = pending;
		downloading = pending;
		return pending;
	};

	/** The newest version staged this run that the launcher can still switch to: not withdrawn,
	 *  on disk, newer than the running one, not marked bad. */
	const newestStaged = (): string | null => {
		const bad = deps.readState()?.badVersions ?? [];
		const known = isExactVersion(deps.currentVersion);
		const valid = [...staged].filter(([, entry]) => !entry.withdrawn).map(([version]) => version).filter((version) => deps.isInstalled(version) && !bad.includes(version) && (!known || compareVersions(version, deps.currentVersion) > 0));
		return valid.sort(compareVersions).at(-1) ?? null;
	};

	const scheduleChecks = () => {
		const loop = () => {
			checkTimer = deps.setTimeout(() => {
				void check();
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
			// Only the attempt that asked the launcher, never a plain Install's refusal.
			const ours = state.pinned && pinnedRequest === state.pinned.id;
			pinnedRequest = null;
			set({ status: "error", message: message.reason, ...(ours && state.pinned ? { pinned: { ...state.pinned, error: message.reason } } : {}) });
		} else if (message.type === "committed") {
			set({ committed: true, status: "up-to-date", version: null, message: `Updated to version ${deps.currentVersion}.`, releaseNotes: [], omittedReleaseCount: 0 });
			// A trial skips the startup check; once it is the active server it checks like any other
			// start, after a pause: the launcher prunes leftover *.tmp version folders right after the
			// commit, which would delete a download being unpacked (T3 also waits 15 s after launch).
			firstCheckTimer = deps.setTimeout(() => { void check(); }, CHECK_AFTER_COMMIT_MS);
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
		/** A check, a download or a pinned staging is running. True even while a ready version
		 *  stays offered as "downloaded" during a look for a newer one. */
		busy: (): boolean => checking !== undefined,
		check,
		/** Download / POST /api/updates/download: stage the offered version. */
		download,
		/** Install / POST /api/updates/install: always a fresh look at the feed first (a download
		 *  can be hours old; work already running finishes first), download a newer offer it finds,
		 *  then apply the ready version. When this Install's own check read a version newer than
		 *  anything staged and that download fails, the newest valid staged version installs
		 *  instead. A check that finds nothing newer (the release was pulled) or can't read the
		 *  feed never falls back. */
		async install(): Promise<void> {
			if (!deps.enabled || requested) return;
			// Wait out a running check, download or pinned staging, then start a check of our own:
			// checking is empty here, so this one reads the feed.
			while (checking) await checking.catch(() => {});
			if (requested) return;
			const before = checkRuns;
			await check();
			const offered = lastReadRun > before && state.status === "available" ? state.version : null;
			if (state.status === "available") await download();
			if (requested) return;
			if (state.status === "downloaded" && state.version) {
				requestUpdate(state.version);
				return;
			}
			const failed = offered && state.status === "available" && state.version === offered && state.errorContext === "download";
			const fallback = failed ? newestStaged() : null;
			if (offered && fallback && compareVersions(offered, fallback) > 0) {
				// The state shows what restarts: the fallback and its notes, not the failed build.
				const entry = staged.get(fallback);
				requestUpdate(fallback, { availableVersion: fallback, releaseNotes: entry?.releaseNotes ?? [], omittedReleaseCount: entry?.omittedReleaseCount ?? 0 });
			}
		},
		/** POST /api/updates/install-version (Update everything, roadmap item 23): checks the
		 *  request at once, then stages exactly `target` from its own release in the background
		 *  and asks the launcher to switch to it. Never takes a newer version. `refused` is the
		 *  reason it won't, or null (started, or nothing to do); `done` settles when staging ends
		 *  (with the failure, or null). The desktop follows `pinned` through GET /api/updates. */
		startInstallVersion(target: string): { refused: string | null; done: Promise<string | null> } {
			const answer = (refused: string | null) => ({ refused, done: Promise.resolve(refused) });
			if (!deps.enabled) return answer("This server isn't run by the lh launcher, so it can't update itself.");
			if (!isExactVersion(target)) return answer("The requested target is not an exact version.");
			if (requested) {
				if (state.version !== target) return answer("Another update is already starting.");
				// Already switching to it (maybe from the server's own Install): this request joins a fresh attempt.
				if (state.pinned?.version !== target || state.pinned.error) {
					const id = globalThis.crypto.randomUUID();
					pinnedRequest = id;
					set({ pinned: { version: target, error: null, id } });
				}
				return answer(null);
			}
			if (state.pinned && !state.pinned.error) return answer(state.pinned.version === target ? null : "Another update is already starting.");
			if (!isExactVersion(deps.currentVersion)) return answer("This server's version is unknown.");
			const order = compareVersions(target, deps.currentVersion);
			if (order === 0) return answer(null);
			if (order < 0) return answer(`This server already runs ${deps.currentVersion}, newer than ${target}.`);
			const bad = deps.readState()?.badVersions ?? [];
			if (bad.includes(target)) return answer(`Version ${target} failed to start on this server earlier.`);
			const id = globalThis.crypto.randomUUID();
			set({ pinned: { version: target, error: null, id } });
			const failed = (message: string) => {
				set({ status: "error", message, pinned: { version: target, error: message, id } });
				return message;
			};
			// A switch to the target already under way (the server's own Install got there first):
			// this attempt joins it, so the launcher's answer to that request is this attempt's.
			const joined = () => {
				pinnedRequest = id;
				return null;
			};
			const run = async (): Promise<string | null> => {
				if (requested) return state.version === target ? joined() : failed("Another update is already starting.");
				try {
					if (!deps.isInstalled(target)) {
						const feed = await deps.fetchRelease(target, deps.feedUrl);
						set({ status: "downloading", version: target, message: null, downloadPercent: null, preparing: false, ...notesFor(feed) });
						await stage(feed, bad);
					}
				} catch (error) {
					return failed(error instanceof Error ? error.message : String(error));
				}
				if (requested) return state.version === target ? joined() : failed("Another update is already starting.");
				pinnedRequest = id;
				requestUpdate(target);
				if (requested) return null;
				pinnedRequest = null; // the launcher was never asked
				return failed(state.message ?? "Couldn't reach the launcher.");
			};
			// Queue behind a check in flight and hold the slot, so a background check can't stage beside it.
			const done = (checking ?? Promise.resolve()).then(run);
			const slot: Promise<void> = done.then(() => {}, () => {}).finally(() => { if (checking === slot) checking = undefined; });
			checking = slot;
			return { refused: null, done };
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
			} else {
				firstCheckTimer = deps.setTimeout(() => { void check(); }, CHECK_AFTER_START_MS);
			}
			scheduleChecks();
		},
		stop(): void {
			if (checkTimer !== undefined) deps.clearTimeout(checkTimer);
			if (firstCheckTimer !== undefined) deps.clearTimeout(firstCheckTimer);
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
		fetchLatest: (url) => fetchLatest(url),
		fetchRelease: (version, url) => fetchRelease(version, url),
		stage: async (feed, badVersions, onBytes, onPhase) => {
			if (!arch) throw new Error("This platform has no self-hosted builds.");
			// The server stages only what it offers, so an installed copy here is a stale one to replace.
			await stageVersion(home, feed, arch, { badVersions, onBytes, onProgress: onPhase, replaceStale: true });
		},
		isInstalled: (version) => isInstalled(home, version),
		isStale: (feed) => {
			const asset = arch ? feed.assets[arch] : undefined;
			const recorded = stagedAssetSha256(home, feed.version);
			return !!asset && recorded !== undefined && recorded !== asset.sha256 && isInstalled(home, feed.version);
		},
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

/** Health's `idle`: nothing running, and no update check or download in
 *  flight, whatever the state shows (a ready version stays "downloaded" while
 *  a newer one is fetched). The launcher's relaunch waits for idle, and
 *  stopping the server mid-download would waste it. */
export function healthIdle(appIdle: boolean, updateBusy: boolean): boolean {
	return appIdle && !updateBusy;
}

/** The update state for callers that aren't signed in (the launcher, `lh status`
 *  of an old launcher, anyone who can reach the port): it still says an update
 *  failed (status "error", the rollback notice), but not the error text. */
export function publicUpdateState(state: SelfUpdateState): SelfUpdateState {
	return {
		...state,
		message: state.status === "error" || state.errorContext ? null : state.message,
		pinned: state.pinned ? { ...state.pinned, error: state.pinned.error ? "The update failed." : null } : null,
		notice: state.notice ? { ...state.notice, text: `Update to version ${state.notice.version} failed to start and was rolled back.` } : null,
	};
}

/** GET /api/health: what the launcher's health check and `lh status` read.
 *  `details` (a signed-in or paired caller) includes update error text. */
export function healthSnapshot({ details = false }: { details?: boolean } = {}): { ok: true; version: string; selfhost: boolean; idle: boolean; update: SelfUpdateState } {
	const updater = selfUpdater();
	const update = updater.state();
	return {
		ok: true,
		version: process.env.LH_VERSION ?? "",
		selfhost: selfhostEnabled(),
		idle: healthIdle(appIsIdle(), updater.busy()),
		update: details ? update : publicUpdateState(update),
	};
}

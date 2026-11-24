"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useNotifyHub } from "@/components/server-events";
import { InstallUpdateDialog } from "@/components/install-update-dialog";
import { APP_VERSION, HOMEPAGE } from "@/components/app-info";
import { CHECK_ERROR, CHECK_FAILED_TITLE, CHECK_UNAVAILABLE, DOWNLOAD_FAILED_TITLE, DOWNLOAD_START_FAILED_TITLE, INSTALL_FAILED_TITLE, showUpdateErrorToast, UNEXPECTED_ERROR } from "@/components/update-toast-helpers";
import { updateButtonTooltip } from "@/components/update-tooltips";
import { capReleaseNoteGroups, type ReleaseNoteGroup } from "@/src/core";
import { BRIDGE_FAILED, readBridgeAnswer, readUpdateEverythingResult, readUpdateEverythingRun, runIsLive, type BridgeAnswer, type UpdateEverythingResult, type UpdateEverythingRun } from "@/components/update-everything-logic";
import { SettingsRow } from "./controls.tsx";
import { isNewerVersion } from "@/selfhost/src/version-order.ts";

/** A rolled-back self-hosted switch (GET /api/updates `notice`), shown until dismissed. */
export type UpdateNotice = {
	kind: "rolled-back";
	version: string;
	text: string;
	at: number;
};

/** Observational snapshot from electron/main.cjs (desktop) or GET /api/updates
 * (self-hosted); never updater permission. `notice` exists only on the
 * self-hosted transport. Both offer a version ("available") and download it
 * on a click (docs/specs/t3-style-updates.md, revision PR 5). */
export type UpdateState = {
	status: "idle" | "checking" | "available" | "downloading" | "up-to-date" | "downloaded" | "error" | "disabled";
	version: string | null;
	revision: number;
	/** Self-hosted only: the server process; a restarted server counts revisions from 0 again. */
	instance?: string;
	/** Self-hosted only: the version the server runs. Newer than this page's APP_VERSION means the page should reload. */
	runningVersion?: string;
	/** Self-hosted only: the launcher kept the running version (false while it is an uncommitted trial). */
	committed?: boolean;
	message?: string | null;
	/** While "downloading": how far, 0 to 100, or null when the size is unknown (the sidebar's progress ring). */
	downloadPercent?: number | null;
	/** Self-hosted only: every byte is in and the server checks and unpacks it ("Preparing update"). */
	preparing?: boolean;
	notice?: UpdateNotice | null;
	/** T3's state (electron/update-machine.cjs): the offered version (both transports) and the
	 *  downloaded one (desktop only). */
	availableVersion?: string | null;
	downloadedVersion?: string | null;
	/** Desktop only: when the last check ran (ISO time). */
	checkedAt?: string | null;
	/** What the last error interrupted (the server's only "download"), and whether the button retries it. */
	errorContext?: "check" | "download" | "install" | null;
	canRetry?: boolean;
	/** Desktop only: the version the last install meant to reach, while this launch is still the old one. */
	notAppliedVersion?: string;
	/** Desktop only: the current "Could not install update" notice (an install the sidebar started
	 *  failed), and its fixed text; gone with the next state change. */
	installFailedNotice?: number;
	installFailedNoticeMessage?: string;
	/** Newest first: versions newer than the running one up to the offered one. */
	releaseNotes?: ReleaseNoteGroup[];
	omittedReleaseCount?: number;
};

/** T3's check result (main's lh:update:check): whether a check ran, and the state after it. */
export type UpdateCheckResult = { checked: boolean; state?: UpdateState };
/** T3's action result (main's lh:update:download): admitted, finished, and the state after it. */
export type UpdateActionResult = { accepted: boolean; completed: boolean; state?: UpdateState };

/** Which updater this window talks to: the Electron shell, or the self-hosted server. */
export type UpdateTransport = "desktop" | "web";

/** The desktop app's own updater as the narrow remote bridge reports it
 *  (window.lh.desktopUpdate, roadmap item 23): only in the desktop app's
 *  window onto a self-hosted server. `updating` while Update everything runs. */
export type DesktopAppStatus = {
	version: string;
	target: string | null;
	phase: UpdateState["status"] | "updating";
	error: string | null;
	/** While this app downloads its update: how far, 0 to 100, or null when unknown. Older apps omit it. */
	downloadPercent?: number | null;
	/** The offered version's notes, newest first, as in UpdateState (the sidebar's hover). Older apps omit them. */
	releaseNotes?: ReleaseNoteGroup[];
	omittedReleaseCount?: number;
	/** This app plans a server-only run when it has no update of its own. Older apps omit it, and
	 *  their Update everything answers "up to date" then, so the page must not offer it. */
	serverOnly?: boolean;
	/** Update everything's run for the page's capsule (revision PR 7), or null. Older apps omit it. */
	run?: UpdateEverythingRun | null;
	/** A result toast waits for this page (takeResult): its number, new for each result. Older apps omit it. */
	result?: number | null;
	/** The app's updater snapshot revision, which moves with every update event. A read or push with
	 *  a lower one than the page already has is older and is dropped; equal ones apply (a run's
	 *  steps and results change without it). Older apps omit it. */
	revision?: number;
};

export type DesktopUpdateBridge = {
	getStatus: () => Promise<DesktopAppStatus>;
	/** Main pushes the status whenever this app's updater changes (T3's onUpdateState,
	 *  apps/desktop/src/preload.ts:339-349 at df09ced7); returns the unsubscribe. Apps from
	 *  before it lack it and are only polled. */
	onStatus?: (callback: (status: unknown) => void) => () => void;
	check: () => Promise<void>;
	download: () => Promise<void>;
	/** Opens the app's own Update everything confirmation; never acts without it. */
	install: () => Promise<void>;
	/** Settings' This app Install: only this app, after T3's confirm in the app's own native
	 *  dialog. Apps from before it lack it. */
	installApp?: () => Promise<void>;
	/** Revision PR 7, all missing from older apps. everything() and retry() make the app show its
	 *  own Update everything dialog over this window (the page can't start a run itself) and
	 *  resolve { started } or { error }. ready() says the capsule shows what the app waits on;
	 *  later() and dismiss() act on the run; takeResult() reads its result toast once. */
	everything?: () => Promise<unknown>;
	ready?: () => Promise<void>;
	later?: () => Promise<void>;
	retry?: () => Promise<unknown>;
	dismiss?: () => Promise<void>;
	takeResult?: () => Promise<unknown>;
};

/** The local desktop window's full bridge (electron/preload.cjs), not the remote one. */
const localDesktopBridge = () => (typeof window.lh?.getUpdateState === "function" ? window.lh : undefined);

export { APP_VERSION, HOMEPAGE };
const UNAVAILABLE_UPDATES_DETAIL = "Automatic updates are not available in this build.";

const isUpdateState = (value: unknown): value is UpdateState =>
	typeof value === "object" && value !== null && typeof (value as UpdateState).status === "string" && typeof (value as UpdateState).revision === "number";

async function fetchWebState(path: string, method: "GET" | "POST"): Promise<UpdateState> {
	const response = await fetch(path, { method, cache: "no-store" });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const body: unknown = await response.json();
	if (!isUpdateState(body)) throw new Error("unexpected update state");
	return body;
}

/** Subscribe before requesting the snapshot. IPC replies and pushes can
 * cross; a revision prevents an older reply from hiding a newer event.
 * The banner shares this read-only observer so late loads recover too.
 *
 * Desktop: the Electron bridge (window.lh). Self-hosted / browser: the
 * server's GET /api/updates, refetched on the "update-changed" event and on
 * every reconnect of the events channel. A browser build that isn't
 * self-hosted answers "disabled": Settings shows the version only, and the
 * sidebar update control shows its dimmed "Updates unavailable" state. */
export function useUpdateState() {
	const [state, setState] = useState<UpdateState | null>(null);
	const [failed, setFailed] = useState(false);
	const [transport, setTransport] = useState<UpdateTransport | null>(null);
	const hub = useNotifyHub();
	const revisionRef = useRef(-1);
	const instanceRef = useRef<string | undefined>(undefined);
	const accept = useCallback((next: UpdateState) => {
		// A restarted server (new instance) starts its revisions over: its first state wins.
		if (next.instance !== instanceRef.current) {
			instanceRef.current = next.instance;
			revisionRef.current = -1;
		}
		if (next.revision < revisionRef.current) return;
		revisionRef.current = next.revision;
		setState(next);
		setFailed(false);
	}, []);

	useEffect(() => {
		let live = true;
		const guarded = (next: UpdateState) => { if (live) accept(next); };
		const lh = localDesktopBridge();
		if (lh) {
			setTransport("desktop");
			const off = lh.onUpdateStatus?.(guarded);
			void lh.getUpdateState?.().then(guarded).catch(() => {
				if (live && revisionRef.current === -1) setFailed(true);
			});
			return () => { live = false; off?.(); };
		}
		setTransport("web");
		const refetch = () => {
			void fetchWebState("/api/updates", "GET").then(guarded).catch(() => { /* offline or not served: keep the last state */ });
		};
		const offEvent = hub?.subscribe("update-changed", refetch);
		const offResync = hub?.onResync(refetch);
		refetch();
		return () => { live = false; offEvent?.(); offResync?.(); };
	}, [accept, hub]);

	/** Desktop: resolves T3's check result once the check ended (rejects when the bridge throws). */
	const check = useCallback(async (): Promise<UpdateCheckResult | undefined> => {
		const lh = localDesktopBridge();
		if (lh) return (await lh.checkForUpdates?.()) ?? undefined;
		accept(await fetchWebState("/api/updates/check", "POST"));
		return undefined;
	}, [accept]);

	/** Apply now. Callers confirm first (InstallUpdateDialog). Resolves false when the request
	 *  failed or the app turned it down (the sidebar control then shows its normal button again),
	 *  never rejects. */
	/** `fromSidebar`: the sidebar control's own Install, whose failure main reports as a notice. */
	const install = useCallback(async ({ onError, fromSidebar = false }: { onError?: () => void; fromSidebar?: boolean } = {}): Promise<boolean> => {
		try {
			const lh = localDesktopBridge();
			// The app can turn it down (an Update everything run owns the updater): only its yes counts.
			if (lh) return (await (fromSidebar ? lh.installUpdate?.("sidebar") : lh.installUpdate?.())) === true;
			accept(await fetchWebState("/api/updates/install", "POST"));
			return true;
		} catch {
			setFailed(true);
			onError?.();
			return false;
		}
	}, [accept]);

	/** Download the "available" version. Desktop: resolves T3's action result, or "threw" when
	 *  the bridge rejected. The server (POST /api/updates/download) answers with its state, which
	 *  says how it went: no result, so no toasts (its updater raises none), or "failed" when the
	 *  request itself failed (offline, signed out). Never rejects. */
	const download = useCallback(async (): Promise<UpdateActionResult | "threw" | "failed" | undefined> => {
		const lh = localDesktopBridge();
		if (!lh) {
			try {
				accept(await fetchWebState("/api/updates/download", "POST"));
				return undefined;
			} catch {
				return "failed";
			}
		}
		const pending = lh.downloadUpdate?.();
		if (!pending) return undefined;
		try {
			return (await pending) ?? undefined;
		} catch {
			setFailed(true);
			return "threw";
		}
	}, [accept]);

	/** Self-hosted only: hide the rollback notice on every browser of this server. */
	const dismissNotice = useCallback((): void => {
		void fetchWebState("/api/updates/notice/dismiss", "POST").then(accept).catch(() => { /* stays visible; retry on next click */ });
	}, [accept]);

	return { state, failed, transport, check, install, download, dismissNotice };
}

const isDesktopAppStatus = (value: unknown): value is DesktopAppStatus =>
	typeof value === "object" && value !== null && typeof (value as DesktopAppStatus).version === "string" && typeof (value as DesktopAppStatus).phase === "string";

// The bridge's caps (electron/release-notes.cjs bridgeNotes), applied again on the page.
const MAX_NOTE_VERSION_LENGTH = 64;
const MAX_RELEASED_AT_LENGTH = 40;
const MAX_OMITTED_RELEASE_COUNT = 1000;
const MAX_TOTAL_ITEMS = 10000;
const SUMMARY_LIMITS = { intro: 600, stats: 120, footer: 220 } as const;

function summaryFields(group: ReleaseNoteGroup): Pick<ReleaseNoteGroup, "intro" | "stats" | "footer"> {
	const fields: Pick<ReleaseNoteGroup, "intro" | "stats" | "footer"> = {};
	for (const key of ["intro", "stats", "footer"] as const) {
		// Trimmed and collapsed first, so padding doesn't count against the bound.
		const value = typeof group[key] === "string" ? group[key].trim().replace(/\s+/g, " ") : "";
		if (value && value.length <= SUMMARY_LIMITS[key]) fields[key] = value;
	}
	return fields;
}

const isReleaseNoteGroup = (value: unknown): value is ReleaseNoteGroup =>
	typeof value === "object" && value !== null && typeof (value as ReleaseNoteGroup).version === "string"
	&& (value as ReleaseNoteGroup).version.length <= MAX_NOTE_VERSION_LENGTH
	&& Array.isArray((value as ReleaseNoteGroup).items) && (value as ReleaseNoteGroup).items.every((item) => typeof item === "string");

/** Tolerant read of the bridge's status: an app from before the notes field (or a malformed
 *  group) reads as no notes, never as a broken status. Groups keep only what the page renders,
 *  within the UI's limits (the app bounds them too, electron/release-notes.cjs bridgeNotes). */
export function readDesktopAppStatus(value: unknown): DesktopAppStatus | null {
	if (!isDesktopAppStatus(value)) return null;
	const groups = (Array.isArray(value.releaseNotes) ? value.releaseNotes.filter(isReleaseNoteGroup) : []).map((group) => ({
		version: group.version,
		...(typeof group.releasedAt === "string" && group.releasedAt.length <= MAX_RELEASED_AT_LENGTH ? { releasedAt: group.releasedAt } : {}),
		items: group.items,
		...(Number.isInteger(group.totalItems) && (group.totalItems as number) >= 0 ? { totalItems: Math.min(group.totalItems as number, MAX_TOTAL_ITEMS) } : {}),
		...(typeof group.summaryCopy === "boolean" ? { summaryCopy: group.summaryCopy } : {}),
		...summaryFields(group),
	}));
	const { releaseNotes } = capReleaseNoteGroups(groups);
	const omitted = value.omittedReleaseCount;
	const status: DesktopAppStatus = {
		...value, releaseNotes, omittedReleaseCount: typeof omitted === "number" && Number.isInteger(omitted) && omitted > 0 ? Math.min(omitted, MAX_OMITTED_RELEASE_COUNT) : 0,
		run: readUpdateEverythingRun(value.run),
		result: typeof value.result === "number" && Number.isInteger(value.result) && value.result > 0 ? value.result : null,
	};
	// Only a plain true counts; anything else reads as an app that doesn't plan the flow.
	if (value.serverOnly !== true) delete status.serverOnly;
	if (!(typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision >= 0)) delete status.revision;
	return status;
}

/** How often the page asks the app for its update status: the fallback for an app without
 *  onStatus, and the way the page follows an Update everything run's own steps, which main
 *  doesn't push. */
export const DESKTOP_STATUS_POLL_MS = 5_000;
/** While Update everything runs: often enough for its capsule's steps and countdown. */
export const DESKTOP_RUN_POLL_MS = 1_000;

/** The desktop app's own update, seen from its window onto a self-hosted
 *  server. Null everywhere else (browsers, the local desktop window). */
export function useDesktopAppUpdate() {
	const [bridge] = useState<DesktopUpdateBridge | undefined>(() => (typeof window === "undefined" ? undefined : window.lh?.desktopUpdate));
	const [status, setStatus] = useState<DesktopAppStatus | null>(null);
	// The newest updater revision shown. An answer to a read can land after a push that came later
	// (T3 drops its initial read once a push has arrived, apps/web/src/state/desktopUpdate.ts:46-77
	// at df09ced7): the older one never replaces the newer.
	const revisionRef = useRef(-1);
	const apply = useCallback((next: DesktopAppStatus) => {
		if (next.revision !== undefined) {
			if (next.revision < revisionRef.current) return;
			revisionRef.current = next.revision;
		}
		setStatus(next);
	}, []);
	const refresh = useCallback(async () => {
		if (!bridge) return;
		try {
			const next = readDesktopAppStatus(await bridge.getStatus());
			if (next) apply(next);
		} catch { /* keep the last status */ }
	}, [bridge, apply]);
	// T3's order: subscribe to main's pushes before the first read, so a change between the two is
	// never missed. A push moves the control at once, never after the next poll. Its own effect, so
	// the poll's rate changing never drops and re-adds it.
	useEffect(() => {
		if (!bridge || typeof bridge.onStatus !== "function") return;
		return bridge.onStatus((pushed) => {
			const next = readDesktopAppStatus(pushed);
			if (next) apply(next);
		});
	}, [bridge, apply]);
	// Fast only while a run moves: a failure kept for Retry waits like the rest.
	const running = runIsLive(status?.run ?? null);
	useEffect(() => {
		if (!bridge) return;
		void refresh();
		const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, running ? DESKTOP_RUN_POLL_MS : DESKTOP_STATUS_POLL_MS);
		const onVisible = () => { if (document.visibilityState !== "hidden") void refresh(); };
		document.addEventListener("visibilitychange", onVisible);
		return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
	}, [bridge, refresh, running]);
	const call = useCallback((method: "check" | "download" | "install" | "installApp") => async (): Promise<void> => {
		const action = bridge?.[method];
		if (!action) return;
		try { await action(); } finally { void refresh(); }
	}, [bridge, refresh]);
	// Update everything in the page (revision PR 7), when the app has it.
	const everything = useMemo(() => {
		if (!bridge || typeof bridge.everything !== "function") return null;
		/** The app's own dialog: how it closed, or what to tell when it didn't open. */
		const ask = (method: "everything" | "retry") => async (): Promise<BridgeAnswer> => {
			try { return readBridgeAnswer(await bridge[method]?.()); } catch {
				return { error: BRIDGE_FAILED, started: false, keyboard: false, dialog: false };
			} finally { void refresh(); }
		};
		const act = (method: "later" | "dismiss") => () => { void bridge[method]?.().catch(() => {}).finally(() => void refresh()); };
		return {
			open: ask("everything"),
			retry: ask("retry"),
			later: act("later"), dismiss: act("dismiss"),
			// The effect that calls it is keyed on awaitingPage alone, so this refresh doesn't loop.
			ready: () => { void bridge.ready?.().catch(() => {}).finally(() => void refresh()); },
			takeResult: async (): Promise<UpdateEverythingResult | null> => {
				try { return readUpdateEverythingResult(await bridge.takeResult?.()); } catch { return null; }
			},
		};
	}, [bridge, refresh]);
	return useMemo(() => bridge ? {
		status, check: call("check"), download: call("download"), install: call("install"),
		// An app from before installApp has only Update everything's install.
		installApp: typeof bridge.installApp === "function" ? call("installApp") : call("install"),
		everything,
	} : null, [bridge, status, call, everything]);
}

/** A newer app version the desktop offers, or null. */
export function desktopOffer(status: DesktopAppStatus | null): string | null {
	return status?.target && isNewerVersion(status.target, status.version) ? status.target : null;
}

/** The offer this app is acting on: `target` outlives a failed check, so only a phase that
 *  has the update (offered, downloading, downloaded, or an Update everything run) counts. */
export function activeDesktopOffer(status: DesktopAppStatus | null): string | null {
	const phase = status?.phase;
	return phase === "available" || phase === "downloading" || phase === "downloaded" || phase === "updating" ? desktopOffer(status) : null;
}

export const DESKTOP_APP_DESCRIPTION = "Current version of the application.";
export const UPDATE_AVAILABLE_DESCRIPTION = "Update available.";
export const CHECK_FOR_UPDATES_LABEL = "Check for Updates";
/** A self-hosted server's request that failed (main's fixed texts, electron/main.cjs). */
export const REQUEST_CHECK_FAILED = "Couldn’t check for updates. Try again later.";
export const REQUEST_DOWNLOAD_FAILED = "Couldn’t download the update. Try again.";
export const REQUEST_INSTALL_FAILED = "Couldn’t install the update.";
const ACTION_LABELS = { download: "Download", install: "Install" } as const;
const STATUS_LABELS: Partial<Record<string, string>> = { checking: "Checking…", downloading: "Downloading…", "up-to-date": "Up to Date" };

/** T3's resolveDesktopUpdateButtonAction (desktopUpdate.logic.ts:49-69 at df09ced7), as the
 *  sidebar control reads it: the server's "downloaded" carries no downloadedVersion. */
export function updateButtonAction(state: UpdateState | null): "download" | "install" | "none" {
	if (!state) return "none";
	if (state.status === "downloaded") return "install";
	if (state.status === "error" && state.downloadedVersion && (state.errorContext == null || state.errorContext === "install")) return "install";
	if (state.status === "available") return "download";
	if (state.status === "error" && state.errorContext === "download" && state.availableVersion) return "download";
	return "none";
}

/** T3's getDesktopUpdateDisabledReason (desktopUpdate.logic.ts:217-228): why updates are off, or null. */
function disabledReason(status: string | undefined, message: string | null | undefined): string | null {
	if (status !== "disabled") return null;
	return message?.trim() || UNAVAILABLE_UPDATES_DETAIL;
}

export type AboutButton = { action: "download" | "install" | "none"; label: string; disabled: boolean; description: string; tooltip: string | null };

/** T3's AboutVersionSection button (SettingsPanels.tsx:300-328 at df09ced7): the label, whether
 *  it can be pressed, the row's description and the tooltip. */
export function aboutButton(state: UpdateState | null): AboutButton {
	const action = updateButtonAction(state);
	const label = action !== "none" ? ACTION_LABELS[action] : STATUS_LABELS[state?.status ?? ""] ?? CHECK_FOR_UPDATES_LABEL;
	// T3's canCheckForUpdate and isDesktopUpdateButtonDisabled.
	const disabled = action === "none"
		? !state || state.status === "checking" || state.status === "downloading" || state.status === "disabled"
		: state?.status === "downloading";
	const description = action !== "none" ? UPDATE_AVAILABLE_DESCRIPTION : disabledReason(state?.status, state?.message) ?? DESKTOP_APP_DESCRIPTION;
	return { action, label, disabled, description, tooltip: state ? updateButtonTooltip(state) : null };
}

/** The same button for this app, from the remote bridge's status. The bridge's status has no
 *  retry fields, so its tooltip is the plain line; none during Update everything. */
export function desktopAppButton(status: DesktopAppStatus | null): AboutButton {
	const offered = desktopOffer(status);
	if (!status || status.phase === "updating") {
		return { action: "none", label: CHECK_FOR_UPDATES_LABEL, disabled: true, description: DESKTOP_APP_DESCRIPTION, tooltip: null };
	}
	const phase = status.phase;
	// Only an offer newer than this app counts (a stale target is not one).
	const shown: UpdateState = {
		status: !offered && (phase === "available" || phase === "downloaded") ? "idle" : phase,
		version: offered, revision: 0, availableVersion: offered, downloadedVersion: phase === "downloaded" ? offered : null,
		message: status.error, downloadPercent: status.downloadPercent ?? null,
	};
	return aboutButton(shown);
}

/** T3's About button: one outline button whose label changes, with the update tooltip. The
 *  same element through every state, so keyboard focus stays on it. While it can't be
 *  pressed it is aria-disabled, not disabled, as the sidebar control is: it stays focusable,
 *  so the keyboard still reaches its tooltip (the download's percent), and a press does nothing. */
function AboutUpdateButton({ button, pending, testid, onClick }: { button: AboutButton; pending: boolean; testid: string; onClick: () => void }) {
	const inert = button.disabled || pending;
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button type="button" size="xs" variant="outline" className="cursor-pointer aria-disabled:cursor-not-allowed aria-disabled:opacity-50" data-testid={testid} data-action={button.action} aria-disabled={inert || undefined} onClick={() => { if (!inert) onClick(); }}>
						{button.label}
					</Button>
				</TooltipTrigger>
				{button.tooltip && <TooltipContent side="top" data-testid={`${testid}-tooltip`}>{button.tooltip}</TooltipContent>}
			</Tooltip>
		</TooltipProvider>
	);
}

/** The extra row in the desktop app's window onto a self-hosted server: this app's own version.
 *  Install updates only this app; the app asks first with T3's confirm (installApp). */
function DesktopAppRow({ desktop }: { desktop: NonNullable<ReturnType<typeof useDesktopAppUpdate>> }) {
	const { status } = desktop;
	const button = desktopAppButton(status);
	const [pending, setPending] = useState(false);
	const onClick = () => {
		if (button.action === "install") {
			setPending(true);
			void desktop.installApp().catch(() => { /* the status reports the failure */ }).finally(() => setPending(false));
			return;
		}
		const run = button.action === "download" ? desktop.download : desktop.check;
		void run().catch(() => { /* the status reports the failure */ });
	};
	return (
		<SettingsRow label={`This app ${status?.version ?? ""}`.trim()} testid="row-desktop-app" hint={<span className="block" data-testid="desktop-app-status">{button.description}</span>}>
			<AboutUpdateButton button={button} pending={pending} testid="desktop-app-update" onClick={onClick} />
		</SettingsRow>
	);
}

/** Settings > General: the version row (and, in the desktop app's window onto a server, this
 *  app's row), each T3's About row (docs/specs/t3-style-updates.md, revision PR 5). Opening it
 *  never checks. In the desktop app's local window its actions raise T3's Settings toasts
 *  (SettingsPanels.tsx:216-298): a failed download, install or check, never a success. */
export function UpdateSettings({
	version = APP_VERSION,
	homepage = HOMEPAGE,
}: {
	version?: string;
	homepage?: string;
} = {}) {
	const { state, transport, check, install, download } = useUpdateState();
	const desktop = useDesktopAppUpdate();
	const [confirming, setConfirming] = useState(false);
	const [installing, setInstalling] = useState(false);
	// A self-hosted server's Check, Download or Install whose request failed (unreachable, signed
	// out): said in the row until the state changes or the next press (its updater raises no toasts).
	const [requestFailed, setRequestFailed] = useState<"check" | "download" | "install" | null>(null);
	const button = aboutButton(state);
	const releaseNotes = version && homepage ? `${homepage}/releases/tag/v${version}` : null;
	const local = transport === "desktop";
	// The confirm belongs to an Install: a state that offers something else closes it for good.
	useEffect(() => { if (button.action !== "install") setConfirming(false); }, [button.action]);
	useEffect(() => setRequestFailed(null), [state]);
	const description = requestFailed === "check" ? REQUEST_CHECK_FAILED : requestFailed === "download" ? REQUEST_DOWNLOAD_FAILED : requestFailed === "install" ? REQUEST_INSTALL_FAILED : button.description;

	const onClick = () => {
		setRequestFailed(null);
		if (button.action === "download") {
			// T3's downloadLocalUpdate(bridge, { notifyDownloaded: false }): its error toasts only.
			void download().then((result) => {
				if (result === "failed") setRequestFailed("download");
				if (!local || result === "failed") return;
				if (result === "threw") showUpdateErrorToast(DOWNLOAD_START_FAILED_TITLE, UNEXPECTED_ERROR);
				else if (result?.accepted && !result.completed && result.state?.message?.trim()) showUpdateErrorToast(DOWNLOAD_FAILED_TITLE, result.state.message.trim());
			});
			return;
		}
		if (button.action === "install") {
			if (confirming || installing) return;
			setConfirming(true);
			return;
		}
		void check()
			.then((result) => {
				if (local && result && !result.checked) showUpdateErrorToast(CHECK_FAILED_TITLE, result.state?.message ?? CHECK_UNAVAILABLE);
			})
			.catch(() => {
				if (local) showUpdateErrorToast(CHECK_FAILED_TITLE, CHECK_ERROR);
				else setRequestFailed("check");
			});
	};

	return (
		<>
			<SettingsRow
				// With this app's own row beside it, T3's labels: "Server" and "This app" (UpdateEverythingDialog.tsx:91-92 at 8cf97b5).
				label={`${desktop ? "Server" : "Version"} ${version || "unknown"}`}
				testid="row-version"
				hint={
					<>
						<span className="block" data-testid="update-description">{description}</span>
						{releaseNotes && <a href={releaseNotes} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" data-testid="release-notes">Release notes</a>}
					</>
				}
			>
				<AboutUpdateButton button={button} pending={confirming || installing} testid="update-button" onClick={onClick} />
			</SettingsRow>
			{desktop && <DesktopAppRow desktop={desktop} />}
			<InstallUpdateDialog
				open={confirming && button.action === "install"}
				version={state?.downloadedVersion ?? state?.version ?? null}
				onClose={() => setConfirming(false)}
				onConfirm={() => {
					setConfirming(false);
					setInstalling(true);
					// T3: a bridge that threw says "Could not install update"; Settings' install raises no notice.
					void install({ onError: () => {
						if (local) showUpdateErrorToast(INSTALL_FAILED_TITLE, UNEXPECTED_ERROR);
						else setRequestFailed("install");
					} }).finally(() => setInstalling(false));
				}}
			/>
		</>
	);
}

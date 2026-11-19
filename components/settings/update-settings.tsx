"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useNotifyHub } from "@/components/server-events";
import { InstallUpdateDialog } from "@/components/install-update-dialog";
import type { ReleaseNoteGroup } from "@/src/core";
import { SettingsRow, Toggle } from "./controls.tsx";
import { isNewerVersion } from "@/selfhost/src/version-order.ts";

/** A rolled-back self-hosted switch (GET /api/updates `notice`), shown until dismissed. */
export type UpdateNotice = {
	kind: "rolled-back";
	version: string;
	text: string;
	at: number;
};

/** Observational snapshot from electron/main.cjs (desktop) or GET /api/updates
 * (self-hosted); never updater permission. `message` and `notice` exist only
 * on the self-hosted transport; "available" (found, not downloaded) only on
 * the desktop, which downloads on click (docs/specs/t3-style-updates.md). */
export type UpdateState = {
	status: "idle" | "checking" | "available" | "downloading" | "up-to-date" | "downloaded" | "error" | "disabled";
	version: string | null;
	revision: number;
	/** Self-hosted only: the server process; a restarted server counts revisions from 0 again. */
	instance?: string;
	/** Self-hosted only: the version the server runs. Newer than this page's APP_VERSION means the page should reload. */
	runningVersion?: string;
	message?: string | null;
	/** While "downloading": how far, 0 to 100, or null when the size is unknown (the sidebar's progress ring). */
	downloadPercent?: number | null;
	/** Self-hosted only: every byte is in and the server checks and unpacks it ("Preparing update"). */
	preparing?: boolean;
	notice?: UpdateNotice | null;
	/** Newest first: versions newer than the running one up to the offered one. */
	releaseNotes?: ReleaseNoteGroup[];
	omittedReleaseCount?: number;
};

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
};

export type DesktopUpdateBridge = {
	getStatus: () => Promise<DesktopAppStatus>;
	check: () => Promise<void>;
	download: () => Promise<void>;
	/** Opens the app's own Update everything confirmation; never acts without it. */
	install: () => Promise<void>;
};

/** The local desktop window's full bridge (electron/preload.cjs), not the remote one. */
const localDesktopBridge = () => (typeof window.lh?.getUpdateState === "function" ? window.lh : undefined);

export const APP_VERSION = process.env.LH_VERSION ?? "";
export const HOMEPAGE = process.env.LH_HOMEPAGE ?? "";
export const MANUAL_UPDATE_HINT = "Check for updates looks for a newer version. Download and Install happen when you click them.";
export const AUTO_UPDATE_HINT = "Check 15 seconds after launch and every 4 hours. Nothing downloads or installs until you click.";
export const WEB_MANUAL_UPDATE_HINT = "Check for updates downloads a newer version. It installs when you click Install.";
export const WEB_AUTO_UPDATE_HINT = "Check at startup and every 4 hours, and download new versions in the background. Nothing installs until you click Install.";
export const AUTO_UPDATE_LABEL = "Check for updates automatically";
const UPDATE_ERROR = "Couldn’t check for updates. Try again later.";
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

	const check = useCallback(async (): Promise<void> => {
		const lh = localDesktopBridge();
		if (lh) return lh.checkForUpdates?.();
		accept(await fetchWebState("/api/updates/check", "POST"));
	}, [accept]);

	/** Apply now. Callers confirm first (InstallUpdateDialog). */
	const install = useCallback((): void => {
		const lh = localDesktopBridge();
		if (lh) { lh.installUpdate?.(); return; }
		void fetchWebState("/api/updates/install", "POST").then(accept).catch(() => setFailed(true));
	}, [accept]);

	/** Desktop only: download the "available" version. */
	const download = useCallback((): void => {
		const pending = localDesktopBridge()?.downloadUpdate?.();
		if (pending) void pending.catch(() => setFailed(true));
	}, []);

	/** Self-hosted only: hide the rollback notice on every browser of this server. */
	const dismissNotice = useCallback((): void => {
		void fetchWebState("/api/updates/notice/dismiss", "POST").then(accept).catch(() => { /* stays visible; retry on next click */ });
	}, [accept]);

	return { state, failed, transport, check, install, download, dismissNotice };
}

const isDesktopAppStatus = (value: unknown): value is DesktopAppStatus =>
	typeof value === "object" && value !== null && typeof (value as DesktopAppStatus).version === "string" && typeof (value as DesktopAppStatus).phase === "string";

/** How often the page asks the app for its update status (the bridge has no push channel). */
export const DESKTOP_STATUS_POLL_MS = 5_000;

/** The desktop app's own update, seen from its window onto a self-hosted
 *  server. Null everywhere else (browsers, the local desktop window). */
export function useDesktopAppUpdate() {
	const [bridge] = useState<DesktopUpdateBridge | undefined>(() => (typeof window === "undefined" ? undefined : window.lh?.desktopUpdate));
	const [status, setStatus] = useState<DesktopAppStatus | null>(null);
	const refresh = useCallback(async () => {
		if (!bridge) return;
		try {
			const next = await bridge.getStatus();
			if (isDesktopAppStatus(next)) setStatus(next);
		} catch { /* keep the last status */ }
	}, [bridge]);
	useEffect(() => {
		if (!bridge) return;
		void refresh();
		const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, DESKTOP_STATUS_POLL_MS);
		const onVisible = () => { if (document.visibilityState !== "hidden") void refresh(); };
		document.addEventListener("visibilitychange", onVisible);
		return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
	}, [bridge, refresh]);
	const call = useCallback((method: "check" | "download" | "install") => async (): Promise<void> => {
		if (!bridge) return;
		try { await bridge[method](); } finally { void refresh(); }
	}, [bridge, refresh]);
	return useMemo(() => bridge ? { status, check: call("check"), download: call("download"), install: call("install") } : null, [bridge, status, call]);
}

/** A newer app version the desktop offers, or null. */
export function desktopOffer(status: DesktopAppStatus | null): string | null {
	return status?.target && isNewerVersion(status.target, status.version) ? status.target : null;
}

export const DESKTOP_APP_DESCRIPTION = "Current version of the application.";

/** T3's AboutVersionSection button for this app (SettingsPanels.tsx:308-328 at 8cf97b5). */
export function desktopAppButton(status: DesktopAppStatus | null): { action: "download" | "install" | "check"; label: string; disabled: boolean; description: string } {
	const offered = desktopOffer(status);
	const action = offered && status?.phase === "downloaded" ? "install" : offered && status?.phase === "available" ? "download" : "check";
	const labels: Record<string, string> = { checking: "Checking…", downloading: "Downloading…", "up-to-date": "Up to Date" };
	const label = action === "install" ? "Install" : action === "download" ? "Download" : labels[status?.phase ?? ""] ?? "Check for Updates";
	const disabled = !status || status.phase === "updating" || (action === "check" && (status.phase === "checking" || status.phase === "downloading" || status.phase === "disabled"));
	const description = action !== "check" ? "Update available."
		: status?.phase === "disabled" ? (status.error?.trim() || UNAVAILABLE_UPDATES_DETAIL)
		: status?.phase === "error" && status.error ? status.error
		: DESKTOP_APP_DESCRIPTION;
	return { action, label, disabled, description };
}

/** The extra row in the desktop app's window onto a self-hosted server: this app's own version. */
function DesktopAppRow({ desktop }: { desktop: NonNullable<ReturnType<typeof useDesktopAppUpdate>> }) {
	const { status } = desktop;
	const button = desktopAppButton(status);
	const onClick = () => {
		const run = button.action === "install" ? desktop.install : button.action === "download" ? desktop.download : desktop.check;
		void run().catch(() => { /* the status reports the failure */ });
	};
	return (
		<SettingsRow label={`This app ${status?.version ?? ""}`.trim()} testid="row-desktop-app" hint={<span className="block" role="status" data-testid="desktop-app-status">{button.description}</span>}>
			<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" data-testid="desktop-app-update" data-action={button.action} disabled={button.disabled} onClick={onClick}>
				{button.label}
			</Button>
		</SettingsRow>
	);
}

export function updateStatusText(state: UpdateState | null, transport: UpdateTransport | null = "desktop"): string | null {
	if (state?.message) return state.message;
	// A rollback stays explained here until dismissed, even after a later check clears the message.
	if (state?.notice && state.status !== "downloaded" && state.status !== "available" && state.status !== "downloading") return state.notice.text;
	switch (state?.status) {
		case "checking": return "Checking for updates…";
		case "available": return state.version ? `Version ${state.version} is available.` : "An update is available.";
		case "downloading":
			if (state.preparing) return state.version ? `Preparing version ${state.version}…` : "Preparing the update…";
			return state.version ? `Downloading version ${state.version}…` : "Downloading an update…";
		case "up-to-date": return "No newer version was found at the last check.";
		case "downloaded": return state.version ? `Version ${state.version} is ready to install.` : "An update is ready to install.";
		case "error": return UPDATE_ERROR;
		default: return null;
	}
}

/** Version information is useful everywhere; update controls only belong
 * to a shell with an available updater. Opening this row never checks. */
export function UpdateSettings({
	autoUpdate,
	onAutoUpdateChange,
	version = APP_VERSION,
	homepage = HOMEPAGE,
}: {
	autoUpdate: boolean;
	onAutoUpdateChange: (on: boolean) => void;
	version?: string;
	homepage?: string;
}) {
	const { state, failed, transport, check: checkNow, install, download } = useUpdateState();
	const desktop = useDesktopAppUpdate();
	const [checkFailed, setCheckFailed] = useState(false);
	const [confirming, setConfirming] = useState(false);
	useEffect(() => setCheckFailed(false), [state]);
	const active = state !== null && state.status !== "disabled";
	const busy = state?.status === "checking" || state?.status === "downloading";
	const status = state?.status === "downloaded" || state?.status === "available" || state?.message || state?.notice ? updateStatusText(state, transport)
		: failed || checkFailed ? UPDATE_ERROR : updateStatusText(state, transport);
	const releaseNotes = version && homepage ? `${homepage}/releases/tag/v${version}` : null;
	const web = transport === "web";
	const check = () => {
		setCheckFailed(false);
		void checkNow().catch(() => setCheckFailed(true));
	};

	return (
		<>
			<SettingsRow
				// With this app's own row beside it, T3's labels: "Server" and "This app" (UpdateEverythingDialog.tsx:91-92 at 8cf97b5).
				label={`${desktop ? "Server" : "Version"} ${version || "unknown"}`}
				testid="row-version"
				hint={
					<>
						{status && <span className="block" role="status" data-testid="update-status">{status}</span>}
						{active && <span className="block">{web ? WEB_MANUAL_UPDATE_HINT : MANUAL_UPDATE_HINT}</span>}
						{releaseNotes && <a href={releaseNotes} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" data-testid="release-notes">Release notes</a>}
					</>
				}
			>
				{active && (state.status === "downloaded" ? (
					<Button type="button" size="xs" className="cursor-pointer" data-testid="update-install" onClick={() => setConfirming(true)}>Install</Button>
				) : state.status === "available" ? (
					<Button type="button" size="xs" className="cursor-pointer" data-testid="update-download" onClick={download}>Download</Button>
				) : (
					<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" data-testid="update-check" disabled={busy} aria-busy={busy} onClick={check}>
						{busy && <BrailleSpinner label={state.status === "downloading" ? "Downloading update" : "Checking for updates"} />}
						Check for updates
					</Button>
				))}
			</SettingsRow>
			{desktop && <DesktopAppRow desktop={desktop} />}
			{active && (
				<SettingsRow label={AUTO_UPDATE_LABEL} hint={web ? WEB_AUTO_UPDATE_HINT : AUTO_UPDATE_HINT} testid="row-auto-update">
					<Toggle checked={autoUpdate} label="auto update" onChange={onAutoUpdateChange} />
				</SettingsRow>
			)}
			<InstallUpdateDialog
				open={confirming && state?.status === "downloaded"}
				version={state?.version ?? null}
				onClose={() => setConfirming(false)}
				onConfirm={() => { setConfirming(false); install(); }}
			/>
		</>
	);
}

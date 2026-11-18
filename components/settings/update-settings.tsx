"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useNotifyHub } from "@/components/server-events";
import { InstallUpdateDialog } from "@/components/install-update-dialog";
import type { ReleaseNoteGroup } from "@/src/core";
import { SettingsRow, Toggle } from "./controls.tsx";

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
	message?: string | null;
	notice?: UpdateNotice | null;
	/** Newest first: versions newer than the running one up to the offered one. */
	releaseNotes?: ReleaseNoteGroup[];
	omittedReleaseCount?: number;
};

/** Which updater this window talks to: the Electron shell, or the self-hosted server. */
export type UpdateTransport = "desktop" | "web";

export const APP_VERSION = process.env.LH_VERSION ?? "";
export const HOMEPAGE = process.env.LH_HOMEPAGE ?? "";
export const MANUAL_UPDATE_HINT = "Check for updates looks for a newer version. Download and Install happen when you click them.";
export const AUTO_UPDATE_HINT = "Check 15 seconds after launch and every 4 hours. Nothing downloads or installs until you click.";
export const WEB_MANUAL_UPDATE_HINT = "Check for updates downloads a newer version. It installs when you click Install.";
export const WEB_AUTO_UPDATE_HINT = "Check at startup and every 4 hours, and download new versions in the background. Nothing installs until you click Install.";
export const AUTO_UPDATE_LABEL = "Check for updates automatically";
const UPDATE_ERROR = "Couldn’t check for updates. Try again later.";

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
 * self-hosted answers "disabled", which hides every update control. */
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
		const lh = window.lh;
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
		if (window.lh) return window.lh.checkForUpdates?.();
		accept(await fetchWebState("/api/updates/check", "POST"));
	}, [accept]);

	/** Apply now. Callers confirm first (InstallUpdateDialog). */
	const install = useCallback((): void => {
		if (window.lh) { window.lh.installUpdate?.(); return; }
		void fetchWebState("/api/updates/install", "POST").then(accept).catch(() => setFailed(true));
	}, [accept]);

	/** Desktop only: download the "available" version. */
	const download = useCallback((): void => {
		const pending = window.lh?.downloadUpdate?.();
		if (pending) void pending.catch(() => setFailed(true));
	}, []);

	/** Self-hosted only: hide the rollback notice on every browser of this server. */
	const dismissNotice = useCallback((): void => {
		void fetchWebState("/api/updates/notice/dismiss", "POST").then(accept).catch(() => { /* stays visible; retry on next click */ });
	}, [accept]);

	return { state, failed, transport, check, install, download, dismissNotice };
}

export function updateStatusText(state: UpdateState | null, transport: UpdateTransport | null = "desktop"): string | null {
	if (state?.message) return state.message;
	// A rollback stays explained here until dismissed, even after a later check clears the message.
	if (state?.notice && state.status !== "downloaded" && state.status !== "available" && state.status !== "downloading") return state.notice.text;
	switch (state?.status) {
		case "checking": return "Checking for updates…";
		case "available": return state.version ? `Version ${state.version} is available.` : "An update is available.";
		case "downloading": return state.version ? `Downloading version ${state.version}…` : "Downloading an update…";
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
				label={`Version ${version || "unknown"}`}
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

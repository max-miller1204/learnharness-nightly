"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useNotifyHub } from "@/components/server-events";
import { SettingsRow, Toggle } from "./controls.tsx";

/** The outcome of the last self-hosted switch (GET /api/updates `notice`). */
export type UpdateNotice = {
	kind: "updated" | "rolled-back";
	version: string;
	text: string;
	at: number;
};

/** Observational snapshot from electron/main.cjs (desktop) or GET /api/updates
 * (self-hosted); never updater permission. `message` and `notice` exist only
 * on the self-hosted transport. */
export type UpdateState = {
	status: "idle" | "checking" | "downloading" | "up-to-date" | "downloaded" | "error" | "disabled";
	version: string | null;
	revision: number;
	message?: string | null;
	notice?: UpdateNotice | null;
};

/** Which updater this window talks to: the Electron shell, or the self-hosted server. */
export type UpdateTransport = "desktop" | "web";

export const APP_VERSION = process.env.LH_VERSION ?? "";
const HOMEPAGE = process.env.LH_HOMEPAGE ?? "";
export const MANUAL_UPDATE_HINT = "Checking downloads available updates. Downloaded updates install when you quit the app.";
export const AUTO_UPDATE_HINT = "Check at startup and every 24 hours. Turning this off does not stop updates already in progress or ready to install.";
export const WEB_MANUAL_UPDATE_HINT = "Checking downloads available updates. Downloaded updates install automatically when no agent is working, or right away with Restart.";
export const WEB_AUTO_UPDATE_HINT = "Check at startup and every 15 minutes. Turning this off does not stop an update that is already downloaded.";
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
	const accept = useCallback((next: UpdateState) => {
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

	const install = useCallback((): void => {
		if (window.lh) { window.lh.installUpdate?.(); return; }
		void fetchWebState("/api/updates/install", "POST").then(accept).catch(() => setFailed(true));
	}, [accept]);

	return { state, failed, transport, check, install };
}

export function updateStatusText(state: UpdateState | null, transport: UpdateTransport | null = "desktop"): string | null {
	if (state?.message) return state.message;
	switch (state?.status) {
		case "checking": return "Checking for updates…";
		case "downloading": return state.version ? `Downloading version ${state.version}…` : "Downloading an update…";
		case "up-to-date": return "No newer version was found at the last check.";
		case "downloaded": {
			const what = state.version ? `Version ${state.version}` : "An update";
			return transport === "web"
				? `${what} is ready. It installs automatically when no agent is working.`
				: `${what} is ready. It will install when you quit the app.`;
		}
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
	const { state, failed, transport, check: checkNow, install } = useUpdateState();
	const [checkFailed, setCheckFailed] = useState(false);
	useEffect(() => setCheckFailed(false), [state]);
	const active = state !== null && state.status !== "disabled";
	const busy = state?.status === "checking" || state?.status === "downloading";
	const status = state?.status === "downloaded" || state?.message ? updateStatusText(state, transport)
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
					<Button type="button" size="xs" className="cursor-pointer" data-testid="update-restart" onClick={install}>Restart</Button>
				) : (
					<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" data-testid="update-check" disabled={busy} aria-busy={busy} onClick={check}>
						{busy && <BrailleSpinner label={state.status === "downloading" ? "Downloading update" : "Checking for updates"} />}
						Check for updates
					</Button>
				))}
			</SettingsRow>
			{active && (
				<SettingsRow label="Automatic updates" hint={web ? WEB_AUTO_UPDATE_HINT : AUTO_UPDATE_HINT} testid="row-auto-update">
					<Toggle checked={autoUpdate} label="auto update" onChange={onAutoUpdateChange} />
				</SettingsRow>
			)}
		</>
	);
}

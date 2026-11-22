"use client";

/**
 * The sidebar update control (docs/specs/t3-style-updates.md, section 5, and
 * docs/specs/update-control.md): one round icon button at the right end of
 * the sidebar's Settings row, on the web and desktop apps. Hovering shows
 * the tooltip (or the release notes, when there are any); clicking acts:
 *
 *   check          refresh icon, checks (never downloads by itself)
 *   checking       spinning refresh icon, disabled
 *   unavailable    dimmed refresh icon, disabled ("Updates unavailable")
 *   download       desktop "available": download it
 *   downloading    download arrow in a ring that fills with the download, disabled
 *   install        "downloaded": the install confirm dialog
 *   restarting     the install was confirmed and the restart hasn't happened yet:
 *                  grey, disabled, the restart arrow spins (owner decision 2026-11-19)
 *   dismiss-notice rolled-back notice: dismiss it (per server)
 *   reload         the server runs a different version than this page: reload
 *                  (newer: the page also reloads by itself, once per version)
 *
 * In the desktop app's window onto a self-hosted server (window.lh.desktopUpdate):
 *
 *   everything     circle-arrow-up: this app has a newer version and the server
 *                  is behind it. Opens the app's own Update everything confirmation
 *   app-download   this app's update is available, the server already runs it
 *   app-install    this app's update is downloaded, the server already runs it
 *                  (also through the app's confirmation: just an app restart)
 *   restarting     also while this app's run is going and the server already runs
 *                  its version: what is left is this app's restart
 *
 * Adapted from T3 Code's SidebarUpdateControl and DesktopUpdateStatusIcon
 * (apps/web/src/components/sidebar/SidebarUpdatePill.tsx and
 * DesktopUpdateStatusIcon.tsx at 7e4c429): the states, icons and tooltip
 * wording, the check spin (at least one full turn, then it stops at a turn
 * boundary once the check ends, never under reduced motion, paused while
 * the tab is hidden), and the hover-to-open release notes popover with a
 * 150 ms close delay. MIT License, Copyright (c) 2026 T3 Tools Inc. (full
 * notice in components/release-notes-view.tsx).
 *
 * Update everything (roadmap item 23 PR 2) follows T3 at 8cf97b5:
 * resolveSidebarUpdatePresentation (SidebarUpdatePill.tsx:82-117) and its
 * "everything" icon (DesktopUpdateStatusIcon.tsx:119), shown only while a
 * server is behind (useUpdateEverything.ts:104).
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import * as Popper from "@radix-ui/react-popper";
import { CheckIcon, CircleArrowUpIcon, DownloadIcon, RefreshCwIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import { useOptionalInteractionLayers } from "@/components/interaction-layers";
import { hasLegacyInteractionForeground } from "@/components/plugin-input-focus";
import { InstallUpdateDialog } from "@/components/install-update-dialog";
import { focusAfterDialog, SidebarUpdateCapsule } from "@/components/sidebar-update-capsule";
import { SIDEBAR_CLOSED_ATTR } from "@/components/sidebar-boot";
import { runIsLive, type BridgeAnswer, type UpdateRunLocalState } from "@/components/update-everything-logic";
import { holdWhatsNew } from "@/components/whats-new-hold";
import { UpdateReleaseNotes } from "@/components/release-notes-view";
import { CHECK_ERROR, CHECK_FAILED_TITLE, CHECK_UNAVAILABLE, DOWNLOAD_FAILED_TITLE, DOWNLOAD_START_FAILED_TITLE, INSTALL_FAILED_TITLE, showUpdateDownloadedToast, showUpdateErrorToast, showUpdateEverythingResult, UNEXPECTED_ERROR } from "@/components/update-toasts";
import { APP_VERSION, HOMEPAGE, desktopOffer, useDesktopAppUpdate, useUpdateState, type DesktopAppStatus, type UpdateState } from "@/components/settings/update-settings";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { downloadingTooltip, PREPARING_LABEL, retryTooltip } from "@/components/update-tooltips";
import { cn } from "@/lib/utils";
import { isExactVersion, isNewerVersion } from "@/selfhost/src/version-order.ts";
import type { ReleaseNoteGroup } from "@/src/core";

export type UpdateControlKind = "check" | "checking" | "unavailable" | "download" | "downloading" | "install" | "restarting" | "dismiss-notice" | "reload" | "everything" | "app-download" | "app-install";

/** True when the server runs a different exact version than the code of this
 *  page: newer after an update, older after a rollback. Either way, reload. */
export function pageIsStale(state: UpdateState | null, pageVersion: string = APP_VERSION): boolean {
	const running = state?.runningVersion;
	return !!running && isExactVersion(running) && isExactVersion(pageVersion) && running !== pageVersion;
}

/** Owner decision (docs/specs/update-control.md): a page whose server now runs
 *  a newer version reloads by itself, without asking about unsent text. Only
 *  newer: after a rollback the button waits for a click. */
export function autoReloadVersion(state: UpdateState | null, pageVersion: string = APP_VERSION): string | null {
	return state?.runningVersion && pageIsStale(state, pageVersion) && isNewerVersion(state.runningVersion, pageVersion) ? state.runningVersion : null;
}

export const AUTO_RELOAD_KEY = "lh-auto-reloaded-versions";
/** How many versions a tab remembers; the oldest drops off past this. */
export const AUTO_RELOAD_MEMORY = 50;

/** At most one automatic reload per server version per tab: every version
 *  the tab reloaded for is kept in sessionStorage (a JSON list) so it
 *  survives the reload. A page whose code still doesn't match afterwards (a
 *  stale cache) keeps the button instead of looping, also when the server
 *  goes back and forth between versions. No usable storage means no
 *  automatic reload, only the button. */
export function claimAutoReload(version: string): boolean {
	try {
		const storage = window.sessionStorage;
		if (!storage) return false;
		let claimed: unknown;
		try { claimed = JSON.parse(storage.getItem(AUTO_RELOAD_KEY) ?? "[]"); } catch { claimed = []; }
		const versions = Array.isArray(claimed) ? claimed.filter((item): item is string => typeof item === "string") : [];
		if (versions.includes(version)) return false;
		const next = JSON.stringify([...versions, version].slice(-AUTO_RELOAD_MEMORY));
		storage.setItem(AUTO_RELOAD_KEY, next);
		return storage.getItem(AUTO_RELOAD_KEY) === next;
	} catch {
		return false;
	}
}

/** The server runs exactly `version` and its launcher committed it (not an uncommitted trial). */
const serverKept = (state: UpdateState, version: string) =>
	!!state.runningVersion && isExactVersion(state.runningVersion) && state.runningVersion === version && state.committed === true;

/** The one place that picks the button's state (T3's resolveSidebarUpdatePresentation order).
 *  `desktop` is this app's own update, only in its window onto a self-hosted server.
 *  `installing`: the user confirmed Install in this page and the restart hasn't happened. */
export function resolveUpdateControl(state: UpdateState | null, { showCheckIcon = false, pageVersion = APP_VERSION, desktop = null, installing = false }: { showCheckIcon?: boolean; pageVersion?: string; desktop?: DesktopAppStatus | null; installing?: boolean } = {}): UpdateControlKind | null {
	if (!state) return null;
	if (pageIsStale(state, pageVersion)) return "reload";
	if (showCheckIcon) return "checking";
	if (desktop?.phase === "downloading") return "downloading";
	const offered = desktopOffer(desktop);
	// Only this app's restart is left once the server runs its version and the launcher kept it,
	// the run's own condition (electron/update-everything.cjs, updateServer).
	if (desktop?.phase === "updating") return offered && serverKept(state, offered) ? "restarting" : "everything";
	if (offered && (desktop?.phase === "available" || desktop?.phase === "downloaded")) {
		if (isNewerVersion(offered, state.runningVersion)) return "everything";
		return desktop.phase === "downloaded" ? "app-install" : "app-download";
	}
	if (state.status === "downloading") return "downloading";
	// A failed install (T3's recovery: still downloaded, with the install context) leaves Restarting.
	if (state.status === "downloaded") return installing && state.errorContext !== "install" ? "restarting" : "install";
	if (state.status === "available") return "download";
	// T3's retry actions (resolveDesktopUpdateButtonAction, desktopUpdate.logic.ts:49-69 at df09ced7):
	// an error that kept a download installs it, a failed download downloads again.
	if (state.status === "error" && state.downloadedVersion && (state.errorContext == null || state.errorContext === "install")) return installing ? "restarting" : "install";
	if (state.status === "error" && state.errorContext === "download" && state.availableVersion) return "download";
	if (state.notice?.kind === "rolled-back") return "dismiss-notice";
	if (state.status === "disabled") return "unavailable";
	return "check";
}

export const UNAVAILABLE_TITLE = "Updates unavailable";
export const UNAVAILABLE_DETAIL = "Automatic updates are not available in this build.";

/** The tooltip, and the popover's title line (T3's wording, plus LearnHarness's notice and reload). */
export function updateControlTooltip(state: UpdateState, kind: UpdateControlKind, pageVersion: string = APP_VERSION): string {
	switch (kind) {
		case "reload": return isNewerVersion(state.runningVersion, pageVersion)
			? `Updated to ${state.runningVersion}. Click to reload.`
			: `Server is on ${state.runningVersion}. Click to reload.`;
		case "checking": return "Checking for updates…";
		case "unavailable": return UNAVAILABLE_TITLE;
		case "download": return retryTooltip(state) ?? (state.version ? `Update ${state.version} ready to download` : "Update available ready to download");
		// Owner decision 2026-11-19: once the server has every byte it checks and unpacks it.
		case "downloading": return state.preparing ? PREPARING_LABEL : downloadingTooltip(state.downloadPercent);
		case "install": return retryTooltip(state) ?? `Update ${state.version ?? "ready"} downloaded. Click to restart and install.`;
		case "restarting": return restartingTooltip(state.version);
		case "dismiss-notice": return state.notice?.text ?? "";
		// T3's updateTargetsSentence for this app and one server (updateEverything.logic.ts:765-772).
		case "everything": return "Update this app and 1 server";
		default: return "Check for updates";
	}
}

export { downloadingTooltip, PREPARING_LABEL, retryTooltip } from "@/components/update-tooltips";

/** Owner decision 2026-11-19: the label between the confirmed install and the restart. */
export const restartingTooltip = (version: string | null | undefined) => `Restarting to install ${version || "the update"}…`;

/** How far the download shown by the "downloading" state is: this app's own when it is the
 *  one downloading (resolveUpdateControl checks it first), else the server's. */
export function shownDownloadPercent(state: UpdateState | null, desktop: DesktopAppStatus | null = null): number | null {
	const percent = desktop?.phase === "downloading" ? desktop.downloadPercent : state?.downloadPercent;
	return typeof percent === "number" && Number.isFinite(percent) ? percent : null;
}

/** Tooltips for this app's own update (T3's getDesktopUpdateButtonTooltip, desktopUpdate.logic.ts:131-145). */
export function appUpdateTooltip(desktop: DesktopAppStatus, kind: "app-download" | "app-install"): string {
	const version = desktopOffer(desktop);
	if (kind === "app-download") return version ? `Update ${version} ready to download` : "Update available ready to download";
	return version ? `Update ${version} downloaded. Click to restart and install.` : "Update ready downloaded. Click to restart and install.";
}

/** T3's showUpdateDetails (SidebarUpdatePill.tsx:95 at df09ced7): the states about one
 *  offered update, whose hover shows its release notes when there are any. */
const DETAIL_KINDS: ReadonlySet<UpdateControlKind> = new Set(["download", "downloading", "install", "restarting", "everything", "app-download", "app-install"]);

/** The notes the hover shows, or null for the plain tooltip. T3's rule
 *  (SidebarUpdatePill.tsx:58-63, 279-280 at df09ced7): `showUpdateDetails && notes.length > 0`,
 *  and none while an Update everything run is going. The notes are this app's for its own
 *  states (everything, app-download, app-install, its own download) and the server's otherwise. */
export type ShownReleaseNotes = {
	releaseNotes: ReleaseNoteGroup[];
	omittedReleaseCount: number;
	/** The offered version, whose generated summary needs no heading (T3's availableVersion). */
	offeredVersion: string | null;
	/** Its updater says "available": the popover's header is "Update ready to download" (T3's
	 *  `state.status === "available"`, also under the everything state). */
	available: boolean;
};

export function shownReleaseNotes(state: UpdateState | null, kind: UpdateControlKind | null, desktop: DesktopAppStatus | null = null): ShownReleaseNotes | null {
	if (!kind || !DETAIL_KINDS.has(kind) || desktop?.phase === "updating") return null;
	const appOwned = kind === "everything" || kind === "app-download" || kind === "app-install" || (kind === "downloading" && desktop?.phase === "downloading");
	const source = appOwned ? desktop : state;
	const releaseNotes = source?.releaseNotes ?? [];
	if (releaseNotes.length === 0) return null;
	return {
		releaseNotes,
		omittedReleaseCount: source?.omittedReleaseCount ?? 0,
		offeredVersion: appOwned ? desktop?.target ?? null : state?.version ?? null,
		// A retry or did-not-apply state heads the notes with its own line (the control's hover text).
		available: appOwned ? desktop?.phase === "available" : state?.status === "available" && !!state && retryTooltip(state) === null,
	};
}

/** The second tooltip line of "unavailable" (T3's getDesktopUpdateDisabledReason fallback). */
export const unavailableDetail = (state: UpdateState) => state.message?.trim() || UNAVAILABLE_DETAIL;

const TEXT_INPUT_TYPES = new Set(["", "text", "email", "url", "tel"]);
/** Search and filter boxes hold a query, not a draft: no prompt for those. */
const SEARCH_LIKE = /^(search|find|filter)\b/i;

function isDraftField(field: Element): boolean {
	const hidden = typeof (field as HTMLElement).checkVisibility === "function" ? !(field as HTMLElement).checkVisibility() : !!field.closest("[hidden]");
	if (hidden || field.getAttribute("aria-disabled") === "true") return false;
	const label = `${field.getAttribute("placeholder") ?? ""}`.trim() || `${field.getAttribute("aria-label") ?? ""}`.trim();
	if (SEARCH_LIKE.test(label) || field.getAttribute("role") === "searchbox" || field.getAttribute("role") === "combobox") return false;
	const editable = (input: HTMLInputElement | HTMLTextAreaElement) =>
		!input.readOnly && !input.disabled && !input.hasAttribute("readonly") && !input.hasAttribute("disabled") && input.value.trim().length > 0;
	if (field instanceof HTMLTextAreaElement) return editable(field);
	if (field instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(field.getAttribute("type")?.toLowerCase() ?? "") && editable(field);
	// The chat composer, the home topic box, answer and thinking fields (PathInput).
	return field.getAttribute("contenteditable") !== "false" && (field.textContent ?? "").trim().length > 0;
}

/** Any user-editable text field on the page holding text that hasn't been sent:
 *  composers and answer fields, the side-question box, the comment editor,
 *  rename fields. Skips read-only, disabled, hidden and search or filter boxes. */
export function hasUnsentMessage(root: ParentNode = document): boolean {
	return Array.from(root.querySelectorAll('[role="textbox"][contenteditable], textarea, input')).some(isDraftField);
}

/** T3's check-spin latch rule: show the spinning icon while checking, or while a started turn finishes. */
export const showsCheckIcon = (checking: boolean, latched: boolean, reducedMotion: boolean) => checking || (latched && !reducedMotion);
/** At each turn boundary: keep spinning only while the check still runs. */
export const continuesCheckSpin = (checking: boolean, reducedMotion: boolean) => checking && !reducedMotion;

const CLOSE_DELAY_MS = 150;

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const tabbablesIn = (root: ParentNode | null | undefined): HTMLElement[] =>
	root ? Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((element) => element.getAttribute("tabindex") !== "-1" && !element.closest("[hidden], [inert]")) : [];

/** Keyboard focus only, as components/ui/tooltip.tsx checks it (a DOM without :focus-visible counts as yes). */
function focusVisible(element: Element): boolean {
	try { return element.matches(":focus-visible"); } catch { return true; }
}

function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(false);
	useEffect(() => {
		const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
		if (!query) return;
		setReduced(query.matches);
		const change = () => setReduced(query.matches);
		query.addEventListener("change", change);
		return () => query.removeEventListener("change", change);
	}, []);
	return reduced;
}

/** Pause a running spin while the tab is hidden (T3's observeVisibleAnimation,
 *  visibility part). Inline, so the class's `animation` shorthand can't reset it. */
function pauseWhileHidden(element: SVGSVGElement | null) {
	if (!element) return;
	const update = () => { element.style.animationPlayState = document.visibilityState === "hidden" ? "paused" : "running"; };
	update();
	document.addEventListener("visibilitychange", update);
	return () => document.removeEventListener("visibilitychange", update);
}

const DOWNLOAD_PROGRESS_RADIUS = 14;
const DOWNLOAD_PROGRESS_CIRCUMFERENCE = 2 * Math.PI * DOWNLOAD_PROGRESS_RADIUS;

/** How much of the ring is left unfilled, from a percent (empty when unknown). */
export function downloadRingOffset(percent: number | null): number {
	const filled = percent === null || !Number.isFinite(percent) ? 0 : Math.min(100, Math.max(0, percent));
	return DOWNLOAD_PROGRESS_CIRCUMFERENCE * (1 - filled / 100);
}

/** T3's DesktopUpdateDownloadingIcon (DesktopUpdateStatusIcon.tsx:15-18 and 56-90 at 3ce21458):
 *  a ring around the download arrow that fills as the download goes, 300 ms ease-out, no
 *  transition under reduced motion. */
function DownloadingIcon({ percent }: { percent: number | null }) {
	return (
		<span className="relative grid size-8 place-items-center" data-testid="update-download-ring" data-percent={percent ?? undefined}>
			<svg aria-hidden className="pointer-events-none absolute inset-0 size-full -rotate-90" viewBox="0 0 32 32">
				<circle cx="16" cy="16" r={DOWNLOAD_PROGRESS_RADIUS} fill="none" className="stroke-current/22" strokeWidth="1.5" />
				<circle
					cx="16"
					cy="16"
					r={DOWNLOAD_PROGRESS_RADIUS}
					fill="none"
					stroke="currentColor"
					strokeDasharray={DOWNLOAD_PROGRESS_CIRCUMFERENCE}
					strokeDashoffset={downloadRingOffset(percent)}
					strokeLinecap="round"
					strokeWidth="1.5"
					className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
				/>
			</svg>
			<DownloadIcon className="size-4" aria-hidden />
		</span>
	);
}

/** T3's DesktopUpdateDownloadedIcon: RotateCw with a check badge. While restarting the
 *  arrow spins (the badge stays put), like the check spin: motion-safe, paused while hidden. */
function RestartIcon({ spinning = false }: { spinning?: boolean }) {
	return (
		<span className="relative grid size-4 place-items-center">
			<RotateCwIcon
				aria-hidden
				data-testid="update-control-restart-icon"
				data-spinning={spinning || undefined}
				ref={spinning ? pauseWhileHidden : undefined}
				className={cn("size-4", spinning && "motion-safe:animate-spin")}
			/>
			<span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background ring-2 ring-background">
				<CheckIcon className="size-2" strokeWidth={3} aria-hidden />
			</span>
		</span>
	);
}

function ControlIcon({ kind, spinning, onIteration, downloadPercent = null }: { kind: UpdateControlKind; spinning: boolean; onIteration: () => void; downloadPercent?: number | null }) {
	if (kind === "download" || kind === "app-download") {
		return (
			<span className="relative grid size-4 place-items-center">
				<DownloadIcon className="size-4" aria-hidden />
				<span aria-hidden className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-current ring-2 ring-accent" />
			</span>
		);
	}
	if (kind === "downloading") return <DownloadingIcon percent={downloadPercent} />;
	if (kind === "everything") return <CircleArrowUpIcon className="size-4" aria-hidden />;
	if (kind === "install" || kind === "app-install" || kind === "reload") return <RestartIcon />;
	if (kind === "restarting") return <RestartIcon spinning={spinning} />;
	if (kind === "dismiss-notice") return <TriangleAlertIcon className="size-3.5 text-destructive" aria-hidden />;
	return (
		<RefreshCwIcon
			aria-hidden
			data-testid="update-control-refresh-icon"
			data-spinning={spinning || undefined}
			ref={spinning ? pauseWhileHidden : undefined}
			onAnimationIteration={onIteration}
			className={cn("size-4", spinning && "motion-safe:animate-spin")}
		/>
	);
}

export const RELOAD_CONFIRM_TITLE = "You have an unsent message. Reload anyway?";

/** The confirm before a reload would erase unsent text. */
export function ReloadConfirmBody({ onClose, onConfirm, confirmRef }: { onClose: () => void; onConfirm: () => void; confirmRef?: RefObject<HTMLButtonElement | null> }) {
	return (
		<>
			<h2 className="text-sm font-semibold text-card-foreground" data-testid="reload-confirm-title">{RELOAD_CONFIRM_TITLE}</h2>
			<div className="mt-4 flex justify-end gap-2">
				<button type="button" data-testid="reload-confirm-cancel" onClick={onClose} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
					Cancel
				</button>
				<button type="button" ref={confirmRef} data-testid="reload-confirm-reload" onClick={onConfirm} className="rounded-sm bg-accent px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/80">
					Reload
				</button>
			</div>
		</>
	);
}

function ReloadConfirmDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: () => void }) {
	const confirmRef = useRef<HTMLButtonElement>(null);
	return (
		<HostDialog
			open={open}
			aria-label={RELOAD_CONFIRM_TITLE}
			initialFocusRef={confirmRef}
			onClose={() => { onClose(); return "closed"; }}
			backdropProps={{ className: "fixed inset-0 z-[60] flex items-center justify-center bg-background/80 backdrop-blur-sm", "data-testid": "reload-confirm-dialog" }}
			frame={<div className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg" onClick={(event) => event.stopPropagation()} />}
		>
			<ReloadConfirmBody onClose={onClose} onConfirm={onConfirm} confirmRef={confirmRef} />
		</HostDialog>
	);
}

/** Whether the sidebar shows (data-lh-sidebar on <html>, components/sidebar.tsx): closed, it is
 *  still mounted at width 0, and the capsule in it can't be seen. */
function subscribeSidebar(onChange: () => void) {
	if (typeof MutationObserver === "undefined") return () => {};
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: [SIDEBAR_CLOSED_ATTR] });
	return () => observer.disconnect();
}
const sidebarShown = () => document.documentElement.getAttribute(SIDEBAR_CLOSED_ATTR) !== "closed";

export function SidebarUpdatePill({ reload = () => window.location.reload(), pageVersion = APP_VERSION, homepage = HOMEPAGE }: { reload?: () => void; pageVersion?: string; homepage?: string } = {}) {
	const { state, transport, check, install, download, dismissNotice } = useUpdateState();
	const desktop = useDesktopAppUpdate();
	const desktopStatus = desktop?.status ?? null;
	const reducedMotion = useReducedMotion();
	const [confirming, setConfirming] = useState(false);
	const [confirmingReload, setConfirmingReload] = useState(false);
	const [pending, setPending] = useState(false);
	// Confirmed Install in this page: "restarting" until the page reloads, or the state moves on (a failure).
	const [installing, setInstalling] = useState(false);
	// Update everything in the page (revision PR 7): the app shows its own dialog; the page shows the capsule.
	const everything = desktop?.everything ?? null;
	// The run's result toast, once each (main numbers them), also after the restart that finished
	// the run (T3's saved result). "This app" counts by the app's own version, not this page's.
	const resultId = desktopStatus?.result ?? null;
	const appVersion = desktopStatus?.version ?? null;
	const takenResult = useRef<number | null>(null);
	useEffect(() => {
		if (resultId === null || !everything || takenResult.current === resultId) return;
		takenResult.current = resultId;
		void everything.takeResult().then((result) => { if (result) showUpdateEverythingResult(result, appVersion ?? undefined); });
	}, [resultId, everything, appVersion]);
	// The app waits for the capsule to show this (the countdown starts only then): say so once
	// each time it starts waiting, and only where it can be seen. In a closed sidebar the app's
	// own countdown shows instead, once its wait is up.
	const awaitingPage = desktopStatus?.run?.awaitingPage === true;
	const keyboardRun = desktopStatus?.run?.keyboard === true;
	const shown = useSyncExternalStore(subscribeSidebar, sidebarShown, () => true);
	// A key closed the app's dialog with Update: focus goes onto the capsule that stands in for the
	// control, and again on the page main reloads after the server's cover (focus starts in the
	// composer there), so the countdown's Later stays one Enter away.
	const [focusCapsule, setFocusCapsule] = useState(0);
	useEffect(() => {
		if (!awaitingPage || !shown || !everything) return;
		everything.ready();
		if (keyboardRun) setFocusCapsule((count) => count + 1);
	}, [awaitingPage, shown, everything, keyboardRun]);
	// While the capsule shows a run, the What's new popup waits (components/whats-new-dialog.tsx):
	// a modal over the countdown would keep Later from the keyboard.
	const runShown = !!(everything && desktopStatus?.run && runIsLive(desktopStatus.run));
	useEffect(() => {
		holdWhatsNew(runShown);
		return () => holdWhatsNew(false);
	}, [runShown]);
	const toastOf = (answer: BridgeAnswer) => {
		if (answer.error) showUpdateErrorToast(answer.error.title, answer.error.detail);
		return answer;
	};
	const [open, setOpen] = useState(false);
	// The plain tooltip's open state, controlled all the time: switching Radix between controlled and
	// uncontrolled lost a close made while the notes applied, and the old state came back after.
	const [plainOpen, setPlainOpen] = useState(false);
	const [spinKey, setSpinKey] = useState(0);
	const isChecking = state?.status === "checking" || desktopStatus?.phase === "checking";
	const [latched, setLatched] = useState(false);
	// Latch when a check starts (also one started elsewhere: Settings, the timer); drop it under reduced motion.
	useEffect(() => {
		if (reducedMotion) setLatched(false);
		else if (isChecking) setLatched(true);
	}, [isChecking, reducedMotion]);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	// Escape from the notes puts focus back on the button without opening them again (T3's suppressReleaseNotesFocusOpen).
	const suppressFocusOpen = useRef(false);
	// The button holds keyboard focus (T3's releaseNotesTriggerFocusVisible), and focus is in the notes.
	const keyboardOnButton = useRef(false);
	const focusInNotes = useRef(false);
	const popoverId = useId();
	useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

	const showCheckIcon = showsCheckIcon(isChecking, latched, reducedMotion);
	const kind = resolveUpdateControl(state, { showCheckIcon, pageVersion, desktop: desktopStatus, installing });
	// Anything but the restart (an error, a newer version to download, a rollback notice) is the normal
	// button again. A check spin started elsewhere (this app's own timer) outranks it only for a moment.
	// An install main recovered from says so through its notice (components/update-toasts.tsx), not here:
	// main reloads this page after it, and an Install may have gone through a download on the way.
	useEffect(() => { if (kind !== "restarting" && kind !== "checking") setInstalling(false); }, [kind]);
	const autoReloadTo = autoReloadVersion(state, pageVersion);
	useEffect(() => {
		if (autoReloadTo && claimAutoReload(autoReloadTo)) reload();
	}, [autoReloadTo, reload]); // claimAutoReload keeps it to once per version, whatever reruns the effect
	const shownNotes = shownReleaseNotes(state, kind, desktopStatus);
	const showsNotes = shownNotes !== null;
	// The notes close when they stop applying, and open when they start applying while the
	// button already holds keyboard focus (T3's SidebarUpdatePill.tsx:282-290).
	useEffect(() => { setOpen(showsNotes && keyboardOnButton.current); if (showsNotes) setPlainOpen(false); }, [showsNotes]);
	const notesOpen = open && showsNotes;
	// Notes that close with focus inside them hand it back to the button, never to the page.
	useEffect(() => {
		if (notesOpen || !focusInNotes.current) return;
		focusInNotes.current = false;
		const active = document.activeElement;
		if (active && active !== document.body && active.isConnected) return;
		suppressFocusOpen.current = true;
		buttonRef.current?.focus({ preventScroll: true });
	}, [notesOpen]);
	// T3 closes the notes on Escape wherever focus is. In the capture phase, so neither a field's
	// own Escape (the composer's dictation) nor the app's turn abort (keyboard-shortcuts.tsx,
	// chat.tsx) sees it: one Esc, one action. They take Escape with any modifier (Shift+Escape
	// aborts a turn too), from inside them always, and from outside only when no foreground layer
	// (Settings, a dialog, a popover) owns it: that layer closes first.
	const layers = useOptionalInteractionLayers();
	useEffect(() => {
		if (!notesOpen) return;
		const onEscape = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing) return;
			// A focused toast takes its own Escape first (components/ui/toast.tsx).
			if ((document.activeElement as HTMLElement | null)?.closest?.("[data-toast-region]")) return;
			const inside = !!popoverRef.current?.contains(document.activeElement);
			// The provider's own capture listener ran first and snapshotted the owner.
			if (!inside && (layers ? layers.isEscapeOwned(event) : hasLegacyInteractionForeground(document))) return;
			event.preventDefault();
			event.stopPropagation();
			if (closeTimer.current) clearTimeout(closeTimer.current);
			closeTimer.current = null;
			// From inside the notes, onto the button; it doesn't open them again (removing a focused
			// element fires no blur, so don't wait for the effect above to notice).
			if (inside) {
				focusInNotes.current = false;
				suppressFocusOpen.current = true;
				buttonRef.current?.focus({ preventScroll: true });
			}
			setOpen(false);
		};
		window.addEventListener("keydown", onEscape, true);
		return () => window.removeEventListener("keydown", onEscape, true);
	}, [notesOpen, layers]);
	const onIteration = useCallback(() => setLatched(continuesCheckSpin(isChecking, reducedMotion)), [isChecking, reducedMotion]);

	// While the app runs Update everything, or keeps a run that failed, the capsule stands in for the control.
	const run = everything ? desktopStatus?.run ?? null : null;
	if (run && everything) {
		const local: UpdateRunLocalState = run.localVersion === null ? null
			: desktopStatus?.phase === "downloading" ? { status: "downloading", percent: desktopStatus.downloadPercent ?? null }
			: { status: "waiting" };
		return (
			// T3's sidebar row for it (SidebarUpdatePill.tsx: @container/sidebar-update): the capsule's width follows it.
			<div className="@container/sidebar-update ml-auto flex min-w-8 flex-1 justify-end">
				<SidebarUpdateCapsule run={run} local={local} icon={<CircleArrowUpIcon className="size-4" aria-hidden />} focusRequest={focusCapsule} actions={{
					later: everything.later,
					// The app asks again in its own dialog before it retries anything.
					retry: () => everything.retry().then(toastOf),
					dismiss: everything.dismiss,
				}} />
			</div>
		);
	}
	if (!state || !kind) return null;
	const downloadPercent = shownDownloadPercent(state, desktopStatus);
	const tooltip = (kind === "app-download" || kind === "app-install") && desktopStatus ? appUpdateTooltip(desktopStatus, kind)
		: kind === "downloading" && desktopStatus?.phase === "downloading" ? downloadingTooltip(downloadPercent)
		: kind === "restarting" && desktopStatus?.phase === "updating" ? restartingTooltip(desktopOffer(desktopStatus))
		: updateControlTooltip(state, kind, pageVersion);
	const detail = kind === "unavailable" ? unavailableDetail(state) : null;
	const disabled = kind === "checking" || kind === "downloading" || kind === "unavailable" || kind === "restarting" || pending || (kind === "everything" && desktopStatus?.phase === "updating");
	const surface = kind !== "check" && kind !== "checking" && kind !== "unavailable";

	const cancelClose = () => {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		closeTimer.current = null;
	};
	const show = () => { cancelClose(); if (showsNotes) setOpen(true); };
	const hideSoon = () => {
		cancelClose();
		closeTimer.current = setTimeout(() => {
			// Keyboard focus inside the notes keeps them open when the pointer leaves; a link a
			// mouse click focused does not.
			const active = document.activeElement;
			if (active && popoverRef.current?.contains(active) && focusVisible(active)) return;
			setOpen(false);
		}, CLOSE_DELAY_MS);
	};
	const closeToButton = () => {
		cancelClose();
		suppressFocusOpen.current = true;
		setOpen(false);
		buttonRef.current?.focus({ preventScroll: true });
	};
	// T3 promotes the hover popover to a focus-managed one on forward Tab (SidebarUpdatePill.tsx:72-80):
	// Tab moves into the notes' links; Escape (above) closes them, onto the button when focus was in
	// them. LearnHarness has no native Tab (interaction-layers.tsx prevents it; Tab cycles text fields
	// and Shift+Tab the thinking level, keyboard-shortcuts.tsx), so the notes move focus themselves
	// and stop the keys they take from reaching those shortcuts.
	const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (!showsNotes || event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key !== "Tab" || event.shiftKey) return;
		cancelClose();
		flushSync(() => setOpen(true));
		const first = tabbablesIn(popoverRef.current)[0];
		if (!first) return;
		event.preventDefault();
		event.stopPropagation();
		first.focus();
	};
	const onNotesKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.metaKey || event.ctrlKey || event.altKey || event.key !== "Tab") return;
		event.preventDefault();
		const inside = tabbablesIn(popoverRef.current);
		const at = inside.indexOf(event.target as HTMLElement);
		if (event.shiftKey) {
			event.stopPropagation();
			(at > 0 ? inside[at - 1] : buttonRef.current)?.focus({ preventScroll: true });
		} else if (at >= 0 && at < inside.length - 1) {
			event.stopPropagation();
			inside[at + 1]?.focus();
		} else {
			// Past the last link the notes close onto the button, and the app's own Tab goes on from there.
			closeToButton();
		}
	};

	const onClick = () => {
		if (disabled) return;
		if (kind === "reload") {
			if (hasUnsentMessage()) setConfirmingReload(true);
			else reload();
		} else if (everything && kind === "everything") {
			// The app's own Update everything dialog (revision PR 7): it plans, asks and starts.
			setPending(true);
			const trigger = buttonRef.current;
			void everything.open().then((answer) => {
				toastOf(answer);
				focusAfterDialog(answer, trigger, () => setFocusCapsule((count) => count + 1));
			}).finally(() => setPending(false));
		} else if (desktop && (kind === "everything" || kind === "app-install")) {
			// An older app asks first in its own native dialog (electron/update-everything.cjs).
			setPending(true);
			void desktop.install().catch(() => {}).finally(() => setPending(false));
		} else if (desktop && kind === "app-download") void desktop.download().catch(() => {});
		else if (kind === "download") {
			// T3's downloadLocalUpdate (SidebarUpdatePill.tsx:147-170 at df09ced7), with LearnHarness's fixed messages.
			void download().then((result) => {
				// "failed": the server's own request; its updater raises no toasts.
				if (result === "failed") return;
				if (result === "threw") showUpdateErrorToast(DOWNLOAD_START_FAILED_TITLE, UNEXPECTED_ERROR);
				else if (result?.completed) showUpdateDownloadedToast(result.state?.downloadedVersion ?? result.state?.version ?? state.version);
				else if (result?.accepted && result.state?.message) showUpdateErrorToast(DOWNLOAD_FAILED_TITLE, result.state.message);
			});
		}
		else if (kind === "install") { setOpen(false); setConfirming(true); }
		else if (kind === "dismiss-notice") dismissNotice();
		else if (kind === "check") {
			if (!reducedMotion) { setLatched(true); setSpinKey((key) => key + 1); }
			setPending(true);
			// A failed check comes back as the "error" state, which shows the refresh button again. A check
			// that didn't run, or a bridge that threw, says so (T3's, SidebarUpdatePill.tsx:340-368 at df09ced7).
			const appCheck = check()
				.then((result) => {
					if (transport === "desktop" && result && !result.checked) showUpdateErrorToast(CHECK_FAILED_TITLE, result.state?.message ?? CHECK_UNAVAILABLE);
				})
				.catch(() => { if (transport === "desktop") showUpdateErrorToast(CHECK_FAILED_TITLE, CHECK_ERROR); });
			void Promise.all([appCheck, desktop?.check().catch(() => {})]).finally(() => setPending(false));
		}
	};

	const button = (
		<button
			ref={buttonRef}
			type="button"
			data-testid="update-pill"
			data-action={kind}
			aria-label={detail ? `${tooltip}: ${detail}` : tooltip}
			aria-disabled={disabled || undefined}
			aria-describedby={open ? popoverId : undefined}
			onClick={onClick}
			onPointerEnter={show}
			onPointerLeave={hideSoon}
			onFocus={(event) => {
				keyboardOnButton.current = focusVisible(event.currentTarget);
				if (suppressFocusOpen.current) { suppressFocusOpen.current = false; return; }
				if (keyboardOnButton.current) show();
			}}
			onBlur={() => { keyboardOnButton.current = false; suppressFocusOpen.current = false; hideSoon(); }}
			onKeyDown={onButtonKeyDown}
			className={cn(
				"inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
				disabled ? "cursor-not-allowed" : "cursor-pointer",
				surface
					? cn("bg-accent text-foreground", !disabled && "hover:bg-accent/70")
					: cn("text-muted-foreground", !disabled && "hover:bg-accent hover:text-foreground"),
				(kind === "unavailable" || kind === "restarting") && "opacity-60",
			)}
		>
			<ControlIcon key={showCheckIcon ? `spin-${spinKey}` : kind} kind={kind} spinning={(kind === "checking" || kind === "restarting") && !reducedMotion} onIteration={onIteration} downloadPercent={downloadPercent} />
		</button>
	);

	return (
		<div className="ml-auto shrink-0">
			{/* One tree for every state, so the button stays mounted (and keeps keyboard focus) when the
			    release notes come and go. The notes anchor on the trigger through the Tooltip's own Popper. */}
			<TooltipProvider>
				{/* T3's <Tooltip disabled={showReleaseNotesPopover}>: the notes replace the plain tooltip. */}
				<Tooltip open={!shownNotes && plainOpen} onOpenChange={(next) => setPlainOpen(next && !shownNotes)}>
					<TooltipTrigger asChild>{button}</TooltipTrigger>
					{shownNotes ? open && createPortal(
						<Popper.Content side="top" align="center" sideOffset={8} collisionPadding={8} className="z-50">
							<div
								ref={popoverRef}
								id={popoverId}
								role="dialog"
								aria-label="Update release notes"
								data-testid="update-pill-notes"
								onPointerEnter={cancelClose}
								onPointerLeave={hideSoon}
								onFocus={() => { focusInNotes.current = true; cancelClose(); }}
								onBlur={() => { focusInNotes.current = false; hideSoon(); }}
								onKeyDown={onNotesKeyDown}
								className="flex max-h-[min(32rem,calc(100vh-6rem))] w-fit max-w-[min(24rem,calc(100vw-2rem))] flex-col rounded-lg border border-border bg-popover p-3 text-left text-pretty text-popover-foreground shadow-lg"
							>
								<UpdateReleaseNotes
									groups={shownNotes.releaseNotes}
									omittedReleaseCount={shownNotes.omittedReleaseCount}
									homepage={homepage}
									offeredVersion={shownNotes.offeredVersion}
									available={shownNotes.available}
									title={tooltip}
								/>
							</div>
						</Popper.Content>,
						document.body,
					) : (
						<TooltipContent side="top" data-testid="update-pill-tooltip">
							{detail ? (
								<div className="text-left">
									<div className="font-medium">{tooltip}</div>
									<div className="text-muted-foreground">{detail}</div>
								</div>
							) : tooltip}
						</TooltipContent>
					)}
				</Tooltip>
			</TooltipProvider>
			<InstallUpdateDialog
				open={confirming && (kind === "install" || state.status === "downloaded")}
				version={state.version}
				onClose={() => setConfirming(false)}
				onConfirm={() => {
					setConfirming(false);
					// The dialog hands focus back only to an enabled opener, and the restarting button is
					// disabled: put focus back on it when it would otherwise drop to the page.
					const target = buttonRef.current;
					const startRestarting = () => {
						setInstalling(true);
						setTimeout(() => {
							const active = document.activeElement;
							if (target?.isConnected && (!active || active === document.body || !active.isConnected)) target.focus({ preventScroll: true });
						}, 0);
					};
					if (transport === "desktop") {
						// The app can turn it down (an Update everything run owns its updater): Restarting
						// only after its yes, and until then the normal button, focus untouched.
						// T3's installLocalUpdate: a refused install shows the downloaded toast, a bridge that threw
						// "Could not install update" (SidebarUpdatePill.tsx:172-195 at df09ced7).
						let threw = false;
						void install({ fromSidebar: true, onError: () => { threw = true; showUpdateErrorToast(INSTALL_FAILED_TITLE, UNEXPECTED_ERROR); } }).then((accepted) => {
							if (accepted) startRestarting();
							else if (!threw) showUpdateDownloadedToast(state.downloadedVersion ?? state.version);
						});
						return;
					}
					startRestarting();
					// A failed request (the existing error behavior: the server's error state) shows the normal button again.
					void install().then((sent) => { if (!sent) setInstalling(false); });
				}}
			/>
			<ReloadConfirmDialog
				open={confirmingReload}
				onClose={() => setConfirmingReload(false)}
				onConfirm={() => { setConfirmingReload(false); reload(); }}
			/>
		</div>
	);
}

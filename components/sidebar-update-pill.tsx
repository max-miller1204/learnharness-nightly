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

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as Popper from "@radix-ui/react-popper";
import { CheckIcon, CircleArrowUpIcon, DownloadIcon, RefreshCwIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import { InstallUpdateDialog } from "@/components/install-update-dialog";
import { ReleaseNoteSections } from "@/components/release-notes-view";
import { APP_VERSION, HOMEPAGE, desktopOffer, useDesktopAppUpdate, useUpdateState, type DesktopAppStatus, type UpdateState } from "@/components/settings/update-settings";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isExactVersion, isNewerVersion } from "@/selfhost/src/version-order.ts";

export type UpdateControlKind = "check" | "checking" | "unavailable" | "download" | "downloading" | "install" | "dismiss-notice" | "reload" | "everything" | "app-download" | "app-install";

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

/** The one place that picks the button's state (T3's resolveSidebarUpdatePresentation order).
 *  `desktop` is this app's own update, only in its window onto a self-hosted server. */
export function resolveUpdateControl(state: UpdateState | null, { showCheckIcon = false, pageVersion = APP_VERSION, desktop = null }: { showCheckIcon?: boolean; pageVersion?: string; desktop?: DesktopAppStatus | null } = {}): UpdateControlKind | null {
	if (!state) return null;
	if (pageIsStale(state, pageVersion)) return "reload";
	if (showCheckIcon) return "checking";
	if (desktop?.phase === "downloading") return "downloading";
	if (desktop?.phase === "updating") return "everything";
	const offered = desktopOffer(desktop);
	if (offered && (desktop?.phase === "available" || desktop?.phase === "downloaded")) {
		if (isNewerVersion(offered, state.runningVersion)) return "everything";
		return desktop.phase === "downloaded" ? "app-install" : "app-download";
	}
	if (state.status === "downloading") return "downloading";
	if (state.status === "downloaded") return "install";
	if (state.status === "available") return "download";
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
		case "download": return state.version ? `Update ${state.version} ready to download` : "Update available ready to download";
		case "downloading": return downloadingTooltip(state.downloadPercent);
		case "install": return `Update ${state.version ?? "ready"} downloaded. Click to restart and install.`;
		case "dismiss-notice": return state.notice?.text ?? "";
		// T3's updateTargetsSentence for this app and one server (updateEverything.logic.ts:765-772).
		case "everything": return "Update this app and 1 server";
		default: return "Check for updates";
	}
}

/** T3's downloading label (desktopUpdate.logic.ts:134-139 at 3ce21458): the percent floored,
 *  or the plain label while the size is unknown. */
export function downloadingTooltip(percent: number | null | undefined): string {
	return typeof percent === "number" && Number.isFinite(percent) ? `Downloading update (${Math.floor(percent)}%)` : "Downloading update";
}

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

/** T3's DesktopUpdateDownloadedIcon: RotateCw with a check badge. */
function RestartIcon() {
	return (
		<span className="relative grid size-4 place-items-center">
			<RotateCwIcon className="size-4" aria-hidden />
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

export function SidebarUpdatePill({ reload = () => window.location.reload(), pageVersion = APP_VERSION }: { reload?: () => void; pageVersion?: string } = {}) {
	const { state, check, install, download, dismissNotice } = useUpdateState();
	const desktop = useDesktopAppUpdate();
	const desktopStatus = desktop?.status ?? null;
	const reducedMotion = useReducedMotion();
	const [confirming, setConfirming] = useState(false);
	const [confirmingReload, setConfirmingReload] = useState(false);
	const [pending, setPending] = useState(false);
	const [open, setOpen] = useState(false);
	const [spinKey, setSpinKey] = useState(0);
	const isChecking = state?.status === "checking" || desktopStatus?.phase === "checking";
	const [latched, setLatched] = useState(false);
	// Latch when a check starts (also one started elsewhere: Settings, the timer); drop it under reduced motion.
	useEffect(() => {
		if (reducedMotion) setLatched(false);
		else if (isChecking) setLatched(true);
	}, [isChecking, reducedMotion]);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const popoverId = useId();
	useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

	const showCheckIcon = showsCheckIcon(isChecking, latched, reducedMotion);
	const kind = resolveUpdateControl(state, { showCheckIcon, pageVersion, desktop: desktopStatus });
	const autoReloadTo = autoReloadVersion(state, pageVersion);
	useEffect(() => {
		if (autoReloadTo && claimAutoReload(autoReloadTo)) reload();
	}, [autoReloadTo, reload]); // claimAutoReload keeps it to once per version, whatever reruns the effect
	const notes = state?.releaseNotes ?? [];
	const showsNotes = (kind === "download" || kind === "install") && notes.length > 0;
	useEffect(() => { if (!showsNotes) setOpen(false); }, [showsNotes]);
	const onIteration = useCallback(() => setLatched(continuesCheckSpin(isChecking, reducedMotion)), [isChecking, reducedMotion]);

	if (!state || !kind) return null;
	const downloadPercent = shownDownloadPercent(state, desktopStatus);
	const tooltip = (kind === "app-download" || kind === "app-install") && desktopStatus ? appUpdateTooltip(desktopStatus, kind)
		: kind === "downloading" ? downloadingTooltip(downloadPercent)
		: updateControlTooltip(state, kind, pageVersion);
	const detail = kind === "unavailable" ? unavailableDetail(state) : null;
	const disabled = kind === "checking" || kind === "downloading" || kind === "unavailable" || pending || (kind === "everything" && desktopStatus?.phase === "updating");
	const surface = kind !== "check" && kind !== "checking" && kind !== "unavailable";

	const cancelClose = () => {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		closeTimer.current = null;
	};
	const show = () => { cancelClose(); if (showsNotes) setOpen(true); };
	const hideSoon = () => {
		cancelClose();
		closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
	};

	const onClick = () => {
		if (disabled) return;
		if (kind === "reload") {
			if (hasUnsentMessage()) setConfirmingReload(true);
			else reload();
		} else if (desktop && (kind === "everything" || kind === "app-install")) {
			// The app asks first in its own dialog (electron/update-everything.cjs).
			setPending(true);
			void desktop.install().catch(() => {}).finally(() => setPending(false));
		} else if (desktop && kind === "app-download") void desktop.download().catch(() => {});
		else if (kind === "download") download();
		else if (kind === "install") { setOpen(false); setConfirming(true); }
		else if (kind === "dismiss-notice") dismissNotice();
		else if (kind === "check") {
			if (!reducedMotion) { setLatched(true); setSpinKey((key) => key + 1); }
			setPending(true);
			// A failed check comes back as the "error" state, which shows the refresh button again.
			void Promise.all([check().catch(() => {}), desktop?.check().catch(() => {})]).finally(() => setPending(false));
		}
	};

	const button = (
		<button
			type="button"
			data-testid="update-pill"
			data-action={kind}
			aria-label={detail ? `${tooltip}: ${detail}` : tooltip}
			aria-disabled={disabled || undefined}
			aria-describedby={open ? popoverId : undefined}
			onClick={onClick}
			onPointerEnter={show}
			onPointerLeave={hideSoon}
			onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) show(); }}
			onBlur={hideSoon}
			className={cn(
				"inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
				disabled ? "cursor-not-allowed" : "cursor-pointer",
				surface
					? cn("bg-accent text-foreground", !disabled && "hover:bg-accent/70")
					: cn("text-muted-foreground", !disabled && "hover:bg-accent hover:text-foreground"),
				kind === "unavailable" && "opacity-60",
			)}
		>
			<ControlIcon key={showCheckIcon ? `spin-${spinKey}` : kind} kind={kind} spinning={kind === "checking" && !reducedMotion} onIteration={onIteration} downloadPercent={downloadPercent} />
		</button>
	);

	return (
		<div className="ml-auto shrink-0">
			{showsNotes ? (
				<Popper.Root>
					<Popper.Anchor asChild>{button}</Popper.Anchor>
					{open && createPortal(
						<Popper.Content side="top" align="center" sideOffset={8} collisionPadding={8} className="z-50">
							<div
								id={popoverId}
								role="dialog"
								aria-label="Update release notes"
								data-testid="update-pill-notes"
								onPointerEnter={cancelClose}
								onPointerLeave={hideSoon}
								className="flex max-h-[min(32rem,calc(100vh-6rem))] w-fit max-w-[min(24rem,calc(100vw-2rem))] flex-col rounded-lg border border-border bg-popover p-3 text-left text-pretty text-popover-foreground shadow-lg"
							>
								<div className="shrink-0 px-1 text-sm leading-5 font-medium">{tooltip}</div>
								<div className="min-h-0 overflow-y-auto px-1 pt-3 pb-1">
									<ReleaseNoteSections groups={notes} omittedReleaseCount={state.omittedReleaseCount ?? 0} homepage={HOMEPAGE} />
								</div>
							</div>
						</Popper.Content>,
						document.body,
					)}
				</Popper.Root>
			) : (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>{button}</TooltipTrigger>
						<TooltipContent side="top" data-testid="update-pill-tooltip">
							{detail ? (
								<div className="text-left">
									<div className="font-medium">{tooltip}</div>
									<div className="text-muted-foreground">{detail}</div>
								</div>
							) : tooltip}
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			)}
			<InstallUpdateDialog
				open={confirming && state.status === "downloaded"}
				version={state.version}
				onClose={() => setConfirming(false)}
				onConfirm={() => { setConfirming(false); install(); }}
			/>
			<ReloadConfirmDialog
				open={confirmingReload}
				onClose={() => setConfirmingReload(false)}
				onConfirm={() => { setConfirmingReload(false); reload(); }}
			/>
		</div>
	);
}

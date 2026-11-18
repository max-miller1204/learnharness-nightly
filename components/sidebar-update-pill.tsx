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
 *   downloading    download arrow, disabled
 *   install        "downloaded": the install confirm dialog
 *   dismiss-notice rolled-back notice: dismiss it (per server)
 *   reload         the server runs a newer version than this page: reload
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
 * Seam for "Update everything" (roadmap item 23 PR 2): resolveUpdateControl
 * is the one place that picks the button's state; a later kind slots in there.
 */

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as Popper from "@radix-ui/react-popper";
import { CheckIcon, DownloadIcon, RefreshCwIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import { InstallUpdateDialog } from "@/components/install-update-dialog";
import { ReleaseNoteSections } from "@/components/release-notes-view";
import { APP_VERSION, HOMEPAGE, useUpdateState, type UpdateState } from "@/components/settings/update-settings";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { compareVersions, isExactVersion } from "@/selfhost/src/version-order.ts";

export type UpdateControlKind = "check" | "checking" | "unavailable" | "download" | "downloading" | "install" | "dismiss-notice" | "reload";

/** True when the server runs a newer exact version than the code of this page. */
export function pageIsStale(state: UpdateState | null, pageVersion: string = APP_VERSION): boolean {
	const running = state?.runningVersion;
	if (!running || !isExactVersion(running) || !isExactVersion(pageVersion)) return false;
	return compareVersions(running, pageVersion) > 0;
}

/** The one place that picks the button's state (T3's resolveSidebarUpdatePresentation order). */
export function resolveUpdateControl(state: UpdateState | null, { showCheckIcon = false, pageVersion = APP_VERSION }: { showCheckIcon?: boolean; pageVersion?: string } = {}): UpdateControlKind | null {
	if (!state) return null;
	if (pageIsStale(state, pageVersion)) return "reload";
	if (showCheckIcon) return "checking";
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
export function updateControlTooltip(state: UpdateState, kind: UpdateControlKind): string {
	switch (kind) {
		case "reload": return `Updated to ${state.runningVersion}. Click to reload.`;
		case "checking": return "Checking for updates…";
		case "unavailable": return UNAVAILABLE_TITLE;
		case "download": return state.version ? `Update ${state.version} ready to download` : "Update available ready to download";
		case "downloading": return "Downloading update";
		case "install": return `Update ${state.version ?? "ready"} downloaded. Click to restart and install.`;
		case "dismiss-notice": return state.notice?.text ?? "";
		default: return "Check for updates";
	}
}

/** The second tooltip line of "unavailable" (T3's getDesktopUpdateDisabledReason fallback). */
export const unavailableDetail = (state: UpdateState) => state.message?.trim() || UNAVAILABLE_DETAIL;

/** Any message box on the page holding text that hasn't been sent. */
export function hasUnsentMessage(root: ParentNode = document): boolean {
	return Array.from(root.querySelectorAll('[data-testid="composer"] [role="textbox"]')).some((box) => (box.textContent ?? "").trim().length > 0);
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

/** Pause a running spin while the tab is hidden (T3's observeVisibleAnimation, visibility part). */
function pauseWhileHidden(element: SVGSVGElement | null) {
	if (!element) return;
	const update = () => element.style.setProperty("--lh-spin-state", document.visibilityState === "hidden" ? "paused" : "running");
	update();
	document.addEventListener("visibilitychange", update);
	return () => document.removeEventListener("visibilitychange", update);
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

function ControlIcon({ kind, spinning, onIteration }: { kind: UpdateControlKind; spinning: boolean; onIteration: () => void }) {
	if (kind === "download") {
		return (
			<span className="relative grid size-4 place-items-center">
				<DownloadIcon className="size-4" aria-hidden />
				<span aria-hidden className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-current ring-2 ring-accent" />
			</span>
		);
	}
	if (kind === "downloading") return <DownloadIcon className="size-4" aria-hidden />;
	if (kind === "install" || kind === "reload") return <RestartIcon />;
	if (kind === "dismiss-notice") return <TriangleAlertIcon className="size-3.5 text-destructive" aria-hidden />;
	return (
		<RefreshCwIcon
			aria-hidden
			data-testid="update-control-refresh-icon"
			data-spinning={spinning || undefined}
			ref={spinning ? pauseWhileHidden : undefined}
			onAnimationIteration={onIteration}
			className={cn("size-4", spinning && "motion-safe:animate-spin [animation-play-state:var(--lh-spin-state,running)]")}
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
	const reducedMotion = useReducedMotion();
	const [confirming, setConfirming] = useState(false);
	const [confirmingReload, setConfirmingReload] = useState(false);
	const [pending, setPending] = useState(false);
	const [open, setOpen] = useState(false);
	const [spinKey, setSpinKey] = useState(0);
	const isChecking = state?.status === "checking";
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
	const kind = resolveUpdateControl(state, { showCheckIcon, pageVersion });
	const notes = state?.releaseNotes ?? [];
	const showsNotes = (kind === "download" || kind === "install") && notes.length > 0;
	useEffect(() => { if (!showsNotes) setOpen(false); }, [showsNotes]);
	const onIteration = useCallback(() => setLatched(continuesCheckSpin(isChecking, reducedMotion)), [isChecking, reducedMotion]);

	if (!state || !kind) return null;
	const tooltip = updateControlTooltip(state, kind);
	const detail = kind === "unavailable" ? unavailableDetail(state) : null;
	const disabled = kind === "checking" || kind === "downloading" || kind === "unavailable" || pending;
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
		} else if (kind === "download") download();
		else if (kind === "install") { setOpen(false); setConfirming(true); }
		else if (kind === "dismiss-notice") dismissNotice();
		else if (kind === "check") {
			if (!reducedMotion) { setLatched(true); setSpinKey((key) => key + 1); }
			setPending(true);
			// A failed check comes back as the "error" state, which shows the refresh button again.
			void check().catch(() => {}).finally(() => setPending(false));
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
			<ControlIcon key={showCheckIcon ? `spin-${spinKey}` : kind} kind={kind} spinning={kind === "checking" && !reducedMotion} onIteration={onIteration} />
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

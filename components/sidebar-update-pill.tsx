"use client";

/**
 * The sidebar update pill (docs/specs/t3-style-updates.md, section 5): a
 * round icon button at the right end of the sidebar's Settings row, shown
 * only when there is something to act on, and staying until acted on.
 * Hovering shows the release notes (when there are any); clicking acts:
 *
 *   desktop "available"   download it
 *   "downloading"         nothing (disabled)
 *   "downloaded"          the install confirm dialog
 *   rolled-back notice    dismiss it (per server)
 *
 * Adapted from T3 Code's SidebarUpdatePill
 * (apps/web/src/components/sidebar/SidebarUpdatePill.tsx): the
 * hover-to-open release notes popover with a 150 ms close delay, and the
 * tooltip wording. MIT License, Copyright (c) 2026 T3 Tools Inc. (full
 * notice in components/release-notes-view.tsx).
 */

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Popper from "@radix-ui/react-popper";
import { ArrowDownToLineIcon, CircleArrowUpIcon, TriangleAlertIcon } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { InstallUpdateDialog } from "@/components/install-update-dialog";
import { ReleaseNoteSections } from "@/components/release-notes-view";
import { HOMEPAGE, useUpdateState, type UpdateState } from "@/components/settings/update-settings";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";

export type PillAction = "download" | "downloading" | "install" | "dismiss-notice" | null;

export function pillAction(state: UpdateState | null): PillAction {
	if (!state) return null;
	if (state.status === "downloaded") return "install";
	if (state.status === "available") return "download";
	if (state.status === "downloading") return "downloading";
	if (state.notice?.kind === "rolled-back") return "dismiss-notice";
	return null;
}

/** The tooltip, and the popover's title line (T3's wording). */
export function pillTooltip(state: UpdateState, action: PillAction): string {
	switch (action) {
		case "download": return "Update ready to download";
		case "downloading": return "Downloading update";
		case "install": return `Update ${state.version ?? "ready"} downloaded. Click to restart and install.`;
		case "dismiss-notice": return state.notice?.text ?? "";
		default: return "";
	}
}

const CLOSE_DELAY_MS = 150;

export function SidebarUpdatePill() {
	const { state, install, download, dismissNotice } = useUpdateState();
	const [confirming, setConfirming] = useState(false);
	const [open, setOpen] = useState(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const popoverId = useId();
	useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

	const action = pillAction(state);
	const notes = state?.releaseNotes ?? [];
	const showsNotes = (action === "download" || action === "install") && notes.length > 0;
	useEffect(() => { if (!showsNotes) setOpen(false); }, [showsNotes]);

	if (!state || !action) return null;
	const tooltip = pillTooltip(state, action);

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
		if (action === "download") download();
		else if (action === "install") { setOpen(false); setConfirming(true); }
		else if (action === "dismiss-notice") dismissNotice();
	};

	const icon = action === "downloading" ? <BrailleSpinner label="Downloading update" />
		: action === "download" ? <ArrowDownToLineIcon className="size-3.5" aria-hidden />
		: action === "install" ? <CircleArrowUpIcon className="size-3.5" aria-hidden />
		: <TriangleAlertIcon className="size-3.5 text-destructive" aria-hidden />;

	const button = (
		<button
			type="button"
			data-testid="update-pill"
			data-action={action}
			aria-label={tooltip}
			aria-disabled={action === "downloading" || undefined}
			aria-describedby={open ? popoverId : undefined}
			onClick={action === "downloading" ? undefined : onClick}
			onPointerEnter={show}
			onPointerLeave={hideSoon}
			onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) show(); }}
			onBlur={hideSoon}
			className={cn(
				"inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-foreground outline-hidden ring-ring transition-colors focus-visible:ring-2",
				action === "downloading" ? "cursor-not-allowed opacity-80" : "cursor-pointer hover:bg-accent/70",
			)}
		>
			{icon}
		</button>
	);

	return (
		<>
			{showsNotes ? (
				<Popper.Root>
					<Popper.Anchor asChild>{button}</Popper.Anchor>
					{open && createPortal(
						<Popper.Content
							side="top"
							align="center"
							sideOffset={8}
							collisionPadding={8}
							className="z-50"
						>
							<div
								id={popoverId}
								role="dialog"
								aria-label="Update release notes"
								data-testid="update-pill-notes"
								onPointerEnter={cancelClose}
								onPointerLeave={hideSoon}
								className="flex max-h-[min(32rem,calc(100vh-6rem))] w-fit max-w-[min(24rem,calc(100vw-2rem))] flex-col rounded-lg border border-border bg-popover p-3 text-left text-pretty text-popover-foreground shadow-lg"
							>
								<div className="shrink-0 px-1 text-sm leading-5 font-medium">{action === "download" ? "Update ready to download" : tooltip}</div>
								{action === "download" && state.version && <div className="mt-0.5 px-1 text-xs leading-4 text-muted-foreground">{state.version}</div>}
								<div className="min-h-0 overflow-y-auto px-1 pt-3 pb-1">
									<ReleaseNoteSections groups={notes} omittedReleaseCount={state.omittedReleaseCount ?? 0} homepage={HOMEPAGE} />
								</div>
							</div>
						</Popper.Content>,
						document.body,
					)}
				</Popper.Root>
			) : (
				<Hint label={tooltip} side="top">{button}</Hint>
			)}
			<InstallUpdateDialog
				open={confirming && state.status === "downloaded"}
				version={state.version}
				onClose={() => setConfirming(false)}
				onConfirm={() => { setConfirming(false); install(); }}
			/>
		</>
	);
}

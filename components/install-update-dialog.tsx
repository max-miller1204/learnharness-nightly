"use client";

/**
 * The install confirm dialog (docs/specs/t3-style-updates.md, section 5 and
 * revision PR 3): T3 Code's text and nothing more (owner, 2026-11-20).
 * Wording from T3 Code's getDesktopUpdateInstallConfirmationMessage
 * (apps/web/src/components/desktopUpdate.logic.ts:180-197 at df09ced7, MIT,
 * Copyright (c) 2026 T3 Tools Inc.). Opened by the sidebar update control
 * and Settings > Install, on both transports.
 */

import { useRef, type RefObject } from "react";
import { HostDialog } from "@/components/host-dialog";

export const installUpdateTitle = (version: string | null) =>
	`Install update${version ? ` ${version}` : ""} and restart LearnHarness?`;
export const INSTALL_UPDATE_LINE = "Any running tasks will be interrupted. Make sure you're ready before continuing.";

/** The pure body, exported for render pins. */
export function InstallUpdateBody({ version, onClose, onConfirm, confirmRef }: {
	version: string | null;
	onClose: () => void;
	onConfirm: () => void;
	confirmRef?: RefObject<HTMLButtonElement | null>;
}) {
	return (
		<>
			<h2 className="text-sm font-semibold text-card-foreground" data-testid="install-update-title">{installUpdateTitle(version)}</h2>
			<p className="mt-1.5 text-xs text-muted-foreground" data-testid="install-update-line">{INSTALL_UPDATE_LINE}</p>
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="install-update-cancel"
					onClick={onClose}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					Cancel
				</button>
				<button
					type="button"
					ref={confirmRef}
					data-testid="install-update-confirm"
					onClick={onConfirm}
					className="rounded-sm bg-accent px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/80"
				>
					Install and restart
				</button>
			</div>
		</>
	);
}

export function InstallUpdateDialog({ open, version, onClose, onConfirm }: {
	open: boolean;
	version: string | null;
	onClose: () => void;
	onConfirm: () => void;
}) {
	const confirmRef = useRef<HTMLButtonElement>(null);
	const title = installUpdateTitle(version);
	return (
		<HostDialog
			open={open}
			aria-label={title}
			initialFocusRef={confirmRef}
			onClose={() => { onClose(); return "closed"; }}
			backdropProps={{ className: "fixed inset-0 z-[60] flex items-center justify-center bg-background/80 backdrop-blur-sm", "data-testid": "install-update-dialog" }}
			frame={<div className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg" onClick={(event) => event.stopPropagation()} />}
		>
			<InstallUpdateBody version={version} onClose={onClose} onConfirm={onConfirm} confirmRef={confirmRef} />
		</HostDialog>
	);
}

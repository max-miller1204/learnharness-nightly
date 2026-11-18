"use client";

/**
 * The install confirm dialog (docs/specs/t3-style-updates.md, section 5).
 * Wording from T3 Code's getDesktopUpdateInstallConfirmationMessage
 * (apps/web/src/components/desktopUpdate.logic.ts, MIT, Copyright (c) 2026 T3
 * Tools Inc.), plus the list of running work that the restart interrupts,
 * read from GET /api/updates/running when the dialog opens. Opened by the
 * sidebar update pill and Settings > Install, on both transports.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { HostDialog } from "@/components/host-dialog";

export type RunningWorkItem = {
	kind: "turn" | "compaction" | "job" | "plugin-worker" | "extraction";
	title: string;
};

const KIND_LABEL: Record<RunningWorkItem["kind"], string> = {
	turn: "Chat turn",
	compaction: "Compaction",
	job: "Background job",
	"plugin-worker": "Plugin worker",
	extraction: "Extraction",
};

export const installUpdateTitle = (version: string | null) =>
	`Install update${version ? ` ${version}` : ""} and restart LearnHarness?`;
export const INSTALL_UPDATE_LINE = "Any running tasks will be interrupted. Make sure you're ready before continuing.";

export const runningWorkLine = (item: RunningWorkItem) => `${KIND_LABEL[item.kind] ?? "Task"}: ${item.title}`;

function parseRunning(body: unknown): RunningWorkItem[] {
	const items = typeof body === "object" && body !== null ? (body as { items?: unknown }).items : undefined;
	if (!Array.isArray(items)) return [];
	return items.filter((item): item is RunningWorkItem =>
		typeof item === "object" && item !== null && typeof (item as RunningWorkItem).kind === "string" && typeof (item as RunningWorkItem).title === "string");
}

/** The pure body, exported for render pins. */
export function InstallUpdateBody({ version, running, onClose, onConfirm, confirmRef }: {
	version: string | null;
	running: RunningWorkItem[];
	onClose: () => void;
	onConfirm: () => void;
	confirmRef?: RefObject<HTMLButtonElement | null>;
}) {
	return (
		<>
			<h2 className="text-sm font-semibold text-card-foreground" data-testid="install-update-title">{installUpdateTitle(version)}</h2>
			<p className="mt-1.5 text-xs text-muted-foreground" data-testid="install-update-line">{INSTALL_UPDATE_LINE}</p>
			{running.length > 0 && (
				<div className="mt-3 text-xs" data-testid="install-update-running">
					<p className="text-card-foreground">Running now:</p>
					<ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-4 text-muted-foreground">
						{running.map((item, index) => <li key={`${item.kind}:${item.title}:${index}`} className="break-words">{runningWorkLine(item)}</li>)}
					</ul>
				</div>
			)}
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
	const [running, setRunning] = useState<RunningWorkItem[]>([]);
	const confirmRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open) { setRunning([]); return; }
		let live = true;
		void fetch("/api/updates/running", { cache: "no-store" })
			.then((response) => (response.ok ? response.json() : null))
			.then((body: unknown) => { if (live) setRunning(parseRunning(body)); })
			.catch(() => { /* the line above still warns */ });
		return () => { live = false; };
	}, [open]);
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
			<InstallUpdateBody version={version} running={running} onClose={onClose} onConfirm={onConfirm} confirmRef={confirmRef} />
		</HostDialog>
	);
}

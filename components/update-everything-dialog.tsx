"use client";

/**
 * The Update everything dialog in the desktop app's window onto a self-hosted
 * server (docs/specs/t3-style-updates.md, revision PR 7).
 *
 * Ported from T3 Code's apps/web/src/components/sidebar/UpdateEverythingDialog.tsx
 * at df09ced7 (MIT, Copyright (c) 2026 T3 Tools Inc.): the "Update N machines?"
 * title (:136-140), the version line (:142-158), the Machine, LearnHarness and
 * Providers table (:168-223), the skipped list (:224-245), the running-work line
 * (:249-273) and Cancel focused first (:79-82, :274-279). Differences:
 * - "This app" is the table's last row, as the owner decided
 *   (docs/specs/desktop-server-list.md); T3 lists this app's machines first
 *   (updateEverything.logic.ts:891-898). It keeps T3's "restarts last" line.
 * - Main plans the rows (electron/update-everything.cjs plan()), so the counts
 *   come with them; LearnHarness has no provider updates, so that column is empty.
 * - An app-only update shows no running work: an app restart doesn't stop the
 *   server's (owner, revision PR 3: no "Running now:" list there).
 */

import { useRef, useState, type RefObject } from "react";
import { ChevronRightIcon } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import type { UpdateEverythingPlan } from "@/components/update-everything-logic";
import { cn } from "@/lib/utils";

const tasks = (count: number) => `${count} running ${count === 1 ? "task" : "tasks"}`;

export const updateEverythingTitle = (plan: UpdateEverythingPlan) => {
	const count = plan.rows.length;
	return `Update ${count} ${count === 1 ? "machine" : "machines"}?`;
};

/** The footer's line about work the update stops (T3's :253-272). */
export const runningWorkLine = (running: number) => (running > 0 ? `${tasks(running)} will be interrupted.` : null);

/** The pure body, exported for render pins. */
export function UpdateEverythingBody({ plan, busy = false, onClose, onConfirm, cancelRef }: {
	plan: UpdateEverythingPlan;
	busy?: boolean;
	onClose: () => void;
	onConfirm: () => void;
	cancelRef?: RefObject<HTMLButtonElement | null>;
}) {
	const [skippedOpen, setSkippedOpen] = useState(false);
	const warning = plan.disabledReason ?? runningWorkLine(plan.running);
	return (
		<>
			<h2 className="text-sm font-semibold text-card-foreground" data-testid="update-everything-title">{updateEverythingTitle(plan)}</h2>
			<p className="mt-1 text-xs text-muted-foreground" data-testid="update-everything-version">
				LearnHarness <span className="font-mono">{plan.version}</span>
			</p>
			{/* Machine names truncate first. */}
			<div role="table" aria-label="Machines to update" data-testid="update-everything-table" className="mt-3 grid grid-cols-[minmax(4rem,max-content)_max-content_minmax(min-content,1fr)_max-content] gap-x-4 text-xs">
				<div role="row" className="col-span-full grid grid-cols-subgrid border-b border-border pb-1.5 text-muted-foreground">
					<span role="columnheader">Machine</span>
					<span role="columnheader">LearnHarness</span>
					<span role="columnheader">Providers</span>
					<span role="columnheader"><span className="sr-only">Running</span></span>
				</div>
				{plan.rows.map((row) => (
					<div key={`${row.app}:${row.label}`} role="row" data-testid={`update-everything-row-${row.app}`} className="col-span-full grid grid-cols-subgrid border-b border-border/50 py-1.5 last:border-b-0">
						<span role="cell" className="min-w-0 max-w-32 truncate" title={row.label}>{row.label}</span>
						<span role="cell">
							{row.app === "this-app" ? "This app" : "Server"}
							{row.app === "this-app" ? <span className="block text-muted-foreground">restarts last</span> : null}
						</span>
						<span role="cell" />
						<span role="cell" className="text-right">
							{row.running > 0 ? <span className="whitespace-nowrap text-amber-600 dark:text-amber-400">{row.running} running</span> : null}
						</span>
					</div>
				))}
			</div>
			{plan.skipped.length > 0 ? (
				<div className="mt-3">
					<button
						type="button"
						aria-expanded={skippedOpen}
						data-testid="update-everything-skipped-toggle"
						onClick={() => setSkippedOpen((open) => !open)}
						className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
					>
						<ChevronRightIcon className={cn("size-3.5 transition-transform", skippedOpen && "rotate-90")} aria-hidden />
						{plan.skipped.length} skipped
					</button>
					{skippedOpen ? (
						<div data-testid="update-everything-skipped" className="grid grid-cols-[minmax(0,max-content)_1fr] gap-x-3 gap-y-0.5 pt-1.5 ps-4.5 text-xs text-muted-foreground">
							{plan.skipped.map((row) => (
								<div key={row.label} className="contents">
									<span className="min-w-0 max-w-32 truncate">{row.label}</span>
									<span className="wrap-anywhere">{row.reason}</span>
								</div>
							))}
						</div>
					) : null}
				</div>
			) : null}
			<div className="mt-4 flex flex-wrap items-center justify-end gap-2">
				{warning ? <p data-testid="update-everything-warning" className={cn("mr-auto text-xs", plan.disabledReason ? "text-foreground" : "text-muted-foreground")}>{warning}</p> : null}
				<button
					type="button"
					ref={cancelRef}
					data-testid="update-everything-cancel"
					disabled={busy}
					onClick={onClose}
					className="rounded-sm border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="update-everything-confirm"
					disabled={busy || plan.disabledReason !== null}
					onClick={onConfirm}
					className="rounded-sm bg-accent px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/80 disabled:opacity-50"
				>
					Update
				</button>
			</div>
		</>
	);
}

export function UpdateEverythingDialog({ plan, busy, onClose, onConfirm }: {
	plan: UpdateEverythingPlan | null;
	busy?: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	return (
		<HostDialog
			open={plan !== null}
			aria-label={plan ? updateEverythingTitle(plan) : "Update everything"}
			initialFocusRef={cancelRef}
			onClose={() => { if (!busy) onClose(); return busy ? "blocked" : "closed"; }}
			backdropProps={{ className: "fixed inset-0 z-[60] flex items-center justify-center bg-background/80 backdrop-blur-sm", "data-testid": "update-everything-dialog" }}
			frame={<div className="mx-4 w-full max-w-xl rounded-xl border bg-card p-5 shadow-lg" onClick={(event) => event.stopPropagation()} />}
		>
			{plan ? <UpdateEverythingBody plan={plan} busy={busy} onClose={onClose} onConfirm={onConfirm} cancelRef={cancelRef} /> : null}
		</HostDialog>
	);
}

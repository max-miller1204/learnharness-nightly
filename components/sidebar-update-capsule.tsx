"use client";

/**
 * The sidebar's Update everything capsule in the desktop app's window onto a
 * self-hosted server (docs/specs/t3-style-updates.md, revision PR 7): while
 * main runs Update everything, it stands where the update control was.
 *
 * Ported from T3 Code's apps/web/src/components/sidebar/SidebarUpdateCapsule.tsx
 * at df09ced7 (MIT, Copyright (c) 2026 T3 Tools Inc.): the label and its action
 * (:96-148: Later, Retry or Dismiss), the countdown seconds in place of the icon
 * (:139-148) and the popover listing this app and each machine (:150-205), with
 * its view from components/update-everything-logic.ts. The run itself is main's
 * (electron/update-everything.cjs); the actions go back through
 * window.lh.desktopUpdate. LearnHarness has no Popover primitive, so the details
 * open from the capsule as a disclosure anchored with Radix's Popper (as the
 * update control's notes are), and close on Escape (one Esc, one action) or a
 * pointer press outside.
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as Popper from "@radix-ui/react-popper";
import { useOptionalInteractionLayers } from "@/components/interaction-layers";
import { hasLegacyInteractionForeground } from "@/components/plugin-input-focus";
import {
	describeUpdateCapsule, formatUpdateElapsed, localStatusLabel, restartSecondsLeft, RUN_STATUS_LABELS,
	type UpdateEverythingRun, type UpdateRunLocalState,
} from "@/components/update-everything-logic";
import { cn } from "@/lib/utils";

/** T3's useNow (SidebarUpdateCapsule.tsx:27-35): a clock that ticks only while something counts. */
function useNow(intervalMs: number | null, clock: () => number): number {
	const step = intervalMs ?? 60_000;
	const subscribe = (onChange: () => void) => {
		if (intervalMs === null) return () => {};
		const timer = setInterval(onChange, intervalMs);
		return () => clearInterval(timer);
	};
	return useSyncExternalStore(subscribe, () => Math.floor(clock() / step) * step, () => Math.floor(clock() / step) * step);
}

export type CapsuleActions = { later: () => void; retry: () => void; dismiss: () => void };

export function SidebarUpdateCapsule({ run, local, icon, actions, clock = Date.now }: {
	run: UpdateEverythingRun;
	local: UpdateRunLocalState;
	icon: ReactNode;
	actions: CapsuleActions;
	/** For tests: the time the capsule counts against. */
	clock?: () => number;
}) {
	const machines = run.machines;
	const hasActiveMachine = machines.some(({ status }) => status !== "done" && status !== "failed" && status !== "waiting");
	const now = useNow(run.phase === "countdown" ? 1_000 : hasActiveMachine ? 30_000 : null, clock);
	const view = describeUpdateCapsule(run, local, now);
	const failed = machines.some(({ status }) => status === "failed");
	const settled = !hasActiveMachine && run.localVersion === null;
	const restartSeconds = restartSecondsLeft(run, now);
	const [open, setOpen] = useState(false);
	// Opened from the keyboard: focus goes into the details, onto their first button.
	const [focusDetails, setFocusDetails] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const popoverId = useId();

	const actionLabel = view.action === "later" ? "Later" : view.action === "retry" ? "Retry" : "Dismiss";
	const runAction = () => {
		if (view.action === "later") actions.later();
		else if (view.action === "retry") actions.retry();
		else actions.dismiss();
	};
	const label = view.slow ? `${view.label} ${view.slow.status} ${view.slow.elapsed}` : view.label;

	// One Esc, one action: the details close and nothing else sees it (the pill's notes do the same).
	const layers = useOptionalInteractionLayers();
	useEffect(() => {
		if (!open) return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing) return;
			const inside = !!popoverRef.current?.contains(document.activeElement) || document.activeElement === buttonRef.current;
			if (!inside && (layers ? layers.isEscapeOwned(event) : hasLegacyInteractionForeground(document))) return;
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			buttonRef.current?.focus({ preventScroll: true });
		};
		const onPointer = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (popoverRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
			setOpen(false);
		};
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("pointerdown", onPointer, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("pointerdown", onPointer, true);
		};
	}, [open, layers]);

	useEffect(() => {
		if (!open || !focusDetails) return;
		setFocusDetails(false);
		popoverRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
	}, [open, focusDetails]);
	// The app has no native Tab: within the details, Tab and Shift+Tab move between their
	// buttons, and past either end focus goes back to the capsule, which closes them.
	const onDetailsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Tab") return;
		const inside = [...(popoverRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
		const at = inside.indexOf(document.activeElement as HTMLButtonElement);
		event.preventDefault();
		event.stopPropagation();
		const next = at + (event.shiftKey ? -1 : 1);
		if (at < 0 || next < 0 || next >= inside.length) {
			setOpen(false);
			buttonRef.current?.focus({ preventScroll: true });
		} else inside[next]?.focus();
	};

	return (
		<Popper.Root>
			<Popper.Anchor asChild>
				<div
					data-testid="update-capsule"
					data-tone={view.tone}
					className={cn(
						"relative ml-auto flex h-8 min-w-8 max-w-48 shrink-0 items-center rounded-full bg-accent text-foreground",
						view.tone === "slow" && "ring-1 ring-inset ring-amber-500/40",
						view.tone === "failed" && "ring-1 ring-inset ring-destructive/40",
					)}
				>
					<button
						ref={buttonRef}
						type="button"
						data-testid="update-capsule-button"
						aria-label={label}
						aria-expanded={open}
						aria-controls={open ? popoverId : undefined}
						onClick={() => setOpen((value) => !value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter" && event.key !== " ") return;
							event.preventDefault();
							if (!open) setFocusDetails(true);
							setOpen((value) => !value);
						}}
						className="absolute inset-0 cursor-pointer rounded-full outline-hidden ring-ring hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-inset"
					/>
					<span data-testid="update-capsule-label" className="pointer-events-none relative min-w-0 flex-1 truncate pl-3 text-xs">
						<span className={cn(view.tone === "failed" && "text-destructive")}>{view.label}</span>
						{view.slow ? <span className="tabular-nums text-amber-600 dark:text-amber-400"> {view.slow.elapsed}</span> : null}
					</span>
					{view.action !== null ? (
						<button
							type="button"
							data-testid="update-capsule-action"
							onClick={runAction}
							className="relative shrink-0 cursor-pointer pl-1.5 pr-3 text-xs underline decoration-muted-foreground/60 underline-offset-3 outline-hidden hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring"
						>
							{actionLabel}
						</button>
					) : (
						<span
							className={cn(
								"pointer-events-none relative grid size-8 shrink-0 place-items-center",
								restartSeconds !== null && "rounded-full text-xs font-medium tabular-nums ring-1 ring-inset ring-current/20",
							)}
						>
							{restartSeconds !== null ? `${restartSeconds}s` : icon}
						</span>
					)}
				</div>
			</Popper.Anchor>
			{open && typeof document !== "undefined" ? createPortal(
				<Popper.Content side="top" align="end" sideOffset={8} collisionPadding={8} className="z-50">
					<div
						ref={popoverRef}
						id={popoverId}
						role="group"
						aria-label="Update everything"
						data-testid="update-capsule-details"
						onKeyDown={onDetailsKeyDown}
						className="flex w-64 flex-col gap-1 rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg"
					>
						{run.localVersion !== null ? (
							<div className="flex items-center justify-between gap-3">
								<span>This app</span>
								<span className="tabular-nums text-muted-foreground">{localStatusLabel(run, local, now)}</span>
							</div>
						) : null}
						{machines.map((machine) => (
							<div key={machine.label} className="flex min-w-0 flex-col" data-testid="update-capsule-machine">
								<div className="flex items-center justify-between gap-3">
									<span className="truncate">{machine.label}</span>
									<span className={cn("shrink-0 tabular-nums", machine.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
										{RUN_STATUS_LABELS[machine.status]}
										{machine.status !== "done" && machine.status !== "failed" && machine.status !== "waiting" ? ` ${formatUpdateElapsed(now - machine.startedAt)}` : ""}
									</span>
								</div>
								{machine.failure !== null ? <span className="break-words text-muted-foreground">{machine.failure}</span> : null}
							</div>
						))}
						{view.action !== null ? (
							<div className="mt-1 flex justify-end gap-1">
								<button type="button" data-testid="update-capsule-details-action" onClick={runAction} className="rounded-sm border border-border px-2 py-1 text-xs hover:bg-accent">
									{actionLabel}
								</button>
								{settled && failed && view.action !== "dismiss" ? (
									<button type="button" data-testid="update-capsule-dismiss" onClick={() => { setOpen(false); actions.dismiss(); }} className="rounded-sm px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
										Dismiss
									</button>
								) : null}
							</div>
						) : null}
					</div>
				</Popper.Content>,
				document.body,
			) : null}
		</Popper.Root>
	);
}

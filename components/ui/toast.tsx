"use client";

/**
 * Toasts (docs/specs/t3-style-updates.md, revision PR 4), modelled on T3
 * Code's apps/web/src/components/ui/toast.tsx at df09ced7, which wraps Base
 * UI's Toast: a module-level manager that keeps toasts added before any
 * viewport mounts (createBufferedToastManager, :74-108), a "Notifications"
 * region at the top right (:596-610), success, error and info types with
 * their icons (:110-116), a 5 s timeout paused while the pointer or focus is
 * on the toasts, at most 3 at a time, and Base UI's F6 to reach them.
 *
 * Built here, not on a toast library: LearnHarness has no native Tab
 * (components/interaction-layers.tsx prevents it; Tab cycles text fields),
 * so the region moves focus itself and keeps its keys from the app's
 * shortcuts. From the keyboard: F6 focuses the newest toast; Tab and
 * Shift+Tab move through the toasts and their buttons; Escape dismisses the
 * focused toast; leaving the region (Tab past the end, or the last toast
 * gone) returns focus to where it was before F6. Each toast is announced as
 * it appears: errors as an alert, the others as a status.
 *
 * T3 Code is MIT licensed, Copyright (c) 2026 T3 Tools Inc. (the full notice
 * is in components/release-notes-view.tsx).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastType = "success" | "error" | "info";

export type ToastOptions = {
	type?: ToastType;
	title: string;
	description?: ReactNode;
	/** How long it stays, in ms (T3's default 5 s). */
	timeout?: number;
};

export type ToastRecord = ToastOptions & { id: number; type: ToastType };

export const TOAST_TIMEOUT_MS = 5_000;
export const TOAST_LIMIT = 3;

const ICONS = { success: CircleCheckIcon, error: CircleAlertIcon, info: InfoIcon } as const;

// The manager outlives every viewport: a toast raised before one mounts waits in the list.
let toasts: readonly ToastRecord[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };
const EMPTY: readonly ToastRecord[] = [];

export const toastManager = {
	/** Shows a toast; the oldest goes past TOAST_LIMIT. Returns its id. */
	add(options: ToastOptions): number {
		const id = nextId++;
		toasts = [...toasts, { ...options, type: options.type ?? "info", id }].slice(-TOAST_LIMIT);
		emit();
		return id;
	},
	close(id: number): void {
		if (!toasts.some((toast) => toast.id === id)) return;
		toasts = toasts.filter((toast) => toast.id !== id);
		emit();
	},
	/** Tests: an empty list. */
	clear(): void {
		toasts = [];
		emit();
	},
	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => { listeners.delete(listener); };
	},
	getSnapshot: (): readonly ToastRecord[] => toasts,
};

const TABBABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The toast and then its links and buttons, in order: what Tab moves through. */
function stops(region: HTMLElement | null): HTMLElement[] {
	if (!region) return [];
	return Array.from(region.querySelectorAll<HTMLElement>("[data-toast-item]")).flatMap((item) => [
		item,
		...Array.from(item.querySelectorAll<HTMLElement>(TABBABLE)).filter((element) => element.getAttribute("tabindex") !== "-1"),
	]);
}

function ToastItem({ toast, paused }: { toast: ToastRecord; paused: boolean }) {
	const remaining = useRef(toast.timeout ?? TOAST_TIMEOUT_MS);
	useEffect(() => {
		if (paused) return;
		const started = Date.now();
		const timer = setTimeout(() => toastManager.close(toast.id), remaining.current);
		return () => {
			clearTimeout(timer);
			remaining.current = Math.max(0, remaining.current - (Date.now() - started));
		};
	}, [paused, toast.id]);
	const Icon = ICONS[toast.type];
	return (
		<li
			data-toast-item
			data-toast-id={toast.id}
			data-testid="toast"
			data-type={toast.type}
			tabIndex={-1}
			// Announced as it appears: an error interrupts, the others wait their turn.
			role={toast.type === "error" ? "alert" : "status"}
			aria-atomic="true"
			className="pointer-events-auto flex items-start gap-2 rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg outline-hidden ring-ring focus-visible:ring-2"
		>
			<Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", toast.type === "error" ? "text-destructive" : toast.type === "success" ? "text-success" : "text-muted-foreground")} />
			<div className="min-w-0 flex-1">
				<div className="font-medium break-words" data-testid="toast-title">{toast.title}</div>
				{toast.description ? <div className="mt-0.5 text-xs break-words text-muted-foreground" data-testid="toast-description">{toast.description}</div> : null}
			</div>
			<button
				type="button"
				data-testid="toast-close"
				aria-label="Dismiss notification"
				onClick={() => toastManager.close(toast.id)}
				className="-m-1 shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
			>
				<XIcon aria-hidden className="size-3.5" />
			</button>
		</li>
	);
}

/** The region, mounted once in the app shell. */
export function Toaster() {
	const items = useSyncExternalStore(toastManager.subscribe, toastManager.getSnapshot, () => EMPTY);
	const region = useRef<HTMLOListElement>(null);
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	// Where focus was before F6, to go back to when the toasts are left or gone.
	const returnTo = useRef<HTMLElement | null>(null);

	const leave = useCallback(() => {
		const target = returnTo.current;
		returnTo.current = null;
		if (target?.isConnected) target.focus({ preventScroll: true });
		else (document.activeElement as HTMLElement | null)?.blur?.();
	}, []);

	// F6 reaches the newest toast (Base UI's Toast.Viewport hotkey).
	useEffect(() => {
		if (items.length === 0) return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "F6" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
			const newest = region.current?.querySelector<HTMLElement>("[data-toast-item]:last-child");
			if (!newest) return;
			event.preventDefault();
			event.stopPropagation();
			const active = document.activeElement as HTMLElement | null;
			if (!region.current?.contains(active)) returnTo.current = active;
			newest.focus({ preventScroll: true });
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [items.length]);

	// The focused toast went away (dismissed or timed out): back to where focus was, unless another remains.
	useEffect(() => {
		if (!focused) return;
		const active = document.activeElement;
		if (active && region.current?.contains(active)) return;
		const first = stops(region.current)[0];
		if (first) first.focus({ preventScroll: true });
		else { setFocused(false); leave(); }
	}, [items, focused, leave]);

	const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === "Escape") {
			const item = (event.target as HTMLElement).closest<HTMLElement>("[data-toast-item]");
			const id = items.find((toast) => item?.dataset.toastId === String(toast.id))?.id;
			event.preventDefault();
			event.stopPropagation();
			if (id !== undefined) toastManager.close(id);
			return;
		}
		if (event.key !== "Tab") return;
		event.preventDefault();
		event.stopPropagation();
		const all = stops(region.current);
		const at = all.indexOf(event.target as HTMLElement);
		const next = event.shiftKey ? all[at - 1] : all[at + 1];
		if (next) next.focus({ preventScroll: true });
		else leave();
	};

	return (
		<section aria-label="Notifications" data-testid="toast-viewport" className="pointer-events-none fixed top-4 right-4 z-[100] w-[calc(100%-2rem)] max-w-90">
			<ol
				ref={region}
				className="flex flex-col gap-2"
				onKeyDown={onKeyDown}
				onPointerEnter={() => setHovered(true)}
				onPointerLeave={() => setHovered(false)}
				onFocus={() => setFocused(true)}
				onBlur={(event) => { if (!region.current?.contains(event.relatedTarget as Node | null)) setFocused(false); }}
			>
				{items.map((toast) => (
					<ToastItem key={toast.id} toast={toast} paused={hovered || focused} />
				))}
			</ol>
		</section>
	);
}

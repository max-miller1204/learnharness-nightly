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
 * gone) returns focus to where it was before F6, or to the composer or the
 * page when that place is gone or hidden. A toast dismissed with the mouse
 * leaves focus alone. Each toast is announced as it appears: its text goes
 * into an always-present live region, assertive for errors and polite for
 * the others. On Windows and Linux the region keeps clear of the window's
 * own buttons (`.lh-toast-region`, app/globals.css), and it is never a
 * window drag band (`.lh-no-drag`). While a modal dialog is open the region
 * moves into the dialog's own popup host, so the dialog neither hides it
 * from screen readers nor traps F6 away from it.
 *
 * T3 Code is MIT licensed, Copyright (c) 2026 T3 Tools Inc. (the full notice
 * is in components/release-notes-view.tsx).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOptionalInteractionLayers } from "@/components/interaction-layers";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastType = "success" | "error" | "info";

export type ToastOptions = {
	type?: ToastType;
	title: string;
	description?: ReactNode;
	/** How long it stays, in ms (T3's default 5 s). */
	timeout?: number;
	/** What a screen reader says; the title and a text description by default. */
	announce?: string;
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
const noSubscribe = () => () => {};
const NO_LAYERS: readonly unknown[] = [];
const noLayers = () => NO_LAYERS;

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
			aria-label={announcement(toast)}
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

const announcement = (toast: ToastRecord) =>
	toast.announce ?? (typeof toast.description === "string" ? `${toast.title}. ${toast.description}` : toast.title);

const visible = (element: HTMLElement) =>
	element.isConnected && !element.closest("[hidden], [inert]") && (typeof element.checkVisibility !== "function" || element.checkVisibility());

/** Where focus goes when the toasts are left and the place before F6 is gone or hidden. */
function fallbackFocus(): HTMLElement | null {
	const composer = document.querySelector<HTMLElement>('[role="textbox"][contenteditable="true"], [role="textbox"][contenteditable=""]');
	return composer && visible(composer) ? composer : null;
}

/** The region, mounted once in the app shell. */
export function Toaster() {
	const items = useSyncExternalStore(toastManager.subscribe, toastManager.getSnapshot, () => EMPTY);
	const region = useRef<HTMLOListElement>(null);
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	// Where focus was before F6, to go back to when the toasts are left or gone; and whether the
	// region was entered with F6 (only then does focus move on to the next toast when one goes).
	const returnTo = useRef<HTMLElement | null>(null);
	const enteredWithKeyboard = useRef(false);
	// The live regions mount empty, then take the toasts' text.
	const [ready, setReady] = useState(false);
	useEffect(() => { setReady(true); }, []);
	const layers = useOptionalInteractionLayers();
	useSyncExternalStore(layers?.subscribe ?? noSubscribe, layers?.getSnapshot ?? noLayers, noLayers);
	const modalHost = layers?.getActiveModal()?.portalRef?.current ?? null;

	const leave = useCallback(() => {
		const target = returnTo.current;
		returnTo.current = null;
		enteredWithKeyboard.current = false;
		for (const candidate of [target, fallbackFocus()]) {
			if (!candidate || !visible(candidate)) continue;
			candidate.focus({ preventScroll: true });
			if (document.activeElement === candidate) { setFocused(false); return; }
		}
		// Nowhere to go: the page itself, so focus never stays in a toast with its timer paused.
		const active = document.activeElement as HTMLElement | null;
		if (active && region.current?.contains(active)) active.blur();
		setFocused(false);
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
			enteredWithKeyboard.current = true;
			newest.focus({ preventScroll: true });
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [items.length]);

	// The focused toast went away (dismissed or timed out). Entered with F6: on to the next toast, or
	// back to where focus was. Clicked with the mouse: focus is left alone and the others time out.
	useEffect(() => {
		if (!focused) return;
		const active = document.activeElement;
		if (active && region.current?.contains(active)) return;
		if (!enteredWithKeyboard.current) { setFocused(false); return; }
		const first = stops(region.current)[0];
		if (first) first.focus({ preventScroll: true });
		else leave();
	}, [items, focused, leave]);

	const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
		// Escape with any modifier is the focused toast's, as in the release notes: never the app's
		// shortcuts (Ctrl+Escape must not reach the chat's abort).
		if (event.key === "Escape") {
			const item = (event.target as HTMLElement).closest<HTMLElement>("[data-toast-item]");
			const id = items.find((toast) => item?.dataset.toastId === String(toast.id))?.id;
			event.preventDefault();
			event.stopPropagation();
			if (id !== undefined) toastManager.close(id);
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey || event.key !== "Tab") return;
		event.preventDefault();
		event.stopPropagation();
		const all = stops(region.current);
		const at = all.indexOf(event.target as HTMLElement);
		const next = event.shiftKey ? all[at - 1] : all[at + 1];
		if (next) next.focus({ preventScroll: true });
		else leave();
	};

	const announced = ready ? items : EMPTY;
	const region_ = (
		<section aria-label="Notifications" data-testid="toast-viewport" data-toast-region className="lh-toast-region lh-no-drag pointer-events-none fixed z-[100] w-[calc(100%-2rem)] max-w-90">
			{/* Always present, and empty when first mounted, so each toast's text is announced as it is
			    inserted (also the ones raised before the region mounted). */}
			<div className="sr-only" aria-live="assertive" aria-atomic="false" data-testid="toast-announce-assertive">
				{announced.filter((toast) => toast.type === "error").map((toast) => <p key={toast.id}>{announcement(toast)}</p>)}
			</div>
			<div className="sr-only" aria-live="polite" aria-atomic="false" data-testid="toast-announce-polite">
				{announced.filter((toast) => toast.type !== "error").map((toast) => <p key={toast.id}>{announcement(toast)}</p>)}
			</div>
			<ol
				ref={region}
				className="flex flex-col gap-2"
				onKeyDown={onKeyDown}
				onPointerEnter={() => setHovered(true)}
				onPointerLeave={() => setHovered(false)}
				onFocus={() => setFocused(true)}
				onBlur={(event) => {
					if (region.current?.contains(event.relatedTarget as Node | null)) return;
					setFocused(false);
					enteredWithKeyboard.current = false;
				}}
			>
				{items.map((toast) => (
					<ToastItem key={toast.id} toast={toast} paused={hovered || focused} />
				))}
			</ol>
		</section>
	);
	// Inside an open modal's popup host: within its boundary, so neither its hideOthers nor its
	// focus trap shuts the toasts out (components/host-dialog.tsx).
	return modalHost ? createPortal(region_, modalHost) : region_;
}

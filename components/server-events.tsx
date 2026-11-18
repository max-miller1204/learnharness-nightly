"use client";

/**
 * THE NOTIFICATION CHANNEL'S CLIENT HALF (push-architecture slice 3,
 * 2026-10-02): ONE EventSource("/api/events") per open window, held for
 * the window's lifetime — the channel that retires the app's poll
 * lattice. Every server-initiated change arrives as a named SSE frame;
 * consumers respond by fetching truth (notify → fetch, the architecture's
 * whole trick — see src/core/events.ts and server/events-stream.ts).
 *
 * This file is the ONE place in the app that knows EventSource exists.
 * Auto-reconnect is EventSource's own — never fought, always exploited:
 * every (re)open fires the resync callbacks, so a reconnect heals with
 * one ordinary fetch per consumer (a dev-server restart self-heals here).
 * The one gap, a source that gave up after an HTTP error from a proxy, is
 * filled by opening a new source (openEventsChannel).
 *
 * Shape: the provider holds a hub (window-local fan-out — the client twin
 * of the server bus; per-window, NOT globalThis: each window's connection
 * is its own) and wires ONE source into it. The hooks are thin: latest-ref
 * callbacks (events fire between renders — never trust a stale closure)
 * plus hub membership for the component's lifetime.
 *
 * TEST SEAM: `connect` injects the source factory — the hub + wiring are
 * plain functions the tests drive directly (no React, no server); the
 * React glue is an adapter seam like lh:turn-state (untested by
 * precedent, components/session.ts).
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { SERVER_EVENT_TYPES, type ServerEventType, type ServerEvents } from "@/src/core";

/** The minimal source surface the provider consumes — EventSource behind
 *  this in production, fakes in tests. */
export interface NotifySource {
	close(): void;
	onOpen(cb: () => void): void;
	onEvent(name: string, cb: (data: string) => void): void;
}

/** A closed channel waits this long before opening a new one, doubling per
 *  failed try up to REOPEN_MAX_MS (T3's connection supervisor:
 *  packages/client-runtime/src/connection/supervisor.ts). */
export const REOPEN_INITIAL_MS = 1_000;
export const REOPEN_MAX_MS = 5 * 60_000;

export interface EventsChannelDeps {
	create(url: string): EventSource;
	checkSession(): Promise<{ authenticated?: boolean }>;
	reload(): void;
	setTimeout(cb: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	isHidden(): boolean;
	/** Calls cb whenever the tab becomes visible; returns the unsubscribe. */
	onVisible(cb: () => void): () => void;
}

const browserDeps = (): EventsChannelDeps => ({
	create: (url) => new EventSource(url),
	checkSession: () => fetch("/api/auth/session", { cache: "no-store" }).then((res) => res.json()),
	reload: () => window.location.reload(),
	setTimeout: (cb, ms) => window.setTimeout(cb, ms),
	clearTimeout: (handle) => window.clearTimeout(handle as number),
	isHidden: () => document.visibilityState === "hidden",
	onVisible: (cb) => {
		const listener = () => { if (document.visibilityState === "visible") cb(); };
		document.addEventListener("visibilitychange", listener);
		return () => document.removeEventListener("visibilitychange", listener);
	},
});

/** EventSource retries a dropped connection on its own, but gives up for
 *  good when a retry gets an HTTP error. A proxy in front of a restarting
 *  server does exactly that (Tailscale Serve answers 502 while an update
 *  restarts it), so a closed source is replaced: after REOPEN_INITIAL_MS,
 *  doubling up to REOPEN_MAX_MS while it keeps failing, never while the tab
 *  is hidden, and at once when it shows again. A new source's open fires the
 *  resync callbacks like any reconnect. */
export function openEventsChannel(deps: EventsChannelDeps = browserDeps()): NotifySource {
	const listeners: Array<[string, (data: string) => void]> = [];
	let onOpen: (() => void) | undefined;
	let closed = false;
	let reopenTimer: unknown;
	let delay = REOPEN_INITIAL_MS;
	let es: EventSource;
	// Signed out while open (a revoked device): the stream fails, the session
	// check says so, and a reload lands on the pairing screen.
	// docs/specs/login-pairing.md
	let checking = false;
	const reopenNow = () => {
		if (reopenTimer !== undefined) deps.clearTimeout(reopenTimer);
		reopenTimer = undefined;
		if (!closed) connect();
	};
	const scheduleReopen = () => {
		if (closed || reopenTimer !== undefined || deps.isHidden()) return; // hidden: onVisible reopens
		const wait = delay;
		delay = Math.min(delay * 2, REOPEN_MAX_MS);
		reopenTimer = deps.setTimeout(() => {
			reopenTimer = undefined;
			if (!closed && !deps.isHidden()) connect();
		}, wait);
	};
	const connect = () => {
		const source = deps.create("/api/events");
		es = source;
		source.onopen = () => { delay = REOPEN_INITIAL_MS; onOpen?.(); };
		for (const [name, cb] of listeners) source.addEventListener(name, (ev) => cb((ev as MessageEvent).data));
		source.addEventListener("error", () => {
			if (source.readyState === 2 /* CLOSED */ && source === es) scheduleReopen();
			if (checking) return;
			checking = true;
			void deps.checkSession()
				.then((state) => { if (state.authenticated === false) deps.reload(); })
				.catch(() => { /* server unreachable: the channel keeps retrying */ })
				.finally(() => { checking = false; });
		});
	};
	connect();
	const offVisible = deps.onVisible(() => { if (es.readyState === 2) reopenNow(); });
	return {
		close: () => {
			closed = true;
			offVisible();
			if (reopenTimer !== undefined) deps.clearTimeout(reopenTimer);
			es.close();
		},
		onOpen: (cb) => {
			onOpen = cb;
		},
		onEvent: (name, cb) => {
			listeners.push([name, cb]);
			es.addEventListener(name, (ev) => cb((ev as MessageEvent).data));
		},
	};
}

/** The per-window fan-out: typed subscriptions over one source. Listener
 *  errors are isolated per the bus's law (one bad consumer never breaks
 *  the window), and dispatch iterates a snapshot (an unsubscribe during
 *  dispatch is safe). */
export function createNotifyHub() {
	const byType = new Map<string, Set<(data: never) => void>>();
	const resyncs = new Set<() => void>();
	return {
		subscribe<K extends ServerEventType>(type: K, cb: (payload: ServerEvents[K]) => void) {
			const set = byType.get(type) ?? new Set<(data: never) => void>();
			byType.set(type, set);
			const slot = cb as unknown as (data: never) => void;
			set.add(slot);
			return () => set.delete(slot);
		},
		/** Resync callbacks: fired on the source's every (re)open — "you may
		 *  have missed events while disconnected; refetch". A consumer that
		 *  mounts while ALREADY open gets no fire (it missed nothing by
		 *  birth); its own mount fetch is its initial truth. */
		onResync(cb: () => void) {
			resyncs.add(cb);
			return () => resyncs.delete(cb);
		},
		/** One named frame arrived: parse, fan out. Unparseable frames are
		 *  dropped loudly — the channel's payloads are tiny and schemaless,
		 *  a bad frame must never half-fire. */
		dispatch(name: string, raw: string) {
			const set = byType.get(name);
			if (!set) return;
			let payload: unknown;
			try {
				payload = JSON.parse(raw);
			} catch (err) {
				console.error(`[events] unparseable frame for ${name}:`, err);
				return;
			}
			for (const cb of [...set]) {
				try {
					(cb as unknown as (data: unknown) => void)(payload);
				} catch (err) {
					console.error(`[events] ${name} handler failed:`, err);
				}
			}
		},
		fireOpen() {
			for (const cb of [...resyncs]) {
				try {
					cb();
				} catch (err) {
					console.error("[events] resync handler failed:", err);
				}
			}
		},
	};
}

/** Wire one source into a hub — the provider's ENTIRE effect body, factored
 *  out so the wiring is testable without React. Returns the disconnect. */
export function wireSource(source: NotifySource, hub: ReturnType<typeof createNotifyHub>): () => void {
	for (const name of SERVER_EVENT_TYPES) source.onEvent(name, (raw) => hub.dispatch(name, raw));
	source.onOpen(() => hub.fireOpen());
	return () => source.close();
}

// ── the React glue ──────────────────────────────────────────────────────────

const EventsContext = createContext<ReturnType<typeof createNotifyHub> | null>(null);

/** Transport adapters may also be mounted in isolation with an injected bridge. */
export function useNotifyHub() { return useContext(EventsContext); }

export function ServerEventsProvider({ children, connect }: { children: ReactNode; connect?: () => NotifySource }) {
	const hub = useMemo(() => createNotifyHub(), []);
	useEffect(() => wireSource((connect ?? openEventsChannel)(), hub), [hub, connect]);
	return <EventsContext.Provider value={hub}>{children}</EventsContext.Provider>;
}

/** Subscribe to one event type for this component's lifetime. The callback
 *  is a latest-ref: pass inline closures freely — the freshest render's
 *  closure runs, so state captured at the last completed render is safe to
 *  read (the provider re-stores it every render). */
export function useServerEvent<K extends ServerEventType>(type: K, cb: (payload: ServerEvents[K]) => void): void {
	const hub = useContext(EventsContext);
	if (!hub) throw new Error("useServerEvent requires <ServerEventsProvider>");
	const cbRef = useRef(cb);
	cbRef.current = cb;
	useEffect(() => {
		const off = hub.subscribe(type, (payload) => cbRef.current(payload));
		return () => {
			off();
		};
	}, [hub, type]);
}

/** Refetch truth on every (re)connect of the window's channel — the
 *  self-heal seam for EventSource reconnects and dev-server restarts. */
export function useServerResync(cb: () => void): void {
	const hub = useContext(EventsContext);
	if (!hub) throw new Error("useServerResync requires <ServerEventsProvider>");
	const cbRef = useRef(cb);
	cbRef.current = cb;
	useEffect(() => {
		const off = hub.onResync(() => cbRef.current());
		return () => {
			off();
		};
	}, [hub]);
}

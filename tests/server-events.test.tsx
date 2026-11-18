/**
 * THE NOTIFICATION CHANNEL'S CLIENT HALF (push-architecture S3,
 * 2026-10-02): one EventSource per window fanned out through the hub.
 * The provider's ENTIRE effect body is wireSource(source, hub) — a plain
 * function — so these pins drive the real wiring with a fake source, no
 * React and no server: typed dispatch, resync-on-open, error isolation,
 * and close-stops-dispatch. The React glue around it (hooks/context) is
 * an adapter seam like lh:turn-state (untested by precedent).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNotifyHub, openEventsChannel, REOPEN_INITIAL_MS, REOPEN_MAX_MS, wireSource, type EventsChannelDeps, type NotifySource } from "../components/server-events.tsx";

/** A source the test drives by hand — recordable, closable, honest. */
function fakeSource() {
	const events = new Map<string, Set<(data: string) => void>>();
	const opens = new Set<() => void>();
	const src: NotifySource & {
		push(name: string, payload: unknown): void;
		open(): void;
		closed: boolean;
	} = {
		closed: false,
		close() {
			this.closed = true;
		},
		onOpen(cb) {
			opens.add(cb);
		},
		onEvent(name, cb) {
			const set = events.get(name) ?? new Set();
			events.set(name, set);
			set.add(cb);
		},
		push(name, payload) {
			for (const cb of events.get(name) ?? []) cb(JSON.stringify(payload));
		},
		open() {
			for (const cb of opens) cb();
		},
	};
	return src;
}

describe("notify hub + wireSource (the client channel wiring)", () => {
	it("a named frame dispatches to the right subscriber with the parsed payload", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		wireSource(src, hub);
		const got: string[] = [];
		hub.subscribe("turn-started", (p) => got.push(p.chatId));
		hub.subscribe("turn-settled", (p) => got.push(`settled:${p.chatId}`));
		src.push("turn-started", { chatId: "chat_wire" });
		src.push("turn-settled", { chatId: "chat_wire" });
		src.push("jobs-changed", { chatId: "chat_wire" }); // no subscriber — no-op
		assert.deepEqual(got, ["chat_wire", "settled:chat_wire"]);
	});

	it("open fires resync (initial AND reconnect — EventSource's own retry exploited)", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		wireSource(src, hub);
		let resyncs = 0;
		hub.onResync(() => resyncs++);
		src.open();
		src.open(); // the reconnect case: same callback, fired again
		assert.equal(resyncs, 2);
	});

	it("a throwing handler never breaks its neighbors (the bus's isolation law)", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		wireSource(src, hub);
		hub.subscribe("chats-changed", () => {
			throw new Error("handler bug");
		});
		const got: number[] = [];
		hub.subscribe("chats-changed", () => got.push(1));
		src.push("chats-changed", {});
		assert.deepEqual(got, [1]);
	});

	it("an unparseable frame is dropped loudly, never half-fired", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		wireSource(src, hub);
		let calls = 0;
		hub.subscribe("activity-changed", () => calls++);
		// dispatch is the seam's own parser — feed it garbage directly
		hub.dispatch("activity-changed", "{not json");
		assert.equal(calls, 0);
	});

	it("unsubscribe stops delivery; close() (the disconnect) is wired through", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		const disconnect = wireSource(src, hub);
		let calls = 0;
		const off = hub.subscribe("chats-changed", () => calls++);
		src.push("chats-changed", {});
		off();
		src.push("chats-changed", {});
		assert.equal(calls, 1);
		assert.equal(src.closed, false, "connected until the provider unmounts");
		disconnect();
		assert.equal(src.closed, true, "the effect's cleanup closes the source");
	});
});

/** A stand-in EventSource: listeners by name, a readyState the test sets. */
class FakeEventSource {
	readyState = 1;
	onopen: (() => void) | null = null;
	closed = false;
	listeners = new Map<string, Array<(ev: unknown) => void>>();
	addEventListener(name: string, cb: (ev: unknown) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]); }
	fire(name: string, data?: string) { for (const cb of this.listeners.get(name) ?? []) cb({ data }); }
	close() { this.closed = true; this.readyState = 2; }
}

describe("openEventsChannel (the real EventSource adapter)", () => {
	function channel() {
		const sources: FakeEventSource[] = [];
		const timers: Array<{ cb: () => void; ms: number }> = [];
		let reloads = 0;
		const page = { hidden: false, visible: undefined as (() => void) | undefined };
		const deps: EventsChannelDeps = {
			create: () => { const es = new FakeEventSource(); sources.push(es); return es as unknown as EventSource; },
			checkSession: async () => ({ authenticated: true }),
			reload: () => { reloads++; },
			setTimeout: (cb, ms) => { timers.push({ cb, ms }); return timers.length; },
			clearTimeout: () => { timers.length = 0; },
			isHidden: () => page.hidden,
			onVisible: (cb) => { page.visible = cb; return () => { page.visible = undefined; }; },
		};
		const hub = createNotifyHub();
		const off = wireSource(openEventsChannel(deps), hub);
		return { sources, timers, hub, off, page, reloads: () => reloads };
	}

	it("a source that gave up (a proxy's 502 during a restart) is replaced, and the new open resyncs", () => {
		const c = channel();
		let resyncs = 0;
		const got: unknown[] = [];
		c.hub.onResync(() => { resyncs++; });
		c.hub.subscribe("update-changed", (payload) => got.push(payload));
		c.sources[0]!.onopen?.();
		assert.equal(resyncs, 1);

		c.sources[0]!.readyState = 2; // CLOSED: EventSource will not retry on its own
		c.sources[0]!.fire("error");
		assert.equal(c.timers.length, 1);
		assert.equal(c.timers[0]!.ms, REOPEN_INITIAL_MS);
		c.sources[0]!.fire("error");
		assert.equal(c.timers.length, 1, "one reopen per closed source");
		c.timers.shift()!.cb();
		assert.equal(c.sources.length, 2, "a new source");

		c.sources[1]!.onopen?.();
		assert.equal(resyncs, 2, "the reopen refetches like any reconnect");
		c.sources[1]!.fire("update-changed", "{}");
		assert.deepEqual(got, [{}], "events flow on the new source");
	});

	it("backs off while reopening keeps failing (1 s doubling to 5 min, T3's supervisor), and a good open resets it", () => {
		const c = channel();
		const fail = () => { const es = c.sources.at(-1)!; es.readyState = 2; es.fire("error"); };
		const waits: number[] = [];
		for (let i = 0; i < 11; i++) { fail(); const t = c.timers.shift()!; waits.push(t.ms); t.cb(); }
		assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, REOPEN_MAX_MS, REOPEN_MAX_MS]);
		c.sources.at(-1)!.onopen?.();
		fail();
		assert.equal(c.timers[0]!.ms, REOPEN_INITIAL_MS, "an open starts the backoff over");
	});

	it("never reopens while the tab is hidden, and reopens at once when it shows", () => {
		const c = channel();
		c.page.hidden = true;
		c.sources[0]!.readyState = 2;
		c.sources[0]!.fire("error");
		assert.equal(c.timers.length, 0, "hidden: no timer, no requests");
		c.page.hidden = false;
		c.page.visible?.();
		assert.equal(c.sources.length, 2, "visible again: a new source right away");

		// A timer that comes due while hidden waits for visibility too.
		c.sources[1]!.readyState = 2;
		c.sources[1]!.fire("error");
		c.page.hidden = true;
		c.timers.shift()!.cb();
		assert.equal(c.sources.length, 2);
		c.page.hidden = false;
		c.page.visible?.();
		assert.equal(c.sources.length, 3);
		c.sources[2]!.onopen?.();
		c.page.visible?.();
		assert.equal(c.sources.length, 3, "an open source is left alone on visibility");
	});

	it("a source still retrying (readyState CONNECTING) is left to EventSource", () => {
		const c = channel();
		c.sources[0]!.readyState = 0;
		c.sources[0]!.fire("error");
		assert.equal(c.timers.length, 0);
	});

	it("close() cancels a pending reopen and closes the current source", () => {
		const c = channel();
		c.sources[0]!.readyState = 2;
		c.sources[0]!.fire("error");
		c.off();
		assert.equal(c.timers.length, 0);
		assert.equal(c.sources[0]!.closed, true);
		assert.equal(c.sources.length, 1);
	});
});

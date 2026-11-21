/** Update UI with a fake preload bridge: no Electron, network or updates. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { describe, it, after, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { InteractionLayersProvider, useInteractionLayer } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { UpdateSettings, readDesktopAppStatus, updateStatusText, MANUAL_UPDATE_HINT, AUTO_UPDATE_HINT, type UpdateState } from "../components/settings/update-settings.tsx";
import { AUTO_RELOAD_KEY, AUTO_RELOAD_MEMORY, claimAutoReload, downloadingTooltip, downloadRingOffset, hasUnsentMessage, shownReleaseNotes, SidebarUpdatePill, updateControlTooltip } from "../components/sidebar-update-pill.tsx";
import { createRequire } from "node:module";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { formatReleaseAge, ReleaseNoteSections, UpdateReleaseNotes } from "../components/release-notes-view.tsx";
import WhatsNewDialog, { WhatsNewBody } from "../components/whats-new-dialog.tsx";
import { InstallUpdateDialog } from "../components/install-update-dialog.tsx";
import { SettingsDialogBody, SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import nextConfig from "../next.config.ts";
import { TOOLTIP_DELAY_MS } from "../components/ui/tooltip.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent });
// A per-tab sessionStorage (linkedom has none): the automatic reload's once-per-version memory.
const tabStorage = new Map<string, string>();
const sessionStorageFake = { getItem: (key: string) => tabStorage.get(key) ?? null, setItem: (key: string, value: string) => { tabStorage.set(key, String(value)); } };
Object.defineProperty(dom.window, "sessionStorage", { configurable: true, writable: true, value: sessionStorageFake });
const restoreModalDom = installModalDom(dom);
after(restoreModalDom);
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
const state = (over: Partial<UpdateState> = {}): UpdateState => ({ status: "idle", version: null, revision: 0, ...over });
const props = { autoUpdate: true, onAutoUpdateChange: () => {}, version: "0.3.7", homepage: "https://github.com/amosblomqvist/learnharness" };
const q = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function bridge(initial = state(), snapshot = Promise.resolve(initial)) {
	const listeners = new Set<(value: UpdateState) => void>();
	const calls = { check: 0, install: 0, get: 0, download: 0 };
	let onOpen: ((section: string) => void) | null = null;
	let checkFailure: Error | null = null;
	window.lh = {
		expandWindow() {},
		getUpdateState: () => { calls.get++; return snapshot; },
		onUpdateStatus: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
		checkForUpdates: async () => { calls.check++; if (checkFailure) throw checkFailure; },
		installUpdate: async () => { calls.install++; return true; },
		downloadUpdate: async () => { calls.download++; },
		onOpenSettings: cb => { onOpen = cb; return () => { onOpen = null; }; },
	};
	return {
		calls, listeners,
		failCheck: () => { checkFailure = new Error("sensitive raw diagnostics"); },
		push: async (value: UpdateState) => { await act(async () => { for (const listener of listeners) listener(value); }); },
		open: async () => { await act(async () => onOpen?.("general")); },
	};
}

async function mount(element: React.ReactElement) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host); roots.push({ root, host });
	await act(async () => { root.render(<InteractionLayersProvider>{element}</InteractionLayersProvider>); });
	return host;
}

async function click(element: HTMLElement | null) {
	assert.ok(element, "missing click target");
	await act(async () => { element.click(); });
}

/** A mouse over `element`: what opens the notes (pointerenter) and the plain tooltip (pointermove). */
async function hover(element: HTMLElement) {
	const pointer = (type: string, bubbles = true) => Object.assign(new window.Event(type, { bubbles, cancelable: true }), { pointerType: "mouse", button: 0, isPrimary: true });
	await act(async () => { element.dispatchEvent(pointer("pointerover")); element.dispatchEvent(pointer("pointerenter", false)); element.dispatchEvent(pointer("pointermove")); });
}

/** After the tooltip's open delay, whether the plain tooltip opened: its trigger's state (linkedom
 *  can't lay out the positioned content itself; tests/passive-tooltip.test.tsx covers that). */
async function plainTooltipOpens(trigger: HTMLElement) {
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, TOOLTIP_DELAY_MS + 50)); });
	return trigger.getAttribute("data-state") === "delayed-open";
}

// linkedom has no capture phase (it runs a window capture listener last, at bubble time), so
// keydown capture listeners on the window are kept here and `key` runs them first, as a browser does.
const windowKeyCapture = new Set<EventListenerOrEventListenerObject>();
const isCapture = (options?: boolean | AddEventListenerOptions | EventListenerOptions) => options === true || (typeof options === "object" && !!options.capture);
const addWindowListener = dom.window.addEventListener.bind(dom.window);
const removeWindowListener = dom.window.removeEventListener.bind(dom.window);
dom.window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
	if (type === "keydown" && isCapture(options)) windowKeyCapture.add(listener);
	else addWindowListener(type, listener, options);
}) as typeof dom.window.addEventListener;
dom.window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
	if (type === "keydown" && isCapture(options)) windowKeyCapture.delete(listener);
	else removeWindowListener(type, listener, options);
}) as typeof dom.window.removeEventListener;

/** A keydown from `element`: the window's capture listeners, then (unless one stopped it) the
 *  target and the bubble through React's root to the document and the window. */
async function key(element: Element, name: string, { shiftKey = false, altKey = false, ctrlKey = false, metaKey = false } = {}) {
	const event = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: name, shiftKey, altKey, ctrlKey, metaKey });
	let stopped = false;
	const stop = event.stopPropagation.bind(event);
	event.stopPropagation = () => { stopped = true; stop(); };
	await act(async () => {
		for (const listener of [...windowKeyCapture]) {
			if (typeof listener === "function") listener.call(window, event); else listener.handleEvent(event);
			if (stopped) return;
		}
		element.dispatchEvent(event);
	});
}

/** Keyboard focus (linkedom can't match :focus-visible). */
function keyboardFocusable(element: HTMLElement) {
	const matches = element.matches.bind(element);
	element.matches = (selector: string) => selector === ":focus-visible" || matches(selector);
	return element;
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); }); host.remove();
	}
	// FocusScope's delayed cleanup still needs the installed fixture DOM.
	await new Promise(resolve => setTimeout(resolve, 5));
	delete window.lh;
	globalThis.fetch = originalFetch;
	tabStorage.clear();
	Object.defineProperty(dom.window, "sessionStorage", { configurable: true, writable: true, value: sessionStorageFake });
});

describe("version and contextual copy", () => {
	it("build metadata comes from package.json and exposes only public version/homepage values", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert.deepEqual(nextConfig.env, { LH_VERSION: pkg.version, LH_HOMEPAGE: pkg.homepage });
	});

	it("never claims live/latest information and keeps updater errors generic", () => {
		assert.equal(updateStatusText(null), null);
		assert.equal(updateStatusText(state()), null);
		assert.equal(updateStatusText(state({ status: "disabled" })), null);
		assert.equal(updateStatusText(state({ status: "checking" })), "Checking for updates…");
		assert.equal(updateStatusText(state({ status: "downloading", version: "0.3.8" })), "Downloading version 0.3.8…");
		assert.equal(updateStatusText(state({ status: "up-to-date" })), "No newer version was found at the last check.");
		assert.equal(updateStatusText(state({ status: "downloaded", version: "0.3.8" })), "Version 0.3.8 is ready to install.");
		assert.equal(updateStatusText(state({ status: "available", version: "0.3.8" })), "Version 0.3.8 is available.");
		assert.equal(updateStatusText(state({ status: "error" })), "Couldn’t check for updates. Try again later.");
		assert.equal(updateStatusText(state({ status: "downloading" })), "Downloading an update…");
		assert.equal(updateStatusText(state({ status: "downloaded" })), "An update is ready to install.");
	});
});

describe("General update rows", () => {
	it("browser/SSR shows version and installed-version release notes, without inactive controls or claims", () => {
		const html = renderToStaticMarkup(<UpdateSettings {...props} />);
		assert.ok(html.includes("Version 0.3.7"));
		assert.ok(html.includes(`${props.homepage}/releases/tag/v0.3.7`));
		assert.ok(!html.includes("update-check")); assert.ok(!html.includes("row-auto-update"));
		assert.ok(!html.includes(MANUAL_UPDATE_HINT)); assert.ok(!html.includes("update-status"));
	});

	it("unpackaged/unavailable updater shows the version-only surface", async () => {
		const b = bridge(state({ status: "disabled" })); const host = await mount(<UpdateSettings {...props} />);
		assert.ok(q(host, "row-version")); assert.equal(q(host, "update-check"), null);
		assert.equal(q(host, "row-auto-update"), null); assert.equal(b.calls.check, 0);
	});

	it("idle shows two rows and clear consequences; opening Settings never checks", async () => {
		const b = bridge(); const seen: boolean[] = [];
		const host = await mount(<UpdateSettings {...props} onAutoUpdateChange={value => seen.push(value)} />);
		assert.deepEqual([...host.children].map(el => el.getAttribute("data-testid")), ["row-version", "row-auto-update"]);
		assert.ok(q(host, "row-version")!.contains(q(host, "update-check")));
		assert.ok(host.textContent!.includes(MANUAL_UPDATE_HINT)); assert.ok(host.textContent!.includes(AUTO_UPDATE_HINT));
		assert.equal(q(host, "update-status"), null); assert.equal(b.calls.check, 0);
		await click(q(host, "toggle-auto-update")); assert.deepEqual(seen, [false]);
		await click(q(host, "update-check")); assert.equal(b.calls.check, 1);
	});

	it("manual check remains available while automatic checks are OFF", async () => {
		const b = bridge(); const host = await mount(<UpdateSettings {...props} autoUpdate={false} />);
		assert.equal(q(host, "toggle-auto-update")!.getAttribute("aria-checked"), "false");
		await click(q(host, "update-check")); assert.equal(b.calls.check, 1);
	});

	it("checking/downloading shows context and disables only the UI button; ready offers Restart", async () => {
		const b = bridge(); const host = await mount(<UpdateSettings {...props} />);
		await b.push(state({ status: "checking", revision: 1 }));
		assert.equal((q(host, "update-check") as HTMLButtonElement).disabled, true);
		assert.equal(q(host, "update-check")!.getAttribute("aria-busy"), "true");
		assert.equal(q(host, "update-status")!.textContent, "Checking for updates…");
		await b.push(state({ status: "downloading", version: "0.3.8", revision: 2 }));
		assert.equal(q(host, "update-status")!.textContent, "Downloading version 0.3.8…");
		assert.equal((q(host, "update-check") as HTMLButtonElement).disabled, true);
		await b.push(state({ status: "downloaded", version: "0.3.8", revision: 3 }));
		assert.equal(q(host, "update-check"), null); assert.equal(q(host, "update-status")!.textContent, "Version 0.3.8 is ready to install.");
		await click(q(host, "update-install"));
		assert.equal(b.calls.install, 0, "Install confirms first");
		assert.equal(q(document, "install-update-title")!.textContent, "Install update 0.3.8 and restart LearnHarness?");
		await click(q(document, "install-update-confirm")); assert.equal(b.calls.install, 1);
	});

	it("a restarted self-hosted server (new instance) is not ignored for counting revisions from 0 again", async () => {
		let body: UpdateState = state({ status: "downloaded", version: "0.3.8", revision: 9, instance: "old" });
		const handlers = new Map<string, (data: string) => void>();
		const source = { close() {}, onOpen() {}, onEvent: (name: string, cb: (data: string) => void) => { handlers.set(name, cb); } };
		const connect = () => source;
		globalThis.fetch = async () => Response.json(body);
		const host = await mount(<ServerEventsProvider connect={connect}><SidebarUpdatePill /></ServerEventsProvider>);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.equal(q(host, "update-pill")!.getAttribute("data-action"), "install");
		body = state({ status: "up-to-date", revision: 1, instance: "new" });
		await act(async () => { handlers.get("update-changed")!("{}"); await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.equal(q(host, "update-pill")!.getAttribute("data-action"), "check", "the new server's lower revision is accepted");
	});

	it("an undismissed rollback stays explained in Settings after a later check clears the message", () => {
		const notice = { kind: "rolled-back" as const, version: "0.3.8", text: "Update to version 0.3.8 failed to start and was rolled back.", at: 1 };
		assert.equal(updateStatusText(state({ status: "up-to-date", notice, message: null })), notice.text);
		assert.equal(updateStatusText(state({ status: "downloaded", version: "0.3.9", notice })), "Version 0.3.9 is ready to install.");
	});

	it("desktop available offers Download (downloads only on click)", async () => {
		const b = bridge(); const host = await mount(<UpdateSettings {...props} />);
		await b.push(state({ status: "available", version: "0.3.8", revision: 1 }));
		assert.equal(q(host, "update-status")!.textContent, "Version 0.3.8 is available.");
		assert.equal(b.calls.download, 0);
		await click(q(host, "update-download")); assert.equal(b.calls.download, 1);
	});

	it("Cancel in the confirm dialog installs nothing", async () => {
		const b = bridge(state({ status: "downloaded", version: "0.3.8", revision: 1 }));
		const host = await mount(<UpdateSettings {...props} />);
		await click(q(host, "update-install"));
		await click(q(document, "install-update-cancel"));
		assert.equal(q(document, "install-update-title"), null);
		assert.equal(b.calls.install, 0);
	});

	it("up-to-date and failure statuses allow another manual check", async () => {
		const b = bridge(); const host = await mount(<UpdateSettings {...props} />);
		await b.push(state({ status: "up-to-date", revision: 1 }));
		assert.equal(q(host, "update-status")!.textContent, "No newer version was found at the last check.");
		await b.push(state({ status: "error", revision: 2 }));
		assert.equal((q(host, "update-check") as HTMLButtonElement).disabled, false);
		assert.equal(q(host, "update-status")!.textContent, "Couldn’t check for updates. Try again later.");
		await click(q(host, "update-check")); assert.equal(b.calls.check, 1);
	});

	it("bridge command rejection is handled without exposing raw diagnostics", async () => {
		const b = bridge(); b.failCheck(); const host = await mount(<UpdateSettings {...props} />);
		await click(q(host, "update-check"));
		assert.equal(q(host, "update-status")!.textContent, "Couldn’t check for updates. Try again later.");
		assert.ok(!host.textContent!.includes("sensitive"));
	});

	it("late Settings and pill subscribers recover the staged update without an event", async () => {
		const b = bridge(state({ status: "downloaded", version: "0.3.8", revision: 5 }));
		const host = await mount(<><UpdateSettings {...props} /><SidebarUpdatePill /></>);
		assert.ok(q(host, "update-install")); assert.ok(q(host, "update-pill"));
		assert.equal(q(host, "update-pill")!.getAttribute("aria-label"), "Update 0.3.8 downloaded. Click to restart and install.");
		await click(q(host, "update-pill"));
		assert.equal(b.calls.install, 0, "the pill confirms first");
		await click(q(document, "install-update-confirm")); assert.equal(b.calls.install, 1);
		assert.equal(b.calls.check, 0);
	});

	it("the update control follows T3's states: check, unavailable, then download, downloading, install", async () => {
		const b = bridge(); const host = await mount(<SidebarUpdatePill />);
		const pill = () => q(host, "update-pill")!;
		for (const [revision, status] of [[1, "idle"], [2, "up-to-date"], [3, "error"]] as const) {
			await b.push(state({ status, revision }));
			assert.equal(pill().getAttribute("data-action"), "check", status);
			assert.equal(pill().getAttribute("aria-label"), "Check for updates", status);
			assert.equal(pill().getAttribute("aria-disabled"), null, status);
		}
		await b.push(state({ status: "disabled", revision: 4 }));
		assert.equal(pill().getAttribute("data-action"), "unavailable");
		assert.equal(pill().getAttribute("aria-label"), "Updates unavailable: Automatic updates are not available in this build.");
		assert.equal(pill().getAttribute("aria-disabled"), "true");
		assert.match(pill().className, /opacity-60/);
		await click(pill()); assert.equal(b.calls.check, 0, "unavailable does nothing");
		await b.push(state({ status: "available", version: "0.3.8", revision: 6 }));
		assert.equal(pill().getAttribute("data-action"), "download");
		assert.equal(pill().getAttribute("aria-label"), "Update 0.3.8 ready to download");
		await click(pill()); assert.equal(b.calls.download, 1);
		await b.push(state({ status: "downloading", version: "0.3.8", revision: 7 }));
		assert.equal(pill().getAttribute("data-action"), "downloading");
		assert.equal(pill().getAttribute("aria-label"), "Downloading update");
		assert.equal(pill().getAttribute("aria-disabled"), "true");
		await click(pill()); assert.equal(b.calls.download, 1);
		await b.push(state({ status: "downloaded", version: "0.3.8", revision: 8 }));
		assert.equal(pill().getAttribute("data-action"), "install");
		assert.equal(b.calls.check, 0, "nothing here checked on its own");
	});

	it("while downloading, T3's ring fills around the arrow and the label says how far (floored); unknown size is empty and plain", async () => {
		assert.equal(downloadingTooltip(42.9), "Downloading update (42%)");
		assert.equal(downloadingTooltip(0), "Downloading update (0%)");
		assert.equal(downloadingTooltip(null), "Downloading update");
		assert.equal(downloadingTooltip(undefined), "Downloading update");
		const full = 2 * Math.PI * 14;
		assert.equal(downloadRingOffset(null), full, "unknown: empty ring");
		assert.equal(downloadRingOffset(100), 0);
		assert.equal(downloadRingOffset(150), 0, "clamped");
		const b = bridge(); const host = await mount(<SidebarUpdatePill />);
		const pill = () => q(host, "update-pill")!;
		const offset = () => Number(pill().querySelectorAll("circle")[1]!.getAttribute("stroke-dashoffset"));
		await b.push(state({ status: "downloading", version: "0.3.8", revision: 1, downloadPercent: null }));
		assert.equal(pill().getAttribute("aria-label"), "Downloading update");
		assert.ok(pill().querySelector(".lucide-download"), "the download arrow stays inside the ring");
		assert.equal(offset(), full);
		await b.push(state({ status: "downloading", version: "0.3.8", revision: 2, downloadPercent: 0 }));
		assert.equal(pill().getAttribute("aria-label"), "Downloading update (0%)");
		const ring = pill().querySelectorAll("circle")[1]!;
		await b.push(state({ status: "downloading", version: "0.3.8", revision: 3, downloadPercent: 37.6 }));
		assert.equal(pill().getAttribute("aria-label"), "Downloading update (37%)");
		assert.ok(Math.abs(offset() - full * (1 - 0.376)) < 1e-9);
		assert.equal(pill().querySelectorAll("circle")[1], ring, "the same ring moves, so the 300 ms transition plays");
		assert.match(ring.getAttribute("class") ?? "", /transition-\[stroke-dashoffset\] duration-300 ease-out motion-reduce:transition-none/);
		assert.match(pill().querySelectorAll("circle")[0]!.getAttribute("class") ?? "", /stroke-current\/22/, "the track at 22%");
		assert.equal(pill().getAttribute("aria-disabled"), "true");
		await b.push(state({ status: "downloading", version: "0.3.8", revision: 4, downloadPercent: 100, preparing: true }));
		assert.equal(pill().getAttribute("aria-label"), "Preparing update", "every byte is in: checked and unpacked next");
		assert.equal(offset(), 0, "a full ring");
		assert.equal(pill().getAttribute("aria-disabled"), "true");
		assert.equal(updateStatusText(state({ status: "downloading", version: "0.3.8", preparing: true })), "Preparing version 0.3.8…");
		assert.equal(updateControlTooltip(state({ status: "downloading", preparing: true }), "downloading"), "Preparing update");
		await b.push(state({ status: "downloaded", version: "0.3.8", revision: 5 }));
		assert.equal(pill().querySelector("circle"), null, "no ring once downloaded");
	});

	it("clicking checks only, and the spin lasts at least one full turn, then stops at a turn boundary once the check ends", async () => {
		const b = bridge(); const host = await mount(<SidebarUpdatePill />);
		const pill = () => q(host, "update-pill")!;
		const icon = () => q(host, "update-control-refresh-icon")!;
		const turn = async () => { await act(async () => { icon().dispatchEvent(new window.Event("animationiteration", { bubbles: true })); }); };
		await click(pill());
		assert.equal(b.calls.check, 1); assert.equal(b.calls.download, 0); assert.equal(b.calls.install, 0);
		assert.equal(pill().getAttribute("data-action"), "checking", "a check that ends at once still spins its first turn");
		assert.equal(pill().getAttribute("aria-label"), "Checking for updates…");
		assert.equal(pill().getAttribute("aria-disabled"), "true");
		assert.equal(icon().getAttribute("data-spinning"), "true");
		assert.match(icon().getAttribute("class") ?? "", /motion-safe:animate-spin/);
		await click(pill()); assert.equal(b.calls.check, 1, "disabled while spinning");
		await turn();
		assert.equal(pill().getAttribute("data-action"), "check", "stops at the turn boundary");
		assert.equal(icon().getAttribute("data-spinning"), null);

		await b.push(state({ status: "checking", revision: 2 }));
		await turn();
		assert.equal(icon().getAttribute("data-spinning"), "true", "keeps turning while the check runs");
		await b.push(state({ status: "up-to-date", revision: 3 }));
		assert.equal(icon().getAttribute("data-spinning"), "true", "finishes the turn it is in");
		await turn();
		assert.equal(pill().getAttribute("data-action"), "check");
		assert.equal(pill().getAttribute("aria-label"), "Check for updates");
	});

	// Owner decision 2026-11-19 (docs/specs/update-control.md, Restarting).
	it("after Install and restart the button greys out, spins and reads Restarting to install X… until the restart; a failure gives the normal button back", async () => {
		const b = bridge(state({ status: "downloaded", version: "0.3.8", revision: 1 }));
		const host = await mount(<SidebarUpdatePill />);
		const pill = () => q(host, "update-pill")!;
		const icon = () => q(host, "update-control-restart-icon")!;
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.equal(pill().getAttribute("data-action"), "install");
		assert.equal(icon().getAttribute("data-spinning"), null, "no spin before the confirm");
		await click(pill());
		await click(q(document, "install-update-confirm"));
		assert.equal(b.calls.install, 1);
		assert.equal(pill().getAttribute("data-action"), "restarting");
		assert.equal(pill().getAttribute("aria-label"), "Restarting to install 0.3.8…");
		assert.equal(pill().getAttribute("aria-disabled"), "true");
		assert.match(pill().className, /opacity-60/);
		assert.match(pill().className, /cursor-not-allowed/);
		assert.equal(icon().getAttribute("data-spinning"), "true");
		assert.match(icon().getAttribute("class") ?? "", /motion-safe:animate-spin/);
		await click(pill());
		assert.equal(q(document, "install-update-title"), null, "a second click opens nothing");
		assert.equal(b.calls.install, 1);
		// The app's install found a newer build and couldn't download it: offered again, as before.
		await b.push(state({ status: "available", version: "0.3.9", revision: 2 }));
		assert.equal(pill().getAttribute("data-action"), "download");
		assert.equal(pill().getAttribute("aria-disabled"), null);
		await b.push(state({ status: "downloaded", version: "0.3.9", revision: 3 }));
		assert.equal(pill().getAttribute("data-action"), "install", "the earlier confirm doesn't carry over");
		assert.equal(pill().getAttribute("aria-disabled"), null);
	});

	it("on a self-hosted server: a refused install (error state) or a failed request gives the normal button back", async () => {
		const ready = state({ status: "downloaded", version: "0.3.8", revision: 1 });
		let answer: () => Response = () => Response.json({ ...ready, revision: 2, message: "Restarting to install version 0.3.8…" });
		const posts: string[] = [];
		globalThis.fetch = async (input, init) => {
			if (init?.method === "POST") { posts.push(String(input)); return answer(); }
			return String(input) === "/api/updates/running" ? Response.json({ items: [] }) : Response.json(ready);
		};
		const host = await mount(<SidebarUpdatePill />);
		const pill = () => q(host, "update-pill")!;
		const confirm = async () => {
			await click(pill());
			await click(q(document, "install-update-confirm"));
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		};
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		await confirm();
		assert.deepEqual(posts, ["/api/updates/install"]);
		assert.equal(pill().getAttribute("data-action"), "restarting", "the server is restarting: it stays");
		assert.equal(pill().getAttribute("aria-label"), "Restarting to install 0.3.8…");
		for (const { root, host: old } of roots.splice(0)) { await act(async () => { root.unmount(); }); old.remove(); }

		answer = () => Response.json({ ...ready, revision: 2, status: "error", message: "Couldn't reach the launcher: gone" });
		const refused = await mount(<SidebarUpdatePill />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		await click(q(refused, "update-pill"));
		await click(q(document, "install-update-confirm"));
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.equal(q(refused, "update-pill")!.getAttribute("data-action"), "check", "the existing error state: the check button");
		for (const { root, host: old } of roots.splice(0)) { await act(async () => { root.unmount(); }); old.remove(); }

		answer = () => new Response("nope", { status: 502 });
		const failed = await mount(<SidebarUpdatePill />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		await click(q(failed, "update-pill"));
		await click(q(document, "install-update-confirm"));
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.equal(q(failed, "update-pill")!.getAttribute("data-action"), "install", "the request failed: Install again");
		assert.equal(q(failed, "update-pill")!.getAttribute("aria-disabled"), null);
	});

	it("from install with release notes to restarting, the same button stays mounted and keeps keyboard focus", async () => {
		const notes = [{ version: "0.3.8", items: ["A change"] }];
		bridge(state({ status: "downloaded", version: "0.3.8", revision: 1, releaseNotes: notes }));
		const host = await mount(<SidebarUpdatePill />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		const before = q(host, "update-pill")!;
		// Keyboard focus (linkedom can't match :focus-visible).
		const matches = before.matches.bind(before);
		before.matches = (selector: string) => selector === ":focus-visible" || matches(selector);
		await act(async () => { before.focus(); });
		await click(before);
		await click(q(document, "install-update-confirm"));
		// The dialog hands focus back to its opener on the next tick.
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
		assert.equal(q(host, "update-pill")!.getAttribute("data-action"), "restarting");
		// assert.ok, not assert.equal: a failing equal would print linkedom's whole node graph.
		assert.ok(q(host, "update-pill") === before, "not remounted");
		assert.ok(before.isConnected);
		assert.ok(document.activeElement === before, "focus is still on the button");
	});

	it("from download with release notes to downloading, the same button stays mounted with focus on it", async () => {
		const b = bridge(state({ status: "available", version: "0.3.8", revision: 1, releaseNotes: [{ version: "0.3.8", items: ["A change"] }] }));
		const host = await mount(<SidebarUpdatePill />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		const before = q(host, "update-pill")!;
		const matches = before.matches.bind(before);
		before.matches = (selector: string) => selector === ":focus-visible" || matches(selector);
		await act(async () => { before.focus(); });
		await click(before);
		assert.equal(b.calls.download, 1);
		await b.push(state({ status: "downloading", version: "0.3.8", revision: 2 }));
		assert.equal(q(host, "update-pill")!.getAttribute("data-action"), "downloading");
		assert.ok(q(host, "update-pill") === before, "not remounted");
		assert.ok(document.activeElement === before);
	});

	it("an install the app turns down (an Update everything run owns the updater), or a bridge without installUpdate, never renders Restarting", async () => {
		const b = bridge(state({ status: "downloaded", version: "0.3.8", revision: 1 }));
		let answer = deferred<boolean>();
		window.lh!.installUpdate = () => { b.calls.install++; return answer.promise; };
		const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
		const watch = async () => {
			const host = await mount(<SidebarUpdatePill />);
			await settle();
			const pill = q(host, "update-pill")!;
			// Every value React writes to this button (it stays the same element), so even one render shows.
			const shown: string[] = [];
			const setAttribute = pill.setAttribute.bind(pill);
			pill.setAttribute = (name: string, value: string) => { if (name === "data-action" || name === "aria-label") shown.push(value); setAttribute(name, value); };
			await click(pill);
			await click(q(document, "install-update-confirm"));
			return { pill, shown };
		};
		const first = await watch();
		assert.equal(b.calls.install, 1);
		assert.equal(first.pill.getAttribute("data-action"), "install", "while the app answers: the normal button");
		assert.equal(first.pill.getAttribute("aria-disabled"), null);
		answer.resolve(false);
		await settle();
		assert.equal(first.pill.getAttribute("data-action"), "install", "main ignored it");
		assert.equal(first.pill.getAttribute("aria-disabled"), null);
		assert.ok(!first.shown.some((value) => value === "restarting" || value.startsWith("Restarting")), `never Restarting: ${first.shown.join(", ")}`);
		for (const { root, host: old } of roots.splice(0)) { await act(async () => { root.unmount(); }); old.remove(); }

		delete window.lh!.installUpdate;
		const bare = await watch();
		await settle();
		assert.equal(bare.pill.getAttribute("data-action"), "install");
		assert.ok(!bare.shown.includes("restarting"));
		for (const { root, host: old } of roots.splice(0)) { await act(async () => { root.unmount(); }); old.remove(); }

		answer = deferred<boolean>();
		window.lh!.installUpdate = () => { b.calls.install++; return answer.promise; };
		const accepted = await watch();
		assert.equal(accepted.pill.getAttribute("data-action"), "install", "not before the app's yes");
		answer.resolve(true);
		await settle();
		assert.equal(accepted.pill.getAttribute("data-action"), "restarting");
	});

	it("an install the desktop bridge throws on never rejects; the button is Install again", async () => {
		bridge(state({ status: "downloaded", version: "0.3.8", revision: 1 }));
		window.lh!.installUpdate = () => { throw new Error("bridge gone"); };
		const host = await mount(<SidebarUpdatePill />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		await click(q(host, "update-pill"));
		await click(q(document, "install-update-confirm"));
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.equal(q(host, "update-pill")!.getAttribute("data-action"), "install");
		assert.equal(q(host, "update-pill")!.getAttribute("aria-disabled"), null);
	});

	it("under reduced motion the restarting arrow doesn't spin; it is still grey, disabled and labeled", async () => {
		const query = { matches: true, addEventListener() {}, removeEventListener() {} };
		Object.defineProperty(dom.window, "matchMedia", { configurable: true, writable: true, value: () => query });
		try {
			bridge(state({ status: "downloaded", version: "0.3.8", revision: 1 }));
			const host = await mount(<SidebarUpdatePill />);
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
			await click(q(host, "update-pill"));
			await click(q(document, "install-update-confirm"));
			const pill = q(host, "update-pill")!;
			assert.equal(pill.getAttribute("data-action"), "restarting");
			assert.equal(pill.getAttribute("aria-disabled"), "true");
			assert.equal(pill.getAttribute("aria-label"), "Restarting to install 0.3.8…");
			const icon = q(host, "update-control-restart-icon")!;
			assert.equal(icon.getAttribute("data-spinning"), null);
			assert.doesNotMatch(icon.getAttribute("class") ?? "", /animate-spin/);
		} finally {
			delete (dom.window as { matchMedia?: unknown }).matchMedia;
		}
	});

	it("a server newer than the page reloads it by itself, even with unsent text; the button stays as the fallback and asks first", async () => {
		const b = bridge(state({ status: "up-to-date", revision: 1, runningVersion: "0.6.1-nightly.20261118.65" }));
		const composer = document.createElement("div"); composer.setAttribute("data-testid", "composer");
		composer.innerHTML = '<div role="textbox" contenteditable="true">half a question</div>'; document.body.append(composer);
		let reloads = 0;
		try {
			const host = await mount(<SidebarUpdatePill pageVersion="0.6.1-nightly.20261118.64" reload={() => { reloads++; }} />);
			const pill = () => q(host, "update-pill")!;
			assert.equal(reloads, 1, "reloads by itself, unsent text or not");
			assert.equal(q(document, "reload-confirm-dialog"), null, "no confirm for the automatic reload");
			assert.equal(pill().getAttribute("data-action"), "reload");
			assert.equal(pill().getAttribute("aria-label"), "Updated to 0.6.1-nightly.20261118.65. Click to reload.");
			await b.push(state({ status: "up-to-date", revision: 2, runningVersion: "0.6.1-nightly.20261118.65" }));
			assert.equal(reloads, 1, "once per version");

			// The fallback button: unsent text asks first.
			await click(pill());
			assert.equal(reloads, 1, "asks first");
			assert.equal(q(document, "reload-confirm-title")!.textContent, "You have an unsent message. Reload anyway?");
			await click(q(document, "reload-confirm-cancel")); assert.equal(reloads, 1);
			assert.equal(q(document, "reload-confirm-dialog"), null);
			await click(pill()); await click(q(document, "reload-confirm-reload")); assert.equal(reloads, 2);
		} finally { composer.remove(); }
		await click(q(document, "update-pill")); assert.equal(reloads, 3, "no unsent text: the button reloads at once");
		assert.equal(b.calls.check, 0);

		await b.push(state({ status: "up-to-date", revision: 3, runningVersion: "0.6.1-nightly.20261118.64" }));
		assert.equal(q(document, "update-pill")!.getAttribute("data-action"), "check", "same version as the page: no reload");
	});

	it("reloads by itself at most once per server version per tab, so a page that stays stale keeps the button instead of looping", async () => {
		const b = bridge(state({ status: "up-to-date", revision: 1, runningVersion: "0.6.1-nightly.20261118.65" }));
		let reloads = 0;
		await mount(<SidebarUpdatePill pageVersion="0.6.1-nightly.20261118.64" reload={() => { reloads++; }} />);
		assert.equal(reloads, 1);
		for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
		// The reloaded page still runs .64 code (a stale cache): same tab, same server version.
		const host = await mount(<SidebarUpdatePill pageVersion="0.6.1-nightly.20261118.64" reload={() => { reloads++; }} />);
		assert.equal(reloads, 1, "no second automatic reload for .65");
		assert.equal(q(host, "update-pill")!.getAttribute("data-action"), "reload", "the button stays");
		// A later, newer server version reloads by itself again.
		await b.push(state({ status: "up-to-date", revision: 2, runningVersion: "0.6.1-nightly.20261118.66" }));
		assert.equal(reloads, 2);
	});

	it("a stale tab never reloads twice for a version, even when the server goes back and forth (.73, .74, .73)", async () => {
		const b = bridge(state({ status: "up-to-date", revision: 1, runningVersion: "0.6.1-nightly.20261118.73" }));
		let reloads = 0;
		const host = await mount(<SidebarUpdatePill pageVersion="0.6.1-nightly.20261118.72" reload={() => { reloads++; }} />);
		assert.equal(reloads, 1, ".73: reloads");
		await b.push(state({ status: "up-to-date", revision: 2, runningVersion: "0.6.1-nightly.20261118.74" }));
		assert.equal(reloads, 2, ".74: reloads");
		await b.push(state({ status: "up-to-date", revision: 3, runningVersion: "0.6.1-nightly.20261118.73" }));
		assert.equal(reloads, 2, ".73 again: no second automatic reload");
		await b.push(state({ status: "up-to-date", revision: 4, runningVersion: "0.6.1-nightly.20261118.74" }));
		assert.equal(reloads, 2, ".74 again: none either");
		assert.equal(q(host, "update-pill")!.getAttribute("data-action"), "reload", "the button stays");
		assert.deepEqual(JSON.parse(tabStorage.get("lh-auto-reloaded-versions")!), ["0.6.1-nightly.20261118.73", "0.6.1-nightly.20261118.74"]);
	});

	it("a page without an exact build version never reloads by itself", async () => {
		bridge(state({ status: "up-to-date", revision: 1, runningVersion: "0.6.1-nightly.20261118.65" }));
		let reloads = 0;
		await mount(<SidebarUpdatePill pageVersion="" reload={() => { reloads++; }} />);
		assert.equal(reloads, 0);
	});

	it("without usable sessionStorage it never reloads by itself, only on a click", async () => {
		Object.defineProperty(dom.window, "sessionStorage", { configurable: true, get() { throw new Error("blocked"); } });
		bridge(state({ status: "up-to-date", revision: 1, runningVersion: "0.6.1-nightly.20261118.65" }));
		let reloads = 0;
		const host = await mount(<SidebarUpdatePill pageVersion="0.6.1-nightly.20261118.64" reload={() => { reloads++; }} />);
		assert.equal(reloads, 0);
		await click(q(host, "update-pill")); assert.equal(reloads, 1);
	});

	it("after a rollback (server older than the page) it does not reload by itself; the button offers it with its own wording", async () => {
		bridge(state({ status: "error", revision: 1, runningVersion: "0.6.1-nightly.20261118.64" }));
		let reloads = 0;
		const host = await mount(<SidebarUpdatePill pageVersion="0.6.1-nightly.20261118.65" reload={() => { reloads++; }} />);
		assert.equal(reloads, 0, "no automatic reload after a rollback");
		const pill = q(host, "update-pill")!;
		assert.equal(pill.getAttribute("data-action"), "reload");
		assert.equal(pill.getAttribute("aria-label"), "Server is on 0.6.1-nightly.20261118.64. Click to reload.");
		await click(pill); assert.equal(reloads, 1);
	});

	it("unsent text in any editable text field asks first; read-only, disabled, hidden and search boxes don't", () => {
		const box = document.createElement("div");
		const field = (html: string) => { box.innerHTML = html; return hasUnsentMessage(box); };
		assert.equal(field('<textarea aria-label="Side question">why?</textarea>'), true, "the side-question box (a textarea)");
		assert.equal(field('<textarea>  </textarea>'), false, "whitespace only");
		assert.equal(field('<input type="text" value="a comment">'), true, "a text input");
		assert.equal(field('<input value="no type is text">'), true);
		assert.equal(field('<div role="textbox" contenteditable="true">a draft</div>'), true, "a PathInput");
		assert.equal(field('<textarea readonly>shown text</textarea>'), false, "read-only");
		assert.equal(field('<input type="text" disabled value="x">'), false, "disabled");
		assert.equal(field('<div hidden><textarea>x</textarea></div>'), false, "hidden");
		assert.equal(field('<input type="text" placeholder="Search…" value="algebra">'), false, "a search box");
		assert.equal(field('<input placeholder="Find in session…" value="x">'), false, "a find box");
		assert.equal(field('<input type="search" value="x">'), false, "type=search");
		assert.equal(field('<input type="checkbox" value="on">'), false, "not a text field");
		assert.equal(field('<input type="number" value="3">'), false);
		assert.equal(field('<div role="textbox" contenteditable="false">x</div>'), false);
	});

	it("the pill's hover shows T3-style notes: What's changed, Changes in X, release links", async () => {
		const notes = [
			{ version: "0.3.9", items: ["**Cards.** Practice with cards.", "Plain item"] },
			{ version: "0.3.8", items: ["Older change"] },
		];
		bridge(state({ status: "downloaded", version: "0.3.9", revision: 1, releaseNotes: notes, omittedReleaseCount: 2 }));
		const host = await mount(<SidebarUpdatePill />);
		const pill = q(host, "update-pill")!;
		await act(async () => { pill.dispatchEvent(new window.Event("pointerover", { bubbles: true })); pill.dispatchEvent(new window.Event("pointerenter")); });
		const popover = q(document, "update-pill-notes");
		assert.ok(popover, "hover opens the notes");
		const headings = [...popover!.querySelectorAll("h3")].map((h) => h.textContent);
		assert.deepEqual(headings, ["What's changed", "Changes in 0.3.8"]);
		assert.equal(popover!.querySelector("strong")!.textContent, "Cards.");
	});

	it("T3's hover rule: every state about an offered update shows its notes when there are any; the others keep the tooltip", async () => {
		const notes = [{ version: "0.3.8", items: ["A change"] }];
		const cases: Array<[string, Partial<UpdateState>, boolean]> = [
			["download", { status: "available", version: "0.3.8" }, true],
			["downloading", { status: "downloading", version: "0.3.8", downloadPercent: 30 }, true],
			["install", { status: "downloaded", version: "0.3.8" }, true],
			["check", { status: "up-to-date" }, false],
			["unavailable", { status: "disabled" }, false],
			["dismiss-notice", { status: "up-to-date", notice: { kind: "rolled-back", version: "0.3.8", text: "Rolled back to 0.3.7.", at: 1 } }, false],
		];
		for (const [action, over, showsNotes] of cases) {
			bridge(state({ revision: 1, releaseNotes: notes, ...over }));
			const host = await mount(<SidebarUpdatePill />);
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
			const pill = q(host, "update-pill")!;
			assert.equal(pill.getAttribute("data-action"), action);
			await hover(pill);
			assert.equal(!!q(document, "update-pill-notes"), showsNotes, `${action}: notes`);
			assert.equal(await plainTooltipOpens(pill), !showsNotes, `${action}: the plain tooltip`);
			const { root } = roots.pop()!; await act(async () => { root.unmount(); }); host.remove();
		}
		// The same states with no notes: the plain tooltip, never an empty popover.
		bridge(state({ status: "available", version: "0.3.8", revision: 1 }));
		const plain = await mount(<SidebarUpdatePill />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		await hover(q(plain, "update-pill")!);
		assert.ok(!q(document, "update-pill-notes"));
		assert.equal(await plainTooltipOpens(q(plain, "update-pill")!), true);
	});

	it("after Install and restart the notes still show on hover, as T3's do while its action is pending", async () => {
		const notes = [{ version: "0.3.8", items: ["A change"] }];
		bridge(state({ status: "downloaded", version: "0.3.8", revision: 1, releaseNotes: notes }));
		const host = await mount(<SidebarUpdatePill />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		await click(q(host, "update-pill"));
		await click(q(document, "install-update-confirm"));
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
		const pill = q(host, "update-pill")!;
		assert.equal(pill.getAttribute("data-action"), "restarting");
		await hover(pill);
		assert.ok(q(document, "update-pill-notes"));
		assert.equal(q(document, "update-pill-notes")!.firstElementChild!.textContent, "Restarting to install 0.3.8…");
	});

	it("from the keyboard: Tab moves into the notes' links and through them, Shift+Tab goes back, Escape closes them onto the button", async () => {
		const notes = [{ version: "0.3.9", items: ["Newest"] }, { version: "0.3.8", items: ["Older"] }];
		bridge(state({ status: "downloaded", version: "0.3.9", revision: 1, releaseNotes: notes }));
		const host = await mount(<SidebarUpdatePill homepage="https://github.com/o/r" />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		// What reaches the window: the app's Tab (cycle text fields), Shift+Tab (thinking) and Escape (abort a turn).
		const reached: string[] = [];
		const onWindow = (event: Event) => { reached.push(`${(event as KeyboardEvent).shiftKey ? "Shift+" : ""}${(event as KeyboardEvent).key}`); };
		window.addEventListener("keydown", onWindow);
		try {
			const pill = keyboardFocusable(q(host, "update-pill")!);
			await act(async () => { pill.focus(); });
			assert.ok(q(document, "update-pill-notes"), "keyboard focus opens the notes");
			await key(pill, "Tab");
			const links = [...q(document, "update-pill-notes")!.querySelectorAll("a")];
			assert.equal(links.length, 2, "one release link per release");
			assert.ok(document.activeElement === links[0], "Tab is on the first link");
			await key(links[0], "Tab");
			assert.ok(document.activeElement === links[1], "Tab moves to the next link");
			await key(links[1], "Tab", { shiftKey: true });
			assert.ok(document.activeElement === links[0], "Shift+Tab moves back");
			await key(links[0], "Tab", { shiftKey: true });
			assert.ok(document.activeElement === pill, "Shift+Tab from the first link is the button");
			assert.ok(q(document, "update-pill-notes"), "with the notes still open");
			assert.deepEqual(reached, [], "none of those reached the app's own Tab and Shift+Tab");

			await key(pill, "Tab");
			await key(links[0], "Escape");
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
			assert.ok(document.activeElement === pill, "Escape returns focus to the button");
			assert.ok(!q(document, "update-pill-notes"), "and the notes stay closed");
			assert.deepEqual(reached, [], "Escape never reaches the turn abort");

			// Escape on the button itself closes notes its focus opened.
			await act(async () => { pill.blur(); });
			await act(async () => { pill.focus(); });
			assert.ok(q(document, "update-pill-notes"));
			await key(pill, "Escape");
			assert.ok(!q(document, "update-pill-notes"));
			assert.deepEqual(reached, []);

			// Past the last link the notes close onto the button, and the app's Tab goes on.
			await key(pill, "Tab");
			const again = [...q(document, "update-pill-notes")!.querySelectorAll("a")];
			await key(again[0]!, "Tab");
			await key(again[1]!, "Tab");
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
			assert.ok(!q(document, "update-pill-notes"));
			assert.ok(document.activeElement === pill);
			assert.deepEqual(reached, ["Tab"]);
		} finally {
			window.removeEventListener("keydown", onWindow);
		}
	});

	it("Escape with focus in the composer closes hover-opened notes first, and reaches neither the field nor the turn abort", async () => {
		bridge(state({ status: "downloaded", version: "0.3.9", revision: 1, releaseNotes: [{ version: "0.3.9", items: ["Newest"] }] }));
		const fieldKeys: string[] = [];
		const host = await mount(<><SidebarUpdatePill /><textarea data-testid="composer" onKeyDown={(event) => fieldKeys.push(event.key)} /></>);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		const reached: string[] = [];
		const onWindow = (event: Event) => { reached.push((event as KeyboardEvent).key); };
		window.addEventListener("keydown", onWindow);
		// React's select plugin reads the selection on a field's keys (linkedom has none).
		const hadSelection = Object.getOwnPropertyDescriptor(dom.window, "getSelection");
		Object.assign(dom.window, { getSelection: () => ({ anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, rangeCount: 0 }) });
		try {
			const composer = q(host, "composer")!;
			await act(async () => { composer.focus(); });
			await hover(q(host, "update-pill")!);
			assert.ok(q(document, "update-pill-notes"), "the pointer opened the notes");
			await key(composer, "Escape");
			assert.ok(!q(document, "update-pill-notes"), "Escape closed them");
			assert.deepEqual([fieldKeys, reached], [[], []], "one Esc, one action: nothing else saw it");
			assert.ok(document.activeElement === composer, "focus stays in the composer");
			await key(composer, "Escape");
			assert.deepEqual([fieldKeys, reached], [["Escape"], ["Escape"]], "with the notes closed Escape is the app's again");
		} finally {
			window.removeEventListener("keydown", onWindow);
			if (hadSelection) Object.defineProperty(dom.window, "getSelection", hadSelection); else Reflect.deleteProperty(dom.window, "getSelection");
		}
	});

	it("Escape with a modifier from the composer closes hover-opened notes too, and never reaches the turn abort", async () => {
		bridge(state({ status: "downloaded", version: "0.3.9", revision: 1, releaseNotes: [{ version: "0.3.9", items: ["Newest"] }] }));
		const fieldKeys: string[] = [];
		const host = await mount(<><SidebarUpdatePill /><textarea data-testid="composer" onKeyDown={(event) => fieldKeys.push(event.key)} /></>);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		const reached: string[] = [];
		const onWindow = (event: Event) => { reached.push((event as KeyboardEvent).key); };
		window.addEventListener("keydown", onWindow);
		// React's select plugin reads the selection on a field's keys (linkedom has none).
		const hadSelection = Object.getOwnPropertyDescriptor(dom.window, "getSelection");
		Object.assign(dom.window, { getSelection: () => ({ anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, rangeCount: 0 }) });
		try {
			const composer = q(host, "composer")!;
			await act(async () => { composer.focus(); });
			for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) {
				await hover(q(host, "update-pill")!);
				assert.ok(q(document, "update-pill-notes"), `${modifier}: the pointer opened the notes`);
				await key(composer, "Escape", { [modifier]: true });
				assert.ok(!q(document, "update-pill-notes"), `${modifier}+Escape closed the notes`);
				assert.deepEqual([fieldKeys, reached], [[], []], `${modifier}+Escape reached neither the field nor the turn abort`);
			}
		} finally {
			window.removeEventListener("keydown", onWindow);
			if (hadSelection) Object.defineProperty(dom.window, "getSelection", hadSelection); else Reflect.deleteProperty(dom.window, "getSelection");
		}
	});

	it("leaving the notes closes them after a mouse click on a link, but not while a link holds keyboard focus", async () => {
		bridge(state({ status: "downloaded", version: "0.3.9", revision: 1, releaseNotes: [{ version: "0.3.9", items: ["Newest"] }] }));
		const host = await mount(<SidebarUpdatePill homepage="https://github.com/o/r" />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		const pill = q(host, "update-pill")!;
		const leave = async (element: Element) => {
			// React makes pointer leave from pointerout to an element outside.
			const out = Object.assign(new window.Event("pointerout", { bubbles: true, cancelable: true }), { pointerType: "mouse", relatedTarget: document.body });
			await act(async () => { element.dispatchEvent(out); await new Promise((resolve) => setTimeout(resolve, 200)); });
		};
		await hover(pill);
		const clicked = q(document, "update-pill-notes")!.querySelector("a")!;
		// A mouse click focuses the link without :focus-visible.
		clicked.matches = ((matches) => (selector: string) => selector !== ":focus-visible" && matches(selector))(clicked.matches.bind(clicked));
		await act(async () => { clicked.focus(); });
		await leave(q(document, "update-pill-notes")!);
		assert.ok(!q(document, "update-pill-notes"), "a clicked link doesn't hold the notes open");

		await hover(pill);
		const typed = keyboardFocusable(q(document, "update-pill-notes")!.querySelector("a")!);
		await act(async () => { typed.focus(); });
		await leave(q(document, "update-pill-notes")!);
		assert.ok(q(document, "update-pill-notes"), "keyboard focus in the notes holds them open");
	});

	it("notes that stop applying with focus in them hand focus back to the button; notes that start applying under keyboard focus open", async () => {
		const notes = [{ version: "0.3.9", items: ["Newest"] }];
		const b = bridge(state({ status: "available", version: "0.3.9", revision: 1, releaseNotes: notes }));
		const host = await mount(<SidebarUpdatePill homepage="https://github.com/o/r" />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		const pill = keyboardFocusable(q(host, "update-pill")!);
		await act(async () => { pill.focus(); });
		await key(pill, "Tab");
		assert.ok(document.activeElement === q(document, "update-pill-notes")!.querySelector("a"));
		// The offer goes away (a check found nothing newer): no notes, and focus is not dropped.
		await b.push(state({ status: "up-to-date", revision: 2 }));
		assert.ok(!q(document, "update-pill-notes"));
		assert.ok(document.activeElement === pill, "focus is back on the button");
		// A new offer arrives while the button holds keyboard focus: its notes open, as T3's do.
		await b.push(state({ status: "available", version: "0.3.10", revision: 3, releaseNotes: [{ version: "0.3.10", items: ["Newer"] }] }));
		assert.ok(q(document, "update-pill-notes"), "the notes open under keyboard focus");
		assert.ok(q(document, "update-pill-notes")!.textContent!.includes("Newer"));
	});

	it("Escape belongs to a foreground layer (Settings, a dialog, a popover) over hover-opened notes: the layer closes, the notes stay", async () => {
		bridge(state({ status: "downloaded", version: "0.3.9", revision: 1, releaseNotes: [{ version: "0.3.9", items: ["Newest"] }] }));
		const closes: string[] = [];
		function Foreground() {
			const rootRef = React.useRef<HTMLDivElement>(null);
			useInteractionLayer({ kind: "modal", enabled: true, rootRef, onClose: (reason) => { closes.push(reason); return "handled-without-close"; } });
			return <div ref={rootRef} data-testid="foreground"><button type="button" data-testid="foreground-button">in the dialog</button></div>;
		}
		const host = await mount(<><SidebarUpdatePill /><Foreground /></>);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		await hover(q(host, "update-pill")!);
		assert.ok(q(document, "update-pill-notes"), "the pointer opened the notes");
		const inDialog = q(host, "foreground-button")!;
		await act(async () => { inDialog.focus(); });
		await key(inDialog, "Escape");
		assert.deepEqual(closes, ["escape"], "the foreground layer got its Escape");
		assert.ok(q(document, "update-pill-notes"), "the background notes stay open");
	});

	it("inside the notes Escape with a modifier closes them too, and never reaches the turn abort", async () => {
		bridge(state({ status: "downloaded", version: "0.3.9", revision: 1, releaseNotes: [{ version: "0.3.9", items: ["Newest"] }] }));
		const host = await mount(<SidebarUpdatePill homepage="https://github.com/o/r" />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		const reached: string[] = [];
		const onWindow = (event: Event) => { reached.push(`${(event as KeyboardEvent).shiftKey ? "Shift+" : ""}${(event as KeyboardEvent).key}`); };
		window.addEventListener("keydown", onWindow);
		try {
			const pill = keyboardFocusable(q(host, "update-pill")!);
			await act(async () => { pill.focus(); });
			await key(pill, "Tab");
			const link = q(document, "update-pill-notes")!.querySelector("a")!;
			assert.ok(document.activeElement === link);
			await key(link, "Escape", { shiftKey: true });
			assert.ok(!q(document, "update-pill-notes"), "Shift+Escape closed the notes");
			assert.ok(document.activeElement === pill, "onto the button");
			assert.deepEqual(reached, [], "the abort shortcut never saw it");
		} finally {
			window.removeEventListener("keydown", onWindow);
		}
	});

	it("a plain tooltip closed while notes applied stays closed once they stop applying", async () => {
		const b = bridge(state({ status: "up-to-date", revision: 1 }));
		const host = await mount(<SidebarUpdatePill />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		const pill = q(host, "update-pill")!;
		await hover(pill);
		assert.equal(await plainTooltipOpens(pill), true, "the plain tooltip opened");
		await b.push(state({ status: "available", version: "0.3.9", revision: 2, releaseNotes: [{ version: "0.3.9", items: ["Newest"] }] }));
		assert.equal(pill.getAttribute("data-state"), "closed", "the notes replace it");
		const out = Object.assign(new window.Event("pointerout", { bubbles: true, cancelable: true }), { pointerType: "mouse", relatedTarget: document.body });
		await act(async () => { pill.dispatchEvent(out); await new Promise((resolve) => setTimeout(resolve, 200)); });
		await b.push(state({ status: "up-to-date", revision: 3 }));
		assert.equal(q(host, "update-pill")!.getAttribute("data-state"), "closed", "the pointer left: no tooltip comes back");
	});

	it("without notes the pill leaves Tab and Escape to the app", async () => {
		bridge(state({ status: "downloaded", version: "0.3.9", revision: 1 }));
		const host = await mount(<SidebarUpdatePill homepage="https://github.com/o/r" />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		const reached: string[] = [];
		const onWindow = (event: Event) => { reached.push((event as KeyboardEvent).key); };
		window.addEventListener("keydown", onWindow);
		try {
			const pill = keyboardFocusable(q(host, "update-pill")!);
			await act(async () => { pill.focus(); });
			await key(pill, "Tab");
			await key(pill, "Escape");
			assert.deepEqual(reached, ["Tab", "Escape"]);
		} finally {
			window.removeEventListener("keydown", onWindow);
		}
	});

	it("release note sections link each group's release with T3's labels, and the older ones", () => {
		const html = renderToStaticMarkup(<ReleaseNoteSections homepage="https://github.com/o/r" omittedReleaseCount={2}
			groups={[{ version: "0.3.9", items: ["a"] }, { version: "0.3.8", items: ["b", "c"], totalItems: 7 }, { version: "0.3.7", items: ["d"], totalItems: 2 }]} />);
		assert.ok(html.includes('href="https://github.com/o/r/releases/tag/v0.3.9"'));
		assert.ok(html.includes('href="https://github.com/o/r/releases/tag/v0.3.8"'));
		assert.equal(html.match(/View release on GitHub/g)?.length, 1, "every change shown: View release on GitHub");
		assert.ok(html.includes("5 more changes on GitHub"), "the rest of a cut release");
		assert.ok(html.includes("1 more change on GitHub"), "singular");
		assert.ok(html.includes('href="https://github.com/o/r/releases"'));
		assert.ok(html.includes("2 older releases on GitHub"));
		const one = renderToStaticMarkup(<ReleaseNoteSections homepage="https://github.com/o/r" omittedReleaseCount={1} groups={[{ version: "0.3.9", items: ["a"] }]} />);
		assert.ok(one.includes("1 older release on GitHub"));
	});

	it("a generated summary (T3's): its stats label the link, an intro replaces the items, the footer follows, and only older versions get an age heading", () => {
		const now = Date.parse("2026-11-20T12:00:00Z");
		const html = renderToStaticMarkup(<ReleaseNoteSections homepage="https://github.com/o/r" omittedReleaseCount={0} offeredVersion="0.3.9" now={now}
			groups={[
				{ version: "0.3.9", releasedAt: "2026-11-20T09:00:00Z", items: ["**Cards.** Practice with cards."], stats: "12 changes from 2 contributors", footer: "Plus 3 more bug fixes." },
				{ version: "0.3.8", releasedAt: "2026-11-18", items: ["hidden by the intro"], intro: "2 bug fixes.", stats: "2 changes from 1 contributor" },
				{ version: "0.3.7", items: ["plain"] },
			]} />);
		const text = parseHTML(`<div>${html}</div>`).document;
		const headings = [...text.querySelectorAll("h3")].map((h) => h.textContent);
		assert.deepEqual(headings, ["0.3.8 · 2d ago", "Changes in 0.3.7"], "no heading for the offered version's summary; an older summary reads version and age");
		const links = [...text.querySelectorAll("a")].map((a) => a.textContent);
		assert.deepEqual(links, ["12 changes from 2 contributors", "2 changes from 1 contributor", "View release on GitHub"]);
		assert.equal(text.querySelector("[data-testid='release-notes-footer']")?.textContent, "Plus 3 more bug fixes.");
		assert.equal(text.querySelector("[data-testid='release-notes-intro']")?.textContent, "2 bug fixes.");
		assert.ok(!html.includes("hidden by the intro"), "an intro shows instead of the items");
	});

	it("the old-client copy of a footer or intro shows once, as itself; a bullet with the same text elsewhere stays", () => {
		const footer = "Plus 2 more bug fixes.";
		const html = renderToStaticMarkup(<ReleaseNoteSections homepage="https://github.com/o/r" omittedReleaseCount={0}
			groups={[
				{ version: "0.3.9", items: ["**Cards.** Practice.", footer], footer },
				{ version: "0.3.8", items: ["3 bug fixes."], intro: "3 bug fixes.", stats: "3 changes from 1 contributor" },
				{ version: "0.3.7", items: [footer, "New feature.", footer], footer },
			]} />);
		const text = parseHTML(`<div>${html}</div>`).document;
		const sections = [...text.querySelectorAll("section")];
		assert.deepEqual([...sections[0]!.querySelectorAll("li")].map((li) => li.textContent), ["Cards. Practice."], "the footer copy isn't a bullet");
		assert.equal(sections[0]!.querySelector("[data-testid='release-notes-footer']")?.textContent, footer);
		assert.equal(sections[1]!.querySelectorAll("li").length, 0, "an intro-only release shows its paragraph, no list");
		assert.equal(sections[1]!.querySelector("[data-testid='release-notes-intro']")?.textContent, "3 bug fixes.");
		assert.deepEqual([...sections[2]!.querySelectorAll("li")].map((li) => li.textContent), [footer, "New feature."], "only the trailing copy goes");
		assert.deepEqual([...text.querySelectorAll("a")].map((a) => a.textContent), ["View release on GitHub", "3 changes from 1 contributor", "View release on GitHub"], "and no copy counts as a change left out");
	});

	it("an intro at its bound keeps T3's count once its copy is cut to 220 characters", () => {
		const intro = "y".repeat(600);
		const cut = `${"y".repeat(217)}...`;
		const html = renderToStaticMarkup(<ReleaseNoteSections homepage="https://github.com/o/r" omittedReleaseCount={0}
			// totalItems as main and the server set it: the intro, counted once before the cut.
			groups={[{ version: "0.3.9", items: [cut], intro, totalItems: 1 }, { version: "0.3.8", items: ["3 bug fixes."], intro: "3 bug fixes.", totalItems: 1 }]} />);
		const links = [...parseHTML(`<div>${html}</div>`).document.querySelectorAll("a")].map((a) => a.textContent);
		assert.deepEqual(links, ["1 more change on GitHub", "1 more change on GitHub"], "a long intro's cut copy counts like a short one's");
	});

	it("formatReleaseAge is T3's: feed times read 3h ago, build days read today or 2d ago, an unreadable time reads nothing", () => {
		const now = Date.parse("2026-11-20T12:00:00Z");
		assert.equal(formatReleaseAge("2026-11-20T11:59:30Z", now), "just now");
		assert.equal(formatReleaseAge("2026-11-20T11:55:00Z", now), "5m ago");
		assert.equal(formatReleaseAge("2026-11-20T09:00:00Z", now), "3h ago");
		assert.equal(formatReleaseAge("2026-11-17T12:00:00Z", now), "3d ago");
		assert.equal(formatReleaseAge("2026-11-21T00:00:00Z", now), "just now", "a clock behind the feed is not negative");
		assert.equal(formatReleaseAge("2026-11-20", now), "today");
		assert.equal(formatReleaseAge("2026-11-18", now), "2d ago");
		assert.equal(formatReleaseAge("2026-11-21", now), "today");
		assert.equal(formatReleaseAge("yesterday", now), "");
	});

	it("the popover's header: Update ready to download over X · age for an available update, else the hover text", () => {
		const now = Date.parse("2026-11-20T12:00:00Z");
		const groups = [{ version: "0.3.9", releasedAt: "2026-11-20T09:00:00Z", items: ["a"] }];
		const available = parseHTML(`<div>${renderToStaticMarkup(<UpdateReleaseNotes groups={groups} omittedReleaseCount={0} homepage="" offeredVersion="0.3.9" available title="Update 0.3.9 ready to download" now={now} />)}</div>`).document;
		assert.equal(available.querySelector("[data-testid='update-notes-header']")?.textContent, "Update ready to download0.3.9 · 3h ago");
		assert.equal(available.querySelector("[data-testid='update-notes-age']")?.textContent, "0.3.9 · 3h ago");
		const undated = parseHTML(`<div>${renderToStaticMarkup(<UpdateReleaseNotes groups={[{ version: "0.3.9", items: ["a"] }]} omittedReleaseCount={0} homepage="" offeredVersion="0.3.9" available title="" now={now} />)}</div>`).document;
		assert.equal(undated.querySelector("[data-testid='update-notes-age']")?.textContent, "0.3.9", "no time: the version alone");
		const downloaded = parseHTML(`<div>${renderToStaticMarkup(<UpdateReleaseNotes groups={groups} omittedReleaseCount={0} homepage="" offeredVersion="0.3.9" available={false} title="Update 0.3.9 downloaded. Click to restart and install." now={now} />)}</div>`).document;
		assert.equal(downloaded.querySelector("[data-testid='update-notes-header']")?.textContent, "Update 0.3.9 downloaded. Click to restart and install.");
	});

	it("a delayed older snapshot cannot overwrite a newer push in Settings or the banner", async () => {
		const snapshot = deferred<UpdateState>(); const b = bridge(state(), snapshot.promise);
		const host = await mount(<><UpdateSettings {...props} /><SidebarUpdatePill /></>);
		await b.push(state({ status: "downloaded", version: "0.3.8", revision: 4 }));
		await act(async () => { snapshot.resolve(state({ status: "checking", revision: 3 })); });
		assert.ok(q(host, "update-install")); assert.ok(q(host, "update-pill"));
	});

	it("snapshot rejection cannot erase an already received event and late callbacks are unsubscribed", async () => {
		const snapshot = deferred<UpdateState>(); const b = bridge(state(), snapshot.promise);
		const host = await mount(<UpdateSettings {...props} />);
		await b.push(state({ status: "downloaded", version: "0.3.8", revision: 1 }));
		await act(async () => { snapshot.reject(new Error("IPC disconnected")); });
		assert.ok(q(host, "update-install"));
		const { root } = roots.pop()!; await act(async () => { root.unmount(); }); host.remove();
		assert.equal(b.listeners.size, 0);
	});

	it("snapshot rejection without an event is handled with a generic message", async () => {
		const snapshot = deferred<UpdateState>(); bridge(state(), snapshot.promise);
		const host = await mount(<UpdateSettings {...props} />);
		await act(async () => { snapshot.reject(new Error("sensitive error")); });
		assert.equal(q(host, "update-status")!.textContent, "Couldn’t check for updates. Try again later.");
		assert.ok(!host.textContent!.includes("sensitive"));
	});
});

describe("Update everything in the desktop app's window onto a server (roadmap item 23)", () => {
	const V71 = "0.6.1-nightly.20261118.71";
	const V72 = "0.6.1-nightly.20261118.72";
	type Status = { version: string; target: string | null; phase: string; error: string | null; downloadPercent?: number | null; releaseNotes?: unknown; omittedReleaseCount?: unknown };
	function remote(status: Status, server: UpdateState) {
		let current = status;
		const calls = { getStatus: 0, check: 0, download: 0, install: 0, fetches: [] as string[] };
		window.lh = { desktopUpdate: {
			getStatus: async () => { calls.getStatus++; return current as never; },
			check: async () => { calls.check++; },
			download: async () => { calls.download++; },
			install: async () => { calls.install++; },
		} };
		globalThis.fetch = async (input) => { calls.fetches.push(String(input)); return Response.json(server); };
		return { calls, set: (next: Status) => { current = next; } };
	}
	const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
	const pillIn = async (status: Status, server: UpdateState) => {
		const r = remote(status, server);
		const host = await mount(<SidebarUpdatePill pageVersion={server.runningVersion} />);
		await settle();
		return { ...r, pill: () => q(host, "update-pill")! };
	};

	it("a newer app with the server behind it shows T3's everything state, and clicking only asks the app", async () => {
		const { calls, pill } = await pillIn({ version: V71, target: V72, phase: "available", error: null }, state({ status: "up-to-date", runningVersion: V71 }));
		assert.equal(pill().getAttribute("data-action"), "everything");
		assert.equal(pill().getAttribute("aria-label"), "Update this app and 1 server");
		assert.ok(pill().querySelector(".lucide-circle-arrow-up"), "T3's CircleArrowUp icon");
		await click(pill());
		await settle();
		assert.equal(calls.install, 1, "the app opens its own confirmation");
		assert.equal(calls.download, 0);
		assert.ok(!calls.fetches.some((url) => url.includes("/install")), "the page never installs anything on the server itself");
	});

	it("everything's hover shows this app's release notes under T3's summary (the hover bug: it showed nothing)", async () => {
		const appNotes = [{ version: V72, items: ["**Cards.** Practice with cards."] }];
		const serverNotes = [{ version: V72, items: ["Server-side copy"] }];
		const { pill } = await pillIn({ version: V71, target: V72, phase: "available", error: null, releaseNotes: appNotes, omittedReleaseCount: 0 },
			state({ status: "up-to-date", runningVersion: V71, releaseNotes: serverNotes }));
		assert.equal(pill().getAttribute("data-action"), "everything");
		await hover(pill());
		const popover = q(document, "update-pill-notes");
		assert.ok(popover, "the notes open");
		// T3's header follows the app's own state: available reads "Update ready to download" (SidebarUpdateReleaseNotes.tsx:82-93).
		assert.equal(q(popover!, "update-notes-header")!.firstElementChild!.firstElementChild!.textContent, "Update ready to download");
		assert.equal(q(popover!, "update-notes-age")!.textContent, V72);
		assert.equal(popover!.querySelector("strong")!.textContent, "Cards.", "this app's notes, not the server's");
		assert.ok(!popover!.textContent!.includes("Server-side copy"));
	});

	it("everything with this app's update downloaded heads the notes with T3's summary", async () => {
		const { pill } = await pillIn({ version: V71, target: V72, phase: "downloaded", error: null, releaseNotes: [{ version: V72, items: ["App change"] }], omittedReleaseCount: 0 },
			state({ status: "up-to-date", runningVersion: V71 }));
		assert.equal(pill().getAttribute("data-action"), "everything");
		await hover(pill());
		assert.equal(q(document, "update-notes-header")?.textContent, "Update this app and 1 server");
	});

	it("this app's download, downloading and install states show its notes; a run, or an app without notes, keeps the tooltip", async () => {
		const appNotes = [{ version: V72, items: ["App change"] }];
		const cases: Array<[string, Status, boolean]> = [
			["app-download", { version: V71, target: V72, phase: "available", error: null, releaseNotes: appNotes }, true],
			["app-install", { version: V71, target: V72, phase: "downloaded", error: null, releaseNotes: appNotes }, true],
			["downloading", { version: V71, target: V72, phase: "downloading", error: null, downloadPercent: 20, releaseNotes: appNotes }, true],
			// T3 shows no notes while an Update everything run is going.
			["restarting", { version: V71, target: V72, phase: "updating", error: null, releaseNotes: appNotes }, false],
			// An app from before the bridge carried notes.
			["app-download", { version: V71, target: V72, phase: "available", error: null }, false],
		];
		for (const [action, status, showsNotes] of cases) {
			const server = state({ status: "up-to-date", runningVersion: V72, committed: true });
			const r = remote(status, server);
			const host = await mount(<SidebarUpdatePill pageVersion={V72} />);
			await settle();
			assert.equal(q(host, "update-pill")!.getAttribute("data-action"), action);
			await hover(q(host, "update-pill")!);
			assert.equal(!!q(document, "update-pill-notes"), showsNotes, `${action}: notes`);
			if (showsNotes) assert.ok(q(document, "update-pill-notes")!.textContent!.includes("App change"));
			void r;
			const { root } = roots.pop()!; await act(async () => { root.unmount(); }); host.remove();
		}
	});

	it("reads the bridge's notes tolerantly: an older app's status or a malformed group is no notes, never a broken status", () => {
		assert.equal(readDesktopAppStatus(null), null);
		assert.equal(readDesktopAppStatus({ version: V71 }), null);
		assert.deepEqual(readDesktopAppStatus({ version: V71, target: V72, phase: "available", error: null }),
			{ version: V71, target: V72, phase: "available", error: null, releaseNotes: [], omittedReleaseCount: 0 });
		const good = { version: V72, items: ["a"], totalItems: 1 };
		const read = readDesktopAppStatus({ version: V71, target: V72, phase: "available", error: null, omittedReleaseCount: "2",
			releaseNotes: [good, { version: 3, items: [] }, { version: V71, items: [1] }, null] });
		assert.deepEqual(read?.releaseNotes, [good]);
		assert.equal(read?.omittedReleaseCount, 0);
		// The bridge's caps again: a version of at most 64 characters, a date of at most 40, a bounded count.
		const capped = readDesktopAppStatus({ version: V71, target: V72, phase: "available", error: null, omittedReleaseCount: 1e9,
			releaseNotes: [{ version: "9".repeat(65), items: ["a"] }, { version: V72, releasedAt: `2026-11-18T00:00:00Z${"0".repeat(30)}`, items: ["b"] }, { version: V71, releasedAt: "2026-11-18", items: ["c"] }] });
		assert.deepEqual(capped?.releaseNotes, [{ version: V72, items: ["b"], totalItems: 1 }, { version: V71, releasedAt: "2026-11-18", items: ["c"], totalItems: 1 }]);
		// T3's summary fields come through, bounded like the bridge's.
		const summary = readDesktopAppStatus({ version: V71, target: V72, phase: "available", error: null,
			releaseNotes: [{ version: V72, items: ["b"], totalItems: 9, stats: "9 changes from 1 contributor", footer: "Plus 1 more bug fix.", intro: "x".repeat(601), extra: "dropped" }] });
		assert.deepEqual(summary?.releaseNotes, [{ version: V72, items: ["b"], totalItems: 9, stats: "9 changes from 1 contributor", footer: "Plus 1 more bug fix." }]);
		// Trimmed and collapsed before the bound: padding doesn't push a field over it.
		const padded = readDesktopAppStatus({ version: V71, target: V72, phase: "available", error: null,
			releaseNotes: [{ version: V72, items: ["b"], stats: `   ${"x".repeat(60)}     ${"y".repeat(58)}   ` }] });
		assert.equal(padded?.releaseNotes?.[0]?.stats, `${"x".repeat(60)} ${"y".repeat(58)}`);
		assert.equal(capped?.omittedReleaseCount, 1000);
	});

	it("shownReleaseNotes picks whose notes: this app's for its own states, the server's otherwise", () => {
		const app = { version: V71, target: V72, phase: "available" as const, error: null, releaseNotes: [{ version: V72, items: ["app"] }], omittedReleaseCount: 1 };
		const server = state({ status: "downloaded", version: V72, releaseNotes: [{ version: V72, items: ["server"] }], omittedReleaseCount: 2 });
		assert.deepEqual(shownReleaseNotes(server, "everything", app), { releaseNotes: app.releaseNotes, omittedReleaseCount: 1, offeredVersion: V72, available: true });
		assert.deepEqual(shownReleaseNotes(server, "install", app), { releaseNotes: server.releaseNotes, omittedReleaseCount: 2, offeredVersion: V72, available: false });
		assert.deepEqual(shownReleaseNotes(server, "downloading", { ...app, phase: "downloading" }), { releaseNotes: app.releaseNotes, omittedReleaseCount: 1, offeredVersion: V72, available: false });
		assert.deepEqual(shownReleaseNotes(server, "downloading", null), { releaseNotes: server.releaseNotes, omittedReleaseCount: 2, offeredVersion: V72, available: false });
		assert.equal(shownReleaseNotes({ ...server, status: "available" }, "download", null)?.available, true, "the server's own available update");
		assert.equal(shownReleaseNotes(server, "check", app), null);
		assert.equal(shownReleaseNotes(server, "reload", app), null);
		assert.equal(shownReleaseNotes(server, "everything", { ...app, phase: "updating" }), null);
		assert.equal(shownReleaseNotes(server, "everything", { ...app, releaseNotes: [] }), null);
	});

	it("this app's own download shows its percent in the ring and label, not the server's", async () => {
		const r = await pillIn({ version: V71, target: V72, phase: "downloading", error: null, downloadPercent: 61.4 }, state({ status: "downloading", version: V72, runningVersion: V71, downloadPercent: 10 }));
		assert.equal(r.pill().getAttribute("data-action"), "downloading");
		assert.equal(r.pill().getAttribute("aria-label"), "Downloading update (61%)");
		for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
		const old = await pillIn({ version: V71, target: V72, phase: "downloading", error: null }, state({ status: "up-to-date", runningVersion: V71 }));
		assert.equal(old.pill().getAttribute("aria-label"), "Downloading update", "an app that doesn't report a percent");
	});

	it("with the server already on the app's version it is a plain app download or install (T3 shows everything only while a server is behind)", async () => {
		const down = await pillIn({ version: V71, target: V72, phase: "available", error: null }, state({ status: "up-to-date", runningVersion: V72 }));
		assert.equal(down.pill().getAttribute("data-action"), "app-download");
		assert.equal(down.pill().getAttribute("aria-label"), `Update ${V72} ready to download`);
		await click(down.pill()); await settle();
		assert.equal(down.calls.download, 1);
		for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
		const ready = await pillIn({ version: V71, target: V72, phase: "downloaded", error: null }, state({ status: "up-to-date", runningVersion: V72 }));
		assert.equal(ready.pill().getAttribute("data-action"), "app-install");
		assert.equal(ready.pill().getAttribute("aria-label"), `Update ${V72} downloaded. Click to restart and install.`);
		await click(ready.pill()); await settle();
		assert.equal(ready.calls.install, 1, "through the app's confirmation, never the in-page dialog");
		assert.equal(q(document, "install-update-title"), null);
	});

	it("while it runs the button stays everything and disabled; the check button checks the server and the app", async () => {
		const r = await pillIn({ version: V71, target: V72, phase: "updating", error: null }, state({ status: "up-to-date", runningVersion: V71 }));
		assert.equal(r.pill().getAttribute("data-action"), "everything");
		assert.equal(r.pill().getAttribute("aria-disabled"), "true");
		await click(r.pill()); await settle();
		assert.equal(r.calls.install, 0);
		r.set({ version: V71, target: null, phase: "up-to-date", error: null });
		await act(async () => { document.dispatchEvent(new dom.window.Event("visibilitychange")); });
		await settle();
		assert.equal(r.pill().getAttribute("data-action"), "check");
		await click(r.pill()); await settle();
		assert.equal(r.calls.check, 1, "the app checks too");
		assert.ok(r.calls.fetches.includes("/api/updates/check"), "and the server");
	});

	it("an uncommitted trial or an inexact server version keeps the run's everything state", async () => {
		const trial = await pillIn({ version: V71, target: V72, phase: "updating", error: null }, state({ status: "up-to-date", runningVersion: V72, committed: false }));
		assert.equal(trial.pill().getAttribute("data-action"), "everything", "the run still waits for the launcher to keep it");
		for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
		const dev = await pillIn({ version: V71, target: V72, phase: "updating", error: null }, state({ status: "up-to-date", runningVersion: "dev", committed: true }));
		assert.equal(dev.pill().getAttribute("data-action"), "everything");
	});

	it("once the server runs the app's version and its launcher kept it, the run's restart greys out, spins and reads Restarting to install X…", async () => {
		const r = await pillIn({ version: V71, target: V72, phase: "updating", error: null }, state({ status: "up-to-date", runningVersion: V72, committed: true }));
		assert.equal(r.pill().getAttribute("data-action"), "restarting");
		assert.equal(r.pill().getAttribute("aria-label"), `Restarting to install ${V72}…`);
		assert.equal(r.pill().getAttribute("aria-disabled"), "true");
		assert.match(r.pill().className, /opacity-60/);
		assert.equal(q(document, "update-control-restart-icon")!.getAttribute("data-spinning"), "true");
		await click(r.pill()); await settle();
		assert.equal(r.calls.install, 0);
		// Later, or a failed install: the app offers its downloaded update again.
		r.set({ version: V71, target: V72, phase: "downloaded", error: null });
		await act(async () => { document.dispatchEvent(new dom.window.Event("visibilitychange")); });
		await settle();
		assert.equal(r.pill().getAttribute("data-action"), "app-install");
		assert.equal(r.pill().getAttribute("aria-disabled"), null);
	});

	it("mid-run, a page whose server came back on the new version still reloads by itself, once (#264), under the app's cover", async () => {
		remote({ version: V71, target: V72, phase: "updating", error: null }, state({ status: "up-to-date", runningVersion: V72 }));
		let reloads = 0;
		const host = await mount(<SidebarUpdatePill pageVersion={V71} reload={() => { reloads++; }} />);
		await settle();
		assert.equal(reloads, 1, "the run doesn't hold the page back");
		assert.equal(q(host, "update-pill")!.getAttribute("data-action"), "reload", "reload outranks the run's everything state");
	});

	it("Later's claim in the page is the same once-per-version memory, so the page doesn't reload itself on top", async () => {
		const shell = createRequire(import.meta.url)("../electron/server-list.cjs");
		assert.equal(shell.AUTO_RELOAD_KEY, AUTO_RELOAD_KEY);
		assert.equal(shell.AUTO_RELOAD_MEMORY, AUTO_RELOAD_MEMORY);
		// Run the script main injects before Later's reload, then ask the page's own rule.
		new Function("sessionStorage", shell.claimReloadScript(V72))(window.sessionStorage);
		assert.equal(claimAutoReload(V72), false, "already reloaded for V72: no second reload");
		assert.equal(claimAutoReload("0.6.1-nightly.20261118.73"), true, "a later version still reloads by itself");
	});

	it("Settings shows Server and This app rows; the app row is T3's About button", async () => {
		const r = remote({ version: V71, target: V72, phase: "downloaded", error: null }, state({ status: "up-to-date", runningVersion: V71 }));
		const host = await mount(<UpdateSettings {...props} version={V71} />);
		await settle();
		assert.equal(q(host, "row-version")!.textContent?.includes(`Server ${V71}`), true);
		assert.equal(q(host, "row-desktop-app")!.textContent?.includes(`This app ${V71}`), true);
		assert.equal(q(host, "desktop-app-status")!.textContent, "Update available.");
		const button = q(host, "desktop-app-update")!;
		assert.equal(button.textContent, "Install");
		await click(button); await settle();
		assert.equal(r.calls.install, 1, "Install opens the app's Update everything confirmation");
		r.set({ version: V71, target: null, phase: "up-to-date", error: null });
		await act(async () => { document.dispatchEvent(new dom.window.Event("visibilitychange")); });
		await settle();
		assert.equal(q(host, "desktop-app-update")!.textContent, "Up to Date");
		assert.equal(q(host, "desktop-app-status")!.textContent, "Current version of the application.");
		r.set({ version: V71, target: null, phase: "disabled", error: null });
		await act(async () => { document.dispatchEvent(new dom.window.Event("visibilitychange")); });
		await settle();
		assert.equal(q(host, "desktop-app-status")!.textContent, "Automatic updates are not available in this build.");
		assert.equal((q(host, "desktop-app-update") as HTMLButtonElement).disabled, true);
	});

	it("browsers and the local desktop window keep one Version row and no app row", async () => {
		bridge(state({ status: "up-to-date", revision: 1 }));
		const host = await mount(<UpdateSettings {...props} />);
		assert.equal(q(host, "row-desktop-app"), null);
		assert.match(q(host, "row-version")!.textContent ?? "", /^Version 0\.3\.7/);
	});
});

describe("install confirm and What's new", () => {
	it("the confirm dialog lists the running work it will interrupt", async () => {
		globalThis.fetch = async (input) => {
			assert.equal(String(input), "/api/updates/running");
			return Response.json({ items: [{ kind: "turn", title: "Calculus" }, { kind: "job", title: "Research" }, { kind: "plugin-worker", title: "Cards" }, { kind: "extraction", title: "notes.pdf" }, { kind: "compaction", title: "Algebra" }] });
		};
		await mount(<InstallUpdateDialog open version="0.3.8" onClose={() => {}} onConfirm={() => {}} />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.equal(q(document, "install-update-line")!.textContent, "Any running tasks will be interrupted. Make sure you're ready before continuing.");
		const lines = [...q(document, "install-update-running")!.querySelectorAll("li")].map((li) => li.textContent);
		assert.deepEqual(lines, ["Chat turn: Calculus", "Background job: Research", "Plugin worker: Cards", "Extraction: notes.pdf", "Compaction: Algebra"]);
	});

	it("What's new shows the groups, or Updated to X with View release on GitHub when there are none", () => {
		const html = renderToStaticMarkup(<WhatsNewBody homepage="https://github.com/o/r" onDone={() => {}}
			whatsNew={{ version: "0.3.9", releaseNotes: [{ version: "0.3.9", items: ["x"] }, { version: "0.3.8", items: ["y"] }], omittedReleaseCount: 0 }} />);
		assert.ok(html.includes("What&#x27;s new in 0.3.9") || html.includes("What's new in 0.3.9"));
		assert.ok(html.includes("Changes in 0.3.8"));
		const empty = renderToStaticMarkup(<WhatsNewBody homepage="https://github.com/o/r" onDone={() => {}} whatsNew={{ version: "0.3.9", releaseNotes: [], omittedReleaseCount: 0 }} />);
		assert.ok(empty.includes("Updated to version 0.3.9."));
		assert.ok(empty.includes('href="https://github.com/o/r/releases/tag/v0.3.9"'));
		assert.ok(empty.includes("View release on GitHub"));
	});

	it("Got it marks the running version seen on the server and closes the popup", async () => {
		const posts: unknown[] = [];
		globalThis.fetch = async (input, init) => {
			if (String(input) === "/api/whats-new/seen") { posts.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }
			assert.equal(String(input), "/api/whats-new");
			return Response.json({ version: "0.3.9", releaseNotes: [], omittedReleaseCount: 0 });
		};
		await mount(<WhatsNewDialog />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.ok(q(document, "whats-new-dialog"));
		await click(q(document, "whats-new-done"));
		assert.equal(q(document, "whats-new-dialog"), null);
		assert.deepEqual(posts, [{ version: "0.3.9" }]);
	});
});

describe("What's new waits for the reload", () => {
	it("is held back while the server runs a newer version than the page, without marking it seen, and shows once on the page that runs it", async () => {
		const posts: unknown[] = [];
		let seen = false;
		globalThis.fetch = async (input, init) => {
			if (String(input) === "/api/whats-new/seen") { seen = true; posts.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }
			assert.equal(String(input), "/api/whats-new");
			return Response.json(seen ? null : { version: "0.6.1-nightly.20261118.65", releaseNotes: [], omittedReleaseCount: 0 });
		};
		const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		// The old tab: page code .64, server .65. Nothing shows, nothing is recorded.
		await mount(<WhatsNewDialog pageVersion="0.6.1-nightly.20261118.64" />);
		await settle();
		assert.equal(q(document, "whats-new-dialog"), null, "held back: the reload button stays visible");
		assert.deepEqual(posts, [], "not marked seen while held back");
		for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
		// After the reload (or the next time the app opens): page code .65. Shows once.
		await mount(<WhatsNewDialog pageVersion="0.6.1-nightly.20261118.65" />);
		await settle();
		assert.equal(q(document, "whats-new-title")!.textContent, "What's new in 0.6.1-nightly.20261118.65");
		await click(q(document, "whats-new-done"));
		assert.deepEqual(posts, [{ version: "0.6.1-nightly.20261118.65" }]);
		for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
		// Another load later: already seen on the server, so never again.
		await mount(<WhatsNewDialog pageVersion="0.6.1-nightly.20261118.65" />);
		await settle();
		assert.equal(q(document, "whats-new-dialog"), null, "exactly once");
	});

	it("a page as new as the server, or a build without an exact version, shows it as before", async () => {
		globalThis.fetch = async () => Response.json({ version: "0.6.1-nightly.20261118.65", releaseNotes: [], omittedReleaseCount: 0 });
		await mount(<WhatsNewDialog pageVersion="" />);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.ok(q(document, "whats-new-dialog"), "no exact page version: never held back");
	});
});

describe("Settings integration", () => {
	it("the toggle sends the complete General section and follows stored server truth", async () => {
		bridge();
		// A synthetic future sibling exercises the caller's section-preserving
		// contract without introducing a new product setting or changing its API.
		const record = { version: 1, general: { autoUpdate: true, futureSibling: "keep" } };
		const puts: unknown[] = [];
		globalThis.fetch = async (input, init) => {
			assert.equal(String(input), init?.method === "PUT" ? "/api/settings/general" : "/api/settings");
			if (init?.method === "PUT") {
				const body = JSON.parse(String(init.body)); puts.push(body);
				return Response.json({ settings: { ...record, general: body } });
			}
			return Response.json({ settings: record });
		};
		const host = await mount(<SettingsDialogBody initialSection="general" onClose={() => {}} />);
		await click(q(host, "toggle-auto-update"));
		assert.deepEqual(puts, [{ autoUpdate: false, futureSibling: "keep" }]);
		assert.equal(q(host, "toggle-auto-update")!.getAttribute("aria-checked"), "false");
	});

	it("the shell's navigation request opens General, but opening alone never checks", async () => {
		const b = bridge();
		globalThis.fetch = async () => Response.json({ settings: { version: 1 } });
		const host = await mount(<SettingsDialogProvider><span>app</span></SettingsDialogProvider>);
		assert.equal(q(document, "settings-dialog"), null);
		await b.open();
		assert.equal(q(document, "settings-nav-general")!.getAttribute("aria-current"), "true");
		assert.ok(q(document, "row-version")); assert.equal(b.calls.check, 0);
		assert.ok(host.textContent!.includes("app"));
	});
});

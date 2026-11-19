/** Update UI with a fake preload bridge: no Electron, network or updates. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { describe, it, after, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { UpdateSettings, updateStatusText, MANUAL_UPDATE_HINT, AUTO_UPDATE_HINT, type UpdateState } from "../components/settings/update-settings.tsx";
import { AUTO_RELOAD_KEY, AUTO_RELOAD_MEMORY, claimAutoReload, downloadingTooltip, downloadRingOffset, hasUnsentMessage, SidebarUpdatePill } from "../components/sidebar-update-pill.tsx";
import { createRequire } from "node:module";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { ReleaseNoteSections } from "../components/release-notes-view.tsx";
import WhatsNewDialog, { WhatsNewBody } from "../components/whats-new-dialog.tsx";
import { InstallUpdateDialog } from "../components/install-update-dialog.tsx";
import { SettingsDialogBody, SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import nextConfig from "../next.config.ts";

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
		installUpdate: () => { calls.install++; },
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
		await b.push(state({ status: "downloaded", version: "0.3.8", revision: 4 }));
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

	it("the pill's hover shows T3-style notes: What's changed, Changes in X, Read more", async () => {
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

	it("release note sections link each group's release (Read more) and the older ones", () => {
		const html = renderToStaticMarkup(<ReleaseNoteSections homepage="https://github.com/o/r" omittedReleaseCount={2}
			groups={[{ version: "0.3.9", items: ["a"] }, { version: "0.3.8", items: [] }]} />);
		assert.ok(html.includes('href="https://github.com/o/r/releases/tag/v0.3.9"'));
		assert.ok(html.includes('href="https://github.com/o/r/releases/tag/v0.3.8"'));
		assert.equal(html.match(/Read more/g)?.length, 2);
		assert.ok(html.includes('href="https://github.com/o/r/releases"'));
		assert.ok(html.includes("2 older releases on GitHub"));
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
	type Status = { version: string; target: string | null; phase: string; error: string | null; downloadPercent?: number | null };
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

	it("What's new shows the groups, or Updated to X with Read more when there are none", () => {
		const html = renderToStaticMarkup(<WhatsNewBody homepage="https://github.com/o/r" onDone={() => {}}
			whatsNew={{ version: "0.3.9", releaseNotes: [{ version: "0.3.9", items: ["x"] }, { version: "0.3.8", items: ["y"] }], omittedReleaseCount: 0 }} />);
		assert.ok(html.includes("What&#x27;s new in 0.3.9") || html.includes("What's new in 0.3.9"));
		assert.ok(html.includes("Changes in 0.3.8"));
		const empty = renderToStaticMarkup(<WhatsNewBody homepage="https://github.com/o/r" onDone={() => {}} whatsNew={{ version: "0.3.9", releaseNotes: [], omittedReleaseCount: 0 }} />);
		assert.ok(empty.includes("Updated to version 0.3.9."));
		assert.ok(empty.includes('href="https://github.com/o/r/releases/tag/v0.3.9"'));
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

/**
 * The toast primitive (components/ui/toast.tsx) and the update toasts'
 * content (components/update-toasts.tsx), docs/specs/t3-style-updates.md
 * revision PR 4. linkedom, no network; assertions never print DOM nodes.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { installModalDom } from "./modal-dom.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent });
const restoreModalDom = installModalDom(dom);
after(restoreModalDom);

// linkedom has no capture phase: keydown capture listeners on the window run first here, as in a browser.
const windowKeyCapture = new Set<EventListenerOrEventListenerObject>();
const isCapture = (options?: boolean | AddEventListenerOptions | EventListenerOptions) => options === true || (typeof options === "object" && !!options.capture);
const addWindowListener = dom.window.addEventListener.bind(dom.window);
const removeWindowListener = dom.window.removeEventListener.bind(dom.window);
dom.window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
	if (type === "keydown" && isCapture(options)) windowKeyCapture.add(listener); else addWindowListener(type, listener, options);
}) as typeof dom.window.addEventListener;
dom.window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
	if (type === "keydown" && isCapture(options)) windowKeyCapture.delete(listener); else removeWindowListener(type, listener, options);
}) as typeof dom.window.removeEventListener;

const { Toaster, toastManager, TOAST_LIMIT, TOAST_TIMEOUT_MS } = await import("../components/ui/toast.tsx");
const updateToasts = await import("../components/update-toasts.tsx");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { HostDialog } = await import("../components/host-dialog.tsx");

async function key(element: Element, name: string, { shiftKey = false } = {}) {
	const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: name, shiftKey, altKey: false, ctrlKey: false, metaKey: false });
	let stopped = false;
	const stop = event.stopPropagation.bind(event);
	event.stopPropagation = () => { stopped = true; stop(); };
	await act(async () => {
		for (const listener of [...windowKeyCapture]) {
			if (typeof listener === "function") listener.call(dom.window, event); else listener.handleEvent(event);
			if (stopped) return;
		}
		element.dispatchEvent(event);
	});
	return { stopped };
}

const roots: { root: Root; host: HTMLElement }[] = [];
async function mount(element: React.ReactElement) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host); roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`);
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid='${id}']`)];
const titles = () => all("toast-title").map((node) => node.textContent);
/** Focus is in a toast on the page (a dismissed one's detached button doesn't count). */
const focusInToast = () => { const active = document.activeElement as HTMLElement | null; return !!active?.isConnected && !!active.closest("[data-toast-item]"); };
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
	await act(async () => { toastManager.clear(); });
});

describe("the toast primitive (T3's ui/toast.tsx)", () => {
	it("keeps toasts raised before the region mounts, newest last, at most 3, with T3's 5 s default", async () => {
		assert.equal(TOAST_LIMIT, 3);
		assert.equal(TOAST_TIMEOUT_MS, 5_000);
		for (const title of ["one", "two", "three", "four"]) toastManager.add({ title });
		await mount(<Toaster />);
		assert.deepEqual(titles(), ["two", "three", "four"], "the oldest went past the limit");
		assert.equal(q("toast-viewport")?.getAttribute("aria-label"), "Notifications");
	});

	it("announces each toast by inserting its text into live regions that were already there: errors assertive, the rest polite", async () => {
		await mount(<Toaster />);
		const assertive = q("toast-announce-assertive")!;
		const polite = q("toast-announce-polite")!;
		assert.deepEqual([assertive.getAttribute("aria-live"), polite.getAttribute("aria-live")], ["assertive", "polite"], "present before any toast");
		assert.deepEqual([assertive.textContent, polite.textContent], ["", ""]);
		await act(async () => { toastManager.add({ type: "error", title: "Broken", description: "Try again." }); toastManager.add({ type: "success", title: "Done", announce: "Done. All set." }); });
		assert.ok(q("toast-announce-assertive") === assertive && q("toast-announce-polite") === polite, "the same regions, their content inserted");
		assert.deepEqual([assertive.textContent, polite.textContent], ["Broken. Try again.", "Done. All set."]);
		assert.equal(all("toast")[0]?.getAttribute("role"), null, "the toasts themselves aren't live regions too (no double announcement)");
	});

	it("a toast dismissed with the mouse leaves focus alone, and the others keep timing out", async () => {
		await mount(<Toaster />);
		await act(async () => { toastManager.add({ title: "Stays a moment", timeout: 40 }); toastManager.add({ title: "Clicked away" }); });
		const close = all("toast-close")[1]!;
		// A click focuses the button, then removes it (removal fires no blur).
		await act(async () => { close.focus(); close.click(); });
		assert.deepEqual(titles(), ["Stays a moment"]);
		assert.ok(!focusInToast(), "focus didn't move into the other toast");
		await wait(90);
		assert.deepEqual(titles(), [], "and it wasn't left paused");
	});

	it("a native mouse click on Close leaves focus where it was (Chromium focuses a pressed button unless mousedown is prevented)", async () => {
		const host = await mount(<><button type="button" data-testid="pill">pill</button><Toaster /></>);
		const pill = host.querySelector<HTMLElement>("[data-testid='pill']")!;
		await act(async () => { pill.focus(); });
		await act(async () => { toastManager.add({ title: "Clicked away" }); });
		const close = q("toast-close")!;
		// Chromium: mousedown focuses the pressed button unless its default is prevented, then click.
		await act(async () => {
			const down = new dom.window.Event("mousedown", { bubbles: true, cancelable: true });
			close.dispatchEvent(down);
			if (!down.defaultPrevented) close.focus();
			close.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true, cancelable: true }));
			close.click();
		});
		assert.deepEqual(titles(), []);
		assert.ok(document.activeElement === pill, "focus stayed on the pill, not the page");
	});

	it("timers stop while the page is hidden, so a toast never runs out unseen", async () => {
		await mount(<Toaster />);
		const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
		const setVisibility = async (value: string) => {
			Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
			await act(async () => { document.dispatchEvent(new dom.window.Event("visibilitychange")); });
		};
		try {
			await setVisibility("hidden");
			await act(async () => { toastManager.add({ title: "Brief", timeout: 30 }); });
			await wait(80);
			assert.deepEqual(titles(), ["Brief"], "still there while hidden");
			await setVisibility("visible");
			await wait(80);
			assert.deepEqual(titles(), [], "it runs out once seen");
		} finally {
			if (visibility) Object.defineProperty(document, "visibilityState", visibility); else Reflect.deleteProperty(document, "visibilityState");
		}
	});

	it("Tab past the end with the old place hidden goes to the composer, or the page, and the timer runs again", async () => {
		const host = await mount(<><button type="button" data-testid="before">before</button><div role="textbox" contentEditable="true" data-testid="composer" /><Toaster /></>);
		const before = host.querySelector<HTMLElement>("[data-testid='before']")!;
		await act(async () => { before.focus(); });
		await act(async () => { toastManager.add({ title: "Brief", timeout: 40 }); });
		await key(before, "F6");
		before.setAttribute("hidden", "");
		await key(all("toast")[0]!, "Tab");
		await key(document.activeElement!, "Tab");
		assert.ok(document.activeElement === host.querySelector("[data-testid='composer']"), "the composer, since the old place is hidden");
		await wait(90);
		assert.deepEqual(titles(), [], "not stranded with its timer paused");
		before.removeAttribute("hidden");
		await act(async () => { toastManager.add({ title: "Again", timeout: 40 }); });
		await key(before, "F6");
		before.setAttribute("hidden", "");
		host.querySelector("[data-testid='composer']")!.setAttribute("hidden", "");
		await key(all("toast")[0]!, "Tab");
		await key(document.activeElement!, "Tab");
		await wait(90);
		assert.deepEqual(titles(), [], "no composer either: the timer runs again, so nothing stays stranded");
		assert.ok(!focusInToast());
	});

	it("is never a window drag band (Close and Read more stay clickable in the packaged app)", async () => {
		await mount(<Toaster />);
		assert.ok(q("toast-viewport")!.classList.contains("lh-no-drag"));
	});

	it("its live regions mount empty, so a toast raised before it mounted is inserted into them (and announced)", async () => {
		toastManager.add({ type: "error", title: "Queued early" });
		const host = document.createElement("div"); document.body.append(host);
		const records: MutationRecord[] = [];
		const observer = new dom.window.MutationObserver((list: MutationRecord[]) => { records.push(...list); });
		observer.observe(host, { childList: true, subtree: true });
		const root = createRoot(host); roots.push({ root, host });
		await act(async () => { root.render(<Toaster />); });
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		records.push(...observer.takeRecords());
		observer.disconnect();
		const region = q("toast-announce-assertive")!;
		assert.equal(region.textContent, "Queued early");
		const added = (name: string) => records.findIndex((record) => [...record.addedNodes].some((node) => node.nodeName === name));
		assert.ok(added("SECTION") >= 0 && added("P") > added("SECTION"), "the region mounted empty, then its text was inserted on its own");
	});

	it("with a modal dialog open the region moves into the dialog: not hidden from screen readers, and F6 reaches it through the focus trap", async () => {
		const host = await mount(
			<InteractionLayersProvider>
				<HostDialog open aria-label="Settings" onClose={() => "closed"}><button type="button" data-testid="in-dialog">inside</button></HostDialog>
				<Toaster />
			</InteractionLayersProvider>,
		);
		await wait(5);
		const inDialog = document.querySelector<HTMLElement>("[data-testid='in-dialog']")!;
		await act(async () => { inDialog.focus(); });
		await act(async () => { toastManager.add({ type: "error", title: "Download failed" }); });
		const region = q("toast-viewport")!;
		assert.ok(region.closest("[data-interaction-popup-host]"), "inside the dialog's popup host");
		const live = q("toast-announce-assertive")!;
		const hidden = (element: Element | null): boolean => !!element && (element.getAttribute("aria-hidden") === "true" || hidden(element.parentElement));
		assert.equal(hidden(live), false, "the live region isn't under aria-hidden");
		assert.equal(live.textContent, "Download failed");
		await key(inDialog, "F6");
		await wait(5);
		assert.ok(document.activeElement === q("toast"), "F6 reached the toast and the trap kept it there");
		void host;
	});

	it("keeps clear of the window's own buttons on Windows and Linux", async () => {
		await mount(<Toaster />);
		assert.ok(q("toast-viewport")!.classList.contains("lh-toast-region"));
		const { readFileSync } = await import("node:fs");
		const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
		assert.match(css, /\.lh-electron \.lh-toast-region \{\s*right: calc\(1rem \+ var\(--lh-wco-right, 0px\)\);/);
	});

	it("goes after its timeout, but not while the pointer is on the toasts; the close button dismisses it", async () => {
		await mount(<Toaster />);
		await act(async () => { toastManager.add({ title: "Brief", timeout: 30 }); });
		const list = q("toast-viewport")!.querySelector("ol")!;
		await act(async () => { list.dispatchEvent(Object.assign(new dom.window.Event("pointerover", { bubbles: true }), { pointerType: "mouse" })); });
		await wait(80);
		assert.deepEqual(titles(), ["Brief"], "paused while hovered");
		await act(async () => { list.dispatchEvent(Object.assign(new dom.window.Event("pointerout", { bubbles: true }), { pointerType: "mouse", relatedTarget: document.body })); });
		await wait(80);
		assert.deepEqual(titles(), [], "gone once the pointer left");
		await act(async () => { toastManager.add({ title: "Stays" }); });
		await act(async () => { q("toast-close")!.click(); });
		assert.deepEqual(titles(), []);
		assert.equal(q("toast-close"), null);
	});

	it("from the keyboard: F6 reaches the newest toast, Tab moves through it, Escape dismisses it, and focus goes back", async () => {
		const host = await mount(<><button type="button" data-testid="before">before</button><Toaster /></>);
		const before = host.querySelector<HTMLElement>("[data-testid='before']")!;
		await act(async () => { before.focus(); });
		await act(async () => { toastManager.add({ title: "Older" }); toastManager.add({ title: "Newest", description: <a href="https://x.test">Read more</a> }); });
		const reached: string[] = [];
		const onWindow = (event: Event) => { reached.push((event as KeyboardEvent).key); };
		dom.window.addEventListener("keydown", onWindow);
		try {
			const f6 = await key(before, "F6");
			assert.ok(f6.stopped, "F6 is the toasts'");
			const [older, newest] = all("toast");
			assert.ok(document.activeElement === newest, "F6 focuses the newest toast");
			await key(newest!, "Tab");
			assert.ok(document.activeElement === newest!.querySelector("a"), "Tab: its link");
			await key(document.activeElement!, "Tab");
			assert.ok(document.activeElement === newest!.querySelector("[data-testid='toast-close']"), "Tab: its close button");
			await key(document.activeElement!, "Tab", { shiftKey: true });
			assert.ok(document.activeElement === newest!.querySelector("a"), "Shift+Tab goes back");
			await key(document.activeElement!, "Escape");
			assert.deepEqual(titles(), ["Older"], "Escape dismissed the focused toast");
			assert.ok(document.activeElement === older, "focus moves to the toast left");
			await key(older!, "Escape");
			assert.deepEqual(titles(), []);
			assert.ok(document.activeElement === before, "the last one gone: focus goes back to where it was");
			assert.deepEqual(reached, [], "Tab, Shift+Tab, Escape and F6 never reached the app's shortcuts");
			// Tab past the end leaves for where focus was.
			await act(async () => { toastManager.add({ title: "Again" }); });
			await key(before, "F6");
			await key(all("toast")[0]!, "Tab");
			await key(document.activeElement!, "Tab");
			assert.ok(document.activeElement === before, "Tab past the last stop goes back");
		} finally {
			dom.window.removeEventListener("keydown", onWindow);
		}
	});

	it("F6 does nothing with no toasts", async () => {
		const host = await mount(<><button type="button" data-testid="before">before</button><Toaster /></>);
		const before = host.querySelector<HTMLElement>("[data-testid='before']")!;
		const result = await key(before, "F6");
		assert.equal(result.stopped, false);
	});
});

describe("the update toasts' content (T3's desktopUpdate.toast.tsx and its callers)", () => {
	it("Update downloaded: T3's line and a Read more link to the release", async () => {
		await mount(<Toaster />);
		await act(async () => { updateToasts.showUpdateDownloadedToast("0.3.8", "https://github.com/o/r"); });
		assert.deepEqual(titles(), ["Update downloaded"]);
		assert.equal(q("toast")?.getAttribute("data-type"), "success");
		assert.ok(q("toast-description")!.textContent!.startsWith("Restart the app from the update button to install it."));
		const link = q("toast-read-more")!;
		assert.equal(link.getAttribute("href"), "https://github.com/o/r/releases/tag/v0.3.8");
		assert.equal(link.textContent, "Read more");
		await act(async () => { toastManager.clear(); updateToasts.showUpdateDownloadedToast(null, "https://github.com/o/r"); });
		assert.equal(q("toast-read-more"), null, "no version: no link");
	});

	it("T3's titles and fixed fallbacks", () => {
		assert.deepEqual([updateToasts.CHECK_FAILED_TITLE, updateToasts.DOWNLOAD_FAILED_TITLE, updateToasts.DOWNLOAD_START_FAILED_TITLE, updateToasts.INSTALL_FAILED_TITLE, updateToasts.NOT_APPLIED_TITLE],
			["Could not check for updates", "Could not download update", "Could not start update download", "Could not install update", "Update did not apply"]);
		assert.equal(updateToasts.notAppliedLine("0.3.7", "0.3.8"), "LearnHarness is still on 0.3.7. Install 0.3.8 again from the update button.");
		assert.deepEqual([updateToasts.UNEXPECTED_ERROR, updateToasts.CHECK_ERROR, updateToasts.CHECK_UNAVAILABLE], ["An unexpected error occurred.", "Update check failed.", "Automatic updates are not available in this build."]);
	});
});

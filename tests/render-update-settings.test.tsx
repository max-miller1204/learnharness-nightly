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
import { SidebarUpdatePill } from "../components/sidebar-update-pill.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { ReleaseNoteSections } from "../components/release-notes-view.tsx";
import WhatsNewDialog, { WhatsNewBody } from "../components/whats-new-dialog.tsx";
import { InstallUpdateDialog } from "../components/install-update-dialog.tsx";
import { SettingsDialogBody, SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import nextConfig from "../next.config.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent });
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
		assert.equal(q(document, "install-update-dialog"), null);
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

	it("a server newer than the page offers a reload, and unsent text asks first", async () => {
		const b = bridge(state({ status: "up-to-date", revision: 1, runningVersion: "0.6.1-nightly.20261118.65" }));
		let reloads = 0;
		const host = await mount(<SidebarUpdatePill pageVersion="0.6.1-nightly.20261118.64" reload={() => { reloads++; }} />);
		const pill = () => q(host, "update-pill")!;
		assert.equal(pill().getAttribute("data-action"), "reload");
		assert.equal(pill().getAttribute("aria-label"), "Updated to 0.6.1-nightly.20261118.65. Click to reload.");
		await click(pill()); assert.equal(reloads, 1, "no unsent text: reloads at once");

		const composer = document.createElement("div"); composer.setAttribute("data-testid", "composer");
		composer.innerHTML = '<div role="textbox" contenteditable="true">half a question</div>'; document.body.append(composer);
		try {
			await click(pill());
			assert.equal(reloads, 1, "asks first");
			assert.equal(q(document, "reload-confirm-title")!.textContent, "You have an unsent message. Reload anyway?");
			await click(q(document, "reload-confirm-cancel")); assert.equal(reloads, 1);
			assert.equal(q(document, "reload-confirm-dialog"), null);
			await click(pill()); await click(q(document, "reload-confirm-reload")); assert.equal(reloads, 2);
		} finally { composer.remove(); }
		assert.equal(b.calls.check, 0);

		await b.push(state({ status: "up-to-date", revision: 2, runningVersion: "0.6.1-nightly.20261118.64" }));
		assert.equal(pill().getAttribute("data-action"), "check", "same version as the page: no reload");
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

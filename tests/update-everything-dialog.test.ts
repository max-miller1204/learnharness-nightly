/**
 * Main's own Update everything dialog (docs/specs/t3-style-updates.md, revision PR 7): the
 * run's consent, drawn over the server's window from the app's own files. Its main side
 * (electron/update-everything-dialog.cjs) with fake Electron objects, and its page
 * (electron/update-everything-dialog.html and .js) run in a DOM. No Electron.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { parseHTML } from "linkedom";
import { installModalDom } from "./modal-dom.ts";

const require = createRequire(import.meta.url);
const { createUpdateEverythingDialog, CHANNEL, PAGE } = require("../electron/update-everything-dialog.cjs");
const PAGE_URL = pathToFileURL(PAGE).href;
const PLAN = {
	version: "0.6.1-nightly.20261118.72", running: 2, skipped: [], disabledReason: null,
	rows: [{ label: "max-desktop", app: "server", running: 2 }, { label: "This app", app: "this-app", running: 0 }],
};

class FakeContents extends EventEmitter {
	destroyed = false;
	focused = 0;
	loaded: { file: string; query: unknown } | null = null;
	mainFrame = { url: "about:blank" };
	isDestroyed() { return this.destroyed; }
	focus() { this.focused++; }
	close() { this.destroyed = true; this.emit("destroyed"); }
	setWindowOpenHandler() {}
	async loadFile(file: string, options: { query: unknown }) { this.loaded = { file, query: options.query }; this.mainFrame = { url: `${pathToFileURL(file).href}?mode=dark` }; }
}

function electron() {
	const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
	const views: Array<{ webContents: FakeContents; preferences: { webPreferences: Record<string, unknown> } }> = [];
	class WebContentsView {
		webContents = new FakeContents();
		constructor(public preferences: { webPreferences: Record<string, unknown> }) { views.push(this); }
		setBackgroundColor() {}
		setBounds() {}
	}
	const page = new EventEmitter() as EventEmitter & { focus: () => void };
	page.focus = () => {};
	const children = new Set<unknown>();
	const contentView = Object.assign(new EventEmitter(), {
		getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
		addChildView: (view: unknown) => children.add(view),
		removeChildView: (view: unknown) => children.delete(view),
	});
	let destroyed = false;
	const win = Object.assign(new EventEmitter(), { contentView, webContents: page, isDestroyed: () => destroyed, close: () => { destroyed = true; win.emit("closed"); } });
	const dialog = createUpdateEverythingDialog({
		ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) },
		WebContentsView, session: { fromPartition: () => ({}) }, themeMode: () => "light",
	});
	const handle = (event: unknown, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(CHANNEL)!(event, ...args));
	return { dialog, views, win, children, page, handle };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("main's dialog: its own view over the window, the page's keys blocked, the plan only for that view at the app's page", async () => {
	const e = electron();
	const answer = e.dialog.ask(e.win, PLAN);
	await tick();
	const [view] = e.views;
	assert.ok(view && e.children.has(view), "a view over the server's window");
	assert.equal(view.preferences.webPreferences.sandbox, true);
	assert.equal(view.preferences.webPreferences.contextIsolation, true);
	assert.match(String(view.preferences.webPreferences.preload), /update-everything-dialog-preload\.cjs$/);
	assert.deepEqual(view.webContents.loaded, { file: PAGE, query: { mode: "light" } }, "the app's own file, in the app theme's mode");
	assert.equal(e.page.listenerCount("before-input-event"), 1, "the server's page takes no keys while main asks");
	const own = { sender: view.webContents, senderFrame: view.webContents.mainFrame };
	assert.deepEqual(await e.handle(own, "plan"), PLAN);
	const refused: unknown[][] = [
		[{ sender: e.page, senderFrame: { url: "https://max-desktop.example" } }, "update"],
		[{ sender: view.webContents, senderFrame: { url: PAGE_URL } }, "update"],
		[{ sender: view.webContents, senderFrame: Object.assign(view.webContents.mainFrame, {}) && { ...view.webContents.mainFrame } }, "update"],
		[own, "update", true],
		[own, "install"],
		[own, { toString: () => "update" }],
	];
	for (const args of refused) await assert.rejects(e.handle(args[0], ...args.slice(1)), /Untrusted dialog request/, JSON.stringify(args.slice(1)));
	const frame = view.webContents.mainFrame;
	frame.url = "https://evil.example/update-everything-dialog.html";
	await assert.rejects(e.handle({ sender: view.webContents, senderFrame: frame }, "update"), /Untrusted dialog request/, "another page in the view");
	frame.url = `${PAGE_URL}?mode=dark`;
	assert.deepEqual(await Promise.all([e.dialog.ask(e.win, PLAN)]), [false], "one at a time");
	await e.handle({ sender: view.webContents, senderFrame: frame }, "update");
	assert.equal(await answer, true, "Update is the yes");
	assert.equal(e.children.size, 0, "the view is gone");
	assert.equal(e.page.listenerCount("before-input-event"), 0, "the page takes keys again");
	assert.equal(view.webContents.destroyed, true);
	await assert.rejects(e.handle({ sender: view.webContents, senderFrame: frame }, "update"), /Untrusted dialog request/, "a closed dialog answers nothing more");
});

test("Cancel, a closed window or a gone view is a no", async () => {
	const cancel = electron();
	const answered = cancel.dialog.ask(cancel.win, PLAN);
	await tick();
	await cancel.handle({ sender: cancel.views[0]!.webContents, senderFrame: cancel.views[0]!.webContents.mainFrame }, "cancel");
	assert.equal(await answered, false);
	const closed = electron();
	const closing = closed.dialog.ask(closed.win, PLAN);
	await tick();
	closed.win.close();
	assert.equal(await closing, false);
	const gone = electron();
	const going = gone.dialog.ask(gone.win, PLAN);
	await tick();
	gone.views[0]!.webContents.close();
	assert.equal(await going, false);
	assert.equal(await gone.dialog.ask(null, PLAN), false, "no window, no dialog");
});

const restores: Array<() => void> = [];
test.after(() => { for (const restore of restores.splice(0).reverse()) restore(); });
/** Whether focus is on `element`: a boolean, so a failure never prints a DOM node. */
const focused = (document: Document, element: Element) => document.activeElement === element;
/** The dialog's own page with `plan`, in a DOM; resolves with its answers. */
async function page(plan: unknown) {
	const shell = path.join(import.meta.dirname, "../electron");
	const dom = parseHTML(await fs.readFile(path.join(shell, "update-everything-dialog.html"), "utf8"));
	const { document, window } = dom;
	// Native focus and activeElement, as the app's other DOM tests have them.
	restores.push(installModalDom(dom));
	const answers: string[] = [];
	const api = { plan: async () => plan, update: async () => { answers.push("update"); }, cancel: async () => { answers.push("cancel"); } };
	runInNewContext(await fs.readFile(path.join(shell, "update-everything-dialog.js"), "utf8"), { window: { updateEverything: api }, document });
	await tick();
	await tick();
	const key = (key: string, shiftKey = false) => {
		const event = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key, shiftKey, isComposing: false });
		(document.activeElement ?? document.body).dispatchEvent(event);
	};
	return { document, answers, key, $: (id: string) => document.getElementById(id)! };
}

test("the dialog shows T3's Update N machines? with This app last, its running work, and Cancel focused", async () => {
	const p = await page(PLAN);
	assert.equal(p.$("dialog").hidden, false);
	assert.equal(p.$("title").textContent, "Update 2 machines?");
	assert.equal(p.$("version").textContent, "LearnHarness 0.6.1-nightly.20261118.72");
	const rows = [...p.document.querySelectorAll("#table [role=row]")].slice(1);
	assert.deepEqual(rows.map((row) => (row as HTMLElement).dataset.app), ["server", "this-app"], "This app is last");
	assert.deepEqual([...rows[1]!.querySelectorAll("[role=cell]")].slice(0, 2).map((cell) => cell.textContent), ["This app", "This apprestarts last"]);
	assert.equal(rows[0]!.querySelector(".running")!.textContent, "2 running");
	assert.deepEqual([...p.document.querySelectorAll("#table [role=columnheader]")].map((cell) => cell.textContent), ["Machine", "LearnHarness", "Providers", "Running"]);
	assert.equal(p.$("warning").textContent, "2 running tasks will be interrupted.");
	assert.equal(focused(p.document, p.$("cancel")), true, "Cancel is focused first");
	assert.deepEqual(p.answers, []);
});

test("its keys: Tab and Shift+Tab cycle its buttons, Escape cancels, Enter presses the focused one", async () => {
	const p = await page({ ...PLAN, skipped: [{ label: "laptop", reason: "needs a manual update" }] });
	assert.equal(focused(p.document, p.$("cancel")), true);
	p.key("Tab");
	assert.equal(focused(p.document, p.$("update")), true);
	p.key("Tab");
	assert.equal(focused(p.document, p.$("skipped-toggle")), true, "it wraps, within the dialog");
	p.key("Enter");
	assert.equal(p.$("skipped-toggle").getAttribute("aria-expanded"), "true");
	assert.match(p.$("skipped").textContent ?? "", /laptopneeds a manual update/);
	p.key("Tab", true);
	assert.equal(focused(p.document, p.$("update")), true);
	p.key("Enter");
	assert.deepEqual(p.answers, ["update"]);
	const cancelled = await page(PLAN);
	cancelled.key("Escape");
	assert.deepEqual(cancelled.answers, ["cancel"]);
	cancelled.key("Escape");
	assert.deepEqual(cancelled.answers, ["cancel"], "answered once");
});

test("an app-only update shows no running work; a disabled reason blocks Update; a broken plan cancels", async () => {
	const appOnly = await page({ ...PLAN, running: 0, rows: [{ label: "This app", app: "this-app", running: 0 }] });
	assert.equal(appOnly.$("title").textContent, "Update 1 machine?");
	assert.equal(appOnly.$("warning").hidden, true);
	const blocked = await page({ ...PLAN, rows: [{ label: "This app", app: "this-app", running: 0 }], disabledReason: "Update max-desktop from its own Settings first." });
	assert.equal(blocked.$("warning").textContent, "Update max-desktop from its own Settings first.");
	assert.equal((blocked.$("update") as HTMLButtonElement).disabled, true);
	blocked.$("update").click();
	blocked.key("Tab");
	assert.equal(focused(blocked.document, blocked.$("cancel")), true, "a disabled Update isn't a stop");
	assert.deepEqual(blocked.answers, []);
	// Text only: a label can't add markup.
	const markup = await page({ ...PLAN, rows: [{ label: "<img src=x onerror=alert(1)>", app: "server", running: 0 }] });
	assert.equal(markup.document.querySelector("#table img"), null);
	const broken = await page({ rows: "nope" });
	assert.deepEqual(broken.answers, ["cancel"]);
});

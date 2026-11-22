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
const { createUpdateEverythingDialog, CHANNEL, PAGE, PARTITION, UPDATE_ARM_MS } = require("../electron/update-everything-dialog.cjs");
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

function electron({ clock = { now: 0 } } = {}) {
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
	const partitions: string[] = [];
	const dialog = createUpdateEverythingDialog({
		ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) },
		WebContentsView, session: { fromPartition: (name: string) => { partitions.push(name); return {}; } }, themeMode: () => "light",
		now: () => clock.now,
	});
	const handle = (event: unknown, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(CHANNEL)!(event, ...args));
	return { dialog, views, win, children, page, handle, partitions, clock };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Past the dialog page's own 500 ms before Update counts. */
const armed = () => new Promise((resolve) => setTimeout(resolve, UPDATE_ARM_MS + 30));

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
	frame.url = `${PAGE_URL}?mode=dark#x`;
	await assert.rejects(e.handle({ sender: view.webContents, senderFrame: frame }, "update"), /Untrusted dialog request/, "a URL with a hash");
	frame.url = `${PAGE_URL}?mode=dark`;
	assert.deepEqual(await Promise.all([e.dialog.ask(e.win, PLAN)]), [{ update: false, keyboard: false }], "one at a time");
	// Update counts only UPDATE_ARM_MS after the dialog showed (its plan was served).
	e.clock.now += UPDATE_ARM_MS - 1;
	await e.handle({ sender: view.webContents, senderFrame: frame }, "update");
	assert.equal(e.children.size, 1, "too early: ignored, the dialog stays");
	e.clock.now += 1;
	await e.handle({ sender: view.webContents, senderFrame: frame }, "update");
	assert.deepEqual(await answer, { update: true, keyboard: false }, "Update is the yes, here not from a key");
	assert.equal(e.children.size, 0, "the view is gone");
	assert.equal(e.page.listenerCount("before-input-event"), 0, "the page takes keys again");
	assert.equal(e.win.listenerCount("focus"), 0, "no focus hook left");
	assert.equal(e.win.listenerCount("closed"), 0);
	assert.equal(e.win.contentView.listenerCount("bounds-changed"), 0, "no bounds hook left");
	assert.deepEqual(e.partitions, [PARTITION], "one fixed session, the dialog's own");
	assert.equal(view.webContents.destroyed, true);
	await assert.rejects(e.handle({ sender: view.webContents, senderFrame: frame }, "update"), /Untrusted dialog request/, "a closed dialog answers nothing more");
});

test("Cancel, a closed window or a gone view is a no", async () => {
	const cancel = electron();
	const answered = cancel.dialog.ask(cancel.win, PLAN);
	await tick();
	await cancel.handle({ sender: cancel.views[0]!.webContents, senderFrame: cancel.views[0]!.webContents.mainFrame }, "cancel");
	assert.deepEqual(await answered, { update: false, keyboard: false });
	const closed = electron();
	const closing = closed.dialog.ask(closed.win, PLAN);
	await tick();
	closed.win.close();
	assert.deepEqual(await closing, { update: false, keyboard: false });
	const gone = electron();
	const going = gone.dialog.ask(gone.win, PLAN);
	await tick();
	gone.views[0]!.webContents.close();
	assert.deepEqual(await going, { update: false, keyboard: false });
	const crashed = electron();
	const crashing = crashed.dialog.ask(crashed.win, PLAN);
	await tick();
	crashed.views[0]!.webContents.emit("render-process-gone", {}, { reason: "crashed" });
	assert.deepEqual(await crashing, { update: false, keyboard: false }, "a crashed dialog is a no");
	assert.equal(crashed.children.size, 0);
	// Every dialog shares the one partition.
	const twice = electron();
	void twice.dialog.ask(twice.win, PLAN);
	await tick();
	twice.views[0]!.webContents.close();
	void twice.dialog.ask(twice.win, PLAN);
	await tick();
	assert.deepEqual(twice.partitions, [PARTITION, PARTITION]);
	assert.deepEqual(await gone.dialog.ask(null, PLAN), { update: false, keyboard: false }, "no window, no dialog");
});

test("the answer says whether a key closed the dialog (T3 returns focus to the trigger only then)", async () => {
	const keyed = electron();
	const byKey = keyed.dialog.ask(keyed.win, PLAN);
	await tick();
	const contents = keyed.views[0]!.webContents;
	const own = { sender: contents, senderFrame: contents.mainFrame };
	contents.emit("input-event", {}, { type: "mouseDown" });
	contents.emit("input-event", {}, { type: "rawKeyDown" });
	await keyed.handle(own, "cancel");
	assert.deepEqual(await byKey, { update: false, keyboard: true }, "Escape or Enter on Cancel");
	const clicked = electron();
	const byClick = clicked.dialog.ask(clicked.win, PLAN);
	await tick();
	const view = clicked.views[0]!.webContents;
	await clicked.handle({ sender: view, senderFrame: view.mainFrame }, "plan");
	view.emit("input-event", {}, { type: "rawKeyDown" });
	view.emit("input-event", {}, { type: "mouseDown" });
	clicked.clock.now += UPDATE_ARM_MS;
	await clicked.handle({ sender: view, senderFrame: view.mainFrame }, "update");
	assert.deepEqual(await byClick, { update: true, keyboard: false }, "a click on Update");
	// A window closed under it is no key's answer, whatever was pressed last.
	const closed = electron();
	const closing = closed.dialog.ask(closed.win, PLAN);
	await tick();
	closed.views[0]!.webContents.emit("input-event", {}, { type: "keyDown" });
	closed.win.close();
	assert.deepEqual(await closing, { update: false, keyboard: false });
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
	runInNewContext(await fs.readFile(path.join(shell, "update-everything-dialog.js"), "utf8"), { window: { updateEverything: api }, document, setTimeout });
	await tick();
	await tick();
	const key = (key: string, shiftKey = false, modifiers: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) => {
		const event = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key, shiftKey, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers });
		(document.activeElement ?? document.body).dispatchEvent(event);
	};
	return { document, answers, key, $: (id: string) => document.getElementById(id)! };
}

test("the dialog's preload exposes only plan, update and cancel, each with no argument, and only in the main frame", () => {
	const source = require("node:fs").readFileSync(path.join(import.meta.dirname, "../electron/update-everything-dialog-preload.cjs"), "utf8");
	for (const isMainFrame of [false, true]) {
		const exposed = new Map<string, Record<string, (...args: unknown[]) => unknown>>();
		const invoked: unknown[][] = [];
		new Function("require", "process", source)((name: string) => {
			assert.equal(name, "electron");
			return {
				contextBridge: { exposeInMainWorld: (key: string, value: Record<string, (...args: unknown[]) => unknown>) => exposed.set(key, value) },
				ipcRenderer: { invoke: (...args: unknown[]) => { invoked.push(args); return Promise.resolve(); } },
			};
		}, { isMainFrame });
		if (!isMainFrame) { assert.deepEqual([...exposed.keys()], [], "a subframe gets nothing"); continue; }
		const api = exposed.get("updateEverything")!;
		assert.deepEqual(Object.keys(api), ["plan", "update", "cancel"]);
		for (const method of ["plan", "update", "cancel"]) api[method]!("evil", { planId: 1 });
		assert.deepEqual(invoked, [[CHANNEL, "plan"], [CHANNEL, "update"], [CHANNEL, "cancel"]], "nothing from the page goes on");
	}
});

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
	assert.equal((p.$("update") as HTMLButtonElement).disabled, true, "Update starts disabled, so a lured click isn't an answer");
	p.$("update").click();
	assert.deepEqual(p.answers, []);
	await armed();
	assert.equal((p.$("update") as HTMLButtonElement).disabled, false);
});

test("its keys: Tab and Shift+Tab cycle its buttons, Escape cancels, Enter presses the focused one", async () => {
	const p = await page({ ...PLAN, skipped: [{ label: "laptop", reason: "needs a manual update" }] });
	await armed();
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
	// A shortcut isn't the dialog's; from outside its buttons, Shift+Tab goes to the last one.
	const shortcut = await page(PLAN);
	await armed();
	shortcut.key("Tab", false, { ctrlKey: true });
	assert.equal(focused(shortcut.document, shortcut.$("cancel")), true, "Ctrl+Tab moved nothing");
	shortcut.key("Enter", false, { metaKey: true });
	assert.deepEqual(shortcut.answers, [], "Meta+Enter pressed nothing");
	(shortcut.document.activeElement as HTMLElement).blur();
	shortcut.key("Tab", true);
	assert.equal(focused(shortcut.document, shortcut.$("update")), true, "Shift+Tab from outside: the last button");
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
	await armed();
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

/**
 * The composer's attach button (issue #285): the picker's twin of a file
 * drop. Picked files become quoted path chips at the caret through the
 * desktop bridge; the browser build explains instead. Same linkedom
 * shims as file-path-drop-zone.test.tsx (no native Selection there).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginSubmissionRunner } from "../components/plugin-submission-runner.ts";
import type { PluginSubmissionTarget } from "../src/core/index.ts";
import { DraftAttachmentChips, useAttachmentDraft, type AttachmentDraft } from "../components/attachment-draft.tsx";
import { Composer } from "../components/composer.tsx";
import { AttachFilesButton, attachmentPopupPlacement, pathsForFiles } from "../components/attach-files-button.tsx";
import { restorePathSelection } from "../components/path-input-dom.ts";
import { quoteFilePath } from "../src/core/file-paths.ts";
import { InteractionLayersProvider, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function fixture({ desktop = true, onDraft }: { desktop?: boolean; onDraft?: (draft: AttachmentDraft) => void } = {}) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	const selection = {
		anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
		setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
			Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
		},
	};
	Object.assign(doc, { getSelection: () => selection, oninput: null });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 200, y: 600, left: 200, right: 240, top: 600, bottom: 640, width: 40, height: 40, toJSON() {} });
	const backingPaths = new Map<File, string>();
	let pickerClicks = 0;
	let folderCalls = 0;
	let folderResult: string | null | Error = null;
	let byteReads = 0;
	let sends = 0;
	let value = "readthis";
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, innerWidth: 1000, innerHeight: 800,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	Object.defineProperty(win, "lh", {
		configurable: true,
		value: desktop ? {
			getPathForFile: (file: File) => backingPaths.get(file) ?? "",
			chooseAttachmentFolder: async () => { folderCalls++; if (folderResult instanceof Error) throw folderResult; return folderResult; },
		} : undefined,
	});
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	let controller!: InteractionLayersController;
	function UploadHarness() {
		const draft = useAttachmentDraft();
		onDraft?.(draft);
		return null;
	}
	function Harness() {
		controller = useInteractionLayers();
		return <div data-testid="clipping-dock" data-attachment-composer="" style={{ overflow: "hidden" }}>{onDraft && <UploadHarness />}<Composer busy={false} value={value} onChange={(next) => { value = next; draw(); }} onSend={() => { sends++; }} onStop={() => {}} canSend /></div>;
	}
	function draw() { root.render(<InteractionLayersProvider><Harness /></InteractionLayersProvider>); }
	await act(async () => { draw(); });
	const picker = doc.querySelector<HTMLInputElement>('[data-testid="attach-files-input"]')!;
	picker.click = () => { pickerClicks++; };
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const editor = doc.querySelector<HTMLElement>("[data-file-path-input]")!;
	return {
		button: doc.querySelector<HTMLButtonElement>('[data-testid="attach-files"]')!,
		get value() { return value; },
		doc,
		controller,
		get pickerClicks() { return pickerClicks; },
		get folderCalls() { return folderCalls; },
		get sends() { return sends; },
		setFolderResult(result: typeof folderResult) { folderResult = result; },
		async choice(label: string) {
			await act(async () => { Array.from(doc.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) => button.textContent === label)!.click(); });
		},
		async resize() { await act(async () => { win.dispatchEvent(new win.Event("resize")); }); },
		async key(key: string) {
			const event = Object.assign(new win.Event("keydown", { bubbles: true, cancelable: true }), { key });
			await act(async () => { controller.captureKeyDown(event as KeyboardEvent); doc.activeElement!.dispatchEvent(event); });
			return event;
		},
		get byteReads() { return byteReads; },
		file(name: string, path?: string) {
			const result = new File(["synthetic bytes must never be read"], name, { type: "application/pdf" });
			for (const method of ["text", "arrayBuffer", "stream"] as const) {
				Object.defineProperty(result, method, { value: () => { byteReads++; throw new Error("No file content reads"); } });
			}
			if (path !== undefined) backingPaths.set(result, path);
			return result;
		},
		caret(offset: number) {
			editor.focus();
			restorePathSelection(editor, { anchor: offset, focus: offset });
			doc.dispatchEvent(new win.Event("selectionchange"));
		},
		async pick(files: File[]) {
			Object.defineProperty(picker, "files", { configurable: true, value: files });
			await act(async () => { picker.dispatchEvent(new win.Event("change", { bubbles: true })); });
		},
	};
}

describe("attachment popup placement", () => {
	it("centers content-sized choices over the paperclip and leaves 4px above the entire short/multiline composer", () => {
		for (const top of [540, 420]) {
			const placed = attachmentPopupPlacement({ left: 680, right: 720 }, { top }, 58, { width: 1000, height: 800 });
			assert.equal(placed.left + 58 / 2, 700);
			assert.equal(800 - placed.bottom, top - 4);
		}
	});
	it("contains choices and wider error notices at both viewport edges", () => {
		for (const width of [58, 256]) {
			for (const left of [0, 980]) {
				const placed = attachmentPopupPlacement({ left, right: left + 40 }, { top: 540 }, width, { width: 1000, height: 800 });
				assert.ok(placed.left >= 8 && placed.left + width <= 992);
			}
		}
	});
	it("caps to the room above the composer instead of flipping across it", () => {
		const placed = attachmentPopupPlacement({ left: 120, right: 160 }, { top: 70 }, 58, { width: 300, height: 800 });
		assert.equal(placed.maxHeight, 58);
		assert.equal(placed.bottom, 734);
		assert.equal(placed.maxWidth, 284);
	});
});

describe("composer attach button", () => {
	it("the choice menu owns one Escape; a newer modal covers it without dismissing it or submitting the composer", async () => {
		const f = await fixture();
		await act(async () => f.button.click());
		assert.equal(f.controller.getTopLayer()?.kind, "popup");
		const menu = f.doc.querySelector<HTMLElement>('[role="menu"]')!;
		const modal = f.doc.createElement("div"); f.doc.body.append(modal);
		let closed = 0;
		let retire!: () => void;
		await act(async () => { retire = f.controller.register({ id: "newer-modal", kind: "modal", ownerId: null, rootRef: { current: modal }, onClose: () => { closed++; retire(); return "closed"; } }); });
		assert.equal(f.controller.isElementEligible(menu), false);
		await act(async () => modal.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
		assert.equal(f.doc.querySelector('[role="menu"]') !== null, true, "outside events belonging to a covering modal leave the lower popup intact");
		await f.key("Escape");
		assert.equal(closed, 1);
		assert.equal(f.doc.querySelector('[role="menu"]') !== null, true, "the same Escape cannot close both owners");
		const escape = await f.key("Escape");
		assert.equal(escape.defaultPrevented, true);
		assert.equal(f.doc.querySelector('[role="menu"]'), null);
		assert.equal(f.doc.activeElement === f.button, true);
		assert.equal(f.sends, 0);
		modal.remove();
	});

	it("pathsForFiles keeps rooted paths and skips files the bridge can't place", () => {
		const a = new File([""], "a.pdf");
		const b = new File([""], "b.png");
		const c = new File([""], "c.txt");
		const paths = new Map<File, string>([[a, "/notes/a.pdf"], [b, "relative/b.png"]]);
		const result = pathsForFiles([a, b, c], (file) => {
			const path = paths.get(file);
			if (!path) throw new Error("no path");
			return path;
		});
		assert.deepEqual(result, { paths: ["/notes/a.pdf"], skipped: 2 });
	});

	it("server render is the browser case: a disabled-looking paperclip between the input and Send", () => {
		const html = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} />);
		assert.match(html, /aria-label="Attach files"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*aria-label="Attach files"/);
		const editor = html.indexOf("data-file-path-input");
		const attach = html.indexOf('data-testid="attach-files"');
		const send = html.indexOf('aria-label="Send"');
		assert.ok(editor >= 0 && editor < attach && attach < send, "the paperclip follows the input and precedes Send");
		assert.ok(html.includes('type="file"') && !html.includes("accept="), "any file type");
	});

	it("desktop: the button offers Files/Folder, and Files keeps multi-file any-type chips at the caret", async () => {
		const f = await fixture();
		assert.equal(f.button.getAttribute("aria-disabled"), "false");
		f.caret(4);
		await act(async () => { f.button.click(); });
		assert.equal(f.pickerClicks, 0);
		assert.deepEqual(Array.from(f.doc.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent), ["Files", "Folder"]);
		await f.choice("Files");
		assert.equal(f.pickerClicks, 1);
		const paths = ["/course/week 3.pdf", "/photos/board.jpg"];
		await f.pick([f.file("week 3.pdf", paths[0]), f.file("board.jpg", paths[1]), f.file("virtual.pdf")]);
		assert.equal(f.value, `read ${paths.map(quoteFilePath).join(" ")} this`);
		assert.equal(f.byteReads, 0, "paths only — file contents are never read");
	});

	it("Folder inserts exactly one directory path (including empty folders) at the saved caret, without file selection or submits", async () => {
		const f = await fixture();
		f.caret(4);
		f.setFolderResult("/course/empty folder");
		await act(async () => { f.button.click(); });
		await f.choice("Folder");
		assert.equal(f.value, "read `/course/empty folder/` this");
		assert.ok(f.doc.querySelector(".lucide-folder"));
		assert.equal(f.folderCalls, 1);
		assert.equal(f.pickerClicks, 0);
		assert.equal(f.byteReads, 0);
		assert.equal(f.sends, 0);
		assert.equal(f.doc.querySelector('[role="menu"]'), null);
		assert.equal(f.doc.querySelector("[webkitdirectory]"), null);
	});

	for (const result of [null, "relative/folder", new Error("cancel/failure")]) it(`folder cancellation or error preserves the draft (${String(result)})`, async () => {
		const f = await fixture();
		f.caret(4);
		f.setFolderResult(result);
		await act(async () => { f.button.click(); });
		await f.choice("Folder");
		assert.equal(f.value, "readthis");
		assert.equal(f.sends, 0);
		assert.equal(f.pickerClicks, 0);
		assert.equal(f.doc.querySelector('[role="status"]') !== null, result !== null);
	});

	it("choices and errors portal outside the dock's clipping boundary, without removing dock clipping", async () => {
		const f = await fixture();
		const dock = f.doc.querySelector('[data-testid="clipping-dock"]')!;
		await act(async () => { f.button.click(); });
		const menu = f.doc.querySelector<HTMLElement>('[role="menu"]')!;
		assert.equal(menu.parentElement, f.doc.body);
		assert.equal(dock.contains(menu), false);
		assert.equal(menu.style.position, "fixed");
		assert.equal(menu.style.bottom, "204px");
		assert.notEqual(menu.style.visibility, "hidden");
		f.setFolderResult(new Error("fixture failure"));
		await f.choice("Folder");
		const notice = f.doc.querySelector<HTMLElement>('[role="status"]')!;
		assert.equal(notice.parentElement, f.doc.body);
		assert.equal(dock.contains(notice), false);
		assert.equal(notice.style.position, "fixed");
		assert.equal((dock as HTMLElement).style.overflow, "hidden");
		assert.equal(f.value, "readthis");
	});

	it("reanchors above the marked composer when its multiline boundary moves, not above the button", async () => {
		const f = await fixture();
		await act(async () => { f.button.click(); });
		const dock = f.doc.querySelector<HTMLElement>('[data-testid="clipping-dock"]')!;
		dock.getBoundingClientRect = () => ({ x: 100, y: 450, left: 100, right: 800, top: 450, bottom: 650, width: 700, height: 200, toJSON() {} });
		await f.resize();
		assert.equal(f.doc.querySelector<HTMLElement>('[role="menu"]')!.style.bottom, "354px");
	});

	it("paperclip menu focuses choices, supports arrows/Escape, and never submits a draft", async () => {
		const f = await fixture();
		f.caret(4);
		await act(async () => { f.button.click(); });
		assert.equal(f.doc.activeElement!.textContent, "Files");
		assert.equal((await f.key("ArrowDown")).defaultPrevented, true);
		assert.equal(f.doc.activeElement!.textContent, "Folder");
		await f.key("ArrowDown");
		assert.equal(f.doc.activeElement!.textContent, "Files");
		await f.key("End");
		assert.equal(f.doc.activeElement!.textContent, "Folder");
		await f.key("Home");
		assert.equal(f.doc.activeElement!.textContent, "Files");
		assert.equal((await f.key("Escape")).defaultPrevented, true);
		assert.equal(f.doc.activeElement, f.button);
		assert.equal(f.doc.querySelector('[role="menu"]'), null);
		assert.equal(f.button.getAttribute("aria-expanded"), "false");
		assert.equal(f.value, "readthis");
		assert.equal(f.sends, 0);
	});

	it("cancelled Files selection preserves draft and opens no folder chooser", async () => {
		const f = await fixture();
		await act(async () => { f.button.click(); });
		await f.choice("Files");
		await f.pick([]);
		assert.equal(f.value, "readthis");
		assert.equal(f.folderCalls, 0);
		assert.equal(f.sends, 0);
	});

	it("browser: the button stays inert and the picker never opens", async () => {
		const f = await fixture({ desktop: false });
		assert.equal(f.button.getAttribute("aria-disabled"), "true");
		await act(async () => { f.button.click(); });
		assert.equal(f.pickerClicks, 0);
		await f.pick([f.file("a.pdf", "/a.pdf")]);
		assert.equal(f.value, "readthis");
	});
});

it("releases an expired grant before replacing it and deletes a replacement that arrives after Remove", async t => {
	const calls: string[] = [];
	const oldGrant = { id: "old", uploadUrl: "/upload/old", expiresAt: Date.now() - 1 };
	const newGrant = { id: "new", uploadUrl: "/upload/new", expiresAt: Date.now() + 60_000 };
	let oldDeleteAttempts = 0;
	let startReplacement!: (response: Response) => void;
	const replacement = new Promise<Response>(resolve => { startReplacement = resolve; });
	t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		if (!init?.method) return Response.json({ capabilities: ["attachment-uploads-v1"] });
		calls.push(`${init.method} ${url}`);
		if (init.method === "POST") return calls.length === 1 ? Response.json(oldGrant) : replacement;
		if (url.endsWith("/old") && ++oldDeleteAttempts === 1) return Response.json({ error: "This file is still uploading." }, { status: 409 });
		return new Response(null, { status: 204 });
	});
	const originalXHR = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
	class FailingUpload {
		upload = {};
		onerror?: () => void;
		open() {}
		send() { this.onerror?.(); }
	}
	Object.defineProperty(globalThis, "XMLHttpRequest", { value: FailingUpload, configurable: true });
	t.after(() => {
		if (originalXHR) Object.defineProperty(globalThis, "XMLHttpRequest", originalXHR);
		else delete (globalThis as Record<string, unknown>).XMLHttpRequest;
	});
	let draft!: AttachmentDraft;
	await fixture({ desktop: false, onDraft: value => { draft = value; } });
	await act(async () => { draft.select([new File(["test"], "fixture.txt")]); });
	assert.match(draft.files[0]!.error!, /Upload interrupted/);
	await act(async () => { draft.retry(draft.files[0]!); });
	assert.equal(draft.files[0]!.grant?.id, "old");
	assert.equal(draft.files[0]!.error, "This file is still uploading.");
	assert.deepEqual(calls, ["POST /api/attachments", "DELETE /api/attachments/old"]);
	await act(async () => { draft.retry(draft.files[0]!); });
	assert.deepEqual(calls.slice(2), ["DELETE /api/attachments/old", "POST /api/attachments"]);
	await act(async () => {
		draft.remove(draft.files[0]!);
		startReplacement(Response.json(newGrant));
	});
	assert.deepEqual(draft.files, []);
	assert.equal(calls.at(-1), "DELETE /api/attachments/new");
});

it("releases the existing-chat submission when a file fails or is removed while Send waits", async t => {
	let grants = 0;
	t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
		if (!init?.method) return Response.json({ capabilities: ["attachment-uploads-v1"] });
		if (init.method === "POST") {
			const id = String(++grants);
			return Response.json({ id, uploadUrl: `/upload/${id}`, expiresAt: Date.now() + 60_000 });
		}
		return new Response(null, { status: 204 });
	});
	const uploads: ManualUpload[] = [];
	class ManualUpload {
		upload = {};
		status = 204;
		onload?: () => void;
		onerror?: () => void;
		open() {}
		send() { uploads.push(this); }
	}
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
	Object.defineProperty(globalThis, "XMLHttpRequest", { value: ManualUpload, configurable: true });
	t.after(() => {
		if (descriptor) Object.defineProperty(globalThis, "XMLHttpRequest", descriptor);
		else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
	});
	let draft!: AttachmentDraft;
	await fixture({ desktop: false, onDraft: value => { draft = value; } });
	const runner = new PluginSubmissionRunner();
	const target: PluginSubmissionTarget = { type: "text", sessionId: "chat", sessionKind: "teaching", channels: ["content"], surfaceTarget: {} as PluginSubmissionTarget["surfaceTarget"] };
	for (const outcome of ["failed", "removed"] as const) {
		await act(async () => { draft.select([new File(["test"], `${outcome}.txt`)]); });
		const row = draft.files.at(-1)!;
		const attempt = runner.begin(target, [], () => true)!;
		const prepared = draft.prepare("same draft", () => attempt.cancel());
		assert.equal(runner.preparing, true);
		await act(async () => {
			if (outcome === "failed") uploads.at(-1)!.onerror?.();
			else {
				draft.remove(row);
				uploads.at(-1)!.onload?.();
			}
			assert.equal(await prepared, null);
		});
		assert.equal(runner.occupied, false);
		if (outcome === "failed") {
			await act(async () => { draft.retry(row); });
			await act(async () => { uploads.at(-1)!.onload?.(); });
			const retry = runner.begin(target, [], () => true)!;
			assert.deepEqual((await draft.prepare("same draft", () => retry.cancel()))?.attachmentUploadIds, ["1"]);
			retry.cancel();
		}
	}
});

it("browser uploads offer Files and Folder on every device; the folder input is webkitdirectory", () => {
	const editorRef = { current: null };
	const html = renderToStaticMarkup(<AttachFilesButton editorRef={editorRef} upload={() => {}} uploadFolder={() => {}} />);
	assert.match(html, /aria-haspopup="menu"/);
	assert.match(html, /data-testid="attach-folder-input"[^>]*webkitdirectory=""|webkitdirectory=""[^>]*data-testid="attach-folder-input"/);
	assert.doesNotMatch(renderToStaticMarkup(<AttachFilesButton editorRef={editorRef} upload={() => {}} />), /attach-folder-input/);
});

it("a folder uploads as one chip, reports skipped entries, and Retry renews only the missing files", async t => {
	const calls: { method: string; url: string; body?: unknown }[] = [];
	const puts: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		if (!init?.method) return Response.json({ capabilities: ["attachment-uploads-v1", "attachment-folders-v1"] });
		calls.push({ method: init.method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
		if (init.method === "POST" && url === "/api/attachments") {
			return Response.json({ id: "folder", expiresAt: Date.now() + 600_000, files: [{ path: "a.md", uploadUrl: "/upload/a" }, { path: "sub/b.md", uploadUrl: "/upload/b" }] }, { status: 201 });
		}
		if (init.method === "POST") return Response.json({ id: "folder", expiresAt: Date.now() + 600_000, files: puts.includes("/upload/b2") ? [] : [{ path: "sub/b.md", uploadUrl: "/upload/b2" }] });
		return new Response(null, { status: 204 });
	});
	class ScriptedUpload {
		upload = {};
		status = 204;
		url = "";
		onload?: () => void;
		onerror?: () => void;
		open(_method: string, url: string) { this.url = url; }
		send() {
			puts.push(this.url);
			queueMicrotask(() => { if (this.url === "/upload/b") this.onerror?.(); else this.onload?.(); });
		}
	}
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
	Object.defineProperty(globalThis, "XMLHttpRequest", { value: ScriptedUpload, configurable: true });
	t.after(() => {
		if (descriptor) Object.defineProperty(globalThis, "XMLHttpRequest", descriptor);
		else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
	});
	let draft!: AttachmentDraft;
	await fixture({ desktop: false, onDraft: value => { draft = value; } });
	assert.equal(draft.folders, true);
	const picked = (relativePath: string) => Object.assign(new File(["x"], relativePath.split("/").at(-1)!, { type: "text/markdown" }), { webkitRelativePath: relativePath });
	await act(async () => { draft.selectFolder([picked("Notes/a.md"), picked("Notes/sub/b.md"), picked("Notes/.DS_Store")]); });
	await act(async () => { await draft.files[0]?.work; });
	assert.deepEqual(calls[0], { method: "POST", url: "/api/attachments", body: { draftId: draft.getDraftId(), name: "Notes", files: [{ path: "a.md", mimeType: "text/markdown", size: 1 }, { path: "sub/b.md", mimeType: "text/markdown", size: 1 }] } });
	assert.equal(draft.files.length, 1);
	assert.match(draft.files[0]!.error!, /Upload interrupted/);
	const chips = renderToStaticMarkup(<DraftAttachmentChips draft={draft} />);
	assert.match(chips, /Notes · 2 files/);
	assert.match(chips, /Skipped 1 hidden or system file in Notes: \.DS_Store/);
	await act(async () => { draft.retry(draft.files[0]!); });
	await act(async () => { await draft.files[0]?.work; });
	assert.deepEqual(calls.slice(1).map(call => `${call.method} ${call.url}`), ["POST /api/attachments/folder", "POST /api/attachments/folder"]);
	assert.deepEqual(puts.sort(), ["/upload/a", "/upload/b", "/upload/b2"]);
	assert.equal(draft.files[0]!.ready, true);
	assert.deepEqual((await draft.prepare("draft"))?.attachmentUploadIds, ["folder"]);
	// An old phone's folder input returns plain files: nothing uploads.
	await act(async () => { draft.selectFolder([new File(["x"], "plain.md")]); });
	assert.equal(draft.validation, "This browser can't attach folders. Attach individual files instead.");
	assert.equal(draft.files.length, 1);
});

function fakeEntries() {
	const fileEntry = (fullPath: string) => ({
		isFile: true, isDirectory: false, name: fullPath.split("/").at(-1)!, fullPath,
		file: (resolve: (value: File) => void) => resolve(new File(["x"], fullPath.split("/").at(-1)!)),
	});
	const directory = (fullPath: string, children: object[]) => ({
		isFile: false, isDirectory: true, name: fullPath.split("/").at(-1)!, fullPath,
		createReader: () => { let done = false; return { readEntries: (resolve: (value: object[]) => void) => { resolve(done ? [] : children); done = true; } }; },
	});
	return { fileEntry, directory };
}

it("each rejected folder of one drop keeps its own error line, even beside an accepted folder", async t => {
	t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
		if (!init?.method) return Response.json({ capabilities: ["attachment-uploads-v1", "attachment-folders-v1"] });
		return Response.json({ error: "Offline in this test." }, { status: 503 });
	});
	let draft!: AttachmentDraft;
	await fixture({ desktop: false, onDraft: value => { draft = value; } });
	const { fileEntry, directory } = fakeEntries();
	const unsafe = directory("/Bad", [fileEntry("/Bad/CON.txt")]);
	const accepted = directory("/Good", [fileEntry("/Good/a.md")]);
	const empty = directory("/Hidden", [fileEntry("/Hidden/.DS_Store")]);
	await act(async () => { await draft.drop([unsafe, accepted, empty] as unknown as FileSystemEntry[], []); });
	assert.deepEqual(draft.files.map(row => row.name), ["Good"]);
	assert.deepEqual(draft.validation?.split("\n"), ["\"Bad/CON.txt\" is not a safe file path. Rename it or attach a different folder.", "Hidden has no files to attach."]);
	const alerts = [...renderToStaticMarkup(<DraftAttachmentChips draft={draft} />).matchAll(/role="alert"[^>]*>([^<]*)</g)].map(match => match[1]);
	assert.ok(alerts.includes("Hidden has no files to attach."));
	assert.ok(alerts.some(text => text?.includes("Bad/CON.txt")));
});

it("grant timing follows the server's clock, not a skewed device clock", async t => {
	let skew = 60 * 60_000; // First the device clock runs an hour ahead of the server.
	let serverNow = Date.now();
	const realNow = Date.now.bind(Date);
	t.mock.method(Date, "now", () => realNow() + skew);
	const posts: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		if (!init?.method) return Response.json({ capabilities: ["attachment-uploads-v1", "attachment-folders-v1"] });
		const headers = { date: new Date(serverNow).toUTCString() };
		if (init.method === "POST") {
			posts.push(url);
			const body = init.body ? JSON.parse(String(init.body)) : {};
			if (body.files) return Response.json({ id: "folder", expiresAt: serverNow + 600_000, files: [{ path: "a.md", uploadUrl: "/upload/folder-a" }] }, { status: 201, headers });
			if (url !== "/api/attachments") return Response.json({ id: "folder", expiresAt: serverNow + 600_000, files: [] }, { headers });
			return Response.json({ id: `file-${posts.length}`, uploadUrl: `/upload/file-${posts.length}`, expiresAt: serverNow + 600_000 }, { status: 201, headers });
		}
		return new Response(null, { status: 204, headers });
	});
	const puts: string[] = [];
	let failFirstFile = true;
	class ClockUpload {
		upload = {};
		status = 204;
		url = "";
		onload?: () => void;
		onerror?: () => void;
		open(_method: string, url: string) { this.url = url; }
		send() {
			puts.push(this.url);
			queueMicrotask(() => {
				if (this.url.startsWith("/upload/file") && failFirstFile) { failFirstFile = false; this.onerror?.(); }
				else this.onload?.();
			});
		}
	}
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
	Object.defineProperty(globalThis, "XMLHttpRequest", { value: ClockUpload, configurable: true });
	t.after(() => {
		if (descriptor) Object.defineProperty(globalThis, "XMLHttpRequest", descriptor);
		else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
	});
	let draft!: AttachmentDraft;
	await fixture({ desktop: false, onDraft: value => { draft = value; } });
	// A folder: against the hour-ahead device clock the fresh grant looks
	// expired, which used to block every upload.
	const picked = Object.assign(new File(["x"], "a.md"), { webkitRelativePath: "Notes/a.md" });
	await act(async () => { draft.selectFolder([picked]); });
	await act(async () => { await draft.files[0]?.work; });
	assert.equal(draft.files[0]!.ready, true);
	assert.deepEqual(puts, ["/upload/folder-a"]);
	// A single file on a device an hour behind, whose PUT failed: eleven
	// minutes later its grant has expired on the server, so Retry reserves
	// again instead of reusing it.
	skew = -60 * 60_000;
	await act(async () => { draft.select([new File(["x"], "b.txt")]); });
	await act(async () => { await draft.files[1]?.work; });
	assert.match(draft.files[1]!.error!, /Upload interrupted/);
	serverNow += 11 * 60_000;
	skew += 11 * 60_000;
	await act(async () => { draft.retry(draft.files[1]!); });
	await act(async () => { await draft.files[1]?.work; });
	assert.equal(draft.files[1]!.ready, true);
	assert.equal(puts.at(-1), "/upload/file-4");
});

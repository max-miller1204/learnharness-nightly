/**
 * Issue #366: the composer is editable from the server render, so text typed
 * before hydration must survive it. The server's markup is hydrated after a
 * native edit that no listener saw, and the field must keep the edit and tell
 * its owner.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { renderToString } from "react-dom/server";
import { PATH_INPUT_BOOT_SCRIPT } from "../components/path-input-boot.ts";
import { PathInput } from "../components/path-input.tsx";
import { readPathInput, readPathSelection } from "../components/path-input-dom.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

/** Server-render `serverValue`, let the "user" edit the live field, then hydrate with `clientValue`. */
async function hydrate(serverValue: string, typed: string | null, clientValue = serverValue, singleLine = false, caret?: number, extra?: React.ReactNode, composing = false) {
	const html = renderToString(<><PathInput value={serverValue} onValueChange={() => assert.fail("SSR cannot emit changes")} singleLine={singleLine} />{extra}</>);
	const { window: win, document: doc } = parseHTML(`<html><body><div id='root'>${html}</div></body></html>`);
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({ React, window: win, document: doc, HTMLElement: win.HTMLElement, Element: win.Element, Event: win.Event, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const field = doc.querySelector("[data-file-path-input]") as HTMLElement;
	const selection = {
		anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
		setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) { Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset }); },
	};
	Object.defineProperty(doc, "activeElement", { get: () => (caret === undefined ? doc.body : field) });
	Object.assign(doc, { getSelection: () => (caret === undefined ? null : selection) });
	if (typed !== null) {
		const text = doc.createTextNode(typed);
		field.replaceChildren(text); // typed before any listener existed
		if (caret !== undefined) selection.setBaseAndExtent(text, caret, text, caret);
	}
	if (composing) new Function("document", PATH_INPUT_BOOT_SCRIPT)(doc);
	if (composing) field.dispatchEvent(new win.Event("compositionstart", { bubbles: true }));
	const originalChild = field.firstChild;
	const { hydrateRoot } = await import("react-dom/client");
	const changes: string[] = [];
	const errors: unknown[] = [];
	let reactRoot!: ReturnType<typeof hydrateRoot>;
	const element = (value: string) => <><PathInput value={value} onValueChange={(next) => changes.push(next)} singleLine={singleLine} />{extra}</>;
	await act(async () => { reactRoot = hydrateRoot(doc.getElementById("root")!, element(clientValue), { onRecoverableError: (error) => errors.push(error) }); });
	cleanup = async () => {
		await act(async () => { reactRoot.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const live = doc.querySelector("[data-file-path-input]") as HTMLElement;
	assert.deepEqual(errors, [], "hydration raised no error (React error 418 is a text mismatch)");
	assert.equal(live, field, "hydration keeps the element the learner typed into");
	return { field, live, selection, doc, changes, errors, originalChild, win, rerender: (value: string) => act(async () => { reactRoot.render(element(value)); }) };
}

test("text typed before hydration is kept and reported to the owner", async () => {
	const f = await hydrate("", "typed early");
	assert.equal(readPathInput(f.live), "typed early");
	assert.deepEqual(f.changes, ["typed early"]);
	assert.equal(f.live.dataset.empty, "false");
});

test("a pre-hydration edit wins over the text the server rendered", async () => {
	const f = await hydrate("saved draft", "saved draft plus more");
	assert.equal(readPathInput(f.live), "saved draft plus more");
	assert.deepEqual(f.changes, ["saved draft plus more"]);
});

test("clearing the server's text before hydration is an edit too", async () => {
	const f = await hydrate("saved draft", "");
	assert.equal(readPathInput(f.live), "");
	assert.deepEqual(f.changes, [""]);
	assert.equal(f.live.dataset.empty, "true");
});

test("an untouched field hydrates silently and shows the server's text", async () => {
	const none = await hydrate("", null);
	assert.equal(readPathInput(none.live), "");
	assert.deepEqual(none.changes, []);
	await cleanup?.();
	const saved = await hydrate("saved draft", null);
	assert.equal(readPathInput(saved.live), "saved draft");
	assert.deepEqual(saved.changes, []);
});

test("single-line fields drop line breaks typed before hydration", async () => {
	const f = await hydrate("", "one\ntwo", "", true);
	assert.equal(readPathInput(f.live), "onetwo");
	assert.deepEqual(f.changes, ["onetwo"]);
});

test("after a pre-hydration edit the owner's later values still apply", async () => {
	const f = await hydrate("", "typed early");
	await f.rerender("typed early and a dictated tail");
	assert.equal(readPathInput(f.live), "typed early and a dictated tail");
});

test("an owner that restores a saved draft after mount leaves a pre-hydration edit alone", async () => {
	function Owner({ saved }: { saved: string }) {
		const [value, setValue] = React.useState("");
		const latest = React.useRef(value);
		React.useEffect(() => { if (saved && latest.current === "") { latest.current = saved; setValue(saved); } }, [saved]);
		return <PathInput value={value} onValueChange={(next) => { latest.current = next; setValue(next); }} />;
	}
	const run = async (typed: string | null) => {
		const html = renderToString(<Owner saved="saved draft" />);
		const { window: win, document: doc } = parseHTML(`<html><body><div id='root'>${html}</div></body></html>`);
		const previous = new Map<string, PropertyDescriptor | undefined>();
		for (const [name, value] of Object.entries({ React, window: win, document: doc, HTMLElement: win.HTMLElement, Element: win.Element, Event: win.Event, IS_REACT_ACT_ENVIRONMENT: true })) {
			previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
			Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
		}
		Object.defineProperty(doc, "activeElement", { get: () => doc.body });
		Object.assign(doc, { getSelection: () => null });
		if (typed !== null) doc.querySelector("[data-file-path-input]")!.replaceChildren(doc.createTextNode(typed));
		const { hydrateRoot } = await import("react-dom/client");
		let reactRoot!: ReturnType<typeof hydrateRoot>;
		await act(async () => { reactRoot = hydrateRoot(doc.getElementById("root")!, <Owner saved="saved draft" />); });
		cleanup = async () => {
			await act(async () => { reactRoot.unmount(); });
			for (const [name, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else delete (globalThis as Record<string, unknown>)[name];
			}
		};
		return readPathInput(doc.querySelector("[data-file-path-input]") as HTMLElement);
	};
	assert.equal(await run("typed early"), "typed early");
	await cleanup?.(); cleanup = undefined;
	assert.equal(await run(null), "saved draft", "with nothing typed the saved draft is restored");
});

test("a server value with CRLF is not an edit: HTML parsing turns it into LF", async () => {
	const f = await hydrate("one\r\ntwo", "one\ntwo"); // what a browser's parser leaves in the field
	assert.deepEqual(f.changes, []);
});

test("the caret keeps its place in the text typed before hydration", async () => {
	const f = await hydrate("", "hello world", "", false, 5);
	assert.equal(readPathInput(f.live), "hello world");
	assert.deepEqual(readPathSelection(f.live), { anchor: 5, focus: 5 });
});

test("a single-line field remaps the caret past a line break typed before hydration", async () => {
	const f = await hydrate("", "ab\ncd", "", true, 4); // 4 is after "ab\nc"
	assert.equal(readPathInput(f.live), "abcd");
	assert.deepEqual(readPathSelection(f.live), { anchor: 3, focus: 3 }, "the caret stays between c and d");
});

/** A sibling after the field: its mount layout effect runs after the field's and before any passive effect. */
function EditAtMount({ text }: { text: string }) {
	React.useLayoutEffect(() => {
		const field = document.querySelector("[data-file-path-input]") as HTMLElement;
		field.replaceChildren(document.createTextNode(text));
		field.dispatchEvent(new Event("input", { bubbles: true }));
	}, [text]);
	return null;
}

test("an edit that lands before the passive report is reported once", async () => {
	const f = await hydrate("", "typed early", "", false, undefined, <EditAtMount text="typed early and more" />);
	assert.equal(readPathInput(f.live), "typed early and more");
	assert.deepEqual(f.changes, ["typed early and more"]);
});

test("a stripped early line break preserves the caret without reporting a change", async () => {
	const f = await hydrate("abcd", "ab\ncd", "abcd", true, 3);
	assert.equal(readPathInput(f.live), "abcd");
	assert.deepEqual(readPathSelection(f.live), { anchor: 2, focus: 2 });
	assert.deepEqual(f.changes, []);
});


test("composition begun before hydration is left alone until commit", async () => {
	const f = await hydrate("", "provisional", "", false, undefined, undefined, true);
	assert.ok(f.live.firstChild === f.originalChild);
	assert.deepEqual(f.changes, []);
	f.live.textContent = "committed";
	await act(async () => { f.live.dispatchEvent(new f.win.Event("compositionend", { bubbles: true })); await Promise.resolve(); });
	assert.equal(readPathInput(f.live), "committed");
	assert.deepEqual(f.changes, ["committed"]);
});

/**
 * The phone's "Open in browser?" prompt (src/Markdown.tsx confirmExternalLink),
 * reached by tapping a link in a message rendered through Markdown and
 * NativeMarkdown, and called directly, then pressed button by button. A link
 * wired straight to Linking.openURL, or a Cancel that opens anyway, fails it.
 * The real module runs against the react-native stand-in in tests/mocks, which
 * records Alert and Linking. Answer key: the mobile beta spec and recipe
 * (an HTTPS link asks first; Cancel stays in the app; Open opens that URL; a
 * non-HTTPS link never asks).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { confirmExternalLink, Markdown } from "../src/Markdown.tsx";

type Alerted = { title: string; message: string; buttons: { text: string; onPress?: () => void }[] };
const g = globalThis as unknown as { lastAlert: Alerted | null; openedLinks: string[]; IS_REACT_ACT_ENVIRONMENT: boolean };
g.IS_REACT_ACT_ENVIRONMENT = true;
const reset = () => { g.lastAlert = null; g.openedLinks = []; };
const press = (text: string) => g.lastAlert?.buttons.find((b) => b.text === text)?.onPress?.();

/** A reply rendered the way the transcript renders it (no math: NativeMarkdown), and its link nodes. */
function renderedLinks(text: string): ReactTestInstance[] {
	let tree: ReturnType<typeof create> | undefined;
	act(() => { tree = create(createElement(Markdown, { text })); });
	return tree!.root.findAll((n) => String(n.type) === "Text" && n.props.accessibilityRole === "link");
}

test("a link in a rendered message asks first, and only Open opens it", () => {
	const links = renderedLinks("Read [the secure page](https://example.com/zz-link-rendered) and [the plain one](http://example.com/zz-link-plain).");
	assert.equal(links.length, 1, "only the HTTPS link is a link");
	reset();
	(links[0]!.props.onPress as () => void)();
	assert.equal(g.lastAlert?.title, "Open in browser?", "tapping the link asks before anything opens");
	assert.deepEqual(g.openedLinks, [], "nothing opens on the tap itself");
	press("Cancel");
	assert.deepEqual(g.openedLinks, [], "Cancel keeps the app in front");
	(links[0]!.props.onPress as () => void)();
	press("Open");
	assert.deepEqual(g.openedLinks, ["https://example.com/zz-link-rendered"]);
});

test("an HTTPS link asks before opening, with Cancel and Open", () => {
	reset();
	confirmExternalLink("https://example.com/zz-link");
	assert.equal(g.lastAlert?.title, "Open in browser?");
	assert.deepEqual(g.lastAlert?.buttons.map((b) => b.text), ["Cancel", "Open"]);
});

test("Cancel stays in the app: nothing opens", () => {
	reset();
	confirmExternalLink("https://example.com/zz-link");
	press("Cancel");
	assert.deepEqual(g.openedLinks, []);
});

test("Open opens exactly the confirmed URL", () => {
	reset();
	confirmExternalLink("https://example.com/zz-link");
	press("Open");
	assert.deepEqual(g.openedLinks, ["https://example.com/zz-link"]);
});

test("a non-HTTPS link never asks and never opens", () => {
	reset();
	confirmExternalLink("http://example.com/zz-link");
	assert.equal(g.lastAlert, null);
	assert.deepEqual(g.openedLinks, []);
});

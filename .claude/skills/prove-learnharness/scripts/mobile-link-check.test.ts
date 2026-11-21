/**
 * mobile-link-check.test.ts: the phone's "Open in browser?" prompt
 * (apps/mobile/src/Markdown.tsx confirmExternalLink), reached by tapping a link
 * in a message rendered through Markdown and NativeMarkdown, and called
 * directly, then pressed button by button. A link wired straight to
 * Linking.openURL, or a Cancel that opens anyway, fails it.
 * Run by scripts/mobile-checks.sh with the app's own test loader, so the real
 * module runs against apps/mobile's react-native stand-in, with Alert and
 * Linking recorded here. Answer key: the mobile beta spec and recipe (an
 * HTTPS link asks first; Cancel stays in the app; Open opens that URL; a
 * non-HTTPS link never asks).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const app = process.env.PROVE_MOBILE_APP ?? path.resolve(import.meta.dirname, "../../../../apps/mobile");
const rn = createRequire(path.join(app, "package.json"))("react-native");
const opened: string[] = [];
let lastAlert: { title: string; message: string; buttons: Array<{ text: string; onPress?: () => void }> } | null = null;
rn.Alert = { alert: (title: string, message: string, buttons: Array<{ text: string; onPress?: () => void }>) => { lastAlert = { title, message, buttons }; } };
rn.Linking = { openURL: (url: string) => { opened.push(url); return Promise.resolve(); } };

const { confirmExternalLink, Markdown } = await import(path.join(app, "src/Markdown.tsx"));
const press = (text: string) => lastAlert?.buttons.find((b) => b.text === text)?.onPress?.();

// The app's own React and test renderer, so the rendered message uses one copy of React.
const appRequire = createRequire(path.join(app, "package.json"));
const { createElement } = appRequire("react");
const TestRenderer = appRequire("react-test-renderer");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A reply rendered the way the transcript renders it (no math: NativeMarkdown), and its link nodes. */
function renderedLinks(text: string) {
	let tree: { root: { findAll: (f: (n: { type: unknown; props: Record<string, unknown> }) => boolean) => Array<{ props: Record<string, unknown> }> } } | undefined;
	TestRenderer.act(() => { tree = TestRenderer.create(createElement(Markdown, { text })); });
	return tree!.root.findAll((n) => String(n.type) === "Text" && n.props.accessibilityRole === "link");
}

test("a link in a rendered message asks first, and only Open opens it", () => {
	const links = renderedLinks("Read [the secure page](https://example.com/zz-prove-rendered) and [the plain one](http://example.com/zz-prove-plain).");
	assert.equal(links.length, 1, "only the HTTPS link is a link");
	lastAlert = null;
	opened.length = 0;
	(links[0].props.onPress as () => void)();
	assert.equal(lastAlert?.title, "Open in browser?", "tapping the link asks before anything opens");
	assert.deepEqual(opened, [], "nothing opens on the tap itself");
	press("Cancel");
	assert.deepEqual(opened, [], "Cancel keeps the app in front");
	(links[0].props.onPress as () => void)();
	press("Open");
	assert.deepEqual(opened, ["https://example.com/zz-prove-rendered"]);
});

test("an HTTPS link asks before opening, with Cancel and Open", () => {
	lastAlert = null;
	confirmExternalLink("https://example.com/zz-prove");
	assert.equal(lastAlert?.title, "Open in browser?");
	assert.deepEqual(lastAlert?.buttons.map((b) => b.text), ["Cancel", "Open"]);
});

test("Cancel stays in the app: nothing opens", () => {
	opened.length = 0;
	confirmExternalLink("https://example.com/zz-prove");
	press("Cancel");
	assert.deepEqual(opened, []);
});

test("Open opens exactly the confirmed URL", () => {
	opened.length = 0;
	confirmExternalLink("https://example.com/zz-prove");
	press("Open");
	assert.deepEqual(opened, ["https://example.com/zz-prove"]);
});

test("a non-HTTPS link never asks and never opens", () => {
	lastAlert = null;
	opened.length = 0;
	confirmExternalLink("http://example.com/zz-prove");
	assert.equal(lastAlert, null);
	assert.deepEqual(opened, []);
});

/**
 * mobile-link-check.test.ts: the phone's "Open in browser?" prompt
 * (apps/mobile/src/Markdown.tsx confirmExternalLink), pressed button by button.
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

const { confirmExternalLink } = await import(path.join(app, "src/Markdown.tsx"));
const press = (text: string) => lastAlert?.buttons.find((b) => b.text === text)?.onPress?.();

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

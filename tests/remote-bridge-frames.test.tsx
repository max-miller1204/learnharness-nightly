/*
 * The remote window's bridges (window.lh.desktopUpdate, window.lh.chatgptSignIn) answer any
 * script that runs with the server page's origin, a same-origin frame included: main sees
 * such a frame's call through window.parent as the main frame's. That is sound only while
 * every frame running content the app doesn't fully trust is opaque (sandboxed without
 * allow-same-origin) or never a frame at all. docs/specs/desktop-server-list.md (Bridge)
 * records this; these tests keep it true.
 */
import React from "react";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { SvgImage } from "../components/artifacts/svg-image.tsx";

const root = path.join(import.meta.dirname, "..");
function sources(dir: string): string[] {
	return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
		const relative = path.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "tests" || entry.name.startsWith(".") ? [] : sources(relative);
		return /\.(tsx?|jsx?|mjs|cjs|html)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [relative] : [];
	});
}

test("the app's only iframe is the lesson demo's, sandboxed with an opaque origin", () => {
	const frames = ["app", "components", "lib", "src", "plugins"].flatMap(sources)
		.filter((file) => /<iframe\b|createElement\(\s*["']iframe["']\s*\)/.test(fs.readFileSync(path.join(root, file), "utf8")));
	assert.deepEqual(frames, [path.join("components", "artifacts", "demo-card.tsx")], "a new frame must be opaque too: update this test and the spec");
	const demo = fs.readFileSync(path.join(root, "components", "artifacts", "demo-card.tsx"), "utf8");
	const values = [...demo.matchAll(/sandbox="([^"]*)"/g)].map((match) => match[1]);
	assert.ok(values.length > 0 && values.every((value) => value === "allow-scripts"), `never allow-same-origin: ${values}`);
});

test("model output can't put a same-origin frame on the page", () => {
	const attack = '<iframe srcdoc="<script>parent.lh.chatgptSignIn.start()</script>"></iframe>\n\n<object data="/x"></object><embed src="/x">';
	const html = renderToStaticMarkup(<MessageResponse>{attack}</MessageResponse>);
	assert.equal(/<iframe|<object|<embed|srcdoc/i.test(html), false, html);
});

test("SVG figures render as images, which run no script", () => {
	const html = renderToStaticMarkup(<SvgImage svg={'<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe srcdoc="x"></iframe></foreignObject><script>parent.lh</script></svg>'} />);
	assert.match(html, /^<img [^>]*src="data:image\/svg\+xml/);
});

test("Mermaid diagrams render in strict mode, which sanitizes their labels", () => {
	assert.match(fs.readFileSync(path.join(root, "components", "mermaid-render.ts"), "utf8"), /securityLevel: "strict"/);
});

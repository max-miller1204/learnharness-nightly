import React from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { LiveToolCard } from "../components/artifacts/live-tool-card.tsx";
import { ToolCallCard } from "../components/artifacts/tool-call-card.tsx";
import { capToolText, isShowImageDetails, TOOL_STEPS, toolStepHeadline, toolStepOutput } from "../src/core/tool-steps.ts";

describe("tool steps", () => {
	it("TOOL_STEPS is exactly the web registry's ToolCallCard entries, so the phone shows the same tools", () => {
		const web = Object.entries(artifactRenderers).filter(([, card]) => card === ToolCallCard).map(([tool]) => tool);
		assert.deepEqual([...web].sort(), [...TOOL_STEPS].sort());
	});

	it("the web card reads its headline and output from the shared rules", () => {
		const part = { type: "tool-read", state: "output-available", toolCallId: "c", input: { path: "notes.md" }, output: "# Notes" };
		const html = renderToStaticMarkup(<ToolCallCard part={part as never} />);
		assert.match(html, />read<\/span><span class="truncate">notes\.md</);
		assert.match(html, /# Notes/);
		assert.equal(toolStepHeadline("read", {}), "~");
		assert.equal(toolStepHeadline("grep", { pattern: "a+" }), "a+");
		assert.equal(toolStepHeadline("list_propositions", { session: "chat_x" }), "chat_x");
		assert.equal(toolStepOutput({ text: "t", images: [1, 2] }), "t\n[2 images attached to the model]");
	});

	it("the web card shows the start of long text with a note, and escapes bidirectional controls in the headline", () => {
		const card = (input: unknown, output: unknown) => renderToStaticMarkup(<ToolCallCard part={{ type: "tool-read", state: "output-available", toolCallId: "c", input, output } as never} />);
		const lines = card({ path: "a.md" }, Array.from({ length: 500 }, (_, at) => `line ${at}`).join("\n"));
		assert.match(lines, /Showing the first 200 of 500 lines\./);
		assert.ok(lines.includes("line 199") && !lines.includes("line 200"));
		assert.match(card({ path: "a.md" }, "x".repeat(500_008)), /Showing the first 8,192 of 500,008 characters\./);
		assert.doesNotMatch(card({ path: "a.md" }, "short"), /Showing the first/);
		const disguised = card({ path: "a\u202Etxt.exe" }, "");
		assert.ok(disguised.includes("a\\u202Etxt.exe") && !/[\u202A-\u202E\u2066-\u2069]/.test(disguised.replace(/<pre[^]*<\/pre>/, "")));
	});

	it("counts lines without a final newline, cuts on code points, and never splits an escape", () => {
		const lines = (n: number, end = "") => Array.from({ length: n }, (_, at) => `l${at}`).join("\n") + end;
		assert.deepEqual(capToolText(lines(200, "\n")), { text: lines(200, "\n") }, "200 lines and a final newline are all shown");
		assert.equal(capToolText(lines(300, "\n")).note, "Showing the first 200 of 300 lines.");
		const emoji = "\u{1F600}".repeat(9000);
		const cut = capToolText(emoji);
		assert.equal(cut.note, "Showing the first 8,192 of 9,000 characters.");
		assert.equal([...cut.text].length, 8192);
		assert.ok(!/[\uD800-\uDBFF]$/.test(cut.text), "no half of a pair left at the end");
		assert.equal(toolStepHeadline("read", { path: "abcd\u202Exyz" }, 5), "abcd\\u202E…", "cut before escaping");
		assert.equal(toolStepHeadline("read", { path: "\u{1F600}".repeat(5) + "x" }, 5), `${"\u{1F600}".repeat(5)}…`);
	});

	it("isShowImageDetails accepts only what the web's image card can draw", () => {
		const good = { snapshotId: "a".repeat(64), mimeType: "image/png", path: "a.png", width: 4, height: 3 };
		assert.ok(isShowImageDetails(good));
		for (const bad of [{ ...good, mimeType: "image/gif" }, { ...good, path: undefined }, { ...good, width: "4" }, { ...good, snapshotId: "x" }]) assert.ok(!isShowImageDetails(bad));
	});

	it("escapes the Arabic letter mark and the left-to-right and right-to-left marks too, never letters", () => {
		const path = "a\u061Cb\u200Ec\u200Fd";
		const html = renderToStaticMarkup(<ToolCallCard part={{ type: "tool-read", state: "output-available", toolCallId: "c", input: { path }, output: `x\u200Fy` } as never} />);
		assert.ok(html.includes("a\\u061Cb\\u200Ec\\u200Fd"), "headline");
		assert.ok(html.includes("x\\u200Fy"), "output");
		assert.ok(!/[\u061C\u200E\u200F]/.test(html));
		const letters = "\u0645\u0644\u0641 \u05E7\u05D5\u05D1\u05E5.txt";
		assert.equal(toolStepHeadline("read", { path: letters }), letters, "Arabic and Hebrew letters stay as written");
	});

	it("the live card escapes every direction control in its headline and its streaming input", () => {
		const controls = "\u061C\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069";
		assert.equal([...controls].length, 12);
		const html = renderToStaticMarkup(<LiveToolCard part={{ type: "tool-read", state: "input-streaming", toolCallId: "c", input: { path: `a${controls}b`, note: controls } } as never} />);
		assert.ok(!/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(html), "no raw control anywhere in the card");
		for (const control of controls) assert.ok(html.includes(`\\u${control.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`), control.charCodeAt(0).toString(16));
	});
});


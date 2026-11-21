import React from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { ToolCallCard } from "../components/artifacts/tool-call-card.tsx";
import { TOOL_STEPS, toolStepHeadline, toolStepOutput } from "../src/core/tool-steps.ts";

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
});

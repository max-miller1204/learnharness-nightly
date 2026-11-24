/**
 * The LIVE tool-input card (owner, streaming round 2026-10-01): what a
 * tool call looks like while the agent writes it — Braille spinner +
 * shimmered activity label in the header (the retired bottom line's
 * text, one glimmer recipe), the streaming input watchable on expand.
 * These pins hold the working-state grammar on the card.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveToolCard } from "../components/artifacts/live-tool-card.tsx";

function part(tool: string, input: unknown) {
	return { type: `tool-${tool}`, toolCallId: "c1", state: "input-streaming", input };
}

describe("LiveToolCard (the working-state grammar)", () => {
	it("spinner + shimmered activity label + headline arg, input on expand", () => {
		const html = renderToStaticMarkup(<LiveToolCard part={part("read", { path: "notes.md" }) as never} />);
		assert.match(html, /data-testid="live-tool-card"/);
		assert.match(html, /data-testid="braille-spinner"/);
		// the label names the ACTUAL tool (the old bottom line's text)
		assert.match(html, /Reading a file…/);
		// the headline argument rides the header (the summary), apart from the body
		const summary = html.match(/<summary[\s\S]*?<\/summary>/)?.[0] ?? "";
		assert.match(summary, /<span class="truncate">notes\.md<\/span>/);
		// the streaming input is shown in the expandable body
		const body = html.slice(html.indexOf("</summary>"));
		assert.match(body, /Input \(streaming\)/);
		assert.match(body, /notes\.md/);
	});

	it("unknown tools stay generic; jobs get their dispatch labels", () => {
		assert.match(renderToStaticMarkup(<LiveToolCard part={part("mystery_tool", {}) as never} />), /Working…/);
		assert.match(
			renderToStaticMarkup(<LiveToolCard part={part("research", { query: "x" }) as never} />),
			/Dispatching research…/,
		);
	});

	it("no input yet renders a placeholder, not an empty pre", () => {
		const html = renderToStaticMarkup(<LiveToolCard part={part("grep", undefined) as never} />);
		assert.match(html, /<pre[^>]*>…<\/pre>/);
	});

	it("shows only a tool step's declared input fields while it streams", () => {
		const html = renderToStaticMarkup(<LiveToolCard part={part("read", { path: "notes.md", modelSolution: "SECRET-SOLUTION", extra: "SECRET-EXTRA" }) as never} />);
		assert.match(html, /notes\.md/);
		assert.doesNotMatch(html, /SECRET/);
	});

	it("never shows a streaming problem, conclusion or plugin tool's arguments", () => {
		const hidden = { statement: "Sum two numbers", modelSolution: "SECRET-SOLUTION", payload: { tests: ["SECRET-TESTS"] }, verdict: "SECRET-VERDICT" };
		for (const tool of ["problem", "conclude", "coding_problem", "mystery_tool"]) {
			const html = renderToStaticMarkup(<LiveToolCard part={part(tool, hidden) as never} />);
			assert.match(html, /data-testid="live-tool-card"/, tool);
			assert.doesNotMatch(html, /SECRET|Sum two numbers/, tool);
			assert.doesNotMatch(html, /Input \(streaming\)/, tool);
		}
	});

	it("takes no headline from an undeclared tool's path, pattern or session", () => {
		const html = renderToStaticMarkup(<LiveToolCard part={part("coding_problem", { path: "SECRET-PATH", pattern: "SECRET-PATTERN", session: "SECRET-SESSION" }) as never} />);
		assert.doesNotMatch(html, /SECRET/);
		assert.doesNotMatch(html, /class="truncate"/);
	});
});

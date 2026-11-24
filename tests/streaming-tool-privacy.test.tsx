/**
 * What a tool call shows before its result is final: only a tool's declared, primitive
 * input fields, and never the arguments of a problem or plugin tool, which can carry the
 * hidden solution and tests (#388).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveToolCard } from "../components/artifacts/live-tool-card.tsx";
import { ToolPartRenderer } from "../components/plugin-renderers.tsx";
import { projectView, type LhMessage, type LiveExecution } from "../src/core/index.ts";
import { toolActivityLabel } from "../src/core/pending.ts";
import { streamingToolInput, toolStepHeadline, toolStepInput } from "../src/core/tool-steps.ts";

const part = (tool: string, input: unknown) => ({ type: `tool-${tool}`, toolCallId: "c1", state: "input-streaming", input });
const NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

describe("a successful plugin pose before its result joins the record", () => {
	const input = { statement: "Sum two numbers", mode: "composition", modelSolution: "SECRET-SOLUTION", payload: { tests: ["SECRET-TESTS"] } };
	const snapshot = { protocolVersion: 1, problemId: "p-one", pluginId: "coding", typeId: "code", label: "Coding problem", contractVersion: 1,
		input, problemSchema: { type: "object" }, submissionSchema: { type: "string" }, requiresSubmissionRefinement: false, requiresProcessing: true };
	const messages = [
		{ id: "u1", role: "user", content: "start" },
		{ id: "a1", role: "assistant", content: [
			{ type: "toolCall", id: "pose", name: "coding_problem", arguments: input },
			{ type: "toolCall", id: "slow", name: "grep", arguments: { pattern: "x" } },
		] },
	] as unknown as LhMessage[];

	it("is recognised from the result its execution stored, so no generic card draws its input", () => {
		// tool_execution_end for the pose has landed; the slow grep is still running and turn_end,
		// which appends the tool results to the record, has not.
		const executions = new Map<string, LiveExecution>([["pose", {
			isError: false, output: { pluginProblem: snapshot },
			result: { content: [{ type: "text", text: "Problem posed" }], details: { pluginProblem: snapshot }, isError: false },
		}]]);
		const view = projectView(messages, { executions, inFlight: true, streamingIds: new Set(["a1"]) });
		const tools = view.flatMap(message => message.parts).filter(each => each.type === "tool-coding_problem");
		assert.equal(tools.length, 1);
		assert.equal(tools[0]!.pluginProblem?.problemId, "p-one");
	});

	it("is not recognised from an errored execution", () => {
		const executions = new Map<string, LiveExecution>([["pose", { isError: true, errorText: "refused",
			result: { content: [], details: { pluginProblem: snapshot }, isError: true } }]]);
		const view = projectView(messages, { executions, inFlight: true, streamingIds: new Set(["a1"]) });
		assert.equal(view.flatMap(message => message.parts).find(each => each.type === "tool-coding_problem")?.pluginProblem, undefined);
	});
});

describe("the declared-field filter", () => {
	it("keeps only declared fields of the declared primitive type", () => {
		assert.deepEqual(streamingToolInput("read", { path: { modelSolution: "SECRET" } }), {});
		assert.deepEqual(streamingToolInput("read", { path: ["SECRET"], offset: "SECRET", limit: { a: 1 } }), {});
		assert.deepEqual(streamingToolInput("read", { path: "a.md", offset: 3, limit: 5, extra: "SECRET" }), { path: "a.md", offset: 3, limit: 5 });
		assert.deepEqual(streamingToolInput("grep", { pattern: "p", ignoreCase: true, literal: "SECRET", context: 2 }), { pattern: "p", ignoreCase: true, context: 2 });
		assert.deepEqual(streamingToolInput("read", ["SECRET"]), {});
		assert.deepEqual(streamingToolInput("read", "SECRET"), {});
		assert.deepEqual(streamingToolInput("read", null), {});
		assert.equal(streamingToolInput("coding_problem", { path: "SECRET" }), undefined);
	});

	it("applies to a settled tool step's input too", () => {
		assert.deepEqual(toolStepInput("read", { path: { modelSolution: "SECRET" } }), {});
		assert.deepEqual(toolStepInput("read", "text"), {});
		assert.equal(toolStepInput("quiz", { any: 1 }) !== undefined, true, "another tool's input passes through");
	});

	it("a streaming read with a nested path shows no nested data, collapsed or expanded", () => {
		const html = renderToStaticMarkup(<LiveToolCard part={part("read", { path: { modelSolution: "SECRET" } }) as never} />);
		assert.doesNotMatch(html, /SECRET|modelSolution/);
	});

	it("takes the headline from declared fields only", () => {
		assert.equal(toolStepHeadline("list_sessions", { pattern: "SECRET" }), "");
		assert.equal(toolStepHeadline("list_sessions", { pattern: "SECRET" }, 200), "");
		assert.equal(toolStepHeadline("read", { path: { modelSolution: "SECRET" } }), "~");
		assert.equal(toolStepHeadline("read", { pattern: "SECRET" }), "~");
		assert.equal(toolStepHeadline("list_propositions", { session: "chat_x", pattern: "SECRET" }), "chat_x");
		assert.equal(toolStepHeadline("coding_problem", { pattern: "SECRET", path: "SECRET", session: "SECRET" }), "");
	});
});

describe("name-keyed lookups ignore the object prototype", () => {
	for (const name of NAMES) {
		it(`${name} is an ordinary unknown tool`, () => {
			assert.equal(toolActivityLabel(name), "Working…");
			assert.equal(streamingToolInput(name, { path: "SECRET" }), undefined);
			assert.equal(toolStepHeadline(name, { pattern: "SECRET" }), "");
			assert.equal(toolStepInput(name, { any: 1 }) !== undefined, true);
			const live = renderToStaticMarkup(<LiveToolCard part={part(name, {}) as never} />);
			assert.match(live, /Working…/);
			const streaming = renderToStaticMarkup(<ToolPartRenderer part={part(name, {}) as never} />);
			assert.match(streaming, /Working…/);
		});
	}
});

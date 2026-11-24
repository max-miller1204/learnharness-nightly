/**
 * Issue #335: what a failed tool step shows. The input a step shows is only the fields its
 * tool declares (src/core/tool-steps.ts), which must stay equal to the tools' own schemas;
 * a call rejected before it ran and a stopped call are told apart by their error text; a
 * conclusion reveals the problem's solution only when its own result settled cleanly.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFindTool } from "../src/agent/tools/find.ts";
import { createGrepTool } from "../src/agent/tools/grep.ts";
import { createLsTool } from "../src/agent/tools/ls.ts";
import { createReadTool } from "../src/agent/tools/read.ts";
import { createShowImageTool } from "../src/agent/tools/show-image.ts";
import { failedCallShowsItsError, isAbortedCall, isRejectedCall, TOOL_STEP_FIELD_TYPES, TOOL_STEP_INPUT_FIELDS, toolStepInput } from "../src/core/tool-steps.ts";
import { projectView, type LiveTurnState } from "../src/core/view.ts";

describe("a tool step's declared input fields", () => {
	const keys = (tool: { parameters: unknown }) => Object.keys((tool.parameters as { properties: object }).properties).sort();
	it("equal the tools' own schemas", () => {
		assert.deepEqual([...TOOL_STEP_INPUT_FIELDS.read!].sort(), keys(createReadTool()));
		assert.deepEqual([...TOOL_STEP_INPUT_FIELDS.ls!].sort(), keys(createLsTool()));
		assert.deepEqual([...TOOL_STEP_INPUT_FIELDS.find!].sort(), keys(createFindTool()));
		assert.deepEqual([...TOOL_STEP_INPUT_FIELDS.grep!].sort(), keys(createGrepTool()));
		assert.deepEqual([...TOOL_STEP_INPUT_FIELDS.show_image!].sort(), keys(createShowImageTool({ chatId: "c", chatStore: { saveImageSnapshot: () => { throw new Error("unused"); } } as never })));
	});
	it("each have the primitive type the tools' own schemas give them", () => {
		const kind = (schema: { type?: string }) => schema.type === "integer" ? "number" : schema.type;
		const props = (tool: { parameters: unknown }) => (tool.parameters as { properties: Record<string, { type?: string }> }).properties;
		const tools: Record<string, { parameters: unknown }> = { read: createReadTool(), ls: createLsTool(), find: createFindTool(), grep: createGrepTool(),
			show_image: createShowImageTool({ chatId: "c", chatStore: { saveImageSnapshot: () => { throw new Error("unused"); } } as never }) };
		for (const [name, tool] of Object.entries(tools)) for (const [field, schema] of Object.entries(props(tool))) assert.equal(TOOL_STEP_FIELD_TYPES[field], kind(schema), `${name}.${field}`);
		for (const fields of Object.values(TOOL_STEP_INPUT_FIELDS)) for (const field of fields) assert.ok(Object.hasOwn(TOOL_STEP_FIELD_TYPES, field), field);
	});
	it("are all a step shows of its input", () => {
		assert.deepEqual(toolStepInput("read", { path: "a.md", modelSolution: "SECRET", payload: { tests: ["SECRET"] } }), { path: "a.md" });
		assert.deepEqual(toolStepInput("list_propositions", { session: "s", extra: 1 }), { session: "s" });
		assert.deepEqual(toolStepInput("list_sessions", { extra: 1 }), {});
		assert.equal(toolStepInput("quiz", { any: 1 }) !== undefined, true, "another tool's input passes through");
		assert.deepEqual(toolStepInput("read", "text"), {}, "a non-object input has no declared field");
	});
});

describe("telling a failed call apart", () => {
	it("a call rejected before it ran goes back to the agent, an executed one shows its error", () => {
		const rejected = 'Validation failed for tool "read":\n  - path: required\n\nReceived arguments:\n{"modelSolution":"SECRET"}';
		for (const text of [rejected, 'Invalid tool input for tool "read":\n- x', "Tool read not found", 'Tool call "read" was not executed: the response hit the output token limit']) {
			assert.equal(isRejectedCall(text), true, text);
			assert.equal(failedCallShowsItsError("read", text), false, text);
		}
		assert.equal(failedCallShowsItsError("read", "ENOENT: no such file or directory, open 'x'"), true);
		assert.equal(failedCallShowsItsError("quiz", "ENOENT"), false);
		assert.equal(failedCallShowsItsError("read", undefined), true);
	});
	it("a stopped call is told by pi's wording and the Node and fetch wordings", () => {
		for (const text of ["Operation aborted", "The operation was aborted", "This operation was aborted"]) assert.equal(isAbortedCall(text), true, text);
		assert.equal(isAbortedCall("The operation timed out"), false);
		assert.equal(isAbortedCall(undefined), false);
	});
});

describe("a conclusion's reveal", () => {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (id: string, content: unknown[]) => ({ id, role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "synthetic", timestamp: 1, stopReason: "toolUse", usage, content });
	const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
	const settled = (id: string, toolCallId: string, toolName: string, isError = false) => ({ id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: isError ? "No active problem." : "ok" }], isError, timestamp: 2 });
	const pose = (callId: string) => [
		assistant(`m_pose_${callId}`, [call(callId, "problem", { statement: "Compute 1 + 1.", mode: "recall", modelSolution: "SOLUTION-A" })]),
		settled(`r_pose_${callId}`, callId, "problem"),
	];
	const conclude = (callId: string) => assistant(`m_end_${callId}`, [call(callId, "conclude", { outcome: "solved", verdict: "Done." })]);
	const concludePart = (view: ReturnType<typeof projectView>, index = 0) => view.flatMap((m) => m.parts).filter((p) => p.type === "tool-conclude")[index];
	const live = (executions: [string, { isError?: boolean }][]): LiveTurnState => ({ executions: new Map(executions) as never, inFlight: true, streamingIds: new Set() });

	it("joins onto a conclusion whose own result settled without an error", () => {
		const part = concludePart(projectView([...pose("p1"), conclude("c1"), settled("r_c1", "c1", "conclude")] as never));
		assert.equal(part?.reveal, "SOLUTION-A");
	});
	it("does not join onto a conclusion that failed", () => {
		const part = concludePart(projectView([...pose("p1"), conclude("c1"), settled("r_c1", "c1", "conclude", true)] as never));
		assert.equal(part?.reveal, undefined);
		assert.equal(part?.problemInput, undefined);
	});
	it("does not join onto a conclusion with no result, such as one the learner stopped", () => {
		const part = concludePart(projectView([...pose("p1"), conclude("c1")] as never));
		assert.equal(part?.reveal, undefined);
		assert.equal(part?.problemInput, undefined);
	});
	it("still joins a later conclusion that reuses an older failed one's id", () => {
		const view = projectView([...pose("p1"), conclude("call_0"), settled("r_fail", "call_0", "conclude", true), ...pose("p2"), assistant("m_end_2", [call("call_0", "conclude", { outcome: "solved", verdict: "Done." })]), settled("r_ok", "call_0", "conclude")] as never);
		assert.equal(concludePart(view, 0)?.reveal, undefined, "the failed one reveals nothing");
		assert.ok(concludePart(view, 1)?.reveal, "the later settled one reveals");
	});
	it("joins live only on the call's clean end", () => {
		const record = [...pose("p1"), conclude("c1")] as never;
		assert.equal(concludePart(projectView(record, live([["c1", { isError: false }]])))?.reveal, "SOLUTION-A");
		assert.equal(concludePart(projectView(record, live([["c1", { isError: true }]])))?.reveal, undefined);
		assert.equal(concludePart(projectView(record, live([])))?.reveal, undefined);
	});
	it("marks a practice call with no clean result, in a turn that is over, as stopped", () => {
		const part = concludePart(projectView([...pose("p1"), conclude("c1")] as never));
		assert.equal(part?.settled, undefined);
		assert.equal(part?.stopped, true);
		const problem = projectView([assistant("m_pose_x", [call("p9", "problem", { statement: "S", mode: "recall", modelSolution: "SOLUTION-A" })])] as never).flatMap((m) => m.parts).find((p) => p.type === "tool-problem");
		assert.equal(problem?.stopped, true, "a pose with no ack");
	});
	it("does not mark a settled or a still-running practice call as stopped", () => {
		const done = concludePart(projectView([...pose("p1"), conclude("c1"), settled("r_c1", "c1", "conclude")] as never));
		assert.equal(done?.settled, true);
		assert.equal(done?.stopped, undefined);
		const posed = projectView(pose("p1") as never).flatMap((m) => m.parts).find((p) => p.type === "tool-problem");
		assert.equal(posed?.settled, true, "a posed problem is settled by its ack");
		assert.equal(posed?.stopped, undefined);
		const running = concludePart(projectView([...pose("p1"), conclude("c1")] as never, live([])));
		assert.equal(running?.stopped, undefined, "the turn still runs");
		const streaming = concludePart(projectView([...pose("p1"), conclude("c1")] as never, { executions: new Map(), inFlight: true, streamingIds: new Set(["m_end_c1"]) }));
		assert.equal(streaming?.state, "input-streaming");
		assert.equal(streaming?.stopped, undefined);
	});
});

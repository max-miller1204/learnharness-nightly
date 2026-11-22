/**
 * Issue #333: a session page's server render must not throw in React's
 * development build, where every useRef object is sealed (adding a property
 * to one throws). `next dev` answered direct loads of teaching, probe and
 * practice sessions with 500, because the chat view added `changed` to its
 * view-reader refs during render. Rendered here with react-dom/server under
 * the test runner's NODE_ENV (not "production": React's development build).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { Chat } from "../components/chat.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { PluginsProvider } from "../components/plugins.tsx";
import { SidebarProvider } from "../components/sidebar.tsx";
import { ActivityProvider } from "../components/activity-dock.tsx";
import { SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";

const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
const quiet = () => ({ close() {}, onOpen() {}, onEvent() {} });

/** The providers Next, app/layout.tsx and AppShell put around a session page. */
function Shell({ pathname, children }: { pathname: string; children: React.ReactNode }) {
	return (
		<AppRouterContext.Provider value={router}><PathnameContext.Provider value={pathname}>
		<ServerEventsProvider connect={quiet}>
			<PluginsProvider>
				<SidebarProvider>
					<ActivityProvider>
						<InteractionLayersProvider><SettingsDialogProvider>{children}</SettingsDialogProvider></InteractionLayersProvider>
					</ActivityProvider>
				</SidebarProvider>
			</PluginsProvider>
		</ServerEventsProvider>
		</PathnameContext.Provider></AppRouterContext.Provider>
	);
}

describe("the chat view's server render", () => {
	it("runs on React's development build, where refs are sealed", () => {
		assert.notEqual(process.env.NODE_ENV, "production", "the development build seals refs; production doesn't");
		const sealed = (() => { let ref: unknown; function Probe() { ref = React.useRef(null); return null; } renderToString(<Probe />); return Object.isSealed(ref); })();
		assert.equal(sealed, true, "this React build seals ref objects, so the test can catch a property added to one");
	});

	// The session pages the issue names, as scripts/smoke-file-paths.mjs seeds
	// them: a teaching session waiting on a quiz, a probe question, and a
	// practice problem (each mounts its dock and that dock's view reader), plus
	// an empty session of each kind.
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (id: string, content: unknown[]) => ({ id, role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "synthetic", timestamp: 1, stopReason: "toolUse", usage, content });
	const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
	const result = (id: string, toolCallId: string, toolName: string, details?: unknown) => ({ id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "Synthetic tool completed." }], ...(details ? { details } : {}), isError: false, timestamp: 2 });
	const quiz = { type: "check", nodeId: "addition", question: "What is 1 + 1?", options: [{ value: "two", label: "2" }, { value: "three", label: "3" }], explanation: "Adding one to one gives two.", correctAnswer: "two" };
	const user = { id: "sent_user", role: "user", content: "Start", timestamp: 0 };
	const sessions: { name: string; kind: "teach" | "practice"; messages: unknown[]; shows?: string }[] = [
		{ name: "an empty teaching session", kind: "teach", messages: [] },
		{ name: "an empty practice session", kind: "practice", messages: [] },
		{ name: "a teaching session waiting on a quiz", kind: "teach", shows: "What is 1 + 1?", messages: [user, assistant("m_probe", [{ type: "text", text: "Lesson." }, call("call_probe", "probe_done", { assessment: { strands: [{ strand: "Addition", assessment: "Ready." }] } })]), result("m_probe_result", "call_probe", "probe_done", { ok: true }), assistant("m_quiz", [call("call_quiz", "quiz", quiz)])] },
		{ name: "a probe question", kind: "teach", shows: "What is 1 + 1?", messages: [user, assistant("m_probe_question", [{ type: "text", text: "Probe." }, call("call_probe_question", "probe", quiz)])] },
		{ name: "a practice problem", kind: "practice", shows: "Compute 1 + 1.", messages: [user, assistant("m_problem", [{ type: "text", text: "Practice." }, call("call_problem", "problem", { statement: "Compute 1 + 1.", mode: "recall", modelSolution: "1 + 1 = 2." })]), result("m_problem_result", "call_problem", "problem")] },
	];
	for (const session of sessions) {
		it(`renders ${session.name} without throwing`, () => {
			let html = "";
			assert.doesNotThrow(() => {
				html = renderToString(<Shell pathname="/chat/chat_ssr_fixture"><Chat chatId="chat_ssr_fixture" title="SSR fixture" kind={session.kind} initialMessages={session.messages as never} /></Shell>);
			});
			assert.ok(html.includes("SSR fixture"), "the session's title is in the page");
			if (session.shows) assert.ok(html.includes(session.shows), `the page shows ${JSON.stringify(session.shows)}`);
		});
	}

	// Issue #335: a failed call that shows its own card (the tool steps and a shared
	// image) shows that card's Error, not "Retrying…". A call that errored back to
	// the agent (questions, practice, plugin problems, dispatches, send_to_user) gets
	// the quiet retry line: its card would draw nothing, a success, or the hidden
	// answer in its arguments. An aborted call is silent for every tool.
	const failure = (id: string, toolCallId: string, toolName: string, text: string) => ({ id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: true, timestamp: 2 });
	const renderCalls = (kind: "teach" | "practice", calls: { id: string; name: string; args: unknown; error?: string }[]) => renderToString(<Shell pathname="/chat/chat_failed"><Chat chatId="chat_failed" title="Failed call" kind={kind} initialMessages={[user, assistant("m_fail", calls.map(c => call(c.id, c.name, c.args))), ...calls.filter(c => c.error !== undefined).map(c => failure(`r_${c.id}`, c.id, c.name, c.error!))] as never} /></Shell>);
	const renderFailed = (name: string, args: unknown, text: string, kind: "teach" | "practice" = "teach") => renderCalls(kind, [{ id: "call_fail", name, args, error: text }]);
	const SECRET = "HIDDEN-MODEL-SOLUTION-7731";
	const hidden = { statement: "Compute 1 + 1.", mode: "recall", modelSolution: SECRET, payload: { tests: [SECRET] } };
	for (const [tool, args] of [["read", { path: "missing.md" }], ["grep", { pattern: "x" }], ["ls", {}], ["find", { pattern: "x" }], ["list_sessions", {}], ["list_propositions", { sessionId: "x" }], ["show_image", { path: "missing.png" }]] as const) {
		it(`shows a failed ${tool} call's card and its error, not Retrying`, () => {
			const html = renderFailed(tool, args, "ENOENT: no such file or directory, open 'missing.md'");
			assert.ok(html.includes('data-testid="tool-call-card"'), "the card renders");
			assert.ok(html.includes("ENOENT: no such file or directory"), "the error text shows");
			assert.ok(html.includes("text-error"), "the failed call is red");
			assert.ok(!html.includes("Retrying"), "no retry is pending");
			assert.ok(!html.includes('data-testid="tool-retry"'));
		});
	}
	const quiz1 = { type: "check", nodeId: "addition", question: "What is 1 + 1?", options: [{ value: "a", label: "2" }], explanation: "x", correctAnswer: "a" };
	for (const [tool, args, kind] of [
		["quiz", quiz1, "teach"], ["probe", quiz1, "teach"], ["ask_user_question", {}, "teach"], ["explain", {}, "teach"], ["recall", {}, "teach"],
		["problem", hidden, "practice"], ["conclude", { outcome: "solved", verdict: "Done." }, "practice"], ["probe_done", { assessment: "x" }, "teach"], ["plan_init", {}, "teach"],
		["research", { question: "q" }, "teach"], ["pdf", { path: "missing.pdf" }, "teach"], ["demo", { title: "t", html: "<p>x</p>" }, "teach"], ["visual", { title: "t", code: "x" }, "teach"],
		["send_to_user", { message: "" }, "teach"], ["coding_problem", hidden, "practice"],
	] as const) {
		it(`shows the quiet retry line for a failed ${tool} call, never its card or its arguments`, () => {
			const html = renderFailed(tool, args, "The call was rejected.", kind);
			assert.ok(html.includes('data-testid="tool-retry"'), "the retry line shows");
			assert.ok(html.includes("Retrying"));
			assert.ok(!html.includes('data-testid="tool-call-card"'), "no raw tool card");
			assert.ok(!html.includes('data-testid="problem-card"'), "no problem card");
			assert.ok(!html.includes(SECRET), "the hidden solution never reaches the page");
		});
	}
	it("shows no card and no retry line for an aborted call, whatever the tool", () => {
		for (const [tool, args] of [["read", { path: "missing.md" }], ["quiz", quiz1], ["pdf", { path: "x.pdf" }], ["coding_problem", hidden]] as const) {
			const html = renderFailed(tool, args, "Operation aborted");
			assert.ok(!html.includes('data-testid="tool-call-card"'), `${tool}: no card`);
			assert.ok(!html.includes('data-testid="tool-retry"'), `${tool}: no retry line`);
			assert.ok(!html.includes("Operation aborted"), `${tool}: no error text`);
		}
	});
	it("does not reveal the active problem's solution when its conclusion failed", () => {
		const html = renderToString(<Shell pathname="/chat/chat_failed"><Chat chatId="chat_failed" title="Failed call" kind="practice" initialMessages={[user, assistant("m_pose", [call("call_pose", "problem", hidden)]), result("m_pose_result", "call_pose", "problem"), assistant("m_end", [call("call_end", "conclude", { outcome: "solved", verdict: "Done." })]), failure("r_end", "call_end", "conclude", "No active problem.")] as never} /></Shell>);
		assert.ok(html.includes("Compute 1 + 1."), "the posed problem still shows");
		assert.ok(html.includes('data-testid="tool-retry"'));
		assert.ok(!html.includes(SECRET), "the model solution stays hidden");
	});
});

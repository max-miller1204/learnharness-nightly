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

	// Issue #335: a failed call shows its card's Error, not "Retrying…". Only a
	// question tool whose error goes back to the agent (it renders nothing of its
	// own) gets the quiet retry line.
	const failure = (id: string, toolCallId: string, toolName: string, text: string) => ({ id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: true, timestamp: 2 });
	const renderFailed = (name: string, args: unknown, text: string) => renderToString(<Shell pathname="/chat/chat_failed"><Chat chatId="chat_failed" title="Failed call" kind="teach" initialMessages={[user, assistant("m_fail", [call("call_fail", name, args)]), failure("m_fail_result", "call_fail", name, text)] as never} /></Shell>);
	for (const tool of ["read", "grep", "ls", "find", "bash"]) {
		it(`shows a failed ${tool} call's card and its error, not Retrying`, () => {
			const html = renderFailed(tool, { path: "missing.md", pattern: "x" }, "ENOENT: no such file or directory, open 'missing.md'");
			assert.ok(html.includes('data-testid="tool-call-card"'), "the card renders");
			assert.ok(html.includes("ENOENT: no such file or directory"), "the error text shows");
			assert.ok(html.includes("text-error"), "the failed call is red");
			assert.ok(!html.includes("Retrying"), "no retry is pending");
			assert.ok(!html.includes('data-testid="tool-retry"'));
		});
	}
	it("still shows the quiet retry line for a question tool that errored back to the agent", () => {
		const html = renderFailed("quiz", { malformed: true }, "Invalid arguments for quiz");
		assert.ok(html.includes('data-testid="tool-retry"'));
		assert.ok(html.includes("Retrying"));
	});
});

import assert from "node:assert/strict";
import test from "node:test";
import type { JobRecord, LhMessage } from "../../../src/client-protocol/index.ts";
import { pendingQuestionOf } from "../../../src/core/native-messages.ts";
import { blockLayout, edgePathD } from "../../../src/core/plan-layout.ts";
import { projectView, type LhViewPart } from "../../../src/core/view.ts";
import { inputWasSaved } from "../src/live-turn.ts";
import {
  checkNeedsReveal, dispatchedKind, fitView, jobLabel, jobSettled, livePlan, pathEnd, PHASE_LABEL, sessionPhase,
  skipAnswer, teachSeam, zoomView, ZOOM_MAX,
} from "../src/lesson.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (id: string, content: unknown[]) => ({
  id, role: "assistant", content, api: "test", provider: "test", model: "test", usage, stopReason: "toolUse", timestamp: 1,
}) as unknown as LhMessage;
const toolResult = (id: string, toolCallId: string, toolName: string, details: unknown) => ({
  id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], details, isError: false, timestamp: 1,
}) as unknown as LhMessage;
const user = (id: string, text: string) => ({ id, role: "user", content: text, timestamp: 1 }) as unknown as LhMessage;
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });

const tree = { nodes: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }], edges: [{ from: "a", to: "b" }], version: 1 };
const probeDone = [
  user("u1", "Teach me sets"),
  assistant("a1", [call("pd", "probe_done", { summary: "knows little" })]),
  toolResult("r1", "pd", "probe_done", { ok: true }),
  assistant("a2", [call("pi", "plan_init", { mermaid: "graph TD; a-->b" })]),
  toolResult("r2", "pi", "plan_init", { ok: true, tree }),
];
const quizBody = { question: "Is {1} a set?", options: [{ label: "Yes" }, { label: "No" }], explanation: "Braces collect things.", correctAnswer: "Yes" };
const check = (type: "check" | "predict", nodeId = "a") => assistant("a3", [
  { type: "text", text: "Sets collect things." },
  call("q1", "quiz", { type, nodeId, ...quizBody }),
]);

test("names the phase and finds where teaching begins", () => {
  assert.equal(PHASE_LABEL[sessionPhase([user("u1", "hi")])], "Probing");
  assert.equal(PHASE_LABEL[sessionPhase(probeDone)], "Planning");
  const lesson = [...probeDone, check("check")];
  assert.equal(PHASE_LABEL[sessionPhase(lesson)], "Teaching");
  // The view groups the teacher's consecutive messages, so teaching begins at
  // the step that poses the first tagged check, inside that group.
  const view = projectView(lesson);
  const seam = teachSeam(view);
  assert.equal(seam?.messageId, "a1");
  assert.equal(view[1]!.parts[seam!.stepIndex]!.type, "step-start");
  assert.equal(view[1]!.parts[seam!.stepIndex + 1]!.text, "Sets collect things.");
  assert.equal(teachSeam(projectView(probeDone)), null);
});

test("a teach-phase check waits behind its reveal; predictions and probe questions arrive open", () => {
  const lesson = [...probeDone, check("check")];
  const pending = pendingQuestionOf(lesson);
  assert.ok(pending);
  assert.equal(checkNeedsReveal(pending, lesson), true);
  const predict = [...probeDone, check("predict")];
  assert.equal(checkNeedsReveal(pendingQuestionOf(predict)!, predict), false);
  const probing = [user("u1", "hi"), assistant("a1", [call("p1", "probe", quizBody)])];
  assert.equal(checkNeedsReveal(pendingQuestionOf(probing)!, probing), false);
});

test("a skip is the web's dismissed answer, carrying the thinking while reading", () => {
  const lesson = [...probeDone, check("check")];
  const pending = pendingQuestionOf(lesson)!;
  const bare = skipAnswer(pending, "   ");
  assert.equal(bare.dismissed, true);
  assert.equal(bare.kind, "quiz");
  assert.equal(bare.questionText, "Is {1} a set?");
  assert.equal(bare.readingThinking, undefined);
  assert.equal(skipAnswer(pending, "  sets hold things ").readingThinking, "sets hold things");
  // A skip the response lost is confirmed by the saved dismissal, like an answer.
  const input = { type: "dismiss" as const, toolCallId: "q1", answer: bare };
  assert.equal(inputWasSaved([...lesson, toolResult("r3", "q1", "quiz", bare)], new Set(lesson.map(({ id }) => id)), input), true);
  assert.equal(inputWasSaved(lesson, new Set(lesson.map(({ id }) => id)), input), false);
});

test("helper cards: which tool parts dispatched a helper, and when one settles", () => {
  const job = (status: JobRecord["status"], kind: JobRecord["kind"] = "research"): JobRecord => ({
    id: "j1", kind, chatId: "c1", toolCallId: "t1", status, activity: "web_search: sets", createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z",
  });
  const part = (type: string, extra: Partial<LhViewPart> = {}): LhViewPart => ({ type, toolCallId: "t1", state: "output-available", ...extra });
  assert.equal(dispatchedKind(part("tool-research"), []), "research");
  assert.equal(dispatchedKind(part("tool-pdf"), []), "pdf");
  assert.equal(dispatchedKind(part("tool-research", { state: "input-available" }), []), undefined);
  assert.equal(dispatchedKind(part("tool-grep"), []), undefined);
  assert.equal(dispatchedKind(part("tool-lookup"), [job("running", "plugin")]), "plugin");
  assert.equal(dispatchedKind(part("tool-lookup", { result: { details: { jobId: "j1", dispatched: true }, isError: false, content: [] } }), []), "plugin");
  assert.equal(dispatchedKind(part("tool-lookup", { background: { pluginId: "p", taskId: "t", status: "succeeded" } }), [job("done", "plugin")]), undefined);
  assert.equal(jobLabel("research"), "Research agent");
  assert.equal(jobLabel("plugin", { ...job("running", "plugin"), plugin: { label: "Flashcards" } } as JobRecord), "Flashcards");
  assert.equal(jobSettled(new Map(), [job("done")]), false, "the first read adopts history");
  assert.equal(jobSettled(new Map([["j1", "running"]]), [job("running")]), false);
  assert.equal(jobSettled(new Map([["j1", "running"]]), [job("done")]), true);
});

test("the live plan reads the latest tree and the current node from the checks", () => {
  assert.equal(livePlan(projectView([user("u1", "hi")])), null);
  const plan = livePlan(projectView([...probeDone, check("check", "b")]));
  assert.ok(plan);
  assert.equal(plan.current, "b");
  assert.equal(plan.statusOf("b"), "current");
  assert.equal(plan.statusOf("a"), "upcoming");
});

test("the arrowhead docks at the edge's end, pointing along its approach", () => {
  const layout = blockLayout(tree.nodes, tree.edges);
  const d = edgePathD(layout.edgePts.get("a->b")!);
  const end = pathEnd(d);
  assert.ok(end);
  assert.ok(Math.abs(end.angle - 90) < 1, `a top-to-bottom edge points down, got ${end.angle}`);
  assert.equal(pathEnd("M0,0"), null);
});

test("pan and zoom keep the web's fit floor and 4x ceiling", () => {
  const box = { w: 400, h: 200 }, viewport = { w: 216, h: 600 };
  const fit = fitView(box, viewport);
  assert.equal(fit.zoom, 0.5);
  assert.equal(fit.x, 8);
  assert.deepEqual(zoomView(fit, 0.5, { x: 0, y: 0 }, box, viewport), fit, "never below the fit");
  const zoomed = zoomView(fit, 2, { x: 108, y: 300 }, box, viewport);
  assert.equal(zoomed.zoom, 1);
  assert.equal(zoomView({ ...zoomed, zoom: 3.9 }, 2, { x: 0, y: 0 }, box, viewport).zoom, ZOOM_MAX);
  assert.deepEqual(zoomView(zoomed, 0.1, { x: 50, y: 50 }, box, viewport), fit, "zooming back out re-centers at the fit");
});

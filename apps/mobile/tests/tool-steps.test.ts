// The transcript's tool steps (#305): the web's quiet "READ notes.md" row, laid out as T3's
// mobile work-log row, one screen-reader stop, opening to the call's input and output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { LhMessage } from "../../../src/client-protocol/index.ts";
import { TOOL_STEPS } from "../../../src/core/tool-steps.ts";
import { projectView, type LhViewPart } from "../../../src/core/view.ts";
import { isToolStep, ToolStep } from "../src/ToolStep.tsx";
import { Transcript } from "../src/Transcript.tsx";
import { useTheme } from "../src/theme.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const quiz = () => JSON.parse(readFileSync(new URL("../../../tests/fixtures/mobile-quiz/chat_zzmobilequiz.json", import.meta.url), "utf8")) as { messages: LhMessage[] };
const flat = (style: unknown) => [style].flat(Infinity).reduce<Record<string, unknown>>((all, part) => ({ ...all, ...(part as object) }), {});
const texts = (node: ReactTestInstance): string[] => node.children.flatMap((child) => typeof child === "string" ? [child] : texts(child));
/** Each tool step's row: the pressable host inside it, and the step it belongs to. */
const rows = (root: ReactTestInstance) => root.findAllByType(ToolStep).map((step) =>
  Object.assign(step.findAll((node) => String(node.type) === "Pressable")[0] as ReactTestInstance, { step }));

async function render(element: Parameters<typeof create>[0]) {
  let tree: ReactTestRenderer | undefined;
  await act(async () => { tree = create(element); });
  return tree as ReactTestRenderer;
}

/** The theme's error color, rendered where the test can read it. */
function ErrorColor() { return createElement("View", { testID: "error-color", color: useTheme().c.error }); }

test("the quiz session's read of notes.md is one quiet row, a single stop, that opens to its input and output", async () => {
  const tree = await render(createElement(Transcript, { settled: projectView(quiz().messages), tail: [], api: {} as never, chatId: "chat", jobs: [], liveHelpers: false,
    openPlan: () => {}, files: new Map(), unavailableFiles: new Set<string>() }));
  try {
    const [row, ...others] = rows(tree.root);
    assert.ok(row);
    assert.equal(others.length, 0, "the probe questions are cards, not tool steps");
    assert.equal(row.props.accessibilityLabel, "read notes.md");
    assert.deepEqual(row.props.accessibilityState, { expanded: false });
    assert.deepEqual(texts(row), ["read", "notes.md", "⌄"]);
    // T3's work-log row: at least 28 tall, the headline on one line ending in an ellipsis.
    const style = flat(typeof row.props.style === "function" ? row.props.style({ pressed: false }) : row.props.style);
    assert.equal(style.minHeight, 28);
    const headline = row.findAll((node) => String(node.type) === "Text" && texts(node).join("") === "notes.md")[0];
    assert.equal(headline?.props.numberOfLines, 1);
    assert.equal(headline?.props.ellipsizeMode, "tail");
    // One stop: nothing inside the row is reachable on its own.
    assert.equal(row.findAll((node) => node !== row && node.props.accessible === true).length, 0);
    await act(async () => row.props.onPress());
    const [open] = rows(tree.root);
    assert.deepEqual(open?.props.accessibilityState, { expanded: true });
    const body = texts((open as { step: ReactTestInstance }).step);
    assert.ok(body.includes("Input") && body.includes(JSON.stringify({ path: "notes.md" }, null, 2)));
    assert.ok(body.includes("Output") && body.some((text) => text.startsWith("# Splits")));
  } finally {
    act(() => tree.unmount());
  }
});

test("a failed step says so in red and opens to its error; a running one says it is running", async () => {
  const failed: LhViewPart = { type: "tool-grep", state: "output-error", input: { pattern: "eta" }, errorText: "No such file" };
  let tree = await render(createElement("View", null, createElement(ErrorColor), createElement(ToolStep, { part: failed })));
  try {
    const [row] = rows(tree.root);
    assert.equal(row?.props.accessibilityLabel, "grep eta, tool call failed");
    const name = row?.findAll((node) => String(node.type) === "Text" && texts(node).join("") === "grep")[0];
    assert.equal(flat(name?.props.style).color, tree.root.find((node) => node.props.testID === "error-color").props.color);
    await act(async () => row?.props.onPress());
    const body = texts(tree.root);
    assert.ok(body.includes("Error") && body.includes("No such file") && !body.includes("Output"));
  } finally {
    act(() => tree.unmount());
  }
  const running: LhViewPart = { type: "tool-ls", state: "input-available", input: {} };
  tree = await render(createElement(ToolStep, { part: running }));
  try {
    const [row] = rows(tree.root);
    assert.equal(row?.props.accessibilityLabel, "ls ~");
    await act(async () => row?.props.onPress());
    assert.ok(texts(tree.root).includes("running…"));
  } finally {
    act(() => tree.unmount());
  }
});

test("tool steps are the web's tools, and a show_image that hasn't shown its picture", () => {
  for (const tool of TOOL_STEPS) assert.ok(isToolStep({ type: `tool-${tool}`, state: "output-available" }), tool);
  assert.ok(isToolStep({ type: "tool-show_image", state: "output-error" }));
  assert.ok(!isToolStep({ type: "tool-show_image", state: "output-available" }));
  for (const type of ["tool-probe", "tool-research", "tool-plan_init", "text"]) assert.ok(!isToolStep({ type, state: "output-available" }), type);
});

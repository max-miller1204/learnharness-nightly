// The transcript's tool steps (#305): the web's quiet "READ notes.md" row, laid out as T3's
// mobile work-log row, one screen-reader stop, opening to the call's input and output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { Platform } from "react-native";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { LhMessage, TurnStreamEvent } from "../../../src/client-protocol/index.ts";
import { TOOL_STEPS } from "../../../src/core/tool-steps.ts";
import { projectView, type LhViewPart } from "../../../src/core/view.ts";
import { isToolStep, ToolStep } from "../src/ToolStep.tsx";
import { Snapshot, Transcript } from "../src/Transcript.tsx";
import { turnReplay } from "../src/live-turn.ts";
import { useTheme } from "../src/theme.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
declare global {
  var startedLoops: number | undefined;
  var loopedAnimation: unknown;
  var reduceMotionListener: unknown;
}

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

const assistant = (id: string, content: unknown[]) => ({ role: "assistant", content, api: "openai-completions", provider: "custom", model: "m",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse", id, timestamp: 1 }) as unknown as LhMessage;
const result = (toolCallId: string, toolName: string, details: unknown, isError = false) => ({ role: "toolResult", toolCallId, toolName,
  content: [{ type: "text", text: typeof details === "string" ? details : "failed" }], details, isError, id: `r_${toolCallId}`, timestamp: 2 }) as unknown as LhMessage;
const transcript = (settled: LhMessage[], tail: LhMessage[]) => createElement(Transcript, { settled: projectView(settled), tail, api: {} as never, chatId: "chat",
  jobs: [], liveHelpers: false, openPlan: () => {}, files: new Map(), unavailableFiles: new Set<string>() });
const reading = assistant("a_live", [{ type: "text", text: "Let me look." }, { type: "toolCall", id: "call_live", name: "read", arguments: { path: "notes.md" } }, { type: "text", text: "Done." }]);

test("during the turn a step shows in order with the text, breathing while its call runs, and settles in place", async () => {
  globalThis.startedLoops = 0;
  const tree = await render(transcript([], [reading]));
  try {
    const [row] = rows(tree.root);
    assert.ok(row);
    assert.equal(row.props.accessibilityLabel, "Reading a file… notes.md");
    assert.ok(row.findAll((node) => String(node.type) === "AnimatedText" && texts(node).join("") === "Reading a file…").length === 1);
    assert.equal(globalThis.startedLoops, 1, "the label breathes");
    // In order with the streaming text: the text, the step, the text.
    const live = row.step.parent as ReactTestInstance;
    const order = live.children.map((child) => typeof child === "string" ? child : child.type === ToolStep ? "step" : texts(child).join(""));
    assert.deepEqual(order, ["Let me look.", "step", "Done."]);
    const runningLabel = flat(row.findAll((node) => String(node.type) === "AnimatedText")[0]?.props.style);
    // The result arrives: the same row, settled, the same height.
    await act(async () => tree.update(transcript([], [reading, result("call_live", "read", "# Notes")])));
    const [settled] = rows(tree.root);
    assert.equal(settled?.props.accessibilityLabel, "read notes.md");
    const name = flat(settled?.findAll((node) => String(node.type) === "Text" && texts(node).join("") === "read")[0]?.props.style);
    assert.equal(name.lineHeight, runningLabel.lineHeight);
    assert.equal(flat(settled?.props.style).minHeight, 28);
  } finally {
    act(() => tree.unmount());
  }
});

test("with Reduce Motion on, a running step's label stays still", async () => {
  globalThis.startedLoops = 0;
  Object.assign(globalThis, { reduceMotion: true });
  const tree = await render(transcript([], [reading]));
  try {
    assert.equal(rows(tree.root).length, 1);
    assert.equal(globalThis.startedLoops, 0);
  } finally {
    act(() => tree.unmount());
    Object.assign(globalThis, { reduceMotion: false });
  }
});

test("an opened step shows the start of long text with a note, and never takes the status bar's scroll to top", async () => {
  const lines = Array.from({ length: 500 }, (_, at) => `line ${at}`).join("\n");
  const tree = await render(createElement(ToolStep, { part: { type: "tool-list_propositions", state: "output-available", input: { session: "chat_x" }, output: lines } }));
  try {
    const [row] = rows(tree.root);
    await act(async () => row?.props.onPress());
    const shown = texts(tree.root);
    assert.ok(shown.includes("Showing the first 200 of 500 lines."));
    assert.ok(shown.some((text) => text.endsWith("line 199")) && !shown.some((text) => text.includes("line 200")));
    for (const scroll of tree.root.findAll((node) => String(node.type) === "ScrollView")) assert.equal(scroll.props.scrollsToTop, false);
  } finally {
    act(() => tree.unmount());
  }
  const wide = await render(createElement(ToolStep, { part: { type: "tool-list_propositions", state: "output-available", input: { session: "chat_x" }, output: "x".repeat(500_008) } }));
  try {
    await act(async () => rows(wide.root)[0]?.props.onPress());
    assert.ok(texts(wide.root).includes("Showing the first 8,192 of 500,008 characters."));
    assert.ok(Math.max(...texts(wide.root).map((text) => text.length)) <= 8192);
  } finally {
    act(() => wide.unmount());
  }
});

test("a step's name can't be disguised, its spoken headline is capped, and a closed row says so on iOS", async () => {
  const was = Platform.OS;
  Object.assign(Platform, { OS: "ios" });
  try {
    const tree = await render(createElement(ToolStep, { part: { type: "tool-read", state: "output-available", input: { path: `a‮txt.exe${"/x".repeat(300)}` }, output: "" } }));
    try {
      const [row] = rows(tree.root);
      assert.ok(row);
      const label = row.props.accessibilityLabel as string;
      assert.ok(!/[‪-‮⁦-⁩]/.test(label + texts(row).join("")), "no bidirectional controls shown or spoken");
      assert.ok(texts(row).some((text) => text.startsWith("a\\u202Etxt.exe")));
      // 200 code points of the path, cut before escaping: its one control adds five characters.
      assert.ok(label.length <= "read ".length + 200 + 5 + 1 && label.endsWith("…"), `spoken headline capped: ${label.length}`);
      assert.deepEqual(row.props.accessibilityValue, { text: "collapsed" });
      await act(async () => row.props.onPress());
      const [open] = rows(tree.root);
      assert.equal(open?.props.accessibilityValue, undefined);
      assert.deepEqual(open?.props.accessibilityState, { expanded: true });
    } finally {
      act(() => tree.unmount());
    }
  } finally {
    Object.assign(Platform, { OS: was });
  }
});

test("a finished show_image whose picture can't be shown says so, as the web's card does", async () => {
  const shown = assistant("a_img", [{ type: "toolCall", id: "call_img", name: "show_image", arguments: { path: "a.png" } }]);
  const tree = await render(transcript([shown, result("call_img", "show_image", { snapshotId: "not-a-hash" })], []));
  try {
    assert.ok(texts(tree.root).includes("Image shown, but it could not be displayed."));
    assert.equal(rows(tree.root).length, 0);
  } finally {
    act(() => tree.unmount());
  }
});

/** The tail the session hook keeps, from turn stream events, through the real replay. */
function replayed(events: TurnStreamEvent[]) {
  const consume = turnReplay();
  let tail: LhMessage[] = [];
  for (const event of events) tail = consume(event) ?? tail;
  return tail;
}
const streamed = (content: unknown[]) => ({ ...assistant("unused", content), id: undefined }) as unknown as LhMessage;
const message = (type: "message_start" | "message_end", content: unknown[]) => ({ type, message: streamed(content) }) as unknown as TurnStreamEvent;
const finished = (toolCallId: string, toolName: string, details: unknown, isError = false) => ({ type: "tool_execution_end", toolCallId, toolName,
  result: { content: [{ type: "text", text: typeof details === "string" ? details : "failed" }], details }, isError }) as unknown as TurnStreamEvent;
const readCall = [{ type: "text", text: "Let me look." }, { type: "toolCall", id: "call_live", name: "read", arguments: { path: "notes.md" } }];
const live = (tail: LhMessage[], settled: LhMessage[] = []) => transcript(settled, tail);

test("a step settles as soon as its tool finishes, while the teacher is still going", async () => {
  globalThis.startedLoops = 0;
  const tail = replayed([message("message_start", readCall), message("message_end", readCall), finished("call_live", "read", "# Notes"),
    message("message_start", [{ type: "text", text: "Now the quiz." }])]);
  const tree = await render(live(tail));
  try {
    const [row] = rows(tree.root);
    assert.equal(row?.props.accessibilityLabel, "read notes.md");
    assert.equal(row?.findAll((node) => String(node.type) === "AnimatedText").length, 0, "no longer breathing");
    assert.ok(texts(tree.root).includes("Now the quiz."));
    await act(async () => row?.props.onPress());
    assert.ok(texts(tree.root).includes("# Notes"));
  } finally {
    act(() => tree.unmount());
  }
  const failedTail = replayed([message("message_start", readCall), message("message_end", readCall), finished("call_live", "read", "No such file", true)]);
  const failedTree = await render(live(failedTail));
  try {
    assert.equal(rows(failedTree.root)[0]?.props.accessibilityLabel, "read notes.md, tool call failed");
  } finally {
    act(() => failedTree.unmount());
  }
});

test("a step opened during the turn stays open when the turn settles into the record", async () => {
  const tail = replayed([message("message_start", readCall), message("message_end", readCall), finished("call_live", "read", "# Notes")]);
  const tree = await render(live(tail));
  try {
    await act(async () => rows(tree.root)[0]?.props.onPress());
    assert.deepEqual(rows(tree.root)[0]?.props.accessibilityState, { expanded: true });
    // The record arrives with the same call and the live tail empties.
    const record = [assistant("a_saved", readCall), result("call_live", "read", "# Notes")];
    await act(async () => tree.update(live([], record)));
    const [row] = rows(tree.root);
    assert.deepEqual(row?.props.accessibilityState, { expanded: true });
    assert.ok(texts(tree.root).includes("# Notes"));
  } finally {
    act(() => tree.unmount());
  }
});

test("a shown image stays in place mid-turn, as its picture or the web's message", async () => {
  const showCall = [{ type: "toolCall", id: "call_img", name: "show_image", arguments: { path: "a.png" } }];
  const details = { snapshotId: "a".repeat(64), mimeType: "image/png", path: "a.png", width: 40, height: 30 };
  const api = { get: () => new Promise(() => {}) } as never;
  const shown = replayed([message("message_start", showCall), message("message_end", showCall), finished("call_img", "show_image", details)]);
  let tree = await render(createElement(Transcript, { settled: [], tail: shown, api, chatId: "chat", jobs: [], liveHelpers: false, openPlan: () => {}, files: new Map(), unavailableFiles: new Set<string>() }));
  try {
    assert.equal(tree.root.findAllByType(Snapshot).length, 1);
  } finally {
    act(() => tree.unmount());
  }
  // Details the web can't show (no type, no size) say so, live and in the record.
  const bad = { snapshotId: "a".repeat(64), path: "a.png" };
  tree = await render(live(replayed([message("message_start", showCall), message("message_end", showCall), finished("call_img", "show_image", bad)])));
  try {
    assert.ok(texts(tree.root).includes("Image shown, but it could not be displayed."));
  } finally {
    act(() => tree.unmount());
  }
  tree = await render(live([], [assistant("a_img", showCall), result("call_img", "show_image", bad)]));
  try {
    assert.equal(tree.root.findAllByType(Snapshot).length, 0);
    assert.ok(texts(tree.root).includes("Image shown, but it could not be displayed."));
  } finally {
    act(() => tree.unmount());
  }
});

test("a running step's breathing is one native timing, looped natively", async () => {
  globalThis.loopedAnimation = undefined;
  const tree = await render(live(replayed([message("message_start", readCall)])));
  try {
    const looped = globalThis.loopedAnimation as { kind?: string; config?: { useNativeDriver?: boolean } } | undefined;
    assert.equal(looped?.kind, "timing");
    assert.equal(looped?.config?.useNativeDriver, true);
  } finally {
    act(() => tree.unmount());
  }
});

test("a Reduce Motion change that arrives before the first lookup answers wins", async () => {
  let answer: (value: boolean) => void = () => {};
  Object.assign(globalThis, { reduceMotionLookup: new Promise<boolean>((resolve) => { answer = resolve; }) });
  const tree = await render(live(replayed([message("message_start", readCall)])));
  try {
    const opacity = () => flat(tree.root.findAll((node) => String(node.type) === "AnimatedText")[0]?.props.style).opacity;
    assert.equal(opacity(), 1, "still until the system says");
    await act(async () => (globalThis.reduceMotionListener as (value: boolean) => void)(false));
    assert.notEqual(opacity(), 1, "motion turned on");
    await act(async () => answer(true));
    assert.notEqual(opacity(), 1, "the older lookup doesn't turn it off again");
  } finally {
    act(() => tree.unmount());
    Object.assign(globalThis, { reduceMotionLookup: undefined });
  }
});

test("an opened step escapes bidirectional controls in its input and output", async () => {
  const tree = await render(createElement(ToolStep, { part: { type: "tool-read", state: "output-available", input: { path: "a‮b" }, output: "x⁧y" } }));
  try {
    await act(async () => rows(tree.root)[0]?.props.onPress());
    const shown = texts(tree.root).join("\n");
    assert.ok(!/[‪-‮⁦-⁩]/.test(shown));
    assert.ok(shown.includes("x\\u2067y") && shown.includes("a\\u202Eb"));
  } finally {
    act(() => tree.unmount());
  }
});

test("the Arabic letter mark and the left-to-right and right-to-left marks show as escapes, letters as written", async () => {
  const letters = "ملف קובץ";
  const tree = await render(createElement(ToolStep, { part: { type: "tool-read", state: "output-available", input: { path: `a؜b‎c‏d ${letters}` }, output: "x‏y" } }));
  try {
    const [row] = rows(tree.root);
    assert.ok(row);
    assert.ok(texts(row).includes(`a\\u061Cb\\u200Ec\\u200Fd ${letters}`));
    assert.ok(!/[؜‎‏]/.test(row.props.accessibilityLabel as string));
    await act(async () => row.props.onPress());
    const shown = texts(tree.root).join("\n");
    assert.ok(shown.includes("x\\u200Fy") && !/[؜‎‏]/.test(shown));
    assert.ok(shown.includes(letters), "letters untouched");
  } finally {
    act(() => tree.unmount());
  }
});

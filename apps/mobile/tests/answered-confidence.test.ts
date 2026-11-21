// The answered quiz card shows the learner's confidence as the web's does (#304): the rail
// with no handle and the percentage, right after the answer, as one screen-reader stop.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { LhMessage } from "../../../src/client-protocol/index.ts";
import type { PendingQuestion } from "../../../src/core/pending.ts";
import { projectView } from "../../../src/core/view.ts";
import { AnswerLine } from "../src/AnswerLine.tsx";
import { BuiltinQuestion } from "../src/BuiltinQuestion.tsx";
import { Transcript } from "../src/Transcript.tsx";
import { confidenceColors } from "../src/theme.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const quiz = () => JSON.parse(readFileSync(new URL("../../../tests/fixtures/mobile-quiz/chat_zzmobilequiz.json", import.meta.url), "utf8")) as { messages: LhMessage[] };

/** The fixture with its first answered quiz's details changed. */
function withFirst(details: Record<string, unknown>) {
  return quiz().messages.map((message) => (message as { toolCallId?: string }).toolCallId === "call_q1"
    ? { ...message, details: { ...(message as { details: object }).details, ...details } } as LhMessage : message);
}

async function cards(messages: LhMessage[]) {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(createElement(Transcript, { settled: projectView(messages), tail: [], api: {} as never, chatId: "chat", jobs: [], liveHelpers: false,
      openPlan: () => {}, files: new Map(), unavailableFiles: new Set<string>() }));
  });
  return tree as ReactTestRenderer;
}

async function records(messages: LhMessage[]) {
  const tree = await cards(messages);
  try {
    return tree.root.findAll((node) => String(node.type) === "View" && node.props.testID === "answered-confidence").map(inspect);
  } finally {
    act(() => tree.unmount());
  }
}

const flat = (style: unknown) => [style].flat(Infinity).reduce<Record<string, unknown>>((all, part) => ({ ...all, ...(part as object) }), {});
const texts = (node: ReactTestInstance): string[] => node.children.flatMap((child) => typeof child === "string" ? [child] : texts(child));
const hosts = (node: ReactTestInstance) => node.findAll((inner) => inner !== node && typeof inner.type === "string");

/** What a record shows and exposes, read before its tree unmounts. */
function inspect(record: ReactTestInstance) {
  const own = record.parent as ReactTestInstance;
  const card = own.parent as ReactTestInstance;
  const views = hosts(record).filter((node) => String(node.type) === "View");
  const text = hosts(record).find((node) => String(node.type) === "Text");
  return {
    label: record.props.accessibilityLabel as string, accessible: record.props.accessible as boolean, texts: texts(record),
    // Every host child of the record is hidden from screen readers, and nothing inside is a stop.
    hidden: record.children.every((child) => typeof child !== "string" && child.props.accessibilityElementsHidden === true
      && child.props.importantForAccessibility === "no-hide-descendants") && hosts(record).every((node) => !node.props.accessible),
    ticks: views.filter((node) => flat(node.props.style).width === 1).map((node) => flat(node.props.style).left),
    fills: views.filter((node) => String(flat(node.props.style).width).endsWith("%")).map((node) => [flat(node.props.style).width, flat(node.props.style).backgroundColor]),
    percent: { lines: text?.props.numberOfLines, ...flat(text?.props.style) } as Record<string, unknown>,
    after: card.children[card.children.indexOf(own) - 1] as ReactTestInstance | undefined,
  };
}

test("each answered quiz shows its confidence right after the answer, as one stop", async () => {
  const shown = await records(quiz().messages);
  assert.deepEqual(shown.map(({ label }) => label), ["Confidence 70%", "Confidence 50%"]);
  for (const [record, value, color] of [[shown[0], 70, confidenceColors[3]], [shown[1], 50, confidenceColors[2]]] as const) {
    assert.ok(record);
    assert.equal(record.accessible, true);
    assert.ok(record.hidden, "one stop: the rail and the percentage aren't reachable on their own");
    assert.deepEqual(record.texts, [`${value}%`]);
    assert.deepEqual(record.ticks, ["30%", "50%", "70%", "90%"]);
    assert.deepEqual(record.fills, [[`${value}%`, color]]);
    assert.equal(record.after?.type, AnswerLine);
    // Larger text widens the percentage on one line instead of wrapping it.
    assert.equal(record.percent.lines, 1);
    assert.equal(record.percent.minWidth, 36);
    assert.equal(record.percent.width, undefined);
  }
});

test("a confidence from 0 to 100 shows, off the stops too; anything else, or a skipped quiz, shows none", async () => {
  for (const [value, shown, color] of [[0, 0, confidenceColors[0]], [55, 55, confidenceColors[2]], [100, 100, confidenceColors[5]], [55.5, 56, confidenceColors[2]]] as const) {
    const [record] = await records(withFirst({ confidence: value }));
    assert.equal(record?.label, `Confidence ${shown}%`);
    assert.deepEqual(record?.texts, [`${shown}%`]);
    assert.deepEqual(record?.fills, [[`${shown}%`, color]]);
  }
  for (const details of [{ dontKnow: true }, { confidence: 140 }, { confidence: -5 }, { confidence: Number.POSITIVE_INFINITY }, { confidence: "70" }, { dismissed: true }, { confidence: undefined }]) {
    const shown = await records(withFirst(details));
    assert.deepEqual(shown.map(({ label }) => label), ["Confidence 50%"], JSON.stringify(details));
  }
  const ask = quiz().messages.map((message) => message.role === "toolResult"
    ? { ...message, details: { ...(message as { details: object }).details, kind: "ask" } } as LhMessage : message);
  assert.deepEqual(await records(ask), []);
});

test("the dock's slider keeps room for 100% at any text size, so its rail never changes width", async () => {
  const call = (quiz().messages[5] as { content: { type: string; name?: string; arguments?: unknown; id?: string }[] }).content.find(({ type }) => type === "toolCall");
  assert.ok(call);
  const question = { tool: call.name, input: call.arguments, toolCallId: call.id, messageId: "m", contentIndex: 0, key: "k" } as unknown as PendingQuestion;
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(createElement(BuiltinQuestion, { question, disabled: false, submit: () => {}, reveal: false, openAtStart: true }));
  });
  try {
    const root = (tree as ReactTestRenderer).root;
    const [percent] = root.findAll((node) => String(node.type) === "Text" && texts(node).join("") === "50%");
    const [widest] = root.findAll((node) => String(node.type) === "Text" && texts(node).join("") === "100%");
    assert.ok(percent && widest);
    // An unseen "100%" in the read-out's own style holds the box open; the value sits over it.
    const box = widest.parent as ReactTestInstance;
    assert.ok(box.findAll((node) => node === percent).length === 1, "the value and the unseen 100% share one box");
    assert.equal(flat(box.props.style).minWidth, 40);
    assert.equal(flat(widest.props.style).opacity, 0);
    assert.equal(widest.props.accessibilityElementsHidden, true);
    assert.equal(widest.props.importantForAccessibility, "no");
    for (const name of ["fontFamily", "fontSize", "lineHeight"]) assert.equal(flat(widest.props.style)[name], flat(percent.props.style)[name], name);
    assert.equal(flat(percent.props.style).position, "absolute");
    assert.equal(percent.props.numberOfLines, 1);
    assert.equal(widest.props.numberOfLines, 1);
  } finally {
    act(() => tree?.unmount());
  }
});

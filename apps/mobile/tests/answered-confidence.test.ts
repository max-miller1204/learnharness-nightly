// The answered quiz card shows the learner's confidence as the web's does (#304): the rail
// with no handle and the percentage, right after the answer, as one screen-reader stop.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { LhMessage } from "../../../src/client-protocol/index.ts";
import { projectView } from "../../../src/core/view.ts";
import { AnswerLine } from "../src/AnswerLine.tsx";
import { Transcript } from "../src/Transcript.tsx";
import { confidenceColors } from "../src/theme.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const quiz = () => JSON.parse(readFileSync(new URL("../../../tests/fixtures/mobile-quiz/chat_zzmobilequiz.json", import.meta.url), "utf8")) as { messages: LhMessage[] };

async function cards(messages: LhMessage[]) {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(createElement(Transcript, { settled: projectView(messages), tail: [], api: {} as never, chatId: "chat", jobs: [], liveHelpers: false,
      openPlan: () => {}, files: new Map(), unavailableFiles: new Set<string>() }));
  });
  return tree as ReactTestRenderer;
}

const records = (root: ReactTestInstance) => root.findAll((node) => String(node.type) === "View" && node.props.testID === "answered-confidence");
const flat = (style: unknown) => [style].flat(Infinity).reduce<Record<string, unknown>>((all, part) => ({ ...all, ...(part as object) }), {});
const texts = (node: ReactTestInstance): string[] => node.children.flatMap((child) => typeof child === "string" ? [child] : texts(child));

test("each answered quiz shows its confidence right after the answer, as one stop", async () => {
  const tree = await cards(quiz().messages);
  try {
    const shown = records(tree.root);
    assert.deepEqual(shown.map((record) => record.props.accessibilityLabel), ["Confidence 70%", "Confidence 50%"]);
    for (const [record, value, color] of [[shown[0], 70, confidenceColors[3]], [shown[1], 50, confidenceColors[2]]] as const) {
      assert.ok(record);
      assert.equal(record.props.accessible, true);
      assert.deepEqual(texts(record), [`${value}%`]);
      // Nothing inside is a stop of its own: the rail is paint, the percentage is the record's label.
      assert.equal(record.findAll((node) => node !== record && node.props.accessible === true).length, 0);
      const fill = record.findAll((node) => String(node.type) === "View" && flat(node.props.style).width === `${value}%`);
      assert.equal(fill.length, 1, "the rail is filled to the value");
      assert.equal(flat(fill[0]?.props.style).backgroundColor, color);
      // In the card, right after the chosen answer.
      const own = record.parent as ReactTestInstance;
      const card = own.parent as ReactTestInstance;
      const at = card.children.indexOf(own);
      const before = card.children[at - 1] as ReactTestInstance;
      assert.equal(before.type, AnswerLine);
    }
  } finally {
    act(() => tree.unmount());
  }
});

test("no confidence shows where the answer has none or isn't a quiz", async () => {
  const messages = quiz().messages.map((message) => {
    if (message.role !== "toolResult") return message;
    const details = { ...(message as { details: Record<string, unknown> }).details };
    // The first: a record from before confidence was saved. The second: an ask question.
    if ((message as { toolCallId: string }).toolCallId === "call_q1") delete details.confidence;
    else Object.assign(details, { kind: "ask" });
    return { ...message, details } as LhMessage;
  });
  const tree = await cards(messages);
  try {
    assert.equal(records(tree.root).length, 0);
  } finally {
    act(() => tree.unmount());
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { LhMessage } from "../../../src/client-protocol/index.ts";
import { projectView } from "../../../src/core/view.ts";
import { drawTex } from "../src/choice-math.ts";
import { Markdown } from "../src/Markdown.tsx";
import { MathWindow, MathWindowContext } from "../src/math-window.ts";
import { Capped, drawCount, equationsIn } from "../src/message-math.ts";
import { smallSession, type Batch } from "../src/session-open.ts";
import { markdownTexts, Transcript } from "../src/Transcript.tsx";

// Frames run on timers in Node.
globalThis.requestAnimationFrame ??= ((callback: (time: number) => void) => setTimeout(() => callback(performance.now()), 0) as unknown as number);
globalThis.cancelAnimationFrame ??= ((frame?: number | null) => clearTimeout(frame as unknown as NodeJS.Timeout));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../tests/fixtures/mobile-session-open/chats/${name}.json`, import.meta.url), "utf8")) as { messages: LhMessage[] };
const is = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;
const all = (root: ReactTestInstance, type: string) => root.findAll((node) => is(node, type));
const strings = (node: ReactTestInstance): string[] => node.children.flatMap((child) => typeof child === "string" ? [child] : strings(child));

async function render(element: ReactElement, nodeMock?: Parameters<typeof create>[1]) {
  let tree: ReactTestRenderer | undefined;
  await act(async () => { tree = create(element, nodeMock); });
  return tree as ReactTestRenderer;
}

const transcript = (props: Partial<Parameters<typeof Transcript>[0]> & { settled: Parameters<typeof Transcript>[0]["settled"] }) =>
  createElement(Transcript, { tail: [], api: {} as never, chatId: "chat", jobs: [], liveHelpers: false, openPlan: () => {}, files: new Map(), unavailableFiles: new Set<string>(), ...props });

test("the long fixture is shaped like the owner's longest phone session", () => {
  const view = projectView(fixture("chat_zzopenlong").messages);
  const counts = view.map((message) => markdownTexts(message).flatMap(equationsIn));
  const equations = counts.flat();
  assert.equal(view.length, 20);
  assert.equal(equations.length, 1291);
  assert.equal(new Set(equations.map(({ tex, display }) => `${display}${tex}`)).size, 478);
  assert.equal(counts.at(-1)?.length, 234);
});

test("short and math-free sessions show whole at once; the long one is drawn newest first", () => {
  assert.equal(smallSession(projectView(fixture("chat_zzopenshort").messages)), true);
  assert.equal(smallSession(projectView(fixture("chat_zzopenplain").messages)), true);
  assert.equal(smallSession(projectView(fixture("chat_zzopenlong").messages)), false);
});

test("message math is drawn natively, with no web view, and only HTTPS links open", async () => {
  const tree = await render(createElement(Markdown, {
    text: "**Solve** $x^2=4$\n\n\\[x=2\\]\n\n<img onerror=alert(1)> [external](https://example.test/?a=1&b=2) [plain](http://example.test)",
  }));
  assert.equal(all(tree.root, "WebView").length, 0);
  assert.equal(all(tree.root, "SvgAst").length, 2);
  assert.equal(all(tree.root, "Image").length, 0);
  const links = tree.root.findAll((node) => is(node, "Text") && node.props.accessibilityRole === "link");
  assert.equal(links.length, 1);
  assert.match(strings(tree.root).join(""), /<img onerror=alert\(1\)> external plain/);
  assert.doesNotMatch(readFileSync(new URL("../src/Markdown.tsx", import.meta.url), "utf8"), /webview/i);
});

test("each distinct equation is drawn once, and the cache keeps to its cap", async () => {
  const before = drawCount();
  await render(createElement(Markdown, { text: "Once $q_{once}^2$ and again $q_{once}^2$." }));
  await render(createElement(Markdown, { text: "Elsewhere $q_{once}^2$." }));
  assert.equal(drawCount() - before, 1);
  const cache = new Capped<number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.get("a");
  cache.set("c", 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
});

test("a unary minus has no space around it, as on the web", () => {
  assert.equal(drawTex("0.1(-1)(-2)", false)?.width, drawTex("0.1(\\mathord{-}1)(\\mathord{-}2)", false)?.width);
  // A binary minus keeps its spacing.
  assert.ok((drawTex("a-b", false)?.width ?? 0) > (drawTex("a\\mathord{-}b", false)?.width ?? 0));
});

test("punctuation right after inline math never wraps away from it", async () => {
  const tree = await render(createElement(Markdown, { text: "The answer is $x^2$. Then $y$, and $z$ again" }));
  const paragraph = tree.root.find((node) => is(node, "Text") && node.findAll((child) => is(child, "SvgAst")).length === 3);
  const kids = paragraph.children.map((child) => typeof child === "string" ? child : child.findAll((node) => is(node, "SvgAst")).length ? "MATH" : "?");
  assert.deepEqual(kids, ["The answer is ", "MATH", "⁠", ". Then ", "MATH", "⁠", ", and ", "MATH", " again"]);
});

test("a table in a message with math keeps equal, readable columns", async () => {
  const tree = await render(createElement(Markdown, {
    text: "Math $x$ first.\n\n| **Term** | Meaning |\n| --- | --- |\n| **MLE** | The estimate that makes the observed data most likely, $\\hat{\\theta}$ |",
  }));
  const rows = tree.root.findAll((node) => is(node, "View") && node.props.style?.flexDirection === "row");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const cells = row.findAll((node) => is(node, "Text") && [node.props.style].flat(4).some((style) => style?.flex === 1));
    assert.equal(cells.length, 2);
  }
});

test("with a screen reader on, a paragraph with math is one stop read with the math, and its link stays", async () => {
  (globalThis as { screenReader?: boolean }).screenReader = true;
  try {
    const tree = await render(createElement(Markdown, { text: "So $x^2$ grows, see [notes](https://example.test/notes)." }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const paragraph = tree.root.find((node) => is(node, "Text") && typeof node.props.accessibilityLabel === "string");
    assert.doesNotMatch(paragraph.props.accessibilityLabel, /\$|\\/);
    assert.match(paragraph.props.accessibilityLabel, /^So x( superscript 2| squared) grows, see notes\.$/);
    assert.equal(paragraph.findAll((node) => is(node, "Text") && node.props.accessibilityRole === "link").length, 1);
  } finally {
    delete (globalThis as { screenReader?: boolean }).screenReader;
  }
});

test("in a session, only blocks near the screen, the start or the end mount their pictures", async () => {
  const settled = projectView(fixture("chat_zzopenlong").messages);
  const window = new MathWindow();
  const batch: Batch = { id: "newest", start: 0, placed: true };
  // Each block sits 100 points below the last, in the order it is created.
  let next = 0;
  const createNodeMock = () => {
    const y = (next++) * 100;
    return { measureLayout: (_parent: unknown, done: (x: number, y: number, width: number, height: number) => void) => done(0, y, 300, 90) };
  };
  const tree = await render(createElement(MathWindowContext.Provider, { value: window },
    transcript({ settled, batches: [batch], eager: () => false, batchWidth: 360 })), { createNodeMock });
  assert.equal(all(tree.root, "SvgAst").length, 0);
  const content = next * 100;
  await act(async () => {
    window.setBatch("newest", { y: 0, height: content });
    window.setView(content / 2, 800, content);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const live = all(tree.root, "SvgAst").length;
  assert.ok(live > 0, "pictures near the screen mount");
  assert.ok(live < 1291 / 3, `only some pictures mount (${live})`);
});

test("a finished reply replaces its streamed text with drawn math in place", async () => {
  const asked: LhMessage = { role: "user", id: "u_more", timestamp: 1, content: "And for a circle?" } as LhMessage;
  const before = [...fixture("chat_zzopenshort").messages, asked];
  const settled = projectView(before);
  const reply: LhMessage = {
    role: "assistant", id: "a_new", timestamp: 1, api: "openai-completions", provider: "custom", model: "m", stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: "text", text: "Now $r^2$ holds." }],
  } as LhMessage;
  const tree = await render(transcript({ settled, tail: [reply] }));
  const top = () => tree.root.children.filter((child): child is ReactTestInstance => typeof child !== "string");
  const count = top().length;
  assert.match(strings(top().at(-1) as ReactTestInstance).join(""), /\$r\^2\$/);
  await act(async () => { tree.update(transcript({ settled: projectView([...before, reply]), tail: [] })); });
  assert.equal(top().length, count);
  assert.equal(all(top().at(-1) as ReactTestInstance, "SvgAst").length, 1);
});

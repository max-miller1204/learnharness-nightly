import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { AccessibilityInfo, Platform, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { LhMessage } from "../../../src/client-protocol/index.ts";
import { projectView } from "../../../src/core/view.ts";
import { drawTex } from "../src/choice-math.ts";
import { Markdown } from "../src/Markdown.tsx";
import { MathWindow, MathWindowContext } from "../src/math-window.ts";
import { Capped, drawCount, drawFrom, drawQueue, equationsIn, isDrawn, setEquationCap, EQUATION_CAP } from "../src/message-math.ts";
import { drawTurn, fitBatches, segmentBefore, smallSession, transcriptVisibility, useSessionOpening, type Batch } from "../src/session-open.ts";
import { markdownTexts, messageSegments, Snapshot, SNAPSHOT_HEIGHT, snapshotBox, Transcript, type Position } from "../src/Transcript.tsx";
import { space } from "../src/theme.ts";
import type { LhViewMessage } from "../../../src/core/view.ts";

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
  const batch: Batch = { id: "newest", start: { message: 0, item: 0 }, placed: true };
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

/** Whether a batch starts at the start of message `index`. */
const at = (batch: Batch | undefined, index: number) => batch?.start.message === index && batch.start.item === 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = (ms: number) => act(async () => { await sleep(ms); });
/** A unique tag per run, so equations here are never already drawn by another test. */
const run = Math.random().toString(36).slice(2, 8);
const user = (id: string, text: string) => ({ role: "user", id, timestamp: 1, content: text }) as LhMessage;
const assistant = (id: string, text: string) => ({
  role: "assistant", id, timestamp: 1, api: "openai-completions", provider: "custom", model: "m", stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  content: [{ type: "text", text }],
}) as LhMessage;
/** A made-up session of `turns` exchanges whose replies hold `perReply` equations never drawn before. */
function coldSession(name: string, turns: number, perReply: number): LhViewMessage[] {
  return projectView(Array.from({ length: turns }, (_, turn) => [
    user(`u${turn}`, `Question ${turn}`),
    assistant(`a${turn}`, Array.from({ length: perReply }, (_, index) => `Step $w_{${name}${run}t${turn}e${index}}^2$ holds.`).join("\n\n")),
  ]).flat());
}

type Opening = ReturnType<typeof useSessionOpening>;
/** The real opening hook over the real transcript, with the ScrollView's events sent by hand. */
async function opened(settled: LhViewMessage[], loaded = true, { deferMeasure = false } = {}) {
  let opening: Opening | undefined;
  // Blocks sit within the first screen of their batch, so a batch's start holds some. With
  // `deferMeasure`, measurements wait for flush(), as they would arriving after a layout.
  let next = 0;
  const queued: (() => void)[] = [];
  const createNodeMock = () => {
    const y = (next++ % 10) * 60;
    return {
      measureLayout: (_parent: unknown, done: (x: number, y: number, width: number, height: number) => void) => {
        if (deferMeasure) queued.push(() => done(0, y, 300, 50));
        else done(0, y, 300, 50);
      },
    };
  };
  function Harness({ settled, loaded, tail }: { settled: LhViewMessage[]; loaded: boolean; tail: string[] }) {
    const result = useSessionOpening(settled, loaded, tail);
    opening = result;
    return createElement(MathWindowContext.Provider, { value: result.mathWindow },
      transcript({ settled, batches: result.batches, eager: result.eager, batchWidth: result.width, onBatchLayout: result.onBatchLayout }));
  }
  const tree = await render(createElement(Harness, { settled, loaded, tail: [] }), { createNodeMock });
  const now = () => opening as Opening;
  /** The ScrollView's events without act, to send several as one change. */
  const raw = {
    layout: (height: number) => now().scrollProps.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height } } } as LayoutChangeEvent),
    content: (height: number) => now().scrollProps.onContentSizeChange(360, height),
    scroll: (offset: number, viewport: number, content: number) => now().scrollProps.onScroll({
      nativeEvent: { contentOffset: { x: 0, y: offset }, layoutMeasurement: { width: 360, height: viewport }, contentSize: { width: 360, height: content } },
    } as NativeSyntheticEvent<NativeScrollEvent>),
    batch: (id: string, layout: { y: number; height: number; width?: number }) => {
      const batch = now().batches.find((each) => each.id === id) as Batch;
      now().onBatchLayout(batch, { x: 0, width: 360, ...layout });
    },
  };
  /** Counts scrollToEnd calls in place of the ScrollView. */
  const toEnd = { calls: 0 };
  const events = {
    tree,
    now,
    toEnd,
    spyScroll: () => { (now().scrollProps.ref as { current: unknown }).current = { scrollToEnd: () => { toEnd.calls++; } }; },
    flush: () => act(async () => { while (queued.length) (queued.shift() as () => void)(); }),
    together: (send: (events: typeof raw) => void) => act(async () => { send(raw); }),
    update: (props: { settled?: LhViewMessage[]; loaded?: boolean; tail?: string[] }) =>
      act(async () => { tree.update(createElement(Harness, { settled, loaded, tail: [], ...props })); }),
    layout: (height: number) => act(async () => { raw.layout(height); }),
    content: (height: number) => act(async () => { raw.content(height); }),
    scroll: (offset: number, viewport: number, content: number) => act(async () => { raw.scroll(offset, viewport, content); }),
    batch: (id: string, layout: { y: number; height: number; width?: number }) => act(async () => { raw.batch(id, layout); }),
  };
  return events;
}

test("drawing keeps its own progress, so a message with more equations than a slice holds always finishes", () => {
  const queue = drawQueue([Array.from({ length: 5 }, (_, index) => `$q_{${run}p${index}}$`).join(" ")]);
  let calls = 0;
  // The deadline has always passed: each call still draws one more and never starts over.
  while (!drawFrom(queue, 0, () => 1)) calls++;
  assert.equal(calls + 1, 5);
  assert.equal(queue.next, 5);
});

test("a cold session of up to 60 equations is still drawn at once and shows whole", () => {
  assert.equal(smallSession(coldSession("small", 4, 10)), true);
  assert.equal(smallSession(coldSession("big", 7, 10)), false);
});

test("the transcript shows only after its own ScrollView reports, and not while a block's batch is unplaced", async () => {
  const settled = coldSession("reveal", 4, 20);
  const session = await session_waiting(settled);
  // The ScrollView shown while loading reported an end; none of it counts for the new one.
  await session.update({ loaded: true });
  await wait(300);
  assert.equal(session.now().shown, false);
  // The new ScrollView is at its end, but the newest batch hasn't reported where it is.
  await session.layout(800);
  await session.content(4000);
  await session.scroll(3200, 800, 4000);
  await wait(100);
  assert.equal(session.now().shown, false);
  assert.ok(session.now().mathWindow.pendingOnScreen() > 0);
  await session.batch("newest", { y: 16, height: 3968 });
  await session.scroll(3200, 800, 4000);
  await wait(200);
  assert.equal(session.now().shown, true);
  await act(async () => session.tree.unmount());
});

async function session_waiting(settled: LhViewMessage[]) {
  const session = await opened(settled, false);
  await session.layout(800);
  await session.content(5000);
  await session.scroll(4200, 800, 5000);
  return session;
}

test("an older batch lands with its first screen drawn, and placed heights clear when the width changes", async () => {
  const settled = coldSession("older", 60, 12);
  const session = await opened(settled);
  await session.layout(800);
  await session.content(1600);
  await session.batch("newest", { y: 16, height: 1568 });
  await session.scroll(800, 800, 1600);
  for (let tries = 0; tries < 50 && !session.now().shown; tries++) await wait(20);
  assert.equal(session.now().shown, true);
  // Older messages come in as a batch measured out of sight.
  let older: Batch | undefined;
  for (let tries = 0; tries < 500 && !older; tries++) {
    await wait(20);
    older = session.now().batches.find((batch) => !batch.placed);
  }
  assert.ok(older, "an older batch is measured");
  await session.batch(older.id, { y: -1e6, height: 900 });
  const placed = session.now().batches.find((batch) => batch.id === older.id) as Batch;
  assert.equal(placed.placed, true);
  // Whole pixels at the test's 2.625 density, one pixel over the measured height.
  assert.equal(Math.round((placed.height as number) * 2.625), Math.round(900 * 2.625) + 1);
  // Its first screen has its pictures in the same commit that placed it.
  const view = session.tree.root.findAll((node) => is(node, "View") && [node.props.style].flat(2).some((style) => style?.minHeight === placed.height))[0];
  assert.ok(view && all(view, "SvgAst").length > 0, "the new start has its pictures");
  await session.batch("newest", { y: 16 + 900 + 16, height: 1568, width: 500 });
  assert.equal(session.now().batches.find((batch) => batch.id === older.id)?.height, undefined);
  await act(async () => session.tree.unmount());
});

test("the end is followed when the reply grows, whichever order a landing batch's events arrive in", async () => {
  const session = await opened(projectView(fixture("chat_zzopenshort").messages));
  await session.layout(800);
  await session.batch("newest", { y: 16, height: 1968 });
  await session.content(2000);
  await session.scroll(1200, 800, 2000);
  session.spyScroll();
  // An older batch lands above: anchoring keeps the screen still, nothing to follow.
  await session.together((events) => {
    events.scroll(2116, 800, 2916);
    events.batch("newest", { y: 932, height: 1968 });
    events.content(2916);
  });
  assert.equal(session.toEnd.calls, 0);
  // One lands while the reply grows by 30: the anchoring scroll event comes first with the new content.
  await session.together((events) => {
    events.scroll(3032, 800, 3862);
    events.batch("newest", { y: 1848, height: 1968 });
    events.content(3862);
  });
  assert.equal(session.toEnd.calls, 1);
  // The reply grows by 20 before a landing's own change: both are handled on their own.
  await session.together((events) => events.content(3882));
  assert.equal(session.toEnd.calls, 2);
  await session.together((events) => {
    events.batch("newest", { y: 2364, height: 1968 });
    events.content(4398);
  });
  assert.equal(session.toEnd.calls, 2);
  await act(async () => session.tree.unmount());
});

test("after a second the session shows without landing, but never with on-screen math missing", async () => {
  const session = await opened(coldSession("fallback", 4, 20));
  // Every message drawn and in, so blocks are waiting for their batch's place.
  for (let tries = 0; tries < 250 && !at(session.now().batches[0], 0); tries++) await wait(20);
  assert.ok(at(session.now().batches[0], 0));
  await session.layout(800);
  await session.content(4000);
  // Scrolled away from the end, and the newest batch hasn't said where it is.
  await session.scroll(0, 800, 4000);
  await wait(1300);
  assert.equal(session.now().shown, false);
  await session.batch("newest", { y: 16, height: 3968 });
  await wait(200);
  assert.equal(session.now().shown, true);
  await act(async () => session.tree.unmount());
});

test("an older batch measured before its blocks waits for them, then lands with its first screen drawn", async () => {
  const session = await opened(coldSession("deferred", 60, 12), true, { deferMeasure: true });
  await session.layout(800);
  await session.content(1600);
  await session.batch("newest", { y: 16, height: 1568 });
  await session.flush();
  await session.scroll(800, 800, 1600);
  for (let tries = 0; tries < 50 && !session.now().shown; tries++) {
    await session.flush();
    await wait(20);
  }
  assert.equal(session.now().shown, true);
  let older: Batch | undefined;
  for (let tries = 0; tries < 500 && !older; tries++) {
    await wait(20);
    older = session.now().batches.find((batch) => !batch.placed);
  }
  assert.ok(older, "an older batch is measured");
  await session.batch(older.id, { y: -1e6, height: 900 });
  assert.equal(session.now().batches.find((batch) => batch.id === older.id)?.placed, false);
  await session.flush();
  const placed = session.now().batches.find((batch) => batch.id === older.id) as Batch;
  assert.equal(placed.placed, true);
  const view = session.tree.root.findAll((node) => is(node, "View") && [node.props.style].flat(2).some((style) => style?.minHeight === placed.height))[0];
  assert.ok(view && all(view, "SvgAst").length > 0, "the new start has its pictures");
  await act(async () => session.tree.unmount());
});

test("a message with more distinct equations than the cache holds renders without drawing them again", async () => {
  setEquationCap(20);
  try {
    const text = Array.from({ length: 25 }, (_, index) => `$c_{${run}x${index}}$`).join(" and ");
    assert.equal(drawFrom(drawQueue([text]), Infinity), true);
    const before = drawCount();
    await render(createElement(Markdown, { text }));
    // Only the five the queue's own drawing pushed out are drawn again, once each.
    assert.ok(drawCount() - before <= 5, `${drawCount() - before} draws`);
  } finally {
    setEquationCap(EQUATION_CAP);
  }
});

test("on iOS a small session keeps the loader up until it shows, and shows at once when it fits", async () => {
  const os = Platform.OS;
  Object.assign(Platform, { OS: "ios" });
  try {
    const fits = await opened(projectView(fixture("chat_zzopenshort").messages));
    assert.equal(fits.now().shown, false);
    assert.equal(fits.now().loading, true);
    await fits.together((events) => {
      events.layout(800);
      events.content(300);
    });
    await wait(50);
    assert.equal(fits.now().shown, true);
    assert.equal(fits.now().loading, false);
    await act(async () => fits.tree.unmount());
    const tall = await opened(projectView(fixture("chat_zzopenplain").messages));
    await tall.together((events) => {
      events.layout(800);
      events.content(3000);
    });
    await wait(50);
    assert.equal(tall.now().shown, false);
    assert.equal(tall.now().loading, true);
    await tall.scroll(2200, 800, 3000);
    await wait(50);
    assert.equal(tall.now().shown, true);
    await act(async () => tall.tree.unmount());
  } finally {
    Object.assign(Platform, { OS: os });
  }
});

test("the streaming reply's finished math is drawn while it streams", async () => {
  const session = await opened(projectView(fixture("chat_zzopenshort").messages));
  assert.equal(session.now().shown, true);
  const tex = `u_{tail${run}}`;
  let text = `First $${tex}$ done.\n\n`;
  for (let tick = 0; tick < 30; tick++) {
    text += "more ";
    await session.update({ tail: [text] });
    await wait(10);
  }
  assert.equal(isDrawn({ tex, display: false }), true);
  await act(async () => session.tree.unmount());
});

test("while hidden the transcript takes no touches, scrolling or screen reader focus", () => {
  assert.deepEqual(transcriptVisibility(true), {
    style: { opacity: 0 }, pointerEvents: "none", scrollEnabled: false, accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants",
  });
  assert.equal(transcriptVisibility(false).pointerEvents, "auto");
  assert.equal(transcriptVisibility(false).scrollEnabled, true);
});

test("a saved image's box takes its own shape, as the web sizes it", () => {
  // The test screen is 400 by 800, so the column is 368 and the cap is 60% of 800.
  assert.deepEqual(snapshotBox(1200, 200, 368, 800), { width: 368, height: 200 * (368 / 1200) });
  assert.deepEqual(snapshotBox(100, 50, 368, 800), { width: 100, height: 50 });
  assert.deepEqual(snapshotBox(300, 2000, 368, 800), { width: 72, height: 480 });
  for (const [width, height] of [[undefined, 200], [1200, undefined], [0, 200], [1200, -1], [Number.NaN, 200], [Infinity, 200], ["1200", 200]]) {
    assert.equal(snapshotBox(width, height, 368, 800), undefined);
  }
});

/** The saved image's box in each state: loading, then shown or failed. */
async function snapshotStates(size: { width?: unknown; height?: unknown }, fail: boolean) {
  let settle: { resolve: (value: unknown) => void; reject: (error: unknown) => void } = { resolve: () => {}, reject: () => {} };
  const api = { get: () => new Promise((resolve, reject) => { settle = { resolve, reject }; }) } as never;
  const tree = await render(createElement(Snapshot, { api, chatId: "c", snapshotId: "s", caption: "A figure", ...size }));
  const box = () => {
    const view = tree.root.findAll((node) => is(node, "View"))[1] as ReactTestInstance;
    const style = Object.assign({}, ...[view.props.style].flat(3).filter(Boolean)) as { width?: number; height?: number };
    return { view, width: style.width, height: style.height };
  };
  const loading = box();
  assert.equal(strings(loading.view).join(""), "Loading image…");
  await act(async () => { if (fail) settle.reject(new Error("gone")); else settle.resolve({ mimeType: "image/png", data: "AAAA", width: 1200, height: 200 }); });
  const after = box();
  assert.equal(fail ? strings(after.view).join("") : all(after.view, "Image").length, fail ? "Image unavailable" : 1);
  return [loading, after].map(({ width, height }) => ({ width, height }));
}

test("a saved image with a known size keeps that box while loading, shown and failed", async () => {
  for (const fail of [false, true]) {
    const [loading, after] = await snapshotStates({ width: 1200, height: 200 }, fail);
    assert.deepEqual(loading, { width: 368, height: 200 * (368 / 1200) });
    assert.deepEqual(after, loading);
  }
});

test("a saved show_image result's own size reaches the transcript's image box", async () => {
  const api = { get: () => new Promise(() => {}) } as never;
  const tree = await render(transcript({ settled: projectView(fixture("chat_zzopenimages").messages), api }));
  const boxes = tree.root.findAll((node) => is(node, "View") && [node.props.style].flat(3).some((style) => style?.alignSelf === "center"))
    .map((view) => { const style = Object.assign({}, ...[view.props.style].flat(3).filter(Boolean)); return { width: style.width, height: style.height }; });
  assert.deepEqual(boxes, [{ width: 368, height: 200 * (368 / 1200) }, { width: 72, height: 480 }]);
});

test("a saved image without a valid size falls back to the fixed box in every state", async () => {
  for (const size of [{}, { width: 0, height: 200 }]) {
    for (const fail of [false, true]) {
      const [loading, after] = await snapshotStates(size, fail);
      assert.deepEqual(loading, { width: undefined, height: SNAPSHOT_HEIGHT });
      assert.deepEqual(after, loading);
    }
  }
});

test("a math paragraph's label is right on the first render, before any screen reader check", async () => {
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(createElement(Markdown, { text: "Then $y^2$ follows." })); });
  const paragraph = (tree as ReactTestRenderer).root.find((node) => is(node, "Text") && typeof node.props.accessibilityLabel === "string");
  assert.match(paragraph.props.accessibilityLabel, /^Then y superscript 2 follows\.$/);
});

test("math in a narrow table cell at the largest text size keeps a positive size", async () => {
  (globalThis as { fontScale?: number }).fontScale = 3;
  try {
    const tree = await render(createElement(Markdown, { text: "| a | b | c | d | e | f |\n| - | - | - | - | - | - |\n| $x^2$ | $y$ | $z$ | $w$ | $v$ | $\\frac{1}{2}$ |" }));
    const sized = tree.root.findAll((node) => is(node, "View") && typeof node.props.style?.width === "number");
    assert.ok(sized.length >= 6);
    for (const view of sized) assert.ok(view.props.style.width > 0 && view.props.style.height > 0);
  } finally {
    delete (globalThis as { fontScale?: number }).fontScale;
  }
});

test("every paragraph shares one screen reader subscription", async () => {
  const add = AccessibilityInfo.addEventListener;
  let subscriptions = 0;
  Object.assign(AccessibilityInfo, { addEventListener: (...args: Parameters<typeof add>) => { subscriptions++; return add(...args); } });
  try {
    await render(createElement("View", null, ...Array.from({ length: 20 }, (_, index) => createElement(Markdown, { key: index, text: `Item $k_{${index}}$.` }))));
    assert.ok(subscriptions <= 1, `${subscriptions} subscriptions`);
  } finally {
    Object.assign(AccessibilityInfo, { addEventListener: add });
  }
});

test("nothing joins the newest batch while landing, and its pictures mount only once it has landed", async () => {
  const session = await opened(coldSession("landing", 30, 12));
  for (let tries = 0; tries < 250 && at(session.now().batches[0], 60); tries++) await wait(20);
  await session.layout(800);
  await session.batch("newest", { y: 16, height: 984 });
  await session.content(1000);
  // Landing, 50 short of the end.
  await session.scroll(150, 800, 1000);
  const start = session.now().batches[0]?.start;
  await wait(400);
  assert.equal(session.now().batches[0]?.start, start, "no message is added while landing");
  assert.equal(session.now().shown, false);
  // Short of the end no picture mounts, since the screen there isn't the one that will show.
  assert.equal(session.now().mathWindow.livePictures, 0);
  // Landed: the pictures on screen mount, and it shows once they are in.
  await session.scroll(200, 800, 1000);
  for (let tries = 0; tries < 50 && !session.now().shown; tries++) await wait(20);
  assert.ok(session.now().mathWindow.livePictures > 0);
  assert.equal(session.now().shown, true);
  // Filling goes on once shown, as older batches.
  let older: Batch | undefined;
  for (let tries = 0; tries < 250 && !older; tries++) {
    await wait(20);
    older = session.now().batches.find((batch) => batch.id !== "newest");
  }
  assert.ok(older, "older messages come in once shown");
  await act(async () => session.tree.unmount());
});

test("while hidden the transcript keeps to the end even after a scroll said it was far from it", async () => {
  const session = await opened(coldSession("hidden", 30, 12));
  for (let tries = 0; tries < 250 && at(session.now().batches[0], 60); tries++) await wait(20);
  await session.layout(800);
  await session.batch("newest", { y: 16, height: 4984 });
  await session.content(5000);
  // A scroll far from the end, as one arriving with new content and an old offset would say.
  await session.scroll(0, 800, 5000);
  assert.equal(session.now().shown, false);
  session.spyScroll();
  await session.content(5200);
  assert.ok(session.toEnd.calls >= 1);
  await act(async () => session.tree.unmount());
});

test("a long reply splits between its paragraphs, a learner's band never does, and every equation is in one segment", () => {
  const view = projectView(fixture("chat_zzopenlong").messages);
  const last = view.at(-1) as LhViewMessage;
  const { items, segments } = messageSegments(last);
  assert.ok(segments.length > 60, `${segments.length} segments`);
  assert.equal(segments[0]?.from, 0);
  assert.equal(segments.at(-1)?.to, items.length);
  segments.forEach((segment, index) => { if (index) assert.equal(segment.from, segments[index - 1]?.to); });
  assert.equal(segments.flatMap(({ equations }) => equations).length, markdownTexts(last).flatMap(equationsIn).length);
  const asked = view.findLast((message) => message.role === "user") as LhViewMessage;
  assert.equal(messageSegments(asked).segments.length, 1);
  // Walking back segment by segment from the end reaches the start through every message once.
  let at: Position = { message: view.length, item: 0 };
  let steps = 0;
  for (let before = segmentBefore(view, at); before; before = segmentBefore(view, at)) {
    at = before.start;
    steps++;
  }
  assert.deepEqual(at, { message: 0, item: 0 });
  assert.equal(steps, view.reduce((sum, message) => sum + messageSegments(message).segments.length, 0));
});

test("a reply split between two batches shows every paragraph once, spaced as one message", async () => {
  const settled = projectView(fixture("chat_zzopenlong").messages);
  const last = settled.length - 1;
  const cut = (messageSegments(settled[last] as LhViewMessage).segments[30] as { from: number }).from;
  const blocks = (tree: ReactTestRenderer) => all(tree.root, "NativeMarkdown").length;
  const whole = await render(transcript({ settled, batches: [{ id: "newest", start: { message: 0, item: 0 }, placed: true }] }));
  const split = await render(transcript({ settled, batches: [
    { id: "older", start: { message: 0, item: 0 }, placed: true },
    { id: "newest", start: { message: last, item: cut }, placed: true },
  ] }));
  assert.equal(blocks(split), blocks(whole));
  // Every word and equation in the same order, the split adding or dropping nothing.
  const reading = (tree: ReactTestRenderer) => strings(tree.root).join("") + tree.root.findAll((node) => typeof node.type === "function" && node.type.name === "MathPicture").map((node) => node.props.svg as string).join("|");
  assert.equal(reading(split), reading(whole));
  // The rest of the reply sits as close to its start as the reply's own paragraphs do, to the
  // whole pixel, so placing content above can never round it a pixel either way.
  const margins = split.root.findAll((node) => is(node, "View")).flatMap((node) => [node.props.style].flat(3))
    .map((style) => style?.marginTop).filter((margin): margin is number => typeof margin === "number" && margin < 0);
  assert.equal(margins.length, 1);
  assert.ok(Math.abs((margins[0] as number) - (space.md - space.lg)) < 0.5);
  assert.equal((margins[0] as number) * 2.625, Math.round((margins[0] as number) * 2.625));
});

test("a long reply shows from its last paragraphs: the newest batch starts inside it before the rest is drawn", async () => {
  const name = `tail${run}`;
  const settled = projectView([user("u0", "Go"), assistant("a0", Array.from({ length: 80 }, (_, index) => `Step $v_{${name}e${index}}^2$ holds.`).join("\n\n"))]);
  const session = await opened(settled);
  for (let tries = 0; tries < 250 && at(session.now().batches[0], 2); tries++) await wait(20);
  const start = session.now().batches[0]?.start;
  assert.equal(start?.message, 1);
  assert.ok((start?.item ?? 0) > 0, "only the reply's last paragraphs are in");
  await act(async () => session.tree.unmount());
});

test("a rotation or new content never leaves the end: only the learner's own scrolling does", async () => {
  const session = await opened(projectView(fixture("chat_zzopenshort").messages));
  await session.layout(800);
  await session.content(2000);
  await session.scroll(1200, 800, 2000);
  session.spyScroll();
  // Rotated: the screen is shorter and the content taller, and the first scroll event says so far from the end.
  await session.layout(400);
  assert.equal(session.toEnd.calls, 1);
  await session.scroll(1200, 400, 2600);
  assert.equal(session.now().awayFromEnd, false, "no Scroll to end button");
  await session.content(2600);
  assert.equal(session.toEnd.calls, 2);
  // Content growing above before its scroll event arrives never flashes the button.
  await session.content(3100);
  assert.equal(session.now().awayFromEnd, false);
  await session.scroll(2700, 400, 3100);
  // The learner drags away: the button shows, and a resize no longer pulls to the end.
  await act(async () => { session.now().scrollProps.onScrollBeginDrag(); });
  await session.scroll(1000, 400, 3100);
  assert.equal(session.now().awayFromEnd, true);
  const calls = session.toEnd.calls;
  await session.layout(800);
  assert.equal(session.toEnd.calls, calls);
  await act(async () => session.tree.unmount());
});

test("Scroll to end from far up jumps to a screen short of the end and animates only the rest", async () => {
  const session = await opened(projectView(fixture("chat_zzopenshort").messages));
  await session.layout(800);
  await session.content(20000);
  await session.scroll(1000, 800, 20000);
  const calls: string[] = [];
  (session.now().scrollProps.ref as { current: unknown }).current = {
    scrollTo: ({ y, animated }: { y: number; animated: boolean }) => calls.push(`to ${y} ${animated}`),
    scrollToEnd: ({ animated }: { animated: boolean }) => calls.push(`end ${animated}`),
  };
  await act(async () => { session.now().scrollToEnd(true); await sleep(30); });
  assert.deepEqual(calls, ["to 18400 false", "end true"]);
  calls.length = 0;
  await session.scroll(19000, 800, 20000);
  await act(async () => { session.now().scrollToEnd(true); });
  assert.deepEqual(calls, ["end true"]);
  await act(async () => session.tree.unmount());
});

test("the picture window holds while the transcript lands, looks ahead of a fling, and mounts a placed batch whole", async () => {
  const window = new MathWindow();
  const live = new Map<string, boolean>();
  const block = (batch: string, y: number) => {
    const entry = { batch, y, height: 50, measured: true, pictures: 1, wanted: false, committed: false, farSince: undefined,
      setLive: (value: boolean) => { live.set(`${batch}:${y}`, value); }, measure: () => {} };
    window.add(entry as Parameters<MathWindow["add"]>[0]);
  };
  for (let y = 0; y < 10000; y += 100) block("newest", y);
  window.setBatch("newest", { y: 0, height: 10000 });
  window.setHold(true);
  window.setView(9000, 1000, 10000);
  window.update();
  assert.equal(live.size, 0, "nothing mounts while held");
  window.setHold(false);
  window.update();
  const mounted = () => [...live].filter(([, value]) => value).map(([key]) => Number(key.split(":")[1]));
  // Within two screens of the screen (here the end) or of the start (where a status-bar tap lands).
  const between = (low: number, high: number) => mounted().filter((y) => y > low && y < high);
  assert.deepEqual(between(3000, 6900), [], "nothing far from the screen, the start and the end");
  // A fast fling toward the start mounts further ahead of the screen than that.
  window.setView(7000, 1000, 10000);
  window.moved(7000, -5);
  for (let frame = 0; frame < 10; frame++) window.update();
  assert.ok(between(3000, 4900).length > 0, "blocks the fling is heading for mount ahead");
  // A batch placed above mounts all its pictures at once.
  for (let y = 0; y < 3000; y += 100) block("older", y);
  window.setBatch("older", { y: -50000, height: 3000 });
  window.mountBatch("older");
  assert.equal([...live].filter(([key, value]) => key.startsWith("older:") && value).length, 30);
});

test("a color that tries to break out of its attribute never adds to the picture", () => {
  for (const tex of [
    String.raw`\color{red"/><image href="https://example.invalid/x.png" width="9000" height="9000}{x}`,
    String.raw`\colorbox{red"/><image href="https://example.invalid/x.png"}{x}`,
    String.raw`\textcolor{red" onload="x}{y}`,
  ]) {
    const drawn = drawTex(tex, false);
    for (const svg of drawn ? [drawn.svg.dark, drawn.svg.light] : []) {
      assert.doesNotMatch(svg, /<image|href=|onload=/, tex);
      for (const [, tag] of svg.matchAll(/<([a-zA-Z]+)/g)) assert.ok(["svg", "g", "path", "rect", "text"].includes(tag as string), `${tex}: <${tag}>`);
    }
  }
});

test("drawn math keeps MathJax's drawing order, so what is drawn later stays on top", () => {
  const drawn = drawTex(String.raw`x\rlap{\color{blue}{x}}x`, false);
  assert.ok(drawn);
  const svg = drawn.svg.light;
  const blue = svg.indexOf('fill="blue"');
  assert.ok(blue > 0 && blue < svg.lastIndexOf("<path"), "the last x is drawn after the blue one");
});

test("filling in stops quietly when the transcript shrinks under it", async () => {
  const view = projectView(fixture("chat_zzopenlong").messages);
  assert.equal(segmentBefore(view.slice(0, 5), { message: 19, item: 3 }), undefined);
  assert.equal(segmentBefore(view.slice(0, 5), { message: 12, item: 0 }), undefined);
  const settled = coldSession("shrink", 30, 12);
  const session = await opened(settled);
  for (let tries = 0; tries < 250 && at(session.now().batches[0], 60); tries++) await wait(20);
  // A rewind removes most of it mid-fill: nothing throws, and filling in carries on or stops.
  await session.update({ settled: settled.slice(0, 6) });
  await wait(300);
  assert.ok(session.now().batches.length > 0);
  await act(async () => session.tree.unmount());
});

test("a drawing turn starts no new segment once its deadline has passed", () => {
  const name = `deadline${run}`;
  const settled = projectView([user("u0", "Go"), assistant("a0", Array.from({ length: 100 }, (_, index) => `Step $d_{${name}e${index}}^2$.`).join("\n\n"))]);
  const gathered = { next: { message: 2, item: 0 }, equations: 0, count: 0 };
  // Each clock reading is 3 ms later, so a 12 ms turn has room for a few equations, not 60.
  let clock = 0;
  const turn = drawTurn(settled, gathered, 200, 12, { current: null }, () => (clock += 3));
  assert.equal(turn.full, false);
  assert.ok(gathered.equations >= 1 && gathered.equations <= 4, `${gathered.equations} equations in one turn`);
});

test("a resize keeps the end whichever of its scroll event and layout comes first", async () => {
  for (const scrollFirst of [false, true]) {
    const session = await opened(projectView(fixture("chat_zzopenshort").messages));
    await session.layout(800);
    await session.content(2000);
    await session.scroll(1200, 800, 2000);
    session.spyScroll();
    await session.together((events) => {
      if (scrollFirst) events.scroll(1200, 400, 2000);
      events.layout(400);
      if (!scrollFirst) events.scroll(1200, 400, 2000);
    });
    assert.equal(session.toEnd.calls, 1, scrollFirst ? "scroll event first" : "layout first");
    assert.equal(session.now().awayFromEnd, false);
    await act(async () => session.tree.unmount());
  }
});

test("a resize mid-drag is still the layout's, not the learner scrolling away", async () => {
  const session = await opened(projectView(fixture("chat_zzopenshort").messages));
  await session.layout(800);
  await session.content(2000);
  await session.scroll(1200, 800, 2000);
  session.spyScroll();
  // A finger is down at the end when the screen shrinks, and its scroll event comes first.
  await act(async () => { session.now().scrollProps.onScrollBeginDrag(); });
  await session.together((events) => {
    events.scroll(1200, 400, 2000);
    events.layout(400);
  });
  assert.equal(session.toEnd.calls, 1);
  assert.equal(session.now().awayFromEnd, false, "no Scroll to end button");
  await act(async () => session.tree.unmount());
});

test("a closed transcript's picture window leaves nothing pending", async () => {
  const window = new MathWindow();
  let calls = 0;
  window.add({ batch: "newest", y: 0, height: 50, measured: true, pictures: 1, wanted: false, committed: false, farSince: undefined,
    setLive: () => { calls++; }, measure: () => {} } as Parameters<MathWindow["add"]>[0]);
  window.setBatch("newest", { y: 0, height: 50 });
  window.setView(0, 800, 50);
  window.moved(0, -5);
  window.dispose();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(calls, 0, "no frame or timer ran after it closed");
});

test("a reply that gets shorter never makes batches overlap or show a message twice", async () => {
  const name = `shrinkreply${run}`;
  const reply = (paragraphs: number) => assistant("a1", Array.from({ length: paragraphs }, (_, index) => `Part ${index} $s_{${name}${index}}$.`).join("\n\n"));
  const messages = (paragraphs: number) => [user("u0", "Go"), reply(paragraphs), user("u2", "More"), assistant("a3", "Last $z$ here.")];
  const long = projectView(messages(50));
  const short = projectView(messages(35));
  // An older batch boundary inside the reply at paragraph 40, the newest batch at the next question.
  const batches: Batch[] = [
    { id: "oldest", start: { message: 0, item: 0 }, placed: true },
    { id: "older", start: { message: 1, item: 40 }, placed: true },
    { id: "newest", start: { message: 2, item: 0 }, placed: true },
  ];
  assert.equal(fitBatches(long, batches), batches, "nothing moves while everything fits");
  const fitted = fitBatches(short, batches);
  // The older batch collapses onto the newest and, holding nothing, goes.
  assert.deepEqual(fitted.map(({ id, start }) => [id, start]), [["oldest", { message: 0, item: 0 }], ["newest", { message: 2, item: 0 }]]);
  // Each message once, in order, as with no batches at all.
  const reading = (tree: ReactTestRenderer) => strings(tree.root).join("");
  const whole = await render(transcript({ settled: short }));
  const split = await render(transcript({ settled: short, batches: [...fitted] }));
  assert.equal(reading(split), reading(whole));
  // No start may pass the one after it, whatever was there before.
  const crossed = fitBatches(short, [
    { id: "a", start: { message: 0, item: 0 }, placed: true },
    { id: "b", start: { message: 3, item: 0 }, placed: true },
    { id: "c", start: { message: 2, item: 0 }, placed: true },
  ]);
  assert.deepEqual(crossed.map(({ id, start }) => [id, start]), [["a", { message: 0, item: 0 }], ["c", { message: 2, item: 0 }]]);
});

test("a shrink leaves no blank gap where a batch's old height was", async () => {
  const name = `gap${run}`;
  const reply = (paragraphs: number) => assistant("a1", Array.from({ length: paragraphs }, (_, index) => `Part ${index} $g_{${name}${index}}$.`).join("\n\n"));
  const messages = (paragraphs: number) => [user("u0", "Go"), reply(paragraphs), user("u2", "More"), assistant("a3", "Last $z$ here.")];
  // Placed at the heights their content had: 900 and 600 points.
  const batches: Batch[] = [
    { id: "older-0-0", start: { message: 0, item: 0 }, placed: true, height: 900 },
    { id: "older-1-40", start: { message: 1, item: 40 }, placed: true, height: 600 },
    { id: "newest", start: { message: 2, item: 0 }, placed: true },
  ];
  const short = projectView(messages(35));
  const fitted = fitBatches(short, batches);
  // Nothing is left holding a height for content that is gone, and no batch is empty.
  assert.ok(fitted.every((batch) => batch.height === undefined), "heights go back to what the content takes");
  const tree = await render(transcript({ settled: short, batches: [...fitted] }));
  const boxes = tree.root.findAll((node) => is(node, "View") && [node.props.style].flat(3).some((style) => typeof style?.minHeight === "number"));
  assert.equal(boxes.length, 0, "no box keeps an old height");
  for (const view of tree.root.children.filter((child): child is ReactTestInstance => typeof child !== "string")) {
    assert.ok(view.children.length > 0, "every batch shown holds messages");
  }
});

test("a resting finger near the end is never pulled to it, however long it rests", async () => {
  const session = await opened(projectView(fixture("chat_zzopenshort").messages));
  await session.layout(800);
  await session.content(2000);
  await session.scroll(1200, 800, 2000);
  session.spyScroll();
  await act(async () => { session.now().scrollProps.onScrollBeginDrag(); });
  // 50 points up, within the 100 that count as the end, then the finger rests past the idle time.
  await session.scroll(1150, 800, 2000);
  await wait(400);
  await session.content(2100);
  await wait(10);
  assert.equal(session.toEnd.calls, 0, "nothing moves under the finger");
  // Once the finger lifts there, the reply growing is followed again.
  await act(async () => { session.now().scrollProps.onScrollEndDrag(); });
  await session.content(2200);
  await wait(10);
  assert.equal(session.toEnd.calls, 1);
  await act(async () => session.tree.unmount());
});

test("a drag away while content grows is the learner leaving the end, in either event order", async () => {
  for (const contentFirst of [false, true]) {
    const session = await opened(projectView(fixture("chat_zzopenshort").messages));
    await session.layout(800);
    await session.content(2000);
    await session.scroll(1200, 800, 2000);
    session.spyScroll();
    await act(async () => { session.now().scrollProps.onScrollBeginDrag(); });
    // The finger moves 200 up as the reply below grows by 100.
    await session.together((events) => {
      if (contentFirst) events.content(2100);
      events.scroll(1000, 800, 2100);
      if (!contentFirst) events.content(2100);
    });
    await wait(10);
    assert.equal(session.now().awayFromEnd, true, contentFirst ? "content first" : "scroll first");
    assert.equal(session.toEnd.calls, 0, "nothing pulls it back under the finger");
    await act(async () => session.tree.unmount());
  }
});

test("closing the transcript leaves its picture window with nothing to do", async () => {
  const session = await opened(projectView(fixture("chat_zzopenshort").messages));
  await session.layout(800);
  await session.content(2000);
  const window = session.now().mathWindow;
  let updates = 0;
  const update = window.update.bind(window);
  window.update = () => { updates++; update(); };
  // Unmounting runs every block's cleanup too, each of which would ask for another look.
  await act(async () => session.tree.unmount());
  await sleep(300);
  assert.equal(updates, 0);
});

test("a transcript cut short while it opens still lands and shows what is left", async () => {
  const settled = projectView(fixture("chat_zzopenlong").messages);
  const session = await opened(settled);
  await session.layout(800);
  // A rewind leaves only the first message before the opening has landed.
  await session.update({ settled: settled.slice(0, 1) });
  for (let tries = 0; tries < 100 && !at(session.now().batches[0], 0); tries++) await wait(20);
  assert.ok(at(session.now().batches[0], 0), "the newest batch starts within what is left");
  await session.batch("newest", { y: 16, height: 100 });
  await session.content(132);
  await session.scroll(0, 800, 132);
  for (let tries = 0; tries < 100 && !session.now().shown; tries++) await wait(20);
  assert.equal(session.now().shown, true);
  await act(async () => session.tree.unmount());
});

test("pictures mounted ahead of a fling are freed once the scrolling stops", async () => {
  const window = new MathWindow();
  const live = new Map<number, boolean>();
  for (let y = 0; y < 20000; y += 100) {
    window.add({ batch: "newest", y, height: 50, measured: true, pictures: 1, wanted: false, committed: false, farSince: undefined,
      setLive: (value: boolean) => { live.set(y, value); }, measure: () => {} } as Parameters<MathWindow["add"]>[0]);
  }
  window.setBatch("newest", { y: 0, height: 20000 });
  window.setView(15000, 1000, 20000);
  window.moved(15000, -5);
  for (let frame = 0; frame < 10; frame++) window.update();
  // Beyond the three screens kept around the screen, the start and the end, so only the
  // look-ahead mounted them.
  const ahead = () => [...live].filter(([y, value]) => value && y >= 11000 && y < 11900).length;
  assert.ok(ahead() > 0, "mounted ahead while moving");
  // No more scroll events: the screen has stopped.
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(ahead(), 0, "freed once still");
});

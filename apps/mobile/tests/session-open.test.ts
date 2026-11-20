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
import { smallSession, transcriptVisibility, useSessionOpening, type Batch } from "../src/session-open.ts";
import { markdownTexts, Snapshot, SNAPSHOT_HEIGHT, snapshotBox, Transcript } from "../src/Transcript.tsx";
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
  for (let tries = 0; tries < 250 && session.now().batches[0]?.start !== 0; tries++) await wait(20);
  assert.equal(session.now().batches[0]?.start, 0);
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

test("nothing joins the newest batch while landing, and it shows two frames after landing with its pictures in", async () => {
  const session = await opened(coldSession("landing", 30, 12));
  for (let tries = 0; tries < 250 && session.now().batches[0]?.start === 60; tries++) await wait(20);
  await session.layout(800);
  await session.batch("newest", { y: 16, height: 984 });
  await session.content(1000);
  // Landing, 50 short of the end.
  await session.scroll(150, 800, 1000);
  const start = session.now().batches[0]?.start;
  await wait(400);
  assert.equal(session.now().batches[0]?.start, start, "no message is added while landing");
  assert.equal(session.now().shown, false);
  // Landed with the pictures on screen already in: shown once two frames have passed.
  await session.scroll(200, 800, 1000);
  assert.equal(session.now().shown, false);
  await wait(100);
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
  for (let tries = 0; tries < 250 && session.now().batches[0]?.start === 60; tries++) await wait(20);
  await session.layout(800);
  await session.batch("newest", { y: 16, height: 4984 });
  await session.content(5000);
  // A scroll far from the end, as one arriving with new content and an old offset would say.
  await session.scroll(0, 800, 5000);
  assert.equal(session.now().shown, false);
  session.spyScroll();
  await session.content(5200);
  assert.equal(session.toEnd.calls, 1);
  await act(async () => session.tree.unmount());
});

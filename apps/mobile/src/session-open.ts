// Opening a session at its latest message with nothing half-drawn
// (docs/specs/mobile-session-open.md). A small session shows whole in its first frame.
// Otherwise the transcript is added newest first, a few paragraphs at a time (a long reply is
// split between its top-level blocks, Transcript.tsx messageSegments), each once its math is
// drawn and so sized, while the transcript stays hidden until it has landed at the end with
// the pictures on screen mounted (T3 ThreadFeed.tsx hides its feed until it has landed). So
// only the last screen's math is drawn before it shows. Older content then fills in above in
// batches, each measured out of the flow first and placed at a whole number of pixels, so
// maintainVisibleContentPosition keeps what is on screen exactly still. While the learner
// drags or flings, drawing takes shorter turns, so the pictures coming into view get the JS
// thread.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import {
  PixelRatio, Platform, useWindowDimensions,
  type LayoutChangeEvent, type LayoutRectangle, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView,
} from "react-native";
import type { LhViewMessage } from "../../../src/core/view.ts";
import { drawEquation, drawFrom, equationsIn, queueOf, type DrawQueue } from "./message-math";
import { MathWindow } from "./math-window";
import { markdownTexts, messageSegments, type Position, type Segment } from "./Transcript";
import { space } from "./theme";

/** How long one drawing step may hold the JS thread, so taps and Back still get through:
 * longer while the session is hidden, shorter once it can be scrolled, and shortest while the
 * learner drags or flings it. */
const SLICE_MS = { hidden: 100, shown: 60, scrolling: 12 };
/** A batch holds at most this many segments (Transcript.tsx), and stops before passing this
 * many equations (a bigger segment goes alone), so no single commit is long. While hidden the
 * newest batch grows by smaller steps, so it stops soon after it fills the screen. */
const SEGMENTS_PER_BATCH = 60;
const EQUATIONS_PER_BATCH = { hidden: 40, shown: 80 };
/** Once shown, an older batch gathers drawn segments for at most this long before it is added. */
const GATHER_MS = 1500;
/** A session with at most this many equations is drawn at once and shows whole in its first frame. */
const SMALL_SESSION_EQUATIONS = 60;
/** The transcript's content padding (Session.tsx's contentContainerStyle, s.section): where
 * an older batch lands. */
const CONTENT_TOP = space.lg;
/** "At the end" is within this of the bottom: the follow rule's and the Scroll to end button's. */
export const NEAR_END = 100;
/** Landed means within this of the end (T3 ThreadFeed.tsx's 2 point rule). */
const LANDED = 2;
/** Once the latest messages are drawn, the session shows anyway after this (T3's fallback). */
const SHOW_ANYWAY_MS = 1000;
/** Android starts a newly mounted ScrollView here, clamped to its end, before its first frame. */
const AT_END = { x: 0, y: 1e7 };
/** A drag or fling counts as over once no scroll event has come for this long, even if its
 * end event never arrives. */
const SCROLL_IDLE_MS = 250;

const ORIGIN: Position = { message: 0, item: 0 };
const same = (one: Position, two: Position) => one.message === two.message && one.item === two.item;

/** The segment that ends at `at`, where it starts and whose message it is, or undefined at
 * the transcript's start or when `at` is past a transcript that has since shrunk (a rewind or
 * retry removed messages while it filled in). */
export function segmentBefore(settled: readonly LhViewMessage[], at: Position): { start: Position; segment: Segment; id: string } | undefined {
  if (at.item > 0) {
    const current = settled[at.message];
    if (!current) return;
    const segment = messageSegments(current).segments.findLast(({ from }) => from < at.item);
    if (segment) return { start: { message: at.message, item: segment.from }, segment, id: current.id };
  }
  const message = settled[at.message - 1];
  if (!message || at.message > settled.length) return;
  const segment = messageSegments(message).segments.at(-1) as Segment;
  return { start: { message: at.message - 1, item: segment.from }, segment, id: message.id };
}

/** Whether a position is past the end of the transcript, or past the items of its message. */
const beyond = (settled: readonly LhViewMessage[], at: Position) => at.message > settled.length
  || (at.message === settled.length && at.item > 0)
  || (at.message < settled.length && at.item > messageSegments(settled[at.message] as LhViewMessage).items.length);

const before = (one: Position, two: Position) => one.message < two.message || (one.message === two.message && one.item < two.item);

/** Batches whose starts fit the transcript as it is now. A start past the end of its message
 * (a reply that got shorter) or of the transcript moves to the next message's start, and no
 * start may pass the one after it, so the batches never overlap and stay in order. The same
 * array when nothing needs to move. */
export function fitBatches(settled: readonly LhViewMessage[], batches: readonly Batch[]): readonly Batch[] {
  let changed = false;
  let limit: Position = { message: settled.length, item: 0 };
  const fitted = [...batches];
  for (let index = fitted.length - 1; index >= 0; index--) {
    const batch = fitted[index] as Batch;
    let start = beyond(settled, batch.start) ? { message: Math.min(batch.start.message + 1, settled.length), item: 0 } : batch.start;
    if (before(limit, start)) start = limit;
    if (!same(start, batch.start)) {
      fitted[index] = { ...batch, start };
      changed = true;
    }
    limit = start;
  }
  return changed ? fitted : batches;
}

/** Where a batch being gathered has got to: its start so far, and what it holds. */
export interface Gathered { next: Position; equations: number; count: number }

/** One turn of drawing, newest first: draws the segments before `gathered.next` until the
 * deadline, moving it back past each one drawn. `full` once the batch can take no more (or
 * the start is reached), `ended` when nothing is left before it. At least one equation is
 * drawn a turn, and no new segment starts after the deadline. */
export function drawTurn(settled: readonly LhViewMessage[], gathered: Gathered, most: number, deadline: number,
  drawing: { current: { id: string; queue: DrawQueue } | null }, now: () => number = () => performance.now()): { full: boolean; ended: boolean } {
  let drew = false;
  while (gathered.count < SEGMENTS_PER_BATCH) {
    // A turn ends at its deadline between segments too, so short ones can't run on past it.
    if (drew && now() >= deadline) return { full: false, ended: false };
    const before = segmentBefore(settled, gathered.next);
    if (!before) return { full: true, ended: true };
    const size = before.segment.equations.length;
    if (gathered.count > 0 && gathered.equations + size > most) return { full: true, ended: false };
    // Progress is kept by message, so messages added or removed meanwhile can't mix it up.
    const id = `${before.id}:${before.start.item}`;
    if (drawing.current?.id !== id) drawing.current = { id, queue: queueOf(before.segment.equations) };
    drew = true;
    if (!drawFrom(drawing.current.queue, deadline, now)) return { full: false, ended: false };
    drawing.current = null;
    gathered.equations += size;
    gathered.next = before.start;
    gathered.count++;
  }
  return { full: true, ended: false };
}

/** The transcript from `start` up to the next batch's start. The newest batch runs to the end
 * and takes new messages as they arrive. An older batch is measured before it is placed. */
export interface Batch {
  id: string;
  start: Position;
  /** The whole-pixel height it is placed at, once measured. */
  height?: number;
  placed: boolean;
}

type Phase = "drawing" | "landing" | "shown";

/** A measured height rounded up to whole pixels. Layout reports it rounded to the nearest
 * pixel, so one more pixel always holds the content. */
const wholePixels = (size: number) => (Math.round(size * PixelRatio.get()) + 1) / PixelRatio.get();

/** Whether a session is small enough to draw now and show whole in its first frame. */
export function smallSession(settled: readonly LhViewMessage[]) {
  let equations = 0;
  for (let index = settled.length - 1; index >= 0; index--) {
    for (const text of markdownTexts(settled[index] as LhViewMessage)) {
      equations += equationsIn(text).length;
      if (equations > SMALL_SESSION_EQUATIONS) return false;
    }
  }
  return true;
}

/** The hidden transcript is invisible, takes no touches or scrolling, and is out of the
 * screen reader's reach, until it has landed. */
export function transcriptVisibility(hidden: boolean) {
  return {
    style: { opacity: hidden ? 0 : 1 },
    pointerEvents: hidden ? "none" as const : "auto" as const,
    scrollEnabled: !hidden,
    accessibilityElementsHidden: hidden,
    importantForAccessibility: hidden ? "no-hide-descendants" as const : "auto" as const,
  };
}

/** The transcript's scroll state while a session opens. Mount the ScrollView only once the
 * session's record is in (`loaded`), so Android can start it at the end. `tailTexts` is the
 * reply streaming in, whose finished math is drawn ahead of time. */
export function useSessionOpening(settled: readonly LhViewMessage[], loaded: boolean, tailTexts: readonly string[]) {
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  /** The mounted ScrollView's size and scroll, and whether it has reported its own. */
  const metrics = useRef({ content: 0, viewport: 0, offset: 0, sized: false, measured: false });
  const { fontScale } = useWindowDimensions();
  /** Whether the transcript keeps to its end. Only the learner's own scrolling changes it, so
   * a rotation, a font change or content above moving the scroll position never does. */
  const nearEnd = useRef(true);
  /** The sizes the last scroll event reported: one with other sizes comes from a layout change. */
  const lastScroll = useRef({ content: 0, viewport: 0 });
  /** Whether the learner is dragging or flinging the transcript. */
  const scrolling = useRef(false);
  const scrollIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mathWindow] = useState(() => new MathWindow());
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [phase, setPhase] = useState<Phase>("drawing");
  const [small, setSmall] = useState(false);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const [width, setWidth] = useState(0);
  const phaseNow = useRef<Phase>(phase);
  const filling = useRef({ loaded: false, all: false });
  /** Where the newest batch starts, and how much content sat below that at the last size
   * change. Placing an older batch moves both; only growth below it (the newest messages, the
   * streaming reply) is followed, since maintainVisibleContentPosition keeps the rest still. */
  const newestTop = useRef(0);
  const below = useRef(0);
  const deciding = useRef(false);
  /** An older batch measured before its blocks were, placed once they are. */
  const placing = useRef<{ id: string; height: number } | null>(null);
  /** Set once landing has taken a second: then the scroll may be off the end, but what is on
   * screen must still have its pictures. */
  const landingLate = useRef(false);
  /** Set by a commit that changes which messages show, until the ScrollView reports the
   * content size that commit gave it: until then the scroll metrics describe the old content. */
  const awaitingContent = useRef(false);
  /** The frames being waited before showing, so the pictures paint before the reveal. */
  const settling = useRef<number | null>(null);
  /** The message being drawn and how far it has got. */
  const drawing = useRef<{ id: string; queue: DrawQueue } | null>(null);
  const tail = useRef(tailTexts);
  const widthNow = useRef(0);

  if (loaded && batches === null) {
    const whole = smallSession(settled);
    setSmall(whole);
    setBatches([{ id: "newest", start: whole ? ORIGIN : { message: settled.length, item: 0 }, placed: true }]);
    // Android's first frame is already at the end; iOS lands a frame later.
    if (whole) setPhase(Platform.OS === "android" ? "shown" : "landing");
  }
  // A rewind, retry or shorter reply leaves no batch starting past what is there, so filling in
  // (and landing) goes on over what is left, and no message shows twice.
  if (batches) {
    const fitted = fitBatches(settled, batches);
    if (fitted !== batches) setBatches([...fitted]);
  }
  const end = useMemo(() => ({ message: settled.length, item: 0 }), [settled.length]);
  const first = batches?.[0]?.start ?? end;
  const measuring = batches?.some((batch) => !batch.placed) ?? false;

  useLayoutEffect(() => {
    phaseNow.current = phase;
    filling.current = { loaded: batches !== null, all: same(first, ORIGIN) };
    tail.current = tailTexts;
    mathWindow.setStartImmediate(phase === "shown");
    // While the transcript is drawn hidden its scroll position isn't its last one yet, so no
    // picture mounts until it has landed (check releases it then).
    if (phase === "drawing") mathWindow.setHold(true);
    if (phase === "shown" || small) mathWindow.setHold(false);
  });

  // The ScrollView mounts again once the record is in: nothing the old one reported counts.
  useLayoutEffect(() => {
    metrics.current = { content: 0, viewport: 0, offset: 0, sized: false, measured: false };
    nearEnd.current = true;
    newestTop.current = 0;
    below.current = 0;
    mathWindow.setView(0, 0, 0);
  }, [loaded, mathWindow]);

  // Placed heights fit the old width and text size; after a rotation or a font change the
  // batches take their natural heights again.
  const clearHeights = useCallback(() => {
    setBatches((current) => current?.some((batch) => batch.height !== undefined)
      ? current.map((batch) => batch.height === undefined ? batch : { ...batch, height: undefined }) : current);
  }, []);
  const scale = useRef(fontScale);
  useEffect(() => {
    if (scale.current === fontScale) return;
    scale.current = fontScale;
    clearHeights();
  }, [fontScale, clearHeights]);

  // Newest first: draw the next segments' math in slices, then add them. While hidden they
  // join the newest batch after every slice, so it stops soon after it fills the screen. Once
  // shown they gather over several slices into an older batch, so fewer batches are measured
  // and placed. Nothing is added while landing, so the end it lands on stays the end. While the
  // learner drags or flings, drawing goes on in short slices, so the pictures coming into view
  // get the JS thread first.
  useEffect(() => {
    if (!batches || same(first, ORIGIN) || measuring || phase === "landing") return;
    let timer: ReturnType<typeof setTimeout>;
    const gathered: Gathered = { next: first, equations: 0, count: 0 };
    const started = performance.now();
    const step = () => {
      const shown = phaseNow.current === "shown";
      const moving = shown && scrolling.current;
      const deadline = performance.now() + (moving ? SLICE_MS.scrolling : shown ? SLICE_MS.shown : SLICE_MS.hidden);
      const most = shown ? EQUATIONS_PER_BATCH.shown : EQUATIONS_PER_BATCH.hidden;
      const turn = drawTurn(settled, gathered, most, deadline, drawing);
      // Nothing before it (the transcript shrank under it): wait for the next change.
      const { next } = gathered;
      if (turn.ended && same(next, first)) return;
      const ready = !same(next, first) && (!shown || turn.full || performance.now() - started >= GATHER_MS);
      if (!ready) {
        timer = setTimeout(step, 0);
        return;
      }
      setBatches((current) => {
        if (!current) return current;
        if (phaseNow.current !== "shown") return current.map((batch, index) => index === 0 ? { ...batch, start: next } : batch);
        return [{ id: `older-${next.message}-${next.item}`, start: next, placed: false }, ...current];
      });
    };
    timer = setTimeout(step, 0);
    return () => clearTimeout(timer);
  }, [batches, first, measuring, settled, phase]);

  const placedCount = batches?.filter((batch) => batch.placed).length ?? 0;
  useLayoutEffect(() => {
    awaitingContent.current = true;
    const timer = setTimeout(() => { awaitingContent.current = false; }, 500);
    return () => clearTimeout(timer);
  }, [first.message, first.item, placedCount]);

  // The streaming reply's finished paragraphs, drawn while it streams so the settled reply
  // swaps in with its math already drawn. One timer reads the latest text, since the reply
  // changes faster than it ticks. The last paragraph may still be mid-equation.
  const streaming = tailTexts.length > 0;
  useEffect(() => {
    if (phase !== "shown" || !streaming) return;
    const done = new Set<string>();
    const timer = setInterval(() => {
      const deadline = performance.now() + 16;
      for (const text of tail.current) {
        for (const equation of equationsIn(text.slice(0, Math.max(0, text.lastIndexOf("\n\n"))))) {
          const key = `${equation.display}${equation.tex}`;
          if (done.has(key)) continue;
          if (performance.now() >= deadline) return;
          drawEquation(equation);
          done.add(key);
        }
      }
    }, 50);
    return () => clearInterval(timer);
  }, [phase, streaming]);

  const distance = () => metrics.current.content - metrics.current.viewport - metrics.current.offset;

  /** Ready to land once the newest messages fill the screen or every message is in; shown
   * once landed at the end with the pictures on screen mounted. */
  const check = useCallback(() => {
    // Away from the end only by the learner's own scrolling, so content filling in above,
    // whose scroll event comes a moment after its new size, never flashes the button.
    const away = !nearEnd.current;
    setAwayFromEnd((current) => current === away ? current : away);
    const { content, viewport, sized, measured } = metrics.current;
    // Only this ScrollView's own size and content size count.
    if (!sized || !measured) return;
    if (phaseNow.current === "landing") {
      // Landed (or late): the pictures on screen there may mount. Short of the end, scroll
      // again, in case a scroll before the last content change didn't reach it.
      const landed = !awaitingContent.current && distance() <= LANDED;
      if (landed || landingLate.current) mathWindow.setHold(false);
      else if (!awaitingContent.current) scroller.current?.scrollToEnd({ animated: false });
    }
    if (phaseNow.current === "drawing" && filling.current.loaded && (filling.current.all || (viewport > 0 && content >= viewport))) {
      phaseNow.current = "landing";
      setPhase("landing");
    }
    // Shown once landed (or landing has taken a second) with the pictures on screen in,
    // still so two frames later, so they have painted before the transcript appears.
    const ready = () => phaseNow.current === "landing" && !awaitingContent.current
      && (distance() <= LANDED || landingLate.current) && mathWindow.pendingOnScreen() === 0;
    if (!ready() || settling.current !== null) return;
    settling.current = requestAnimationFrame(() => {
      settling.current = requestAnimationFrame(() => {
        settling.current = null;
        if (!ready()) return;
        phaseNow.current = "shown";
        setPhase("shown");
      });
    });
  }, [mathWindow]);

  /** Places a measured older batch at the top. The window mounts its first screen in the same
   * commit, so a status-bar tap to the new start never meets empty boxes. */
  const place = useCallback((id: string, height: number) => {
    mathWindow.setMeasuring(id, false);
    mathWindow.setBatch(id, { y: CONTENT_TOP, height });
    mathWindow.mountBatch(id);
    mathWindow.update();
    setBatches((current) => current?.map((each) => each.id === id ? { ...each, placed: true, height } : each) ?? current);
  }, [mathWindow]);

  useEffect(() => () => {
    if (settling.current !== null) cancelAnimationFrame(settling.current);
  }, []);

  useEffect(() => mathWindow.subscribe(() => {
    check();
    const waiting = placing.current;
    if (waiting && mathWindow.measuredAll(waiting.id)) {
      placing.current = null;
      place(waiting.id, waiting.height);
    }
  }), [mathWindow, check, place]);

  /** A drag or fling began, or goes on, until the transcript has been still a moment. */
  const scrollMoving = useCallback(() => {
    scrolling.current = true;
    if (scrollIdle.current !== null) clearTimeout(scrollIdle.current);
    scrollIdle.current = setTimeout(() => {
      scrollIdle.current = null;
      scrolling.current = false;
    }, SCROLL_IDLE_MS);
  }, []);

  useEffect(() => {
    mathWindow.open();
    return () => {
      if (scrollIdle.current !== null) clearTimeout(scrollIdle.current);
      mathWindow.dispose();
    };
  }, [mathWindow]);

  // Layout and scroll events move it on too; this catches a commit with no new layout.
  useEffect(() => {
    const frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [check, first, batches]);

  useEffect(() => {
    if (phase !== "landing") return;
    nearEnd.current = true;
    landingLate.current = false;
    scroller.current?.scrollToEnd({ animated: false });
    const frame = requestAnimationFrame(check);
    const timer = setTimeout(() => {
      landingLate.current = true;
      scroller.current?.scrollToEnd({ animated: false });
      check();
    }, SHOW_ANYWAY_MS);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [phase, check]);

  const onScroll = useCallback(({ nativeEvent: { contentOffset, layoutMeasurement, contentSize, velocity } }: NativeSyntheticEvent<NativeScrollEvent>) => {
    // The screen's new size can come with a scroll event before onLayout reports it.
    const resized = metrics.current.sized && Math.abs(layoutMeasurement.height - metrics.current.viewport) >= 0.5;
    metrics.current = { content: contentSize.height, viewport: layoutMeasurement.height, offset: contentOffset.y, sized: true, measured: true };
    mathWindow.setView(contentOffset.y, layoutMeasurement.height, contentSize.height);
    // A scroll that came with new sizes was the layout's (a rotation, content above, a font
    // change), not the learner's: it leaves keeping to the end as it was.
    const sameScreen = Math.abs(layoutMeasurement.height - lastScroll.current.viewport) < 0.5;
    const sized = sameScreen && Math.abs(contentSize.height - lastScroll.current.content) < 0.5;
    lastScroll.current = { content: contentSize.height, viewport: layoutMeasurement.height };
    // A new screen size is never the learner, even mid-drag. New content is, during a drag:
    // the finger moved too.
    if (sized || (sameScreen && scrolling.current)) nearEnd.current = distance() < NEAR_END;
    if (scrolling.current) scrollMoving();
    if (sized) mathWindow.moved(contentOffset.y, Platform.OS === "android" ? velocity?.y : undefined);
    // A rotation or the keyboard changed the screen: at the end it stays at the end.
    if (resized && nearEnd.current) scroller.current?.scrollToEnd({ animated: false });
    check();
  }, [check, mathWindow, scrollMoving]);

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    metrics.current.content = height;
    metrics.current.measured = true;
    awaitingContent.current = false;
    mathWindow.setView(metrics.current.offset, metrics.current.viewport, height);
    // Decided once the layouts of the same change have all arrived.
    if (!deciding.current) {
      deciding.current = true;
      queueMicrotask(() => {
        deciding.current = false;
        const now = metrics.current.content - newestTop.current;
        const grew = Math.abs(now - below.current) > 0.5;
        below.current = now;
        // While hidden the transcript always keeps to the end it is landing on.
        // Never under the learner's finger: a drag or fling decides where it ends up.
        if (grew && ((nearEnd.current && !scrolling.current) || phaseNow.current !== "shown")) scroller.current?.scrollToEnd({ animated: false });
      });
    }
    check();
  }, [check, mathWindow]);

  const onLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const resized = metrics.current.sized && Math.abs(nativeEvent.layout.height - metrics.current.viewport) >= 0.5;
    metrics.current.viewport = nativeEvent.layout.height;
    metrics.current.sized = true;
    mathWindow.setView(metrics.current.offset, nativeEvent.layout.height);
    // A rotation or the keyboard changed the screen: at the end it stays at the end.
    if (resized && nearEnd.current) scroller.current?.scrollToEnd({ animated: false });
    check();
  }, [check, mathWindow]);

  /** A batch's layout: the newest gives the width older ones are measured at, and a measured
   * batch is placed at its height rounded up to whole pixels. */
  const onBatchLayout = useCallback((batch: Batch, layout: LayoutRectangle) => {
    if (batch.id === "newest" && layout.width !== widthNow.current) {
      if (widthNow.current) clearHeights();
      widthNow.current = layout.width;
      setWidth(layout.width);
    }
    if (!batch.placed) {
      const height = wholePixels(layout.height);
      if (mathWindow.measuredAll(batch.id)) return place(batch.id, height);
      // Its blocks' measurements haven't arrived: placed when they have.
      placing.current = { id: batch.id, height };
      mathWindow.measureBatch(batch.id);
      return;
    }
    if (batch.id === "newest") newestTop.current = layout.y;
    mathWindow.setBatch(batch.id, { y: layout.y, height: layout.height });
  }, [mathWindow, clearHeights, place]);

  /** The Scroll to end button. From far up it first jumps to a screen short of the end, where
   * the pictures are always in (math-window.ts keeps the end's), and animates only the rest:
   * flying through the whole session would pass every equation too fast to draw. */
  const scrollToEnd = useCallback((animated: boolean) => {
    nearEnd.current = true;
    const { content, viewport } = metrics.current;
    if (animated && distance() > 2 * viewport) {
      scroller.current?.scrollTo({ y: Math.max(0, content - 2 * viewport), animated: false });
      requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: true }));
    } else scroller.current?.scrollToEnd({ animated });
  }, []);

  return {
    batches: batches ?? [],
    /** Older batches are measured this wide, the newest batch's width. */
    width,
    onBatchLayout,
    /** Whether a batch's blocks that mount from now on show their pictures at once. */
    eager: (batch: Batch) => small || (batch.id === "newest" ? phase === "shown" : batch.placed),
    shown: phase === "shown",
    /** "Loading session…" shows until the transcript does, except for a small session on
     * Android, whose first frame is already the transcript at its end. */
    loading: phase !== "shown" && !(small && Platform.OS === "android"),
    awayFromEnd: phase === "shown" && awayFromEnd,
    scrollToEnd,
    mathWindow,
    scrollProps: {
      ref: scroller,
      onScroll,
      onContentSizeChange,
      onLayout,
      scrollEventThrottle: 16,
      contentOffset: Platform.OS === "android" ? AT_END : undefined,
      onScrollBeginDrag: scrollMoving,
      onMomentumScrollBegin: scrollMoving,
      // The status-bar tap leaves the end.
      onScrollToTop: () => { nearEnd.current = false; },
      // Content added above leaves what is on screen where it is.
      maintainVisibleContentPosition: { minIndexForVisible: 0 },
    },
  };
}

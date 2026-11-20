// Opening a session at its latest message with nothing half-drawn
// (docs/specs/mobile-session-open.md). A small session shows whole in its first frame.
// Otherwise messages are added newest first, each once its math is drawn and so sized, while
// the transcript stays hidden until it has landed at the end with the pictures on screen
// mounted (T3 ThreadFeed.tsx hides its feed until it has landed). Older messages then fill in
// above in batches, each measured out of the flow first and placed at a whole number of
// pixels, so maintainVisibleContentPosition keeps what is on screen exactly still.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef } from "react";
import {
  PixelRatio, Platform, useWindowDimensions,
  type LayoutChangeEvent, type LayoutRectangle, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView,
} from "react-native";
import type { LhViewMessage } from "../../../src/core/view.ts";
import { drawEquation, drawFrom, drawQueue, equationsIn, type DrawQueue } from "./message-math";
import { MathWindow } from "./math-window";
import { markdownTexts } from "./Transcript";
import { space } from "./theme";

/** How long one drawing step may hold the JS thread, so taps and Back still get through:
 * longer while the session is hidden, shorter once it can be scrolled. */
const SLICE_MS = { hidden: 100, shown: 40 };
/** A batch holds at most this many messages, and stops before passing this many equations
 * (a bigger message goes alone), so no single commit is long. */
const MESSAGES_PER_BATCH = 8;
const EQUATIONS_PER_BATCH = 120;
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

/** Messages from `start` up to the next batch's start. The newest batch runs to the end and
 * takes new messages as they arrive. An older batch is measured before it is placed. */
export interface Batch {
  id: string;
  start: number;
  /** The whole-pixel height it is placed at, once measured. */
  height?: number;
  placed: boolean;
}

type Phase = "drawing" | "landing" | "shown";

const equationCount = (message: LhViewMessage) => markdownTexts(message).reduce((sum, text) => sum + equationsIn(text).length, 0);
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
  const nearEnd = useRef(true);
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
    setBatches([{ id: "newest", start: whole ? 0 : settled.length, placed: true }]);
    // Android's first frame is already at the end; iOS lands a frame later.
    if (whole) setPhase(Platform.OS === "android" ? "shown" : "landing");
  }
  const first = batches?.[0]?.start ?? settled.length;
  const measuring = batches?.some((batch) => !batch.placed) ?? false;

  useLayoutEffect(() => {
    phaseNow.current = phase;
    filling.current = { loaded: batches !== null, all: first === 0 };
    tail.current = tailTexts;
    mathWindow.setStartImmediate(phase === "shown");
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

  // Newest first: draw the next messages' math in slices, then add them. While hidden they
  // join the newest batch; once shown they come in as an older batch, one at a time. Nothing
  // is added while landing, so the end it lands on stays the end.
  useEffect(() => {
    if (!batches || first === 0 || measuring || phase === "landing") return;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const deadline = performance.now() + (phaseNow.current === "shown" ? SLICE_MS.shown : SLICE_MS.hidden);
      let next = first;
      let equations = 0;
      while (next > 0 && first - next < MESSAGES_PER_BATCH) {
        const message = settled[next - 1];
        if (!message) break;
        const count = equationCount(message);
        if (next < first && equations + count > EQUATIONS_PER_BATCH) break;
        if (drawing.current?.id !== message.id) drawing.current = { id: message.id, queue: drawQueue(markdownTexts(message)) };
        if (!drawFrom(drawing.current.queue, deadline)) break;
        drawing.current = null;
        equations += count;
        next--;
      }
      if (next === first) {
        timer = setTimeout(step, 0);
        return;
      }
      setBatches((current) => {
        if (!current) return current;
        if (phaseNow.current !== "shown") return current.map((batch, index) => index === 0 ? { ...batch, start: next } : batch);
        return [{ id: `older-${next}`, start: next, placed: false }, ...current];
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
  }, [first, placedCount]);

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
    const away = distance() > NEAR_END;
    setAwayFromEnd((current) => current === away ? current : away);
    const { content, viewport, sized, measured } = metrics.current;
    // Only this ScrollView's own size and content size count.
    if (!sized || !measured) return;
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
      check();
    }, SHOW_ANYWAY_MS);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [phase, check]);

  const onScroll = useCallback(({ nativeEvent: { contentOffset, layoutMeasurement, contentSize } }: NativeSyntheticEvent<NativeScrollEvent>) => {
    metrics.current = { content: contentSize.height, viewport: layoutMeasurement.height, offset: contentOffset.y, sized: true, measured: true };
    mathWindow.setView(contentOffset.y, layoutMeasurement.height, contentSize.height);
    nearEnd.current = distance() < NEAR_END;
    check();
  }, [check, mathWindow]);

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
        if (grew && (nearEnd.current || phaseNow.current !== "shown")) scroller.current?.scrollToEnd({ animated: false });
      });
    }
    check();
  }, [check, mathWindow]);

  const onLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    metrics.current.viewport = nativeEvent.layout.height;
    metrics.current.sized = true;
    mathWindow.setView(metrics.current.offset, nativeEvent.layout.height);
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

  const scrollToEnd = useCallback((animated: boolean) => {
    nearEnd.current = true;
    scroller.current?.scrollToEnd({ animated });
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
      // Content added above leaves what is on screen where it is.
      maintainVisibleContentPosition: { minIndexForVisible: 0 },
    },
  };
}

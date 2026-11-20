// Opening a session at its latest message with nothing half-drawn
// (docs/specs/mobile-session-open.md). A small session shows whole in its first frame.
// Otherwise messages are added newest first, each once its math is drawn and so sized, while
// the transcript stays hidden until it has landed at the end with the pictures on screen
// mounted (T3 ThreadFeed.tsx hides its feed until it has landed). Older messages then fill in
// above in batches, each measured out of the flow first and placed at a whole number of
// pixels, so maintainVisibleContentPosition keeps what is on screen exactly still.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef } from "react";
import { PixelRatio, Platform, type LayoutChangeEvent, type LayoutRectangle, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView } from "react-native";
import type { LhViewMessage } from "../../../src/core/view.ts";
import { drawUntil, equationsIn, isDrawn } from "./message-math";
import { MathWindow } from "./math-window";
import { markdownTexts } from "./Transcript";

/** How long one drawing step may hold the JS thread, so taps and Back still get through:
 * longer while the session is hidden, shorter once it can be scrolled. */
const SLICE_MS = { hidden: 100, shown: 40 };
/** A batch holds at most this many messages, and stops before passing this many equations
 * (a bigger message goes alone), so no single commit is long. */
const MESSAGES_PER_BATCH = 8;
const EQUATIONS_PER_BATCH = 120;
/** A session shows whole in its first frame when it has at most this many equations, and
 * at most this many still to draw. */
const SMALL_SESSION_EQUATIONS = 60;
const SMALL_SESSION_UNDRAWN = 20;
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
  let undrawn = 0;
  for (let index = settled.length - 1; index >= 0; index--) {
    for (const text of markdownTexts(settled[index] as LhViewMessage)) {
      for (const equation of equationsIn(text)) {
        equations++;
        if (!isDrawn(equation)) undrawn++;
        if (equations > SMALL_SESSION_EQUATIONS || undrawn > SMALL_SESSION_UNDRAWN) return false;
      }
    }
  }
  return true;
}

/** The transcript's scroll state while a session opens. Mount the ScrollView only once the
 * session's record is in (`loaded`), so Android can start it at the end. `tailTexts` is the
 * reply streaming in, whose finished math is drawn ahead of time. */
export function useSessionOpening(settled: readonly LhViewMessage[], loaded: boolean, tailTexts: readonly string[]) {
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const metrics = useRef({ content: 0, viewport: 0, offset: 0 });
  const nearEnd = useRef(true);
  const [mathWindow] = useState(() => new MathWindow());
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [phase, setPhase] = useState<Phase>("drawing");
  const [small, setSmall] = useState(false);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const [width, setWidth] = useState(0);
  const phaseNow = useRef<Phase>(phase);
  const filling = useRef({ loaded: false, all: false });
  /** Set when an older batch was just placed, so the follow rule leaves the scroll to
   * maintainVisibleContentPosition: a second correction a frame later moved it by a pixel. */
  const placed = useRef(false);

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
  });

  // Newest first: draw the next messages' math in slices, then add them. While hidden they
  // join the newest batch; once shown they come in as an older batch, one at a time.
  useEffect(() => {
    if (!batches || first === 0 || measuring) return;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const deadline = performance.now() + (phaseNow.current === "shown" ? SLICE_MS.shown : SLICE_MS.hidden);
      let next = first;
      let equations = 0;
      while (next > 0 && first - next < MESSAGES_PER_BATCH) {
        const message = settled[next - 1] as LhViewMessage;
        const count = equationCount(message);
        if (next < first && equations + count > EQUATIONS_PER_BATCH) break;
        if (!drawUntil(markdownTexts(message), deadline)) break;
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
  }, [batches, first, measuring, settled]);

  // The streaming reply's finished paragraphs, drawn while it streams so the settled reply
  // swaps in with its math already drawn. The last paragraph may still be mid-equation.
  useEffect(() => {
    const texts = tailTexts.map((text) => text.slice(0, Math.max(0, text.lastIndexOf("\n\n")))).filter(Boolean);
    if (phase !== "shown" || !texts.length) return;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => { if (!drawUntil(texts, performance.now() + 16)) timer = setTimeout(step, 50); };
    timer = setTimeout(step, 50);
    return () => clearTimeout(timer);
  }, [tailTexts, phase]);

  const distance = () => metrics.current.content - metrics.current.viewport - metrics.current.offset;

  /** Ready to land once the newest messages fill the screen or every message is in; shown
   * once landed at the end with the pictures on screen mounted. */
  const check = useCallback(() => {
    const away = distance() > NEAR_END;
    setAwayFromEnd((current) => current === away ? current : away);
    const { content, viewport } = metrics.current;
    if (phaseNow.current === "drawing" && filling.current.loaded && (filling.current.all || (viewport > 0 && content >= viewport))) {
      phaseNow.current = "landing";
      setPhase("landing");
    }
    if (phaseNow.current === "landing" && distance() <= LANDED && mathWindow.pendingOnScreen() === 0) {
      phaseNow.current = "shown";
      setPhase("shown");
    }
  }, [mathWindow]);

  useEffect(() => mathWindow.subscribe(check), [mathWindow, check]);

  // Layout and scroll events move it on too; this catches a commit with no new layout.
  useEffect(() => {
    const frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [check, first, batches]);

  useEffect(() => {
    if (phase !== "landing") return;
    scroller.current?.scrollToEnd({ animated: false });
    const frame = requestAnimationFrame(check);
    const timer = setTimeout(() => {
      if (phaseNow.current !== "landing") return;
      phaseNow.current = "shown";
      setPhase("shown");
    }, SHOW_ANYWAY_MS);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [phase, check]);

  const onScroll = useCallback(({ nativeEvent: { contentOffset, layoutMeasurement, contentSize } }: NativeSyntheticEvent<NativeScrollEvent>) => {
    metrics.current = { content: contentSize.height, viewport: layoutMeasurement.height, offset: contentOffset.y };
    mathWindow.setView(contentOffset.y, layoutMeasurement.height, contentSize.height);
    nearEnd.current = distance() < NEAR_END;
    check();
  }, [check, mathWindow]);

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    metrics.current.content = height;
    mathWindow.setView(metrics.current.offset, metrics.current.viewport, height);
    if (nearEnd.current && !placed.current) scroller.current?.scrollToEnd({ animated: false });
    placed.current = false;
    check();
  }, [check, mathWindow]);

  const onLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    metrics.current.viewport = nativeEvent.layout.height;
    mathWindow.setView(metrics.current.offset, nativeEvent.layout.height);
    check();
  }, [check, mathWindow]);

  /** A batch's layout: the newest gives the width older ones are measured at, and a measured
   * batch is placed at its height rounded up to whole pixels. */
  const onBatchLayout = useCallback((batch: Batch, layout: LayoutRectangle) => {
    if (batch.id === "newest") setWidth((current) => current === layout.width ? current : layout.width);
    if (!batch.placed) {
      mathWindow.setBatch(batch.id, undefined);
      const height = wholePixels(layout.height);
      setBatches((current) => current?.map((each) => each.id === batch.id ? { ...each, placed: true, height } : each) ?? current);
      return;
    }
    mathWindow.setBatch(batch.id, { y: layout.y, height: layout.height });
  }, [mathWindow]);

  // The frame an older batch moves into place, its content change is maintainVisibleContentPosition's.
  const placedCount = batches?.filter((batch) => batch.placed).length ?? 0;
  const placedBefore = useRef(placedCount);
  useLayoutEffect(() => {
    if (placedCount > placedBefore.current && phaseNow.current === "shown") placed.current = true;
    placedBefore.current = placedCount;
  }, [placedCount]);

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
    /** "Loading session…" shows while a session too big to show at once is drawn. */
    loading: !small && phase !== "shown",
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

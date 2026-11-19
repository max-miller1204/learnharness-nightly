// Opening a session at its latest message with nothing half-drawn
// (docs/specs/mobile-session-open.md). Messages are shown newest first, each only once its
// math is drawn and so sized, while the transcript stays hidden until it has landed at the
// end with the pictures on screen mounted. Older messages then fill in above without moving
// what is on screen.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from "react-native";
import type { LhViewMessage } from "../../../src/core/view.ts";
import { drawUntil, equationsIn } from "./message-math";
import { MathWindow } from "./math-window";
import { markdownTexts } from "./Transcript";

/** How long one drawing step may hold the JS thread, so taps and Back still get through:
 * longer while the session is hidden, shorter once it can be scrolled. */
export const SLICE_MS = { hidden: 100, shown: 40 };
/** One step adds at most this many messages, or past this many equations stops adding
 * (a bigger message still goes alone), so no single commit is long. */
const MESSAGES_PER_STEP = 8;
const EQUATIONS_PER_STEP = 120;
/** "At the end" is within this of the bottom: the follow rule and the Scroll to end button's. */
export const NEAR_END = 100;
/** Landed means within this of the end (T3 ThreadFeed.tsx's 2 point rule). */
const LANDED = 2;
/** Once the latest messages are drawn, the session shows anyway after this (T3's fallback). */
const SHOW_ANYWAY_MS = 1000;

export type OpeningTrace = (event: string, data: Record<string, unknown>) => void;

export function useSessionOpening(settled: readonly LhViewMessage[], loaded: boolean, trace?: OpeningTrace) {
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const metrics = useRef({ content: 0, viewport: 0, offset: 0 });
  const nearEnd = useRef(true);
  const [from, setFrom] = useState<number | null>(null);
  const [phase, setPhase] = useState<"drawing" | "landing" | "shown">("drawing");
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const [mathWindow] = useState(() => new MathWindow());
  const phaseNow = useRef(phase);
  const ready = useRef({ loaded: false, all: false });
  /** Set when older messages were just added, so the follow rule leaves the scroll to
   * maintainVisibleContentPosition: two corrections a frame apart moved it by a pixel. */
  const prepended = useRef(false);
  if (loaded && from === null) setFrom(settled.length);
  const start = from === null ? settled.length : Math.min(from, settled.length);

  const asked = useRef(0);
  useLayoutEffect(() => {
    if (!asked.current) return;
    trace?.("commit", { start, ms: Math.round(performance.now() - asked.current) });
    if (phaseNow.current === "shown") prepended.current = true;
  }, [start, trace]);

  // Newest first: draw a message's math in slices, then add it with any drawn ones before it.
  useEffect(() => {
    if (from === null || start === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const began = performance.now();
      const deadline = began + (phaseNow.current === "shown" ? SLICE_MS.shown : SLICE_MS.hidden);
      let next = start;
      let equations = 0;
      while (next > 0 && start - next < MESSAGES_PER_STEP && (next === start || equations < EQUATIONS_PER_STEP)) {
        const texts = markdownTexts(settled[next - 1] as LhViewMessage);
        const count = texts.reduce((sum, text) => sum + equationsIn(text).length, 0);
        if (next < start && equations + count > EQUATIONS_PER_STEP) break;
        if (!drawUntil(texts, deadline)) break;
        equations += count;
        next--;
      }
      trace?.("step", { start, next, ms: Math.round(performance.now() - began) });
      if (next < start) {
        asked.current = performance.now();
        setFrom(next);
      } else timer = setTimeout(step, 0);
    };
    timer = setTimeout(step, 0);
    return () => clearTimeout(timer);
  }, [from, start, settled, trace]);

  const distance = () => metrics.current.content - metrics.current.viewport - metrics.current.offset;
  useLayoutEffect(() => {
    phaseNow.current = phase;
    ready.current = { loaded: from !== null, all: start === 0 };
  });

  /** Moves the opening on from what is known now: ready to land once the newest messages
   * fill the screen or every message is in, shown once landed at the end. */
  const check = useCallback(() => {
    const away = distance() > NEAR_END;
    setAwayFromEnd((current) => current === away ? current : away);
    const { content, viewport } = metrics.current;
    if (phaseNow.current === "drawing" && ready.current.loaded && (ready.current.all || (viewport > 0 && content >= viewport))) {
      phaseNow.current = "landing";
      trace?.("ready", { ...metrics.current });
      setPhase("landing");
    }
    if (phaseNow.current === "landing" && distance() <= LANDED && mathWindow.pendingOnScreen() === 0) {
      phaseNow.current = "shown";
      trace?.("shown", { reason: "landed", distance: distance(), ...metrics.current });
      setPhase("shown");
    }
  }, [trace, mathWindow]);

  useEffect(() => mathWindow.subscribe(check), [mathWindow, check]);

  // Layout events move it on too; this catches what a commit changed with no new layout.
  useEffect(() => {
    const frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [check, start, from]);

  useEffect(() => {
    if (phase !== "landing") return;
    scroller.current?.scrollToEnd({ animated: false });
    const frame = requestAnimationFrame(check);
    const timer = setTimeout(() => {
      if (phaseNow.current !== "landing") return;
      phaseNow.current = "shown";
      trace?.("shown", { reason: "fallback", distance: distance(), ...metrics.current });
      setPhase("shown");
    }, SHOW_ANYWAY_MS);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [phase, check, trace]);

  const onScroll = useCallback(({ nativeEvent: { contentOffset, layoutMeasurement, contentSize } }: NativeSyntheticEvent<NativeScrollEvent>) => {
    metrics.current = { content: contentSize.height, viewport: layoutMeasurement.height, offset: contentOffset.y };
    mathWindow.setView(contentOffset.y, layoutMeasurement.height);
    nearEnd.current = distance() < NEAR_END;
    check();
  }, [check, mathWindow]);

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    metrics.current.content = height;
    if (nearEnd.current && !prepended.current) scroller.current?.scrollToEnd({ animated: false });
    prepended.current = false;
    check();
    trace?.("content", { ...metrics.current });
  }, [check, trace]);

  const onLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    metrics.current.viewport = nativeEvent.layout.height;
    mathWindow.setView(metrics.current.offset, nativeEvent.layout.height);
    check();
  }, [check, mathWindow]);

  const scrollToEnd = useCallback((animated: boolean) => {
    nearEnd.current = true;
    scroller.current?.scrollToEnd({ animated });
  }, []);

  return {
    /** The first settled message shown. */
    from: start,
    shown: phase === "shown",
    awayFromEnd: phase === "shown" && awayFromEnd,
    scrollToEnd,
    mathWindow,
    scrollProps: {
      ref: scroller,
      onScroll,
      onContentSizeChange,
      onLayout,
      scrollEventThrottle: 16,
      // Content added above leaves what is on screen where it is.
      maintainVisibleContentPosition: { minIndexForVisible: 0 },
    },
  };
}

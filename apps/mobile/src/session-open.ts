// Opening a session at its latest message with nothing half-drawn
// (docs/specs/mobile-session-open.md). Messages are shown newest first, each only once its
// math is drawn, while the transcript stays hidden until it has landed at the end. Older
// messages then fill in above without moving what is on screen.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from "react-native";
import type { LhViewMessage } from "../../../src/core/view.ts";
import { drawUntil } from "./message-math";
import { markdownTexts } from "./Transcript";

/** How long one drawing step may hold the JS thread, so taps and Back still get through. */
export const SLICE_MS = 48;
/** At most this many messages are added in one step, so no single commit is long. */
const MESSAGES_PER_STEP = 8;
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
  if (loaded && from === null) setFrom(settled.length);
  const start = from === null ? settled.length : Math.min(from, settled.length);

  const asked = useRef(0);
  useLayoutEffect(() => {
    if (asked.current) trace?.("commit", { start, ms: Math.round(performance.now() - asked.current) });
  }, [start, trace]);

  // Newest first: draw a message's math in slices, then add it with any drawn ones before it.
  useEffect(() => {
    if (from === null || start === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const began = performance.now();
      const deadline = began + SLICE_MS;
      let next = start;
      while (next > 0 && start - next < MESSAGES_PER_STEP && drawUntil(markdownTexts(settled[next - 1] as LhViewMessage), deadline)) next--;
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
  const phaseNow = useRef(phase);
  const ready = useRef({ loaded: false, all: false });
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
    if (phaseNow.current === "landing" && distance() <= LANDED) {
      phaseNow.current = "shown";
      trace?.("shown", { reason: "landed", distance: distance(), ...metrics.current });
      setPhase("shown");
    }
  }, [trace]);

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
    nearEnd.current = distance() < NEAR_END;
    check();
  }, [check]);

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    metrics.current.content = height;
    if (nearEnd.current) scroller.current?.scrollToEnd({ animated: false });
    check();
    trace?.("content", { ...metrics.current });
  }, [check, trace]);

  const onLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    metrics.current.viewport = nativeEvent.layout.height;
    check();
  }, [check]);

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

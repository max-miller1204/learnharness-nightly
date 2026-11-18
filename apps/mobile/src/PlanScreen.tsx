import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { BackHandler, Text, View, type GestureResponderEvent } from "react-native";
import { blockLayout, GLOW_REACH } from "../../../src/core/plan-layout.ts";
import type { LhViewMessage } from "../../../src/core/view.ts";
import { fitView, fitZoomFor, livePlan, zoomView, type View as Viewport } from "./lesson";
import { PlanDiagram } from "./PlanDiagram";
import { Button } from "./ui";
import { radius, space, useTheme } from "./theme";

type Touch = { pageX: number; pageY: number };
const spread = (a: Touch, b: Touch) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);

/** The live plan (plan-block.tsx PlanPopup): the latest tree with statuses
 * derived now, the current node glowing. Fully zoomed out is the fit; pinch
 * zooms, drag pans once zoomed in, and the buttons step or re-fit. */
export function PlanScreen({ messages, close }: { messages: readonly LhViewMessage[]; close: () => void }) {
  const { c, s } = useTheme();
  const plan = useMemo(() => livePlan(messages), [messages]);
  const layout = useMemo(() => plan ? blockLayout(plan.tree.nodes, plan.tree.edges) : null, [plan]);
  const box = useMemo(() => layout ? { w: layout.width + 2 * GLOW_REACH, h: layout.height + 2 * GLOW_REACH } : { w: 0, h: 0 }, [layout]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const adjusted = useRef(false);
  const frame = useRef<ComponentRef<typeof View>>(null);
  const origin = useRef({ x: 0, y: 0 });
  const live = useRef({ view, box, size });
  useEffect(() => { live.current = { view, box, size }; });
  const floor = fitZoomFor(box, size);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { close(); return true; });
    return () => subscription.remove();
  }, [close]);

  // Re-fit whenever the plan or the screen changes, until the learner moves it.
  useEffect(() => {
    if (!adjusted.current && size.w && size.h) setView(fitView(box, size));
  }, [box, size]);

  const gesture = useRef<{ start: Viewport; page: Touch; pinch?: { distance: number; view: Viewport } } | null>(null);
  const begin = (touch: Touch) => { gesture.current = { start: live.current.view, page: { pageX: touch.pageX, pageY: touch.pageY } }; };
  function move(event: GestureResponderEvent) {
    const current = gesture.current;
    if (!current) return;
    const touches = event.nativeEvent.touches;
    const { box: content, size: viewport } = live.current;
    if (touches.length >= 2) {
      const [a, b] = [touches[0]!, touches[1]!];
      const distance = spread(a, b);
      if (!current.pinch) current.pinch = { distance, view: live.current.view };
      const focus = { x: (a.pageX + b.pageX) / 2 - origin.current.x, y: (a.pageY + b.pageY) / 2 - origin.current.y };
      setView(zoomView(current.pinch.view, distance / Math.max(1, current.pinch.distance), focus, content, viewport));
      adjusted.current = true;
      return;
    }
    const touch = touches[0] ?? event.nativeEvent;
    // Lifting one finger of a pinch starts a fresh drag from where the pinch left off.
    if (current.pinch) { begin(touch); return; }
    if (current.start.zoom <= fitZoomFor(content, viewport) + 1e-9) return;
    setView({ ...current.start, x: current.start.x + touch.pageX - current.page.pageX, y: current.start.y + touch.pageY - current.page.pageY });
    adjusted.current = true;
  }

  const step = (factor: number) => {
    adjusted.current = true;
    setView((value) => zoomView(value, factor, { x: size.w / 2, y: size.h / 2 }, box, size));
  };
  const refit = () => { adjusted.current = false; setView(fitView(box, size)); };

  return (
    <View style={{ flex: 1 }}>
      <View style={s.bar}>
        <Button variant="ghost" label="Back to the session" onPress={close} style={{ width: 36, paddingHorizontal: 0 }}>
          <Text style={[s.ui, { fontSize: 20, lineHeight: 24 }]}>‹</Text>
        </Button>
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={s.heading}>The plan</Text>
          <Text style={s.meta}>live: statuses derive from your check outcomes</Text>
        </View>
      </View>
      <View ref={frame}
        onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderTerminationRequest={() => false}
        onResponderGrant={({ nativeEvent }) => begin(nativeEvent)} onResponderMove={move}
        onResponderRelease={() => { gesture.current = null; }} onResponderTerminate={() => { gesture.current = null; }}
        onLayout={({ nativeEvent }) => {
          setSize({ w: nativeEvent.layout.width, h: nativeEvent.layout.height });
          frame.current?.measure((_x, _y, _w, _h, pageX, pageY) => { origin.current = { x: pageX, y: pageY }; });
        }}
        style={{ flex: 1, margin: space.md, overflow: "hidden", borderRadius: radius.lg, borderCurve: "continuous", borderWidth: 1, borderColor: c.border }}>
        {plan ? (
          <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, transformOrigin: [0, 0, 0],
            opacity: size.w ? 1 : 0, transform: [{ translateX: view.x }, { translateY: view.y }, { scale: view.zoom }] }}>
            <PlanDiagram nodes={plan.tree.nodes} edges={plan.tree.edges} statusOf={plan.statusOf} glowId={plan.current} pad={GLOW_REACH} />
          </View>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={s.muted}>No plan in this session yet.</Text></View>
        )}
      </View>
      {plan && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.md }}>
          <Text style={[s.meta, { flex: 1 }]}>Drag to pan · pinch to zoom</Text>
          <Button label="Zoom out" disabled={view.zoom <= floor + 1e-9} onPress={() => step(1 / 1.25)} style={{ width: 40, paddingHorizontal: 0 }}>−</Button>
          <Button label="Fit plan to screen" onPress={refit} style={{ width: 40, paddingHorizontal: 0 }}>⤢</Button>
          <Button label="Zoom in" onPress={() => step(1.25)} style={{ width: 40, paddingHorizontal: 0 }}>+</Button>
        </View>
      )}
    </View>
  );
}

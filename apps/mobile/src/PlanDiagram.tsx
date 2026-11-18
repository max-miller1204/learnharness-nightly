import { useMemo } from "react";
import Svg, { Defs, FeGaussianBlur, Filter, G, Path, Rect, Text as SvgText } from "react-native-svg";
import type { PlanNodeStatus } from "../../../src/core/contracts/plan.ts";
import {
  ARROW_HEAD, GLOW_BLUR, GLOW_MARGIN, HEAD_H, LINE_H, NODE_H, NODE_W_MIN, STROKE_W,
  blockLayout, edgePathD, wrapTitle, type PlanLayoutNode,
} from "../../../src/core/plan-layout.ts";
import { pathEnd } from "./lesson";
import { alpha, fonts, useTheme } from "./theme";

type Edge = { from: string; to: string };

/** The web plan diagram (components/plan-block.tsx PlanDiagram), drawn with
 * the same shared layout: boxes, curved edges, the arrowhead and the
 * current node's blurred yellow glow. `width` is the rendered width in px. */
export function PlanDiagram({ nodes, edges, statusOf, glowId, monochrome, pad, width }: {
  nodes: readonly PlanLayoutNode[]; edges: readonly Edge[]; statusOf: (id: string) => PlanNodeStatus;
  glowId?: string | null; monochrome?: boolean; pad: number; width?: number;
}) {
  const { c } = useTheme();
  const layout = useMemo(() => blockLayout(nodes, edges), [nodes, edges]);
  const vbW = Math.max(layout.width, 1) + 2 * pad;
  const vbH = Math.max(layout.height, 1) + 2 * pad;
  const ox = (layout.originX ?? 0) - pad, oy = (layout.originY ?? 0) - pad;
  const renderW = width ?? vbW;
  const headScale = HEAD_H / 104;
  const box = (status: PlanNodeStatus) => monochrome ? { fill: c.card, stroke: c.text }
    : status === "upcoming" ? { fill: c.card, stroke: c.border } : { fill: alpha(c.background, 0.5), stroke: c.text };
  const ink = (status: PlanNodeStatus) => monochrome || status !== "upcoming" ? c.text : alpha(c.muted, 0.8);
  return (
    <Svg width={renderW} height={(renderW * vbH) / vbW} viewBox={`${ox} ${oy} ${vbW} ${vbH}`} accessibilityLabel="Plan diagram" accessibilityRole="image">
      <Defs>
        <Filter id="plan-glow" x="-60%" y="-60%" width="220%" height="220%">
          <FeGaussianBlur stdDeviation={GLOW_BLUR} />
        </Filter>
      </Defs>
      {edges.map((edge) => {
        const points = layout.edgePts.get(`${edge.from}->${edge.to}`);
        if (!points) return null;
        const tx = layout.x.get(edge.to), ty = layout.y.get(edge.to);
        const target = tx !== undefined && ty !== undefined
          ? { x: tx, y: ty, w: layout.nodeW.get(edge.to) ?? NODE_W_MIN, h: layout.nodeH.get(edge.to) ?? NODE_H } : undefined;
        const d = edgePathD(points, target);
        const end = pathEnd(d);
        const dim = !monochrome && (statusOf(edge.from) === "upcoming" || statusOf(edge.to) === "upcoming");
        const color = dim ? c.border : c.text;
        return (
          <G key={`${edge.from}->${edge.to}`}>
            <Path d={d} fill="none" stroke={color} strokeWidth={STROKE_W} />
            {end && <Path d={ARROW_HEAD} fill={color}
              transform={`translate(${end.x} ${end.y}) rotate(${end.angle}) scale(${headScale}) translate(-27.2 -52)`} />}
          </G>
        );
      })}
      {nodes.map((node) => {
        const status = statusOf(node.id);
        const lines = wrapTitle(node.title);
        const h = layout.nodeH.get(node.id) ?? NODE_H;
        const w = layout.nodeW.get(node.id) ?? NODE_W_MIN;
        const top = (h - lines.length * LINE_H) / 2 + 10;
        const { fill, stroke } = box(status);
        return (
          <G key={node.id} transform={`translate(${layout.x.get(node.id) ?? 0} ${layout.y.get(node.id) ?? 0})`}>
            <Rect width={w} height={h} fill={fill} stroke={stroke} strokeWidth={STROKE_W} />
            {node.id === glowId && !monochrome && <Rect x={-GLOW_MARGIN} y={-GLOW_MARGIN} width={w + 2 * GLOW_MARGIN} height={h + 2 * GLOW_MARGIN}
              fill="rgba(250, 204, 21, 0.25)" filter="url(#plan-glow)" />}
            {lines.map((line, i) => (
              <SvgText key={i} x={w / 2} y={top + i * LINE_H} textAnchor="middle" fontFamily={fonts.prose} fontSize={11}
                fontWeight={status === "current" && !monochrome ? "500" : "400"} fill={ink(status)}>{line}</SvgText>
            ))}
          </G>
        );
      })}
    </Svg>
  );
}

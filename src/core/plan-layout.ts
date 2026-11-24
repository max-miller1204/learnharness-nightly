/**
 * Pure DAG layout shared by web plan views and the mobile app. Imported by path
 * rather than through the core barrel so barrel importers do not pull in dagre
 * and d3.
 *
 * Callers supply `measure` so box dimensions match the active font and line
 * breaker (browser measurement on client, `chartMeasure` for SSR and first
 * paint so hydration markup matches before measurement).
 */

// The placement engine — literally mermaid's: dagre-d3-es, the fork
// mermaid 11 ships with (owner, plan-graph round 8: same engine as the
// mermaid graphs, our SVG skin stays). The deep subpath is how mermaid
// itself imports it.
// Only the graph and layout subpaths: the package root also loads its d3 renderer.
import * as graphlib from "dagre-d3-es/src/graphlib/index.js";
import { layout as dagreLayout } from "dagre-d3-es/src/dagre/index.js";
// Mermaid's default flowchart edge curve: dagre's waypoints drawn through
// d3's curveBasis (the exact recipe dagre-d3's own renderer uses).
import { curveBasis, line } from "d3-shape";
import type { PlanTree } from "./contracts.ts";

/** A node for layout purposes — the payload's shape and the tree's shape agree. */
export interface LayoutNode {
	id: string;
	title: string;
}
/** The phone's name for it (mobile follow-up 1). */
export type PlanLayoutNode = LayoutNode;

/** The label font's answers, all in px. `lines` breaks a title into lines
 *  no wider than `maxWidth` wherever possible (never inside a word);
 *  `width` measures one line; line height and the line cap derive from
 *  `fontSize`. */
export interface LabelMeasure {
	lines: (title: string, maxWidth: number) => string[];
	width: (line: string) => number;
	fontSize: number;
}

// ─── Box geometry ─────────────────────────────────────────────────────────────

/** Symmetric horizontal padding — EQUALS the vertical padding a single
 *  line gets in the minimum-height box (owner: "the horizontal padding
 *  should be the same as the vertical one"): (44 − 11) / 2 ≈ 16. */
export const PAD_X = 16;
/** Top/bottom padding around the text block: a 2-line box at 11px is
 *  2 × 13 + 2 × 9 = 44, the minimum height since the first plan round. */
const PAD_Y = 9;
export const NODE_W_MIN = 96;
/** Baseline-to-baseline distance as a multiple of the label font size
 *  (13px at 11px — the original LINE_H). */
const LINE_HEIGHT = 13 / 11;
/** Longest line before wrapping, as a multiple of the label font size
 *  (owner, #671 design: ≈140px at 11px — default-font boxes keep their
 *  look, wider fonts wrap onto more lines instead of widening the box).
 *  Exported: the browser's line breaker gets the same cap in CSS. */
export const MAX_LINE_EM = 12.75;
export const GAP_X = 24;
export const GAP_Y = 48;

/** The server's and first render's stand-in measure: per-character-CLASS
 *  rates least-squares-fitted against getComputedTextLength() of the live
 *  plan titles in Source Sans 3 at 11px (2026-10-07 smoke; residuals within
 *  ±4px per line), wrapping greedily at spaces. Only right for that font
 *  and spaced scripts — the browser replaces it with real line breaks and
 *  widths right after hydration. */
const NARROW_CHARS = new Set(" ijltfr.,:;'!|()[]-\\");
const WIDE_CHARS = new Set("mwMW@");
const CAP_DIGIT = /[A-Z0-9]/;
function chartWidth(text: string): number {
	let w = 0;
	for (const ch of text) {
		if (NARROW_CHARS.has(ch)) w += 3.1;
		else if (WIDE_CHARS.has(ch)) w += 9.2;
		else if (CAP_DIGIT.test(ch)) w += 6.0;
		else w += 5.4;
	}
	return w;
}
export const chartMeasure: LabelMeasure = {
	fontSize: 11,
	width: chartWidth,
	lines(title, maxWidth) {
		const lines: string[] = [];
		for (const word of title.trim().split(/\s+/)) {
			const last = lines[lines.length - 1];
			if (last !== undefined && chartWidth(`${last} ${word}`) <= maxWidth) lines[lines.length - 1] = `${last} ${word}`;
			else lines.push(word);
		}
		return lines;
	},
};

// ─── Placement ────────────────────────────────────────────────────────────────

/** Topological order + longest-path depth (Kahn, authoring tie-break) —
 *  order + depth semantics kept for tests; placement itself runs on dagre
 *  now (owner, round 8). */
export function topoFor(nodes: readonly LayoutNode[], edges: ReadonlyArray<{ from: string; to: string }>) {
	const index = new Map(nodes.map((n, i) => [n.id, i] as const));
	const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0] as const));
	const dependents = new Map<string, string[]>();
	for (const e of edges) {
		if (!index.has(e.from) || !index.has(e.to)) continue; // defensive: dangling ids
		indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
		const list = dependents.get(e.from);
		if (list) list.push(e.to);
		else dependents.set(e.from, [e.to]);
	}
	const ready = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
	const order: LayoutNode[] = [];
	const depth = new Map<string, number>();
	const byId = new Map(nodes.map((n) => [n.id, n] as const));
	while (ready.length > 0) {
		ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
		const id = ready.shift()!;
		const node = byId.get(id);
		if (node) order.push(node);
		const d = depth.get(id) ?? 0;
		depth.set(id, d);
		for (const t of dependents.get(id) ?? []) {
			if ((depth.get(t) ?? -1) < d + 1) depth.set(t, d + 1);
			const left = (indegree.get(t) ?? 0) - 1;
			indegree.set(t, left);
			if (left === 0) ready.push(t);
		}
	}
	for (const n of nodes) {
		if (!depth.has(n.id)) {
			order.push(n);
			depth.set(n.id, 0);
		}
	}
	return { order, depth };
}

/** The whole plan's geometry: wrapped label lines, box sizes, top-left
 *  positions, dagre's edge routes and the ink extent. */
export type PlanLayout = ReturnType<typeof blockLayout>;

/** Placement — dagre (mermaid's engine, owner round 8): Sugiyama-style
 *  layered layout, TB, with our geometry (text-first sized boxes,
 *  GAP_X/GAP_Y separations, zero margin — the caller adds its own pad).
 *  Each box hugs its measured, width-wrapped lines; dagre returns node
 *  CENTERS, we hand back top-lefts. Dangling edges are ignored defensively
 *  — a ghost endpoint would spawn an unmeasured node. */
export function blockLayout(
	nodes: readonly LayoutNode[],
	edges: ReadonlyArray<{ from: string; to: string }>,
	/** The phone can't measure its labels: it lays out with the chart stand-in. */
	measure: LabelMeasure = chartMeasure,
) {
	const x = new Map<string, number>();
	const y = new Map<string, number>();
	const nodeH = new Map<string, number>();
	const nodeW = new Map<string, number>();
	const lines = new Map<string, string[]>();
	const lineH = measure.fontSize * LINE_HEIGHT;
	/** Dagre's per-edge waypoint routes — each starts/ends at the node
	 *  border intersection on whatever SIDE the edge leaves/enters
	 *  (round 11: the mermaid line drawing). Keyed `${from}->${to}`. */
	const edgePts = new Map<string, Array<{ x: number; y: number }>>();
	if (nodes.length === 0) return { x, y, nodeH, nodeW, lines, lineH, fontSize: measure.fontSize, edgePts, originX: 0, originY: 0, width: 0, height: 0 };
	const ids = new Set(nodes.map((n) => n.id));
	const routed: Array<{ from: string; to: string }> = [];
	const g = new graphlib.Graph({ compound: false, multigraph: true });
	g.setGraph({ rankdir: "TB", nodesep: GAP_X, ranksep: GAP_Y, marginx: 0, marginy: 0 });
	const minH = 2 * lineH + 2 * PAD_Y;
	for (const n of nodes) {
		const wrapped = measure.lines(n.title, MAX_LINE_EM * measure.fontSize);
		const widest = Math.max(1, ...wrapped.map(measure.width));
		const w = Math.max(NODE_W_MIN, Math.ceil(widest) + 2 * PAD_X);
		const h = Math.max(minH, wrapped.length * lineH + 2 * PAD_Y);
		lines.set(n.id, wrapped);
		nodeW.set(n.id, w);
		nodeH.set(n.id, h);
		g.setNode(n.id, { width: w, height: h });
	}
	for (const e of edges) {
		if (ids.has(e.from) && ids.has(e.to)) {
			g.setEdge(e.from, e.to, { label: "", width: 0, height: 0 });
			routed.push(e);
		}
	}
	// (the d.ts marks opts required; the runtime ignores it)
	dagreLayout(g, undefined);
	for (const n of nodes) {
		const pos = g.node(n.id);
		if (pos) {
			x.set(n.id, pos.x - nodeW.get(n.id)! / 2);
			y.set(n.id, pos.y - nodeH.get(n.id)! / 2);
		}
	}
	for (const e of routed) {
		const pts: Array<{ x: number; y: number }> | undefined = g.edge(e.from, e.to)?.points;
		if (pts) edgePts.set(`${e.from}->${e.to}`, pts.map((pt) => ({ x: pt.x, y: pt.y })));
	}
	// THE CANVAS MUST COVER THE ARROWS (owner, 2026-10-10): dagre's
	// graph extent is the NODE bounding box — the edge curves drawn on
	// top can bow past it (cross-column edges' bezier control points;
	// measured 14–20px cut on the right in the owner's plans) and the
	// viewBox clipped them. The ink extent unions the node boxes with
	// every edge path's control-point hull: a bezier never leaves the
	// hull of its control points, and parsing the d-string edgePathD
	// builds (the SAME call the renderer makes, same inputs) bounds every
	// segment — M, L and C pairs alternate strictly, so even/odd matches
	// are x/y. Dagre's extent stays the FLOOR: plans whose arrows stay
	// inside keep byte-identical viewBoxes, and the origin only moves when
	// ink bulges past zero.
	let inkMinX = Infinity;
	let inkMinY = Infinity;
	let inkMaxX = -Infinity;
	let inkMaxY = -Infinity;
	const stretch = (px: number, py: number) => {
		if (px < inkMinX) inkMinX = px;
		if (py < inkMinY) inkMinY = py;
		if (px > inkMaxX) inkMaxX = px;
		if (py > inkMaxY) inkMaxY = py;
	};
	for (const n of nodes) {
		const nx = x.get(n.id);
		const ny = y.get(n.id);
		if (nx === undefined || ny === undefined) continue;
		stretch(nx, ny);
		stretch(nx + nodeW.get(n.id)!, ny + nodeH.get(n.id)!);
	}
	for (const e of routed) {
		const pts = edgePts.get(`${e.from}->${e.to}`);
		const tx = x.get(e.to);
		const ty = y.get(e.to);
		if (!pts) continue;
		const target = tx !== undefined && ty !== undefined ? { x: tx, y: ty, w: nodeW.get(e.to)!, h: nodeH.get(e.to)! } : undefined;
		const nums = edgePathD(pts, target).match(/-?\d+(?:\.\d+)?/g);
		if (!nums) continue;
		for (let i = 0; i + 1 < nums.length; i += 2) {
			stretch(parseFloat(nums[i]!), parseFloat(nums[i + 1]!));
		}
	}
	// Dagre coordinates start at 0; only ink past zero on the negative
	// side moves the origin (viewBox x/y shift with it).
	const originX = Math.min(0, inkMinX === Infinity ? 0 : inkMinX);
	const originY = Math.min(0, inkMinY === Infinity ? 0 : inkMinY);
	return {
		x,
		y,
		nodeH,
		nodeW,
		lines,
		lineH,
		fontSize: measure.fontSize,
		edgePts,
		originX,
		originY,
		width: Math.max((g.graph().width ?? 0) - originX, inkMaxX === -Infinity ? 0 : inkMaxX - originX, 1),
		height: Math.max((g.graph().height ?? 0) - originY, inkMaxY === -Infinity ? 0 : inkMaxY - originY, 1),
	};
}

// ─── Edge paths (the owner's arrowhead geometry) ──────────────────────────────

/** Lines + outlines run at the app's standard border weight (owner,
 *  2026-09-26 — same 1px the UI borders use; was 1.5). */
export const STROKE_W = 1;
/** The heads scale by the SAME factor the lines thinned by (owner,
 *  2026-09-26): 16 was the height tuned for 1.5-wide lines, so both sides
 *  of the head:shaft proportion shrink together — the LaTeX ratio (tail
 *  opening tucking the line flush) is preserved exactly, just smaller. */
export const HEAD_H = 16 * (STROKE_W / 1.5);
const HEAD_SCALE = HEAD_H / 104;
export const HEAD_W = 50.2 * HEAD_SCALE;
/** The drawn line terminates at the notch mouth (refX 27.2) — it never
 *  reaches the narrow tip, where it would show through (owner). The tip
 *  overhangs the line's end by this much, so edges shorten by it to land
 *  the tip exactly on the target node's border. */
const HEAD_TIP_OVERHANG = (50.2 - 27.2) * HEAD_SCALE;
/** The head floats this far off the target face — the tip kisses nothing
 *  (owner, round 12). ~half a head length: clearly docked-off, still
 *  visually attached. Scaled with the head (2026-09-26) so "half a head"
 *  stays true at the thinner lines. */
const DOCK_GAP = 4 * (STROKE_W / 1.5);
/** The shaft stub — the straight run before the head (owner, round 12):
 *  control points from Q on sit exactly on the approach line, so the
 *  basis spline renders that stretch perfectly straight and the head
 *  lands on a straight shaft; the corner where the route squares up onto
 *  the line is rounded by the curve. ~1.5 head lengths of shaft. */
const STRAIGHT_RUN = 12;
/** The tilt limit at the termination point, measured off the entry
 *  face's perpendicular: past ±40° one of the head's barbs crosses the
 *  tip's level and the silhouette breaks (owner measured it in
 *  Photoshop, round 14). The final run swings to the cone edge instead. */
const ENTRY_ANGLE_LIMIT = (40 * Math.PI) / 180;
const edgeLine = line<{ x: number; y: number }>()
	.x((p) => p.x)
	.y((p) => p.y)
	.curve(curveBasis);

/** The entry face's outward unit normal — whichever face of the target
 *  box dagre's border point sits on. Pure. */
function faceNormal(
	border: { x: number; y: number },
	box: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
	const d = { top: border.y - box.y, bottom: box.y + box.h - border.y, left: border.x - box.x, right: box.x + box.w - border.x };
	const face = (Object.keys(d) as Array<keyof typeof d>).reduce((a, b) => (d[a] <= d[b] ? a : b));
	switch (face) {
		case "top":
			return { x: 0, y: -1 };
		case "bottom":
			return { x: 0, y: 1 };
		case "left":
			return { x: -1, y: 0 };
		default:
			return { x: 1, y: 0 };
	}
}

/** The edge path — mermaid's own line drawing: dagre's border-intersected
 *  waypoints through d3's curveBasis (mermaid's default flowchart curve —
 *  the same recipe dagre-d3's renderer uses). The head docks off the
 *  target: its TIP floats DOCK_GAP past the border along the FACE NORMAL
 *  (constant gap at any tilt), its mouth sits at the path's end on a
 *  straight run (the shaft stub), and — when the target box is given —
 *  the entry direction is clamped to ±ENTRY_ANGLE_LIMIT of the face's
 *  perpendicular (owner, round 14): a steeper natural approach swings to
 *  the 40° cone edge instead of breaking the head's silhouette. Without
 *  a target box the unclamped geometry applies. Straight collinear
 *  routes render identically. Pure. */
export function edgePathD(
	points: Array<{ x: number; y: number }>,
	target?: { x: number; y: number; w: number; h: number },
): string {
	const pts = points.map((p) => ({ ...p }));
	if (pts.length >= 2) {
		const last = pts[pts.length - 1]!;
		const prev = pts[pts.length - 2]!;
		const dx = last.x - prev.x;
		const dy = last.y - prev.y;
		const len = Math.hypot(dx, dy) || 1;
		let ux = dx / len;
		let uy = dy / len;
		// The tip: DOCK_GAP outside the face along its normal (or along the
		// approach when no box is known).
		let tipx: number;
		let tipy: number;
		if (target) {
			const n = faceNormal(last, target);
			tipx = last.x + n.x * DOCK_GAP;
			tipy = last.y + n.y * DOCK_GAP;
			// Clamp the approach to the ±LIMIT cone around the normal: if
			// the outgoing direction -u tilts past ENTRY_ANGLE_LIMIT, swing
			// it to the cone edge (same rotation side as the route).
			const v = { x: -ux, y: -uy };
			const vn = v.x * n.x + v.y * n.y;
			if (vn < Math.cos(ENTRY_ANGLE_LIMIT)) {
				const t = { x: v.x - vn * n.x, y: v.y - vn * n.y };
				const tl = Math.hypot(t.x, t.y);
				const that = tl > 0 ? { x: t.x / tl, y: t.y / tl } : { x: -n.y, y: n.x };
				const c = Math.cos(ENTRY_ANGLE_LIMIT);
				const s = Math.sin(ENTRY_ANGLE_LIMIT);
				v.x = c * n.x + s * that.x;
				v.y = c * n.y + s * that.y;
				ux = -v.x;
				uy = -v.y;
			}
		} else {
			tipx = last.x - ux * DOCK_GAP;
			tipy = last.y - uy * DOCK_GAP;
		}
		// The mouth: overhang back from the tip along the (clamped) approach.
		const M = { x: tipx - ux * HEAD_TIP_OVERHANG, y: tipy - uy * HEAD_TIP_OVERHANG };
		// From Q the control points lie on the approach line — the basis
		// spline renders Q→M perfectly straight (a B-spline span with
		// collinear control points IS the line), and curveBasis's internal
		// endpoint repetition makes the end tangent exactly the approach
		// direction. NOTE: do NOT repeat M manually — a duplicated final
		// control point renders a zero-length last segment, and
		// orient="auto" on a zero-length segment falls back to 0° (every
		// head pointing right — the round-12 regression, fixed round 13).
		const Q = { x: M.x - ux * STRAIGHT_RUN, y: M.y - uy * STRAIGHT_RUN };
		pts.splice(pts.length - 1, 1, Q, M);
	}
	return edgeLine(pts) ?? "";
}

// ─── Shared drawing constants (the web block and the phone) ──────────────────

/** SVG-unit padding around the layout extent: strokes are centered on the
 *  geometry (half bleeds outside the extent) and the glow halo reaches −4 —
 *  without this pad the outermost node borders clip at the svg edge. */
export const GRAPH_PAD = 8;
/** The current node's yellow glow: a fill blurred so it bleeds over the
 *  node's edges (owner). A Gaussian's visible spread is ≈3σ, so the glow
 *  reaches GLOW_MARGIN + 3·GLOW_BLUR past the node — any surface that
 *  shows the glow must pad its viewBox by GLOW_REACH or the blur clips
 *  at the frame edge (owner: extend the container padding to fit it). */
export const GLOW_MARGIN = 8;
export const GLOW_BLUR = 5;
export const GLOW_REACH = GLOW_MARGIN + 3 * GLOW_BLUR;
/** The phone's in-transcript diagram scales up to fill the column but never
 *  past the chat prose size (16px over the 12.5px label size). */
export const TEXT_CAP_SCALE = 16 / 12.5;

// ─── The owner's arrowhead (plan-graph round 5) ──────────────────────────────

/** Baked from arrowhead_1.svg (the CM/MJX long-arrow head), transform chain
 *  collapsed: viewBox 0 0 50.2 104, tip at (50.2, 52), notch mouth at
 *  x 27.2 with a 9.6-tall opening — at full height 104 the tail opening
 *  is ≈10, per the owner's spec. Solid strong-ink fill, no padding. */
export const ARROW_HEAD = "M48,55.2C49.4,54.6 50.2,53.4 50.2,52C50.2,50.6 49.4,49.4 48,48.8C38.2,45.6 29.2,38.8 21,28.4C15.2,21.4 11.4,13.2 9.6,3.8C9,1.2 7.4,0 4.8,0C1.6,0 0,1.6 0,5L0.2,5.6C3.6,23 12.6,36.8 27.2,47.2L27.2,56.8C12.6,67.2 3.6,81 0.2,98.4L0,99C0,102.4 1.6,104 4.8,104C7.4,104 9,102.8 9.6,100.2C11.4,90.8 15.2,82.6 21,75.6C29.2,65.2 38.2,58.4 48,55.2Z";

// ─── The latest plan in a transcript ──────────────────────────────────────────

/** Minimal structural message slice (same trick as phases.ts). */
export interface PopupMessage {
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }>;
}

/** The latest plan tree in the transcript (latest tool-plan_ output). */
export function latestTree(messages: readonly PopupMessage[]): PlanTree | null {
	for (let m = messages.length - 1; m >= 0; m--) {
		const parts = messages[m]?.parts;
		if (!parts) continue;
		for (let p = parts.length - 1; p >= 0; p--) {
			const part = parts[p]!;
			if (!part.type.startsWith("tool-plan_") || part.state !== "output-available") continue;
			const output = part.output as { tree?: PlanTree } | undefined;
			if (output?.tree && Array.isArray(output.tree.nodes)) return output.tree;
		}
	}
	return null;
}

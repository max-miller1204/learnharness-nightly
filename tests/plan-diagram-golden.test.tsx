import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import {
	PlanBlock,
	PlanDiagram,
	PlanPopup,
	blockLayout,
	edgePathD,
	latestTree,
	nodeWidth,
	topoFor,
	wrapTitle,
	type PopupMessage,
} from "../components/plan-block.tsx";
import { PlanMarginalia } from "../components/plan-window.tsx";
import { derivePlanStatuses, derivedNodeStatus, type PlanBlockData, type PlanTree } from "../src/core/contracts.ts";

/**
 * THE PLAN DIAGRAM GOLDEN (mobile follow-up 1): the web and desktop plan
 * diagram must render exactly as before when its layout math became shared
 * with the phone. The golden file was recorded from the web plan code BEFORE
 * the move. Any difference in node positions, edge paths, statuses or the
 * rendered markup (pinned by hash) of the block, the live popup and the
 * marginalia fails here.
 * Record again (PLAN_GOLDEN_RECORD=1) only for an intended visual change.
 */
const GOLDEN = path.join(import.meta.dirname, "fixtures/plan-diagram-golden.json");
const render = (node: ReactNode) => renderMarkup(<InteractionLayersProvider>{node}</InteractionLayersProvider>);
/** Markup is pinned by hash (the geometry above it is pinned in full). */
const markup = (node: ReactNode) => {
	const html = render(node);
	return { length: html.length, sha256: createHash("sha256").update(html).digest("hex") };
};

const PLANS: Record<string, PlanTree> = {
	chain: {
		nodes: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }, { id: "c", title: "Gamma" }],
		edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
		version: 1,
	},
	diamond: {
		nodes: [
			{ id: "sets", title: "What a set is" },
			{ id: "union", title: "Unions and intersections" },
			{ id: "power", title: "Power sets" },
			{ id: "venn", title: "Venn diagrams and the inclusion-exclusion principle for two and three sets" },
		],
		edges: [{ from: "sets", to: "union" }, { from: "sets", to: "power" }, { from: "union", to: "venn" }, { from: "power", to: "venn" }],
		version: 2,
	},
	// Long words, a dangling edge and an isolated node: the defensive paths.
	ragged: {
		nodes: [
			{ id: "x", title: "Supercalifragilisticexpialidociousness and friends" },
			{ id: "y", title: "MWMW @@ wide glyphs 0123" },
			{ id: "z", title: "" },
			{ id: "lonely", title: "On its own" },
		],
		edges: [{ from: "x", to: "y" }, { from: "y", to: "z" }, { from: "x", to: "z" }, { from: "ghost", to: "x" }],
		version: 3,
	},
	// The owner's real linear-algebra plan (tests/plan-window.test.tsx): cross-column edges.
	linearAlgebra: {
		nodes: [
			{ id: "vector-space-axioms", title: "What a vector space is" },
			{ id: "span-basis-dimension", title: "Span, basis, dimension" },
			{ id: "matrix-as-map", title: "Matrices as maps" },
			{ id: "elimination-rank", title: "Elimination exposes rank" },
			{ id: "determinant-volume", title: "Det as volume scaling" },
			{ id: "orthogonality-complements", title: "Orthogonality and complements" },
			{ id: "projection-theorem", title: "The projection theorem" },
			{ id: "transpose-adjoint", title: "The transpose as bridge" },
			{ id: "normal-equations", title: "Least squares, normal equations" },
			{ id: "eigen-diagonalization", title: "Eigenvectors as coordinates" },
			{ id: "spectral-theorem", title: "The spectral theorem" },
			{ id: "pca-synthesis", title: "Goal: PCA and least-squares derivations" },
		],
		edges: [
			{ from: "span-basis-dimension", to: "matrix-as-map" },
			{ from: "matrix-as-map", to: "elimination-rank" },
			{ from: "matrix-as-map", to: "determinant-volume" },
			{ from: "matrix-as-map", to: "orthogonality-complements" },
			{ from: "span-basis-dimension", to: "orthogonality-complements" },
			{ from: "orthogonality-complements", to: "projection-theorem" },
			{ from: "orthogonality-complements", to: "transpose-adjoint" },
			{ from: "matrix-as-map", to: "transpose-adjoint" },
			{ from: "projection-theorem", to: "normal-equations" },
			{ from: "transpose-adjoint", to: "normal-equations" },
			{ from: "matrix-as-map", to: "normal-equations" },
			{ from: "determinant-volume", to: "eigen-diagonalization" },
			{ from: "matrix-as-map", to: "eigen-diagonalization" },
			{ from: "span-basis-dimension", to: "eigen-diagonalization" },
			{ from: "eigen-diagonalization", to: "spectral-theorem" },
			{ from: "transpose-adjoint", to: "spectral-theorem" },
			{ from: "orthogonality-complements", to: "spectral-theorem" },
			{ from: "spectral-theorem", to: "pca-synthesis" },
			{ from: "normal-equations", to: "pca-synthesis" },
		],
		version: 1,
	},
};

/** The lesson so far: the plan_init, then one tagged check per node taught. */
function lesson(tree: PlanTree, taught: readonly string[]): PopupMessage[] {
	return [
		{ id: "m1", role: "user", parts: [] },
		{ id: "m2", role: "assistant", parts: [{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree } }] },
		...taught.map((nodeId, i) => ({ id: `q${i}`, role: "assistant", parts: [{ type: "tool-quiz", state: "input-available", input: { nodeId } }] })),
	] as PopupMessage[];
}

/** Progress steps per plan: nothing taught, then each node in turn. */
function progressions(tree: PlanTree): string[][] {
	const order = topoFor(tree.nodes, tree.edges).order.map(({ id }) => id);
	return order.map((_, i) => order.slice(0, i)).concat([order]);
}

function snapshot() {
	const out: Record<string, unknown> = {};
	for (const [name, tree] of Object.entries(PLANS)) {
		const layout = blockLayout(tree.nodes, tree.edges);
		const box = (id: string) => ({ x: layout.x.get(id), y: layout.y.get(id), w: layout.nodeW.get(id), h: layout.nodeH.get(id) });
		const steps = progressions(tree).map((taught) => {
			const messages = lesson(tree, taught);
			const statuses = derivePlanStatuses(tree, messages as unknown as Parameters<typeof derivePlanStatuses>[1]);
			const status = Object.fromEntries(tree.nodes.map(({ id }) => [id, derivedNodeStatus(statuses, id)]));
			const block: PlanBlockData = {
				kind: "full", at: "2026-11-18T00:00:00.000Z", current: statuses.current,
				nodes: tree.nodes.map(({ id, title }) => ({ id, title, status: status[id]! })), edges: tree.edges,
			};
			return {
				taught,
				status,
				current: statuses.current,
				latestTree: latestTree(messages)?.version ?? null,
				block: markup(<PlanBlock data={block} onOpen={() => {}} />),
				diagram: markup(<PlanDiagram nodes={tree.nodes} edges={tree.edges} statusOf={(id) => status[id] ?? "upcoming"}
					glowId={statuses.current} markerId="golden" pad={23} naturalSize />),
				marginalia: markup(<PlanMarginalia messages={messages} />),
				popup: markup(<PlanPopup messages={messages} onClose={() => {}} />),
			};
		});
		out[name] = {
			topo: topoFor(tree.nodes, tree.edges).order.map(({ id }) => id),
			nodes: Object.fromEntries(tree.nodes.map(({ id, title }) => [id, { ...box(id), lines: wrapTitle(title), width: nodeWidth(wrapTitle(title)) }])),
			edges: Object.fromEntries([...layout.edgePts].map(([key, points]) => {
				const to = key.split("->")[1]!;
				const target = box(to);
				return [key, { points, d: edgePathD(points, target as { x: number; y: number; w: number; h: number }), bare: edgePathD(points) }];
			})),
			extent: { width: layout.width, height: layout.height, originX: layout.originX ?? null, originY: layout.originY ?? null },
			steps,
		};
	}
	return out;
}

describe("plan diagram golden (web and desktop unchanged)", () => {
	it("renders every representative plan and progress step exactly as recorded", () => {
		const actual = JSON.parse(JSON.stringify(snapshot()));
		if (process.env.PLAN_GOLDEN_RECORD === "1") writeFileSync(GOLDEN, JSON.stringify(actual, null, "\t") + "\n");
		const expected = JSON.parse(readFileSync(GOLDEN, "utf8"));
		for (const name of Object.keys(PLANS)) assert.deepEqual(actual[name], expected[name], `plan "${name}" changed`);
		assert.deepEqual(Object.keys(actual), Object.keys(expected));
	});
});

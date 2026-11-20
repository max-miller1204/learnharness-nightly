import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { LhMessage } from "../../../src/client-protocol/index.ts";
import { projectView } from "../../../src/core/view.ts";
import { drawTex, flattening } from "../src/choice-math.ts";
import { equationsIn } from "../src/message-math.ts";
import { flattenSvg, type SvgNode } from "../src/svg-flatten.ts";
import { markdownTexts } from "../src/Transcript.tsx";

const node = (kind: string, attributes: SvgNode["attributes"] = {}, children: SvgNode[] = []): SvgNode => ({ kind, attributes, children });
const svg = (...children: SvgNode[]) => node("svg", { viewBox: "0 -10 100 20" }, children);
const paths = (markup: string) => [...markup.matchAll(/<path [^>]*d="([^"]*)"/g)].map(([, d]) => d);

test("a flattened picture moves each glyph's outline by its groups' translate and scale", () => {
  const flat = flattenSvg(svg(node("g", { fill: "currentColor", stroke: "currentColor", "stroke-width": "0", transform: "scale(1,-1)" }, [
    node("g", { transform: "translate(10,0) scale(2)", "data-mml-node": "mi" }, [node("path", { d: "M1 1L2 2H3V4Q5 6 7 8Z" })]),
    // A space is an empty path.
    node("path", { d: "" }),
  ])));
  assert.ok(flat);
  assert.deepEqual(paths(flat), ["M12 -2L14 -4H16V-8Q20 -12 24 -16Z"]);
  assert.match(flat, /viewBox="0 -10 100 20"/);
  assert.doesNotMatch(flat, /<g|transform/);
});

test("shapes join into one path only while they don't overlap, one join per color", () => {
  const shape = (x: number, fill?: string) => node("path", { d: `M${x} 0H${x + 10}V10H${x}Z`, ...(fill ? { fill } : {}) });
  const flat = flattenSvg(svg(node("g", { fill: "currentColor", stroke: "currentColor", "stroke-width": "0" }, [
    shape(0), shape(20), shape(25), shape(40, "#FF0000"),
  ])));
  assert.ok(flat);
  // 0 and 20 join; 25 overlaps 20 and starts a second path; red has its own.
  assert.deepEqual(paths(flat), ["M0 0H10V10H0ZM20 0H30V10H20Z", "M25 0H35V10H25Z", "M40 0H50V10H40Z"]);
  assert.match(flat, /fill="#FF0000"/);
});

test("anything a flattened picture can't hold keeps MathJax's own", () => {
  const glyph = (attributes: SvgNode["attributes"]) => svg(node("g", { fill: "currentColor", stroke: "currentColor", "stroke-width": "0", ...attributes }, [node("path", { d: "M0 0L1 1Z" })]));
  assert.ok(flattenSvg(glyph({})));
  assert.equal(flattenSvg(glyph({ transform: "matrix(1 0 0 1 0 0)" })), undefined);
  assert.equal(flattenSvg(glyph({ transform: "rotate(10)" })), undefined);
  assert.equal(flattenSvg(glyph({ "stroke-width": "40" })), undefined);
  assert.equal(flattenSvg(glyph({ style: "opacity: 0.5" })), undefined);
  assert.equal(flattenSvg(svg(node("path", { d: "m0 0l1 1z", fill: "currentColor", stroke: "currentColor", "stroke-width": "0" }))), undefined);
  assert.equal(flattenSvg(svg(node("line", { x1: "0", y1: "0", x2: "1", y2: "1" }))), undefined);
  assert.equal(flattenSvg(svg(node("svg", { viewBox: "0 0 1 1" }))), undefined);
});

test("a background box stays a box behind the glyphs, so dropping colors still drops it", () => {
  const drawn = drawTex("\\colorbox{yellow}{y} + x", false);
  assert.ok(drawn);
  assert.doesNotMatch(drawn.svg.dark + drawn.svg.light, /<g/);
  // Light text on yellow fails contrast in Default, so that picture drops the box; Ivory keeps it.
  assert.match(drawn.svg.light, /<rect fill="yellow"[^>]*><\/rect><path/);
  assert.doesNotMatch(drawn.svg.dark, /<rect/);
});

test("the session's math draws as a few paths, in MathJax's own box", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/mobile-session-open/chats/chat_zzopenlong.json", import.meta.url), "utf8")) as { messages: LhMessage[] };
  const equations = [...new Map(projectView(fixture.messages).flatMap((message) => markdownTexts(message).flatMap(equationsIn))
    .map((equation) => [`${equation.display}${equation.tex}`, equation])).values()].slice(0, 120);
  let flat = 0;
  for (const { tex, display } of equations) {
    flattening.on = false;
    const original = drawTex(tex, display);
    flattening.on = true;
    const drawn = drawTex(tex, display);
    assert.ok(original && drawn, tex);
    const box = (markup: string) => /viewBox="([^"]*)"/.exec(markup)?.[1];
    assert.equal(box(drawn.svg.dark), box(original.svg.dark), tex);
    assert.deepEqual([drawn.width, drawn.height, drawn.depth], [original.width, original.height, original.depth], tex);
    if (drawn.svg.dark.includes("<g")) continue;
    flat++;
    const elements = drawn.svg.dark.match(/<[a-z]+/g) ?? [];
    assert.ok(elements.length <= 6, `${tex}: ${elements.length} elements`);
  }
  assert.ok(flat >= equations.length * 0.95, `${flat} of ${equations.length} flattened`);
});

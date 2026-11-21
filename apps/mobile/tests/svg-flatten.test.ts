import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { LhMessage } from "../../../src/client-protocol/index.ts";
import { projectView } from "../../../src/core/view.ts";
import { drawTex, flattening } from "../src/choice-math.ts";
import { Markdown } from "../src/Markdown.tsx";
import { equationsIn } from "../src/message-math.ts";
import { flattenSvg, safeMarkup, type SvgNode } from "../src/svg-flatten.ts";
import { markdownTexts } from "../src/Transcript.tsx";

interface Element { tag: string; attributes: Record<string, string>; children: Element[] }

/** A small reader for the SVG markup MathJax and the flattener write. */
function read(markup: string): Element {
  const root: Element = { tag: "#root", attributes: {}, children: [] };
  const stack = [root];
  for (const [, close, tag, attributes, self] of markup.matchAll(/<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z][a-zA-Z0-9:-]*="[^"]*")*)\s*(\/?)>/g)) {
    if (close) { stack.pop(); continue; }
    const element: Element = { tag: tag as string, attributes: Object.fromEntries([...(attributes as string).matchAll(/([a-zA-Z][a-zA-Z0-9:-]*)="([^"]*)"/g)].map(([, name, value]) => [name, value])), children: [] };
    (stack.at(-1) as Element).children.push(element);
    if (!self) stack.push(element);
  }
  return root.children[0] as Element;
}

/** What a picture draws, in drawing order: runs of shapes of one color, each with how many
 * outlines it holds. Strokes are drawn zero wide throughout, so only the fill shows. Joining
 * outlines into fewer paths keeps this. */
function drawn(svg: Element): string[] {
  const out: { key: string; outlines: number }[] = [];
  const walk = (element: Element, paint: Record<string, string>) => {
    const next = { ...paint };
    if (element.attributes.fill !== undefined) next.fill = element.attributes.fill;
    if (element.tag === "path" || element.tag === "rect") {
      const outlines = element.tag === "rect" ? 1 : (element.attributes.d?.match(/M/g) ?? []).length;
      const key = `${next.fill}`;
      const last = out.at(-1);
      if (last && last.key === key) last.outlines += outlines;
      else if (outlines) out.push({ key, outlines });
    }
    for (const child of element.children) walk(child, next);
  };
  walk(svg, {});
  return out.map(({ key, outlines }) => `${key} x${outlines}`);
}

const fixtures = ["chat_zzopenlong", "chat_zzopenmath", "chat_zzopenshort", "chat_zzopenimages"].flatMap((name) => {
  const { messages } = JSON.parse(readFileSync(new URL(`../../../tests/fixtures/mobile-session-open/chats/${name}.json`, import.meta.url), "utf8")) as { messages: LhMessage[] };
  return projectView(messages).flatMap((message) => markdownTexts(message).flatMap(equationsIn));
});
const extra = [
  String.raw`x\rlap{\color{blue}{x}}x`, String.raw`\rlap{X}\colorbox{yellow}{i}`, String.raw`\color{red}{x} + \colorbox{yellow}{y}`,
  String.raw`\boxed{a=b}`, String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, String.raw`\overbrace{a+b}^{n}`, String.raw`\sqrt[3]{x}`,
  String.raw`\left(\frac{a}{b}\right)^{\!2}`, String.raw`\not= \neq \notin`, String.raw`\mathbb{R}\mathcal{L}`,
].map((tex) => ({ tex, display: true }));

test("a flattened equation draws MathJax's shapes and colors, in MathJax's order, in both themes", () => {
  const seen = new Set<string>();
  let simplified = 0;
  let total = 0;
  const elements = { original: 0, simplified: 0 };
  const count = (markup: string) => (markup.match(/<[a-z]+/g) ?? []).length;
  for (const { tex, display } of [...fixtures, ...extra]) {
    const key = `${display}${tex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flattening.on = false;
    const original = drawTex(tex, display);
    flattening.on = true;
    const flattened = drawTex(tex, display);
    assert.equal(!!flattened, !!original, tex);
    if (!original || !flattened) continue;
    total++;
    if (flattened.svg.light !== original.svg.light) simplified++;
    elements.original += count(original.svg.light);
    elements.simplified += count(flattened.svg.light);
    for (const mode of ["dark", "light"] as const) {
      const shapes = drawn(read(flattened.svg[mode]));
      // Every picture draws something.
      assert.ok(shapes.some((shape) => Number(shape.split(" x").at(-1)) > 0), `${tex} (${mode}) draws nothing`);
      assert.deepEqual(shapes, drawn(read(original.svg[mode])), `${tex} (${mode})`);
      assert.equal(read(flattened.svg[mode]).attributes.viewBox, read(original.svg[mode]).attributes.viewBox, tex);
    }
    assert.deepEqual([flattened.width, flattened.height, flattened.depth], [original.width, original.height, original.depth], tex);
  }
  assert.ok(simplified >= total * 0.95, `${simplified} of ${total} flattened`);
  // A few elements in place of MathJax's tree of groups.
  assert.ok(elements.simplified < elements.original * 0.15, `${elements.original} elements became ${elements.simplified}`);
});

test("what is drawn later stays on top after flattening", () => {
  const picture = drawTex(String.raw`x\rlap{\color{blue}{x}}x`, false)?.svg.light ?? "";
  const shapes = drawn(read(picture));
  const blue = shapes.findIndex((shape) => shape.startsWith("blue "));
  assert.ok(blue > 0 && blue < shapes.length - 1, "the blue x sits between the two others");
  const box = drawn(read(drawTex(String.raw`\rlap{X}\colorbox{yellow}{i}`, false)?.svg.light ?? ""));
  const yellow = box.findIndex((shape) => shape.startsWith("yellow "));
  assert.ok(yellow > 0, "the box comes after the X, so it covers it as in MathJax's picture");
});

test("anything the flattener can't carry over keeps MathJax's picture", () => {
  const node = (kind: string, attributes: SvgNode["attributes"] = {}, children: SvgNode[] = []): SvgNode => ({ kind, attributes, children });
  const svg = (...children: SvgNode[]) => node("svg", { viewBox: "0 -10 100 20" }, children);
  const glyph = (attributes: SvgNode["attributes"], path: SvgNode["attributes"] = { d: "M0 0L1 1Z" }) =>
    svg(node("g", { fill: "currentColor", stroke: "currentColor", "stroke-width": "0", ...attributes }, [node("path", path)]));
  assert.equal(flattenSvg(glyph({ transform: "translate(10,0) scale(2)" }, { d: "M1 1L2 2H3V4Q5 6 7 8Z" })),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -10 100 20"><path fill="currentColor" stroke="currentColor" stroke-width="0" d="M12 2L14 4H16V8Q20 12 24 16Z"></path></svg>');
  assert.equal(flattenSvg(glyph({ transform: "matrix(1 0 0 1 0 0)" })), undefined);
  assert.equal(flattenSvg(glyph({ fill: 'red"/><image href="x' })), undefined);
  assert.equal(flattenSvg(glyph({ style: "opacity: 0.5" })), undefined);
  assert.equal(flattenSvg(glyph({ "stroke-width": "40" })), undefined);
  assert.equal(flattenSvg(glyph({}, { d: "m0 0l1 1z" })), undefined);
  assert.equal(flattenSvg(svg(node("text", { fill: "currentColor" }))), undefined);
  assert.equal(flattenSvg(svg(node("svg", { viewBox: "0 0 1 1" }))), undefined);
  assert.equal(flattenSvg(svg(node("line", { x1: "0", y1: "0", x2: "1", y2: "1" }))), undefined);
});

test("only drawing reaches the screen: nothing that loads, links or runs", () => {
  assert.equal(safeMarkup('<svg viewBox="0 0 1 1"><path fill="red" d="M0 0Z"></path></svg>'), true);
  assert.equal(safeMarkup('<svg><image href="https://example.invalid/x.png"></image></svg>'), false);
  assert.equal(safeMarkup('<svg><g fill="red"/><image href="x"></g></svg>'), false);
  assert.equal(safeMarkup('<svg><path onload="x" d=""></path></svg>'), false);
  assert.equal(safeMarkup('<svg><a href="x"></a></svg>'), false);
  // Every value in its grammar: no url(), no stray words where a color or number goes.
  assert.equal(safeMarkup('<svg viewBox="0 0 1 1"><path fill="url(#x)" d="M0 0Z"></path></svg>'), false);
  assert.equal(safeMarkup('<svg viewBox="0 0 1 1"><path transform="translate(1,2) skew(url(x))" d="M0 0Z"></path></svg>'), false);
  assert.equal(safeMarkup('<svg viewBox="0 0 1 1"><text font-family="url(x)">x</text></svg>'), false);
  // One picture, properly nested.
  assert.equal(safeMarkup('<svg><g></svg></g>'), false);
  assert.equal(safeMarkup('<svg></svg><svg></svg>'), false);
  assert.equal(safeMarkup('<path d="M0 0Z"></path>'), false);
  assert.equal(safeMarkup('<svg><g>'), false);
});

test("math MathJax draws with rotations, matrices and rgb() colors still draws", () => {
  for (const tex of [
    String.raw`\cancelto{0}{x}`, String.raw`\color{rgb(255,0,0)}x`, String.raw`\colorbox{rgb(255,255,0)}{y}`, String.raw`\textcolor{rgba(0,0,255,0.5)}{z}`,
    String.raw`\boxed{a=b}`, String.raw`\xcancel{x}`, String.raw`\bcancel{x}`, String.raw`\cancel{x}`,
    String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`,
    String.raw`\hat{x}\vec{v}\tilde{y}\dot{z}\ddot{w}\bar{u}\overline{ab}\underline{cd}\widehat{xyz}`,
  ]) {
    const picture = drawTex(tex, true);
    assert.ok(picture, `${tex} draws`);
    assert.ok(safeMarkup(picture.svg.dark) && safeMarkup(picture.svg.light), tex);
  }
});

test("shapes of one color join only while they don't overlap", () => {
  const node = (kind: string, attributes: SvgNode["attributes"] = {}, children: SvgNode[] = []): SvgNode => ({ kind, attributes, children });
  const box = (x: number) => node("path", { d: `M${x} 0H${x + 10}V10H${x}Z` });
  const flat = flattenSvg(node("svg", { viewBox: "0 0 100 10" }, [
    node("g", { fill: "currentColor", stroke: "currentColor", "stroke-width": "0" }, [box(0), box(20), box(25), box(40)]),
  ])) ?? "";
  // 0 and 20 join; 25 overlaps 20 and starts its own path, which 40 then joins.
  assert.deepEqual([...flat.matchAll(/ d="([^"]*)"/g)].map(([, d]) => d), ["M0 0H10V10H0ZM20 0H30V10H20Z", "M25 0H35V10H25ZM40 0H50V10H40Z"]);
});

test("math that tries to break out of a color shows its source instead of a picture", async () => {
  const tex = String.raw`\color{red"/><image href="https://example.invalid/x.png" width="9000" height="9000}{x}`;
  assert.equal(drawTex(tex, false), undefined);
  let tree: ReactTestRenderer | undefined;
  await act(async () => { tree = create(createElement(Markdown, { text: `Look: $${tex}$ here.` })); });
  const root = (tree as ReactTestRenderer).root;
  const text = (node: ReactTestInstance): string[] => node.children.flatMap((child) => typeof child === "string" ? [child] : text(child));
  assert.ok(text(root).join("").includes(`$${tex}$`), "the source shows");
  assert.equal(root.findAll((node) => (node.type as unknown) === "SvgAst").length, 0);
});

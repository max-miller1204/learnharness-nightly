// \fcolorbox draws on the phone as MathJax draws it (#319). MathJax gives the box a border
// style and four polygons; drawTex accepts only that border, parsed, and turns the polygons
// into paths, so the picture holds nothing but drawing.
import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import type { LiteElement } from "mathjax-full/js/adaptors/lite/Element.js";
import { drawTex } from "../src/choice-math.ts";
import { frameBorder } from "../src/svg-flatten.ts";

const THEMES = { dark: { ink: "#e6e6e6", back: "#141414" }, light: { ink: "#3d3d3a", back: "#faf9f5" } } as const;
type Mode = keyof typeof THEMES;

/** MathJax's own picture, style and polygons included, with drawTex's border width (the
 *  web's \fboxrule, 0.04em). */
function mathjaxOwn(tex: string): string {
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const document = mathjax.document("", { InputJax: new TeX({ packages: AllPackages, color: { borderWidth: "0.04em" } }), OutputJax: new SVG({ fontCache: "none" }) });
  const svg = adaptor.firstChild(document.convert(tex, { display: true }) as LiteElement) as LiteElement;
  for (const name of ["width", "height", "style"]) adaptor.removeAttribute(svg, name);
  return adaptor.outerHTML(svg);
}

/** A picture's colors dropped, as drawTex does in a theme they don't stand out in. */
const withoutColors = (svg: string) => svg.replace(/<rect\b[^>]*\bdata-bgcolor="true"[^>]*>(<\/rect>)?/g, "")
  .replace(/\b(fill|stroke)="(?!currentColor"|none")[^"]*"/g, '$1="currentColor"');

/** Whether two drawings look the same: no pixel apart by more than anti-aliasing at an edge
 *  (MathJax transforms its shapes, the flattened picture moves their points, so an edge can
 *  round a step differently). A missing border or box is far beyond that. */
function same(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at++) if (Math.abs((a[at] as number) - (b[at] as number)) > 48) return false;
  return true;
}

function pixels(svg: string, mode: Mode) {
  const [, , width, height] = (svg.match(/viewBox="([^"]*)"/)?.[1] ?? "").split(/\s+/).map(Number) as [number, number, number, number];
  const page = svg.replace("<svg ", `<svg width="600" height="${Math.ceil(600 * height / width)}" style="color:${THEMES[mode].ink}" `);
  return new Resvg(page, { background: THEMES[mode].back }).render().pixels;
}

test("\\fcolorbox draws as MathJax draws it, with its colors where they stand out", () => {
  // light: colors stand out
  // dark: light text on yellow doesn't, so colors drop
  for (const [tex, colored] of [
    [String.raw`\fcolorbox{red}{yellow}{x}`, { light: true, dark: false }],
    [String.raw`\fcolorbox{black}{white}{x}`, { light: true, dark: false }],
    [String.raw`\fcolorbox{yellow}{navy}{\color{white}{x}}`, { light: false, dark: true }],
    [String.raw`a + \fcolorbox{red}{yellow}{b} = c`, { light: true, dark: false }],
  ] as const) {
    const own = mathjaxOwn(tex);
    // The comparison sees the border: without it the picture isn't the same.
    assert.ok(!same(pixels(own.replace(/<polygon\b[^>]*>(<\/polygon>)?/g, ""), "light"), pixels(own, "light")), `${tex}: border visible`);
    const drawn = drawTex(tex, true);
    assert.ok(drawn, `${tex}: drawn, not shown as source`);
    for (const mode of ["light", "dark"] as const) {
      const svg = drawn.svg[mode];
      assert.doesNotMatch(svg, /style=|<polygon/, `${tex} (${mode}): only drawing`);
      const meant = colored[mode] ? own : withoutColors(own);
      assert.ok(same(pixels(svg, mode), pixels(meant, mode)), `${tex} (${mode}): as MathJax draws it${colored[mode] ? "" : " without colors"}`);
    }
  }
});

test("only \\fcolorbox's own border is accepted, parsed and written back", () => {
  assert.deepEqual(frameBorder("border: 2px solid red"), { width: "2px", color: "red" });
  assert.deepEqual(frameBorder("border: 0.05em solid #FF0000;"), { width: "0.05em", color: "#FF0000" });
  for (const style of ["border: 2px dashed red", "border: 2px solid red; color: blue", "border: 2px solid url(#x)", "border: 2vw solid red",
    "border: 2px solid javascript:alert(1)", "background: red", "border: -2px solid red", "border: 2px solid red red"]) {
    assert.equal(frameBorder(style), undefined, style);
  }
});

test("\\colorbox, \\fbox and \\boxed are unchanged", () => {
  for (const tex of [String.raw`\colorbox{yellow}{x}`, String.raw`\fbox{x}`, String.raw`\boxed{x}`]) {
    const drawn = drawTex(tex, true);
    assert.ok(drawn, tex);
    const own = mathjaxOwn(tex);
    assert.ok(same(pixels(drawn.svg.light, "light"), pixels(own, "light")), tex);
  }
});

// \xrightarrow and \xleftarrow are as wide on the phone as on the web (#365). KaTeX gives them a
// width of at least 1.469em (katexImagesData in its stretchy.ts) and pads the label by 0.5em on
// each side, where MathJax pads by 5mu and 10mu and stretches an empty arrow to one em.
import assert from "node:assert/strict";
import test from "node:test";
import { drawTex } from "../src/choice-math.ts";

const KATEX_MIN_WIDTH = 1.469;
const near = (actual: number, expected: number, message: string) => assert.ok(Math.abs(actual - expected) < 0.01, `${message}: ${actual} vs ${expected}`);
const spaced = (label: string) => label.replace(/ /g, "\\ ");
const width = (tex: string) => (drawTex(tex, true) ?? assert.fail(`${tex}: not drawn`)).width;

test("a short label gets the arrow's minimum width", () => {
  for (const arrow of ["xrightarrow", "xleftarrow"]) {
    near(width(`\\${arrow}{f}`), KATEX_MIN_WIDTH, `\\${arrow}{f}`);
    near(width(`\\${arrow}{}`), KATEX_MIN_WIDTH, `\\${arrow}{}`);
    near(width(`\\${arrow}[g]{f}`), KATEX_MIN_WIDTH, `\\${arrow}[g]{f}`);
  }
});

test("a long label is padded by 0.5em on each side of its script-size width", () => {
  for (const [arrow, label] of [["xrightarrow", "longer label"], ["xleftarrow", "a + b + c + d"]] as const) {
    const script = width(`\\scriptstyle ${spaced(label)}`);
    near(width(`\\${arrow}{${spaced(label)}}`), script + 1, `\\${arrow}{${label}}`);
  }
});

test("an arrow in a sentence keeps its place and the other arrows are unchanged", () => {
  assert.ok(width(String.raw`A \xrightarrow{f} B`) > KATEX_MIN_WIDTH + 1);
  // KaTeX's own widths for these differ, and the phone keeps MathJax's for them.
  for (const tex of [String.raw`\xRightarrow{f}`, String.raw`\xleftrightarrow{f}`, String.raw`\xhookrightarrow{f}`, String.raw`\xmapsto{f}`]) assert.ok(drawTex(tex, true), tex);
});

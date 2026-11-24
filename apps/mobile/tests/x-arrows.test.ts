// \xrightarrow and \xleftarrow are as wide on the phone as on the web (#365). KaTeX 0.18.2 gives
// them a width of at least 1.469em (katexImagesData in its stretchy.ts), and pads the label by
// 0.5em of the label's own size on each side, 0.7em in all at the label's script size. MathJax
// pads by 5mu and 10mu, and keeps an arrow's size when it sits in a script.
import assert from "node:assert/strict";
import test from "node:test";
import { drawTex } from "../src/choice-math.ts";

const KATEX_MIN_WIDTH = 1.469;
/** MathJax sets the label at script size: 1/√2 of the text. */
const SCRIPT = Math.SQRT1_2;
const near = (actual: number, expected: number, message: string, within = 0.02) =>
  assert.ok(Math.abs(actual - expected) < within, `${message}: ${actual} vs ${expected}`);
const spaced = (label: string) => label.replace(/ /g, "\\ ");
const width = (tex: string) => (drawTex(tex, true) ?? assert.fail(`${tex}: not drawn`)).width;

test("a short label gets the arrow's minimum width", () => {
  for (const arrow of ["xrightarrow", "xleftarrow"]) {
    near(width(`\\${arrow}{f}`), KATEX_MIN_WIDTH, `\\${arrow}{f}`);
    near(width(`\\${arrow}{}`), KATEX_MIN_WIDTH, `\\${arrow}{}`);
    near(width(`\\${arrow}[g]{f}`), KATEX_MIN_WIDTH, `\\${arrow}[g]{f}`);
  }
});

test("a long label is padded by 0.5em of its own size on each side", () => {
  for (const [tex, label] of [
    [String.raw`\xrightarrow{longer\ label}`, String.raw`longer\ label`],
    [String.raw`\xleftarrow{a+b+c+d}`, "a+b+c+d"],
    [String.raw`\xrightarrow[longer\ label]{f}`, String.raw`longer\ label`],
    [String.raw`\xleftarrow[a+b+c+d]{f}`, "a+b+c+d"],
  ] as const) near(width(tex), width(`\\scriptstyle ${label}`) + SCRIPT, tex);
  // KaTeX 0.18.2's widths for the same TeX, measured in Chrome, to the font's difference.
  near(width(`\\xrightarrow{${spaced("longer label")}}`), 4.318, "\\xrightarrow{longer label} against KaTeX", 0.1);
  near(width(String.raw`\xleftarrow{a+b+c+d}`), 3.672, "\\xleftarrow{a+b+c+d} against KaTeX", 0.1);
});

test("the minimum scales with the style the arrow is in, as KaTeX's does", () => {
  // KaTeX's arrow itself is 1.469 * 0.7 = 1.028em in a script style.
  near(width(String.raw`\scriptstyle\xrightarrow{f}`), 1.028, "\\scriptstyle\\xrightarrow{f}", 0.03);
  near(width(String.raw`x^{\xrightarrow{f}}`), 1.650, "x^{\\xrightarrow{f}}", 0.06);
});

test("an arrow in a sentence keeps its place", () => {
  assert.ok(width(String.raw`A \xrightarrow{f} B`) > KATEX_MIN_WIDTH + 1);
});

test("a user's own definition of the arrow wins", () => {
  near(width(String.raw`\renewcommand{\xrightarrow}[1]{#1}\xrightarrow{f}`), width("f"), "\\renewcommand");
  near(width(String.raw`\renewcommand{\xleftarrow}[1]{#1}\xleftarrow{f}`), width("f"), "\\renewcommand of the other arrow");
  near(width(String.raw`\let\xrightarrow\alpha\xrightarrow`), width(String.raw`\alpha`), "\\let");
  near(width(String.raw`\newcommand{\myarrow}[1]{\xrightarrow{#1}}\myarrow{f}`), KATEX_MIN_WIDTH, "a macro that uses it");
});

test("the other x-arrows keep MathJax's own sizes", () => {
  for (const [tex, expected] of [
    [String.raw`\xRightarrow{f}`, 1.1356], [String.raw`\xleftrightarrow{f}`, 1.1745],
    [String.raw`\xhookrightarrow{f}`, 1.126], [String.raw`\xmapsto{longer\ label}`, 4.3544],
  ] as const) near(width(tex), expected, tex, 0.001);
});

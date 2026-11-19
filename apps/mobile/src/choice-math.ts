// Math in quiz choice labels, drawn by MathJax as an SVG picture for
// react-native-svg, with no web view in the row (docs/specs/mobile-quiz-choice-math.md).
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { STATE } from "mathjax-full/js/core/MathItem.js";
import { SerializedMmlVisitor } from "mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js";
import type { MmlNode, TextNode } from "mathjax-full/js/core/MmlTree/MmlNode.js";
import type { LiteElement } from "mathjax-full/js/adaptors/lite/Element.js";

/** `html` makes links, styles and ids; `bussproofs` needs an output that measures boxes;
 * `noerrors` would hide the error node that sends broken math back to its source. */
const EXCLUDED_PACKAGES = new Set(["html", "bussproofs", "noerrors"]);

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const document = mathjax.document("", {
  InputJax: new TeX({ packages: AllPackages.filter((name) => !EXCLUDED_PACKAGES.has(name)) }),
  OutputJax: new SVG({ fontCache: "none" }),
});
const mathml = new SerializedMmlVisitor();

/** Sizes are in em of the surrounding text. `depth` is how far the picture hangs below the baseline. */
export interface DrawnMath {
  svg: string;
  width: number;
  height: number;
  depth: number;
  mathml: string;
  /** The math as symbol text ("P → Q"), the spoken fallback when the speech engine can't run. */
  symbols: string;
}

/** Draws TeX, or returns undefined when it doesn't parse. */
export function drawTex(tex: string, display: boolean): DrawnMath | undefined {
  const root = document.convert(tex, { display, end: STATE.COMPILED }) as MmlNode;
  let broken = false;
  const tokens: string[] = [];
  root.walkTree((visited) => {
    const node = visited as MmlNode;
    if (node.isKind("merror")) broken = true;
    if (node.isToken) tokens.push((node.childNodes as TextNode[]).map((child) => child.getText?.() ?? "").join(""));
  });
  if (broken) return;
  const container = document.convert(tex, { display }) as LiteElement;
  const svg = adaptor.firstChild(container) as LiteElement;
  const [, minY = 0, width = 0, height = 0] = (adaptor.getAttribute(svg, "viewBox") ?? "").split(" ").map(Number);
  for (const name of ["width", "height", "style"]) adaptor.removeAttribute(svg, name);
  return {
    svg: adaptor.outerHTML(svg),
    width: width / 1000,
    height: height / 1000,
    depth: (height + minY) / 1000,
    mathml: mathml.visitTree(root),
    symbols: tokens.filter(Boolean).join(" "),
  };
}

export type LabelPiece =
  | { kind: "text"; text: string }
  | { kind: "math"; tex: string; display: boolean; drawn: DrawnMath };

const DELIMITERS = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;

/** Splits a label into text and drawn math. Math that fails to draw stays as its source text. */
export function splitLabel(label: string): LabelPiece[] {
  const pieces: LabelPiece[] = [];
  const text = (value: string) => {
    if (!value) return;
    const last = pieces.at(-1);
    if (last?.kind === "text") last.text += value;
    else pieces.push({ kind: "text", text: value });
  };
  let at = 0;
  for (const match of label.matchAll(DELIMITERS)) {
    text(label.slice(at, match.index));
    at = match.index + match[0].length;
    const display = match[1] !== undefined || match[2] !== undefined;
    const tex = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
    const drawn = drawTex(tex, display);
    if (drawn) pieces.push({ kind: "math", tex, display, drawn });
    else text(match[0]);
  }
  text(label.slice(at));
  return pieces;
}

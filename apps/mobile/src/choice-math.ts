// Math in quiz and ask choice labels, drawn by MathJax as an SVG picture for
// react-native-svg, with no web view in the row (docs/specs/mobile-quiz-choice-math.md).
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor, type LiteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { STATE } from "mathjax-full/js/core/MathItem.js";
import { SerializedMmlVisitor } from "mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js";
import type { MathDocument } from "mathjax-full/js/core/MathDocument.js";
import type { MmlNode, TextNode } from "mathjax-full/js/core/MmlTree/MmlNode.js";
import type { LiteElement } from "mathjax-full/js/adaptors/lite/Element.js";
import type { LiteDocument } from "mathjax-full/js/adaptors/lite/Document.js";
import type { LiteText } from "mathjax-full/js/adaptors/lite/Text.js";
import { readContentSpans } from "../../../src/core/content-reader.ts";
import { repairMathForDisplay } from "../../../src/core/math-delims.ts";

/** AI-written math is untrusted. `html` makes links, styles and ids; `bussproofs` needs
 * an output that measures boxes. `noerrors` and `noundefined` would draw broken math
 * instead of handing it back as its source text, and `colorv2` is the older `\color` of
 * `color`, which stays on. `require` and `autoload` load code and aren't bundled. Every
 * other TeX package MathJax ships is on, including the two AllPackages leaves out. */
export const EXCLUDED_PACKAGES = ["html", "bussproofs", "noerrors", "noundefined", "colorv2"];
const PACKAGES = [...AllPackages, "physics", "setoptions"].filter((name) => !EXCLUDED_PACKAGES.includes(name));
/** Math that sets any of these (\mmlToken, \bbox[style], \label, \eqref) stays as text.
 * The one class MathJax sets itself (gensymb's units) is allowed. */
const UNTRUSTED_ATTRIBUTES = ["href", "style", "class", "id"];
const MATHJAX_CLASSES = ["MathML-Unit"];

let mathJax: { adaptor: LiteAdaptor; document: MathDocument<LiteElement, LiteText, LiteDocument>; mathml: SerializedMmlVisitor } | undefined;
/** Set up on first use, so screens without math never pay for it. */
function setUp() {
  if (mathJax) return mathJax;
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const document = mathjax.document("", {
    InputJax: new TeX({ packages: PACKAGES }),
    OutputJax: new SVG({ fontCache: "none" }),
  });
  mathJax = { adaptor, document, mathml: new SerializedMmlVisitor() };
  return mathJax;
}

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

/** Checks the compiled math and collects its visible symbols, or returns undefined
 * when it is broken or untrusted. */
function readTree(node: MmlNode, symbols: string[]): boolean {
  if (node.isKind("merror")) return false;
  const untrusted = (node.attributes?.getExplicitNames() ?? []).filter((name) => UNTRUSTED_ATTRIBUTES.includes(name));
  if (untrusted.some((name) => name !== "class" || !MATHJAX_CLASSES.includes(String(node.attributes.getExplicit(name))))) return false;
  if (node.isKind("mphantom")) return true;
  if (node.isToken) {
    const text = (node.childNodes as TextNode[]).map((child) => child.getText?.() ?? "").join("").trim();
    if (text) symbols.push(text);
    return true;
  }
  return (node.childNodes as MmlNode[]).every((child) => !child || readTree(child, symbols));
}

/** Draws TeX, or returns undefined when it doesn't parse or sets untrusted attributes. */
export function drawTex(tex: string, display: boolean): DrawnMath | undefined {
  const { adaptor, document, mathml } = setUp();
  const root = document.convert(tex, { display, end: STATE.COMPILED }) as MmlNode;
  const symbols: string[] = [];
  if (!readTree(root, symbols)) return;
  const container = document.convert(tex, { display }) as LiteElement;
  const svg = adaptor.firstChild(container) as LiteElement;
  const [, minY = 0, width = 0, height = 0] = (adaptor.getAttribute(svg, "viewBox") ?? "").split(" ").map(Number);
  for (const name of ["width", "height", "style"]) adaptor.removeAttribute(svg, name);
  return {
    svg: adaptor.outerHTML(svg).replace(/ data-[a-z-]+="[^"]*"/g, ""),
    width: width / 1000,
    height: height / 1000,
    depth: (height + minY) / 1000,
    mathml: mathml.visitTree(root),
    symbols: symbols.join(" "),
  };
}

export type LabelPiece =
  | { kind: "text"; text: string }
  | { kind: "math"; tex: string; display: boolean; drawn: DrawnMath };

const pushText = (pieces: LabelPiece[], text: string) => {
  if (!text) return;
  const last = pieces.at(-1);
  if (last?.kind === "text") last.text += text;
  else pieces.push({ kind: "text", text });
};

const drawnLabels = new Map<string, LabelPiece[]>();

/** Splits a label into text and drawn math, the way the web reads it: repaired first
 * (repairMathForDisplay, as ToolContentResponse does), then the shared math reader.
 * `$$...$$` and `\[...\]` are block math. Math that fails to draw stays as its source text. */
export function splitLabel(label: string): LabelPiece[] {
  const cached = drawnLabels.get(label);
  if (cached) return cached;
  const pieces: LabelPiece[] = [];
  for (const span of readContentSpans(repairMathForDisplay(label))) {
    const tex = span.kind === "math" ? span.body.trim() : "";
    const display = span.kind === "math" && (span.open === "$$" || span.open === "\\[");
    const drawn = tex ? drawTex(tex, display) : undefined;
    if (drawn) pieces.push({ kind: "math", tex, display, drawn });
    else pushText(pieces, span.raw);
  }
  if (drawnLabels.size >= 200) drawnLabels.delete(drawnLabels.keys().next().value as string);
  drawnLabels.set(label, pieces);
  return pieces;
}

/** Text that never goes through the math reader: typed answers and "Other". */
export const plainText = (text: string): LabelPiece[] => text ? [{ kind: "text", text }] : [];

/** Pieces joined with a plain separator, merging text so it reads as one line. */
export function joinPieces(parts: LabelPiece[][], separator: string): LabelPiece[] {
  const pieces: LabelPiece[] = [];
  parts.filter((part) => part.length).forEach((part, index) => {
    if (index) pushText(pieces, separator);
    for (const piece of part) {
      if (piece.kind === "text") pushText(pieces, piece.text);
      else pieces.push(piece);
    }
  });
  return pieces;
}

export const hasMath = (pieces: LabelPiece[]) => pieces.some((piece) => piece.kind === "math");

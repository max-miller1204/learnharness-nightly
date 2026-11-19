// Math in quiz and ask choice labels, drawn by MathJax as an SVG picture for
// react-native-svg, with no web view in the row (docs/specs/mobile-quiz-choice-math.md).
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor, type LiteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { STATE, type MathItem } from "mathjax-full/js/core/MathItem.js";
import { SerializedMmlVisitor } from "mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js";
import type { MmlNode, TextNode } from "mathjax-full/js/core/MmlTree/MmlNode.js";
import type { LiteElement } from "mathjax-full/js/adaptors/lite/Element.js";
import type { LiteDocument } from "mathjax-full/js/adaptors/lite/Document.js";
import type { LiteText } from "mathjax-full/js/adaptors/lite/Text.js";
import { readContentSpans } from "../../../src/core/content-reader.ts";
import { repairMathForDisplay } from "../../../src/core/math-delims.ts";
import { resolveTheme, shiftHex } from "../../../src/core/themes.ts";

/** AI-written math is untrusted. `html` makes links, styles and ids; `bussproofs` needs
 * an output that measures boxes; `action` adds event handlers, which the drawing can't
 * run. `noerrors` and `noundefined` would draw broken math instead of handing it back as
 * its source text. `require` and `autoload` load code and aren't bundled. Every other
 * package in MathJax's AllPackages is on. Its `physics` and `setoptions` stay off: the
 * web draws with KaTeX, which has neither, and physics redefines standard commands. */
export const EXCLUDED_PACKAGES = ["html", "bussproofs", "action", "noerrors", "noundefined"];
const PACKAGES = AllPackages.filter((name) => !EXCLUDED_PACKAGES.includes(name));
/** Math that sets any of these (\mmlToken, \bbox[style], \unicode[font], \label, \eqref)
 * stays as text. The one class MathJax sets itself (gensymb's units) is allowed. */
const UNTRUSTED_ATTRIBUTES = ["href", "style", "class", "id", "fontfamily"];
const MATHJAX_CLASSES = ["MathML-Unit"];
/** A drawn color must stand out this much from every row background in both themes, so
 * `\color{white}` on the light theme or `\color{black}` on the dark one (both about 1.1:1)
 * never makes math invisible. WCAG's 3:1 for graphics would refuse plain `\color{blue}` on
 * the dark theme's hover surface (about 1.45:1). */
const MIN_COLOR_CONTRAST = 1.4;

let adaptor: LiteAdaptor | undefined;
let mathml: SerializedMmlVisitor | undefined;

/** A fresh TeX input and document for every equation, so nothing one label defines
 * (\newcommand, \definecolor, \label, tags) reaches another. Set up on first use. */
function freshDocument() {
  if (!adaptor) {
    adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    mathml = new SerializedMmlVisitor();
  }
  const document = mathjax.document("", { InputJax: new TeX({ packages: PACKAGES }), OutputJax: new SVG({ fontCache: "none" }) });
  return { adaptor, document, mathml: mathml as SerializedMmlVisitor };
}

/** Sizes are in em of the math. `depth` is how far the picture hangs below the baseline. */
export interface DrawnMath {
  svg: string;
  width: number;
  height: number;
  depth: number;
  mathml: string;
  /** The math as text ("x superscript 2", "P → Q"), read when the speech engine can't run. */
  symbols: string;
}

const children = (node: MmlNode) => node.childNodes as (MmlNode | null)[];

/** False when the compiled math is broken or sets an untrusted attribute. */
function trusted(node: MmlNode): boolean {
  if (node.isKind("merror")) return false;
  const untrusted = (node.attributes?.getExplicitNames() ?? []).filter((name) => UNTRUSTED_ATTRIBUTES.includes(name));
  if (untrusted.some((name) => name !== "class" || !MATHJAX_CLASSES.includes(String(node.attributes.getExplicit(name))))) return false;
  return node.isToken || children(node).every((child) => !child || trusted(child));
}

const words = (...parts: string[]) => parts.filter(Boolean).join(" ");
const simple = (text: string) => !text.includes(" ");

/** The math as words that keep its structure: scripts, fractions, roots, limits, tables. */
export function readAloud(node: MmlNode | null): string {
  if (!node || node.isKind("mphantom") || node.isKind("mspace") || node.isKind("none") || node.isKind("mprescripts")) return "";
  if (node.isToken) return (node.childNodes as TextNode[]).map((child) => child.getText?.() ?? "").join("").trim();
  const kids = children(node);
  const at = (index: number) => readAloud(kids[index] ?? null);
  const slot = node as unknown as { base: number; sub: number; sup: number; under: number; over: number };
  switch (node.kind) {
    case "msup": return words(at(slot.base), "superscript", at(slot.sup));
    case "msub": return words(at(slot.base), "subscript", at(slot.sub));
    case "msubsup": return words(at(slot.base), "subscript", at(slot.sub), "superscript", at(slot.sup));
    case "munder": return words(at(slot.base), "below", at(slot.under));
    case "mover": return words(at(slot.base), "above", at(slot.over));
    case "munderover": return words(at(slot.base), "from", at(slot.under), "to", at(slot.over));
    case "mfrac": {
      const [top, bottom] = [at(0), at(1)];
      return simple(top) && simple(bottom) ? words(top, "over", bottom) : words("start fraction", top, "over", bottom, "end fraction");
    }
    case "msqrt": {
      const inside = kids.map(readAloud).join(" ").trim();
      return simple(inside) ? words("square root of", inside) : words("start root", inside, "end root");
    }
    case "mroot": return words("root", at(1), "of", at(0), simple(at(0)) ? "" : "end root");
    case "mtable": return kids.map(readAloud).filter(Boolean).join("; ");
    case "mtr": case "mlabeledtr": return kids.map(readAloud).filter(Boolean).join(", ");
    default: return kids.map(readAloud).filter(Boolean).join(" ");
  }
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  cyan: "#00ffff", aqua: "#00ffff", magenta: "#ff00ff", fuchsia: "#ff00ff", gray: "#808080", grey: "#808080",
  silver: "#c0c0c0", maroon: "#800000", olive: "#808000", lime: "#00ff00", teal: "#008080", navy: "#000080",
  purple: "#800080", orange: "#ffa500", brown: "#a52a2a", pink: "#ffc0cb", violet: "#ee82ee", gold: "#ffd700",
  indigo: "#4b0082", darkgreen: "#006400", darkblue: "#00008b", darkred: "#8b0000", lightgray: "#d3d3d3", lightgrey: "#d3d3d3",
};

function luminance(color: string): number | undefined {
  const named = NAMED_COLORS[color.toLowerCase()] ?? color;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(named)?.[1];
  if (!hex) return;
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((at) => {
    const channel = parseInt(full.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Every surface a row or an answered card sits on, in the dark (Default) and light (Ivory) themes. */
const BACKGROUNDS = (["default", "ivory"] as const).flatMap((id) => {
  const { colors } = resolveTheme(id);
  return [colors.background, colors.surface, shiftHex(colors.surface, id === "default" ? 14 : -14)];
}).map((color) => luminance(color) ?? 0);

/** False when the drawing uses a color it can't check, or one too close to a background. */
function visible(svg: string): boolean {
  for (const [, color = ""] of svg.matchAll(/\b(?:fill|stroke)="([^"]*)"/g)) {
    if (["currentColor", "none", "transparent"].includes(color)) continue;
    const shade = luminance(color);
    if (shade === undefined) return false;
    if (BACKGROUNDS.some((back) => (Math.max(shade, back) + 0.05) / (Math.min(shade, back) + 0.05) < MIN_COLOR_CONTRAST)) return false;
  }
  return true;
}

/** Draws TeX, or returns undefined when it doesn't parse, throws, or isn't safe to show. */
export function drawTex(tex: string, display: boolean): DrawnMath | undefined {
  try {
    const { adaptor, document, mathml } = freshDocument();
    type Item = MathItem<LiteElement, LiteText, LiteDocument>;
    const MathItemClass = document.options.MathItem as new (math: string, jax: unknown, display: boolean) => Item;
    const item = new MathItemClass(tex, document.inputJax[0], display);
    item.start.node = adaptor.body(document.document);
    item.setMetrics(16, 8, 640, 1000000, 1);
    // Compile once, check the tree, then typeset that same item: converting twice would
    // define a \label twice and draw MathJax's "multiply defined" error.
    item.convert(document, STATE.COMPILED);
    const root = item.root;
    if (!trusted(root)) return;
    item.convert(document);
    const svg = adaptor.firstChild(item.typesetRoot) as LiteElement;
    const [, minY = 0, width = 0, height = 0] = (adaptor.getAttribute(svg, "viewBox") ?? "").split(" ").map(Number);
    for (const name of ["width", "height", "style"]) adaptor.removeAttribute(svg, name);
    const markup = adaptor.outerHTML(svg);
    if (/data-mml-node="merror"|data-mjx-error/.test(markup) || /\s(?:style|id)=/.test(markup) || !visible(markup)) return;
    if (!(width > 0 && height > 0)) return;
    return {
      svg: markup.replace(/ data-[a-z-]+="[^"]*"/g, ""),
      width: width / 1000,
      height: height / 1000,
      depth: (height + minY) / 1000,
      mathml: mathml.visitTree(root),
      symbols: readAloud(root),
    };
  } catch {
    return;
  }
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

/** Splits a label into text and drawn math, the way the web reads it: repaired first
 * (repairMathForDisplay, as ToolContentResponse does), then the shared math reader, whose
 * `display` says which math is a block. Math that fails to draw stays as its source text. */
function readLabel(label: string): LabelPiece[] {
  const pieces: LabelPiece[] = [];
  for (const span of readContentSpans(repairMathForDisplay(label))) {
    const tex = span.kind === "math" ? span.body.trim() : "";
    const drawn = span.kind === "math" && tex ? drawTex(tex, span.display) : undefined;
    if (drawn && span.kind === "math") pieces.push({ kind: "math", tex, display: span.display, drawn });
    else pushText(pieces, span.raw);
  }
  return pieces;
}

const drawnLabels = new Map<string, LabelPiece[]>();

/** A label as text and drawn math. Any failure leaves the whole label as its text. */
export function splitLabel(label: string): LabelPiece[] {
  const cached = drawnLabels.get(label);
  if (cached) return cached;
  let pieces: LabelPiece[];
  try {
    pieces = readLabel(label);
  } catch {
    pieces = plainText(label);
  }
  if (drawnLabels.size >= 200) drawnLabels.delete(drawnLabels.keys().next().value as string);
  drawnLabels.set(label, pieces);
  return pieces;
}

/** Text that never goes through the math reader: typed answers and "Other". */
export function plainText(text: string): LabelPiece[] {
  return text ? [{ kind: "text", text }] : [];
}

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

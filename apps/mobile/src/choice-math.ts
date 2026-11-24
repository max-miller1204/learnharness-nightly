// Math in quiz and ask choice labels, drawn by MathJax as an SVG picture for
// react-native-svg, with no web view in the row (docs/specs/mobile-quiz-choice-math.md).
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor, type LiteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { TagsFactory } from "mathjax-full/js/input/tex/Tags.js";
import { STATE, type MathItem } from "mathjax-full/js/core/MathItem.js";
import { SerializedMmlVisitor } from "mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js";
import type { MmlNode, TextNode } from "mathjax-full/js/core/MmlTree/MmlNode.js";
import type { LiteElement } from "mathjax-full/js/adaptors/lite/Element.js";
import type { LiteDocument } from "mathjax-full/js/adaptors/lite/Document.js";
import type { LiteText } from "mathjax-full/js/adaptors/lite/Text.js";
import { readContentSpans } from "../../../src/core/content-reader.ts";
import { indented, repairMathForDisplay } from "../../../src/core/math-delims.ts";
import { resolveTheme, shiftHex } from "../../../src/core/themes.ts";
import { parseColor } from "./math-colors";
import { PARITY_PACKAGES, PARITY_TEXT_PACKAGES } from "./mathjax-katex-parity";
import { flattenSvg, frameBorder, safeMarkup, SVG_NUMBER, type SvgNode } from "./svg-flatten";

/** AI-written math is untrusted. `html` makes links, styles and ids; `bussproofs` needs
 * an output that measures boxes; `action` adds event handlers, which the drawing can't
 * run. `noerrors` and `noundefined` would draw broken math instead of handing it back as
 * its source text. `require` and `autoload` load code and aren't bundled. Packages the
 * web's KaTeX doesn't support at all stay off to match it: those listed after
 * `noundefined`, and `physics` and `setoptions`, which AllPackages leaves out (physics also
 * redefines standard commands). Every other package in MathJax's AllPackages is on. */
export const EXCLUDED_PACKAGES = [
  "html", "bussproofs", "action", "noerrors", "noundefined",
  "mhchem", "bbox", "cases", "centernot", "colortbl", "empheq", "enclose", "upgreek", "unicode",
];
const PACKAGES = AllPackages.filter((name) => !EXCLUDED_PACKAGES.includes(name));
/** Math that sets any of these (\mmlToken, \label, \eqref) stays as text. */
const UNTRUSTED_ATTRIBUTES = ["href", "style", "class", "id", "fontfamily"];
const COLOR_ATTRIBUTES = ["mathcolor", "color", "mathbackground", "background"];
/** gensymb's unit symbols, the only tokens MathJax gives its unit class. */
const GENSYMB_UNITS = ["Ω", "°", "℃", "‰", "µ"];
/** Colored math must stand out this much (WCAG's 3:1 for graphics) from what is behind
 * it in a theme, or it is drawn in that theme's text color instead. */
const MIN_COLOR_CONTRAST = 3;

// MathJax's tag registry has no delete, and mathtools and tagformat add a class to it for
// every TeX input, each holding that input, so a fresh input per equation would keep them
// all. It is replaced by one that drops what each draw added.
type TagsClass = Parameters<typeof TagsFactory.add>[1];
const tagClasses = new Map<string, TagsClass>((["none", "all"] as const).map((name) => [name, TagsFactory.create(name).constructor as TagsClass]));
let defaultTags = "none";
Object.assign(TagsFactory, {
  add: (name: string, constr: TagsClass) => { tagClasses.set(name, constr); },
  create: (name: string) => new (tagClasses.get(name) ?? tagClasses.get(defaultTags) ?? (tagClasses.get("none") as TagsClass))(),
  setDefault: (name: string) => { defaultTags = name; },
  getDefault: () => TagsFactory.create(defaultTags),
});
/** How many tag classes MathJax holds; it never grows from drawing. */
export const tagClassCount = () => tagClasses.size;

let adaptor: LiteAdaptor | undefined;
let mathml: SerializedMmlVisitor | undefined;

/** \fcolorbox's border width: the web's KaTeX draws it at \fboxrule, 0.04em. */
const FBOX_RULE = "0.04em";

/** A fresh TeX input and document for every equation, so nothing one label defines
 * (\newcommand, \definecolor, \label, tags) reaches another. Set up on first use. */
function freshDocument() {
  if (!adaptor) {
    adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    mathml = new SerializedMmlVisitor();
  }
  const document = mathjax.document("", { InputJax: new TeX({ packages: [...PACKAGES, ...PARITY_PACKAGES], color: { borderWidth: FBOX_RULE }, textmacros: { packages: ["text-base", ...PARITY_TEXT_PACKAGES] } }), OutputJax: new SVG({ fontCache: "none" }) });
  return { adaptor, document, mathml: mathml as SerializedMmlVisitor };
}

export type ThemeMode = "dark" | "light";

/** Sizes are in em of the math. `depth` is how far the picture hangs below the baseline. */
export interface DrawnMath {
  /** The picture for each theme: colors that don't stand out there are dropped. */
  svg: Record<ThemeMode, string>;
  width: number;
  height: number;
  depth: number;
  mathml: string;
  /** The math as text ("x superscript 2", "P → Q"), read when the speech engine can't run. */
  symbols: string;
}

const children = (node: MmlNode) => node.childNodes as (MmlNode | null)[];
const tokenText = (node: MmlNode) => (node.childNodes as TextNode[]).map((child) => child.getText?.() ?? "").join("").trim();

/** False when the compiled math is broken, sets an untrusted attribute, or is made invisible. */
function trusted(node: MmlNode): boolean {
  if (node.isKind("merror")) return false;
  const names = node.attributes?.getExplicitNames() ?? [];
  for (const name of names) {
    const value = String(node.attributes.getExplicit(name)).trim().toLowerCase();
    if (COLOR_ATTRIBUTES.includes(name) && (value === "none" || value === "transparent")) return false;
    // Input may only give the unit class to exactly what gensymb draws with it.
    const unit = name === "class" && value === "mathml-unit" && node.isKind("mi") && GENSYMB_UNITS.includes(tokenText(node))
      && names.every((other) => other === "class" || other === "mathvariant");
    // \fcolorbox's border, the only style a drawing may carry (frameBorder).
    const frame = name === "style" && node.isKind("mpadded") && frameBorder(String(node.attributes.getExplicit(name))) !== undefined;
    if (UNTRUSTED_ATTRIBUTES.includes(name) && !unit && !frame) return false;
  }
  return node.isToken || children(node).every((child) => !child || trusted(child));
}

const words = (...parts: string[]) => parts.filter(Boolean).join(" ");
const simple = (text: string) => !text.includes(" ");

/** The math as words that keep its structure: scripts, fractions, roots, limits, tables. */
export function readAloud(node: MmlNode | null): string {
  if (!node || node.isKind("mphantom") || node.isKind("mspace") || node.isKind("none") || node.isKind("mprescripts")) return "";
  if (node.isToken) return tokenText(node);
  const kids = children(node);
  const at = (index: number) => readAloud(kids[index] ?? null);
  const slot = node as unknown as { base: number; sub: number; sup: number; under: number; over: number };
  switch (node.kind) {
    case "msup": return words(at(slot.base), "superscript", at(slot.sup));
    case "msub": return words(at(slot.base), "subscript", at(slot.sub));
    case "msubsup": return words(at(slot.base), "subscript", at(slot.sub), "superscript", at(slot.sup));
    case "mmultiscripts": {
      // Base, then subscript and superscript pairs, then mprescripts and the pairs before the base.
      const split = kids.findIndex((kid) => kid?.isKind("mprescripts"));
      const scripts = (list: (MmlNode | null)[], sub: string, sup: string) =>
        list.flatMap((kid, index) => { const text = readAloud(kid); return text ? [index % 2 ? sup : sub, text] : []; });
      const post = scripts(kids.slice(1, split < 0 ? undefined : split), "subscript", "superscript");
      const pre = split < 0 ? [] : scripts(kids.slice(split + 1), "pre-subscript", "pre-superscript");
      return words(...pre, at(0), ...post);
    }
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

function luminance(color: string): number | undefined {
  const full = parseColor(color)?.hex.slice(1);
  if (!full) return;
  const [r, g, b] = [0, 2, 4].map((at) => {
    const channel = parseInt(full.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Each theme's text color and every surface a row (plain, pressed or selected) or an
 * answered card sits on: Default when the phone is dark, Ivory when it is light. */
const THEMES = Object.fromEntries((["dark", "light"] as const).map((mode) => {
  const { colors } = resolveTheme(mode === "dark" ? "default" : "ivory");
  const surfaces = [colors.background, colors.surface, shiftHex(colors.surface, mode === "dark" ? 14 : -14)];
  return [mode, { text: colors.text, surfaces }];
})) as Record<ThemeMode, { text: string; surfaces: string[] }>;

/** Whether a space draws a rule: it has a background and a size. \rule{0pt}{1.2em}, a strut,
 * only holds the line open. */
function drawnRule(node: MmlNode): boolean {
  if (!node.isKind("mspace") || node.attributes?.getExplicit("mathbackground") === undefined) return false;
  const size = (name: string) => parseFloat(String(node.attributes.getExplicit(name) ?? 0));
  return size("width") > 0 && (size("height") > 0 || size("depth") > 0);
}

/** A \rule is a space MathJax fills with the \color in effect where the rule is parsed, or
 * with black when there is none (BaseMethods' Rule). That black stands for the color around
 * it: the nearest \color above it, which math inside \text doesn't see while it is parsed,
 * or else the text's color. Any other fill was chosen, and is left alone. */
function rulesInTextColor(node: MmlNode, color?: string) {
  const own = ["mathcolor", "color"].map((name) => node.attributes?.getExplicit(name)).find((value) => value !== undefined);
  color = own === undefined ? color : String(own);
  if (drawnRule(node) && String(node.attributes.getExplicit("mathbackground")).trim().toLowerCase() === "black") {
    node.attributes.set("mathbackground", color ?? "currentColor");
  }
  if (!node.isToken) for (const child of children(node)) if (child) rulesInTextColor(child, color);
}

/** MathJax draws a rule as a rectangle marked as a background, like a \colorbox's, but it is
 * the rule's ink: unmarked, a picture drawn without its colors recolors it instead of
 * dropping it. */
function rulesAsInk(adaptor: LiteAdaptor, node: LiteElement) {
  for (const child of adaptor.childNodes(node)) {
    if (adaptor.kind(child) === "#text") continue;
    const element = child as LiteElement;
    if (adaptor.kind(element) === "rect" && adaptor.getAttribute(node, "data-mml-node") === "mspace") adaptor.removeAttribute(element, "data-bgcolor");
    rulesAsInk(adaptor, element);
  }
}

/** MathJax places the stretched middle of a brace, arrow or bar in a nested svg with an x and
 * y offset. react-native-svg 15 draws a nested Svg at its parent's origin, keeping only its
 * size, clip and viewBox (RNSVGGroup.mm: CGRectMake(0, 0, width, height); Android's SvgView:
 * RectF(0, 0, width, height)), and leaves that clip, and on Android its viewBox, on the canvas
 * for what is drawn after it. So every nested svg gets a group of its own, which holds both in,
 * and its offset moves onto that group, which every renderer draws the same. False when an
 * offset isn't a plain number, so the picture isn't drawn. */
export function offsetsAsGroups(adaptor: LiteAdaptor, node: LiteElement): boolean {
  for (const child of [...adaptor.childNodes(node)]) {
    if (adaptor.kind(child) === "#text") continue;
    const element = child as LiteElement;
    if (!offsetsAsGroups(adaptor, element)) return false;
    if (adaptor.kind(element) !== "svg") continue;
    const [x, y] = ["x", "y"].map((name) => {
      const value = adaptor.getAttribute(element, name);
      return value === null || value === undefined ? 0 : SVG_NUMBER.test(String(value)) ? Number(value) : NaN;
    }) as [number, number];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (!nestedOffsets.moved) continue;
    adaptor.removeAttribute(element, "x");
    adaptor.removeAttribute(element, "y");
    const group = adaptor.node("g", x === 0 && y === 0 ? {} : { transform: `translate(${String(x)},${String(y)})` }) as LiteElement;
    adaptor.insert(group, element);
    adaptor.append(group, element);
  }
  return true;
}

/** Each framed box's border written back from its parsed parts (frameBorder), so MathJax
 *  draws it from nothing but a number, a unit and a color. */
function framesNormalized(node: MmlNode) {
  if (node.isKind("mpadded")) {
    const frame = frameBorder(String(node.attributes?.getExplicit("style") ?? ""));
    if (frame) node.attributes.set("style", `border: ${frame.width} solid ${frame.color}`);
  }
  if (!node.isToken) for (const child of children(node)) if (child) framesNormalized(child);
}

/** MathJax draws a framed box's border (\fcolorbox) as four polygons in a group that keeps
 *  the style it came from. Each polygon becomes a path from its parsed points and color, and
 *  the style goes, so the picture holds only drawing. False when a frame's points or color
 *  don't parse, so the picture isn't drawn. */
export function framesAsPaths(adaptor: LiteAdaptor, node: LiteElement): boolean {
  for (const child of [...adaptor.childNodes(node)]) {
    if (adaptor.kind(child) === "#text") continue;
    const element = child as LiteElement;
    if (!framesAsPaths(adaptor, element)) return false;
    if (adaptor.kind(element) !== "g" || adaptor.getAttribute(element, "data-mml-node") !== "mpadded") continue;
    const style = adaptor.getAttribute(element, "style");
    if (style === null || style === undefined) continue;
    if (!frameBorder(String(style))) return false;
    adaptor.removeAttribute(element, "style");
    for (const side of [...adaptor.childNodes(element)]) {
      if (adaptor.kind(side) !== "polygon") continue;
      const polygon = side as LiteElement;
      // Points are "x,y" pairs apart by spaces; an empty or extra value fails the picture.
      const points = String(adaptor.getAttribute(polygon, "points") ?? "").trim().split(/\s+/).map((point) => point.split(","));
      const fill = parseColor(String(adaptor.getAttribute(polygon, "fill") ?? ""));
      if (points.length < 3 || !fill || !points.every((point) => point.length === 2 && point.every((value) => SVG_NUMBER.test(value) && Number.isFinite(Number(value))))) return false;
      const pairs = points.map((point) => point.map((value) => String(Number(value))).join(" "));
      const path = adaptor.node("path", { d: `M${pairs.join("L")}Z`, fill: fill.css, stroke: "none" }) as LiteElement;
      adaptor.insert(path, polygon);
      adaptor.remove(polygon);
    }
  }
  return true;
}

/** Each fill and stroke color MathJax wrote as parseColor writes it (a trimmed, lowercase name,
 *  lowercase hex or rgb(r,g,b)), the form the contrast check measured: React Native's color
 *  parser rejects " navy " or "RED" and would leave the shape unfilled. A color parseColor
 *  doesn't know is only trimmed; it is dropped wherever the contrast check can't measure it. */
function colorsNormalized(adaptor: LiteAdaptor, node: LiteElement) {
  for (const child of adaptor.childNodes(node)) {
    if (adaptor.kind(child) === "#text") continue;
    const element = child as LiteElement;
    for (const name of ["fill", "stroke"]) {
      const value = adaptor.getAttribute(element, name);
      if (value === null || value === undefined) continue;
      const text = String(value).trim();
      if (/^(?:currentColor|none)$/.test(text)) continue;
      adaptor.setAttribute(element, name, parseColor(text)?.css ?? text);
    }
    colorsNormalized(adaptor, element);
  }
}

/** The color of each visible glyph or rule and the box drawn behind it, if any. */
function inks(node: MmlNode, color: string | undefined, behind: string | undefined, found: { color?: string; behind?: string }[]) {
  if (node.isKind("mphantom")) return found;
  const explicit = (names: string[]) => names.map((name) => node.attributes?.getExplicit(name)).find((value) => value !== undefined);
  // A rule's background is its ink: currentColor is the text's color. A strut draws nothing.
  if (drawnRule(node)) {
    const rule = String(explicit(["mathbackground", "background"]));
    found.push({ color: rule === "currentColor" ? undefined : rule, behind });
    return found;
  }
  // A framed box's border is ink against what is behind the box.
  const frame = node.isKind("mpadded") ? frameBorder(String(explicit(["style"]) ?? "")) : undefined;
  if (frame) found.push({ color: frame.color, behind });
  color = (explicit(["mathcolor", "color"]) as string | undefined) ?? color;
  behind = (explicit(["mathbackground", "background"]) as string | undefined) ?? behind;
  if (node.isToken) {
    if (tokenText(node)) found.push({ color, behind });
  } else {
    for (const child of children(node)) if (child) inks(child, color, behind, found);
  }
  return found;
}

const contrast = (one: number, two: number) => (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);

/** Whether every glyph stands out from what is behind it, in a theme. A color it can't check fails. */
function readable(found: { color?: string; behind?: string }[], mode: ThemeMode): boolean {
  const { text, surfaces } = THEMES[mode];
  return found.every(({ color, behind }) => {
    const ink = luminance(color ?? text);
    const backs = (behind ? [behind] : surfaces).map(luminance);
    return ink !== undefined && backs.every((back) => back !== undefined && contrast(ink, back) >= MIN_COLOR_CONTRAST);
  });
}

/** The picture without its colors: no boxes behind, every glyph in the theme's text color. */
const withoutColors = (svg: string) => svg
  .replace(/<rect\b[^>]*\bdata-bgcolor="true"[^>]*>(<\/rect>)?/g, "")
  .replace(/\b(fill|stroke)="(?!currentColor"|none")[^"]*"/g, '$1="currentColor"');

/** Data attributes and classes do nothing in the drawing, so none reaches it. */
const stripData = (svg: string) => svg.replace(/ (?:data-[a-z-]+|class)="[^"]*"/g, "");

/** Whether drawings are flattened (svg-flatten.ts); off only to compare with MathJax's own, in tests. */
export const flattening = { on: true };
/** Whether nested svgs' offsets move onto groups (offsetsAsGroups); off only to compare with
 * MathJax's own placement, in tests. */
export const nestedOffsets = { moved: true };

/** Draws TeX, or returns undefined when it doesn't parse, throws, or isn't safe to show. */
export function drawTex(tex: string, display: boolean): DrawnMath | undefined {
  const registered = new Set(tagClasses.keys());
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
    framesNormalized(root);
    rulesInTextColor(root);
    item.convert(document);
    const svg = adaptor.firstChild(item.typesetRoot) as LiteElement;
    const [, minY = 0, width = 0, height = 0] = (adaptor.getAttribute(svg, "viewBox") ?? "").split(" ").map(Number);
    for (const name of ["width", "height", "style"]) adaptor.removeAttribute(svg, name);
    rulesAsInk(adaptor, svg);
    if (!offsetsAsGroups(adaptor, svg)) return;
    if (!framesAsPaths(adaptor, svg)) return;
    colorsNormalized(adaptor, svg);
    const original = adaptor.outerHTML(svg);
    if (/data-mml-node="merror"|data-mjx-error/.test(original) || /\s(?:style|id)=/.test(original)) return;
    // The same picture without its groups draws far faster (svg-flatten.ts).
    const markup = (flattening.on && flattenSvg(svg as unknown as SvgNode)) || original;
    if (!(width > 0 && height > 0)) return;
    const found = inks(root, undefined, undefined, []);
    const plain = stripData(withoutColors(markup));
    const colored = stripData(markup);
    // What is drawn is only drawing: nothing that loads, links or runs.
    if (!safeMarkup(plain) || !safeMarkup(colored)) return;
    return {
      svg: { dark: readable(found, "dark") ? colored : plain, light: readable(found, "light") ? colored : plain },
      width: width / 1000,
      height: height / 1000,
      depth: (height + minY) / 1000,
      mathml: mathml.visitTree(root),
      symbols: readAloud(root),
    };
  } catch {
    return;
  } finally {
    for (const name of [...tagClasses.keys()]) if (!registered.has(name)) tagClasses.delete(name);
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
 * (repairMathForDisplay, as ToolContentResponse does), then the shared math reader. Block
 * math follows the reader's `display`, and legacy `\[...\]` is a block unless indented, as
 * in the web's transformMathDelimiters. Math that fails to draw shows its original text. */
function readLabel(label: string): LabelPiece[] {
  const repaired = repairMathForDisplay(label);
  const spans = readContentSpans(repaired);
  // Repair changes only math, so the spans line up with the label's own.
  const original = readContentSpans(label);
  const aligned = original.length === spans.length && original.every((span, index) => span.kind === spans[index]?.kind);
  const pieces: LabelPiece[] = [];
  let failed = false;
  let offset = 0;
  spans.forEach((span, index) => {
    const start = offset;
    offset += span.raw.length;
    const source = aligned ? original[index]?.raw ?? span.raw : span.raw;
    if (span.kind !== "math") return pushText(pieces, source);
    const display = span.open === "\\[" ? !indented(repaired, start) : span.display;
    const tex = span.body.trim();
    const drawn = tex ? drawTex(tex, display) : undefined;
    if (drawn) pieces.push({ kind: "math", tex, display, drawn });
    else {
      failed = true;
      pushText(pieces, source);
    }
  });
  if (failed && !aligned) return plainText(label);
  // Block math sits on its own line, so the line breaks beside it would add blank lines.
  pieces.forEach((piece, index) => {
    if (piece.kind !== "math" || !piece.display) return;
    const [before, after] = [pieces[index - 1], pieces[index + 1]];
    if (before?.kind === "text") before.text = before.text.replace(/\s+$/, "");
    if (after?.kind === "text") after.text = after.text.replace(/^\s+/, "");
  });
  return pieces.filter((piece) => piece.kind !== "text" || piece.text);
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

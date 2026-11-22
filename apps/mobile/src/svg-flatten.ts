// MathJax draws an equation as nested groups, each glyph its own path: about two dozen SVG
// elements, and react-native-svg makes a native view for every one, too many to mount while a
// fling moves through a screen of math. Flattened, the same picture is a few paths: the glyphs'
// outlines moved into place at full precision, and each joined to the path just before it when
// that path has its color and nothing in it overlaps (so nothing is drawn in a different order,
// and no glyph's winding can cut a hole in another). Background boxes stay boxes, in place.
// The shapes, colors and drawing order are MathJax's; only antialiasing at a few edge pixels
// can differ. Anything this doesn't understand, and any value outside a strict grammar, keeps
// MathJax's own picture.

/** An element of MathJax's lite DOM, or any tree of the same shape. */
export interface SvgNode {
  kind: string;
  attributes: Record<string, string | number | undefined>;
  children: SvgNode[];
}

/** x' = sx·x + tx, y' = sy·y + ty: the only transforms MathJax's TeX output uses. */
type Transform = [sx: number, sy: number, tx: number, ty: number];

const IDENTITY: Transform = [1, 1, 0, 0];
const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`;
/** One SVG number and nothing else (around it, only spaces): a value to parse, never to copy. */
export const SVG_NUMBER = new RegExp(`^\\s*${NUMBER}\\s*$`);
const STEP = new RegExp(String.raw`\s*(translate|scale)\(\s*(${NUMBER})(?:[\s,]+(${NUMBER}))?\s*\)`, "g");
const TOKEN = new RegExp(`[A-Za-z]|${NUMBER}`, "g");

const then = ([psx, psy, ptx, pty]: Transform, [sx, sy, tx, ty]: Transform): Transform =>
  [psx * sx, psy * sy, psx * tx + ptx, psy * ty + pty];

/** A transform attribute of translate and scale steps, or undefined for anything else. */
function parseTransform(value: string): Transform | undefined {
  let result = IDENTITY;
  const rest = value.replace(STEP, (_all, kind: string, one: string, two?: string) => {
    const [a, b] = [Number(one), two === undefined ? undefined : Number(two)];
    result = then(result, kind === "translate" ? [1, 1, a, b ?? 0] : [a, b ?? a, 0, 0]);
    return "";
  });
  return rest.trim() ? undefined : result;
}

/** Coordinates at full precision, so nothing moves by rounding. */
const format = (value: number) => String(value);
/** A color MathJax writes: a name, a hex value, currentColor or none. */
const COLOR = new RegExp(String.raw`^(?:[a-zA-Z]{1,30}|#[0-9a-fA-F]{3,8}|rgba?\(\s*${NUMBER}%?(?:\s*,\s*${NUMBER}%?){2,3}\s*\))$`);
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Box { left: number; top: number; right: number; bottom: number }

/** Path data with every point moved, and its bounds, or undefined for commands it can't move. */
function movePath(d: string, [sx, sy, tx, ty]: Transform): { d: string; box: Box } | undefined {
  const tokens = d.match(TOKEN) ?? [];
  const out: string[] = [];
  const box: Box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  const x = (value: number) => { const moved = sx * value + tx; box.left = Math.min(box.left, moved); box.right = Math.max(box.right, moved); return format(moved); };
  const y = (value: number) => { const moved = sy * value + ty; box.top = Math.min(box.top, moved); box.bottom = Math.max(box.bottom, moved); return format(moved); };
  let command = "";
  let numbers: number[] = [];
  const flush = () => {
    if (!command) return true;
    const pairs = "MLTQCS".includes(command);
    if (pairs && (numbers.length === 0 || numbers.length % 2)) return false;
    if ((command === "H" || command === "V") && numbers.length === 0) return false;
    if (command === "Z" && numbers.length) return false;
    out.push(command, numbers.map((value, index) =>
      command === "H" ? x(value) : command === "V" ? y(value) : index % 2 ? y(value) : x(value)).join(" "));
    return true;
  };
  for (const token of tokens) {
    const code = token.charCodeAt(0);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      if (!flush() || !"MLHVCSQTZ".includes(token)) return;
      command = token;
      numbers = [];
    } else {
      if (!command) return;
      numbers.push(Number(token));
    }
  }
  if (!flush() || !Number.isFinite(box.left)) return;
  return { d: out.join(""), box };
}

const overlaps = (one: Box, two: Box) => one.left < two.right && two.left < one.right && one.top < two.bottom && two.top < one.bottom;

interface Shape { d: string; box: Box; fill: string; stroke: string }

const SHARED = ["fill", "stroke", "stroke-width", "transform"];
const allowed = (node: SvgNode, own: string[]) =>
  Object.keys(node.attributes).every((name) => name.startsWith("data-") || name === "class" || SHARED.includes(name) || own.includes(name));

/** The equation as a few joined paths, or undefined when it holds anything but groups,
 * paths and rectangles moved by translate and scale, or a stroke. */
export function flattenSvg(root: SvgNode): string | undefined {
  if (root.kind !== "svg") return;
  const viewBox = root.attributes.viewBox;
  if (typeof viewBox !== "string" || !viewBox.trim().split(/\s+/).every((part) => new RegExp(`^${NUMBER}$`).test(part))) return;
  /** What is drawn, in MathJax's order: a background box, or a shape to join. */
  const items: (Shape | string)[] = [];
  const visit = (node: SvgNode, at: Transform, fill: string | undefined, stroke: string | undefined, width: string | undefined): boolean => {
    const own = node.attributes;
    const local = own.transform === undefined ? IDENTITY : parseTransform(String(own.transform));
    if (!local) return false;
    const transform = then(at, local);
    fill = own.fill === undefined ? fill : String(own.fill);
    stroke = own.stroke === undefined ? stroke : String(own.stroke);
    width = own["stroke-width"] === undefined ? width : String(own["stroke-width"]);
    if (node.kind === "g") return allowed(node, []) && node.children.every((child) => visit(child, transform, fill, stroke, width));
    if (node.children.length || fill === undefined || stroke === undefined || !COLOR.test(fill) || !COLOR.test(stroke) || Number(width) !== 0) return false;
    if (node.kind === "path") {
      if (!allowed(node, ["d"]) || typeof own.d !== "string") return false;
      // MathJax gives a space an empty path.
      if (!own.d.trim()) return true;
      const moved = movePath(own.d, transform);
      if (!moved) return false;
      items.push({ ...moved, fill, stroke });
      return true;
    }
    if (node.kind === "rect") {
      if (!allowed(node, ["x", "y", "width", "height"])) return false;
      const [x, y, w, h] = ["x", "y", "width", "height"].map((name) => Number(own[name] ?? 0)) as [number, number, number, number];
      if (![x, y, w, h].every(Number.isFinite)) return false;
      const moved = movePath(`M${x} ${y}H${x + w}V${y + h}H${x}Z`, transform);
      if (!moved) return false;
      if (own["data-bgcolor"] === "true") {
        const { left, top, right, bottom } = moved.box;
        items.push(`<rect data-bgcolor="true" fill="${escape(fill)}" x="${format(left)}" y="${format(top)}" width="${format(right - left)}" height="${format(bottom - top)}"></rect>`);
      } else items.push({ ...moved, fill, stroke });
      return true;
    }
    return false;
  };
  if (!allowed(root, ["viewBox", "xmlns", "role", "focusable"])) return;
  if (!root.children.every((child) => visit(child, IDENTITY, undefined, undefined, undefined))) return;
  // A shape joins the path just before it when that path is its color and nothing in it
  // overlaps the shape, so nothing is drawn in a different order (what is drawn later stays on
  // top) and no shape's winding can cut into another's.
  const out: (string | { fill: string; stroke: string; parts: Shape[] })[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (typeof item === "string") out.push(item);
    else if (last && typeof last !== "string" && last.fill === item.fill && last.stroke === item.stroke && last.parts.every(({ box }) => !overlaps(box, item.box))) last.parts.push(item);
    else out.push({ fill: item.fill, stroke: item.stroke, parts: [item] });
  }
  const drawn = out.map((item) => typeof item === "string" ? item
    : `<path fill="${escape(item.fill)}" stroke="${escape(item.stroke)}" stroke-width="0" d="${item.parts.map(({ d }) => d).join("")}"></path>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${escape(viewBox)}">${drawn.join("")}</svg>`;
}

const TAG = /<([a-zA-Z]+)((?:\s+[a-zA-Z][a-zA-Z0-9:-]*="[^"<>]*")*)\s*>|<\/([a-zA-Z]+)>/g;
/** The elements a drawing is made of; nothing that shows another picture, links or holds code. */
const SAFE_TAGS = new Set(["svg", "g", "path", "rect", "line", "text"]);
/** Attributes that load, link, run or style; all others only describe the drawing. */
const UNSAFE_ATTRIBUTE = /^(?:on|xlink:|xml:)|href|src|style|^id$|^class$/i;
const NUMBERS = new RegExp(`^${NUMBER}(?:[\\s,]+${NUMBER})*$`);
/** The grammar each drawing attribute's value must follow. */
const VALUES: Record<string, RegExp> = {
  xmlns: /^http:\/\/www\.w3\.org\/2000\/svg$/, role: /^img$/, focusable: /^false$/, viewBox: NUMBERS,
  fill: COLOR, stroke: COLOR, "stroke-width": NUMBERS, transform: new RegExp(String.raw`^(?:\s*(?:translate|scale|rotate|matrix|skewX|skewY)\(\s*${NUMBER}(?:[\s,]+${NUMBER}){0,5}\s*\))*\s*$`),
  d: /^[MLHVCSQTAZmlhvcsqtaz0-9.eE\s,+-]*$/, x: NUMBERS, y: NUMBERS, width: NUMBERS, height: NUMBERS,
  x1: NUMBERS, y1: NUMBERS, x2: NUMBERS, y2: NUMBERS, "data-bgcolor": /^true$/,
};
/** Any other attribute MathJax writes holds a plain word or number: no parentheses, colons
 * or anything else a link or a style would need. */
const PLAIN = /^[a-zA-Z0-9 .,#%_-]*$/;

/** Whether a finished picture is only drawing: one svg of the elements above, properly nested,
 * every value in its grammar, and no attribute that loads, links, runs or styles. Checked on
 * the markup that is actually drawn. */
export function safeMarkup(markup: string): boolean {
  let ok = true;
  const open: string[] = [];
  let roots = 0;
  const rest = markup.replace(TAG, (_all, opening?: string, attributes?: string, closing?: string) => {
    if (closing !== undefined) {
      if (open.pop() !== closing) ok = false;
      return "";
    }
    const tag = opening as string;
    if (!SAFE_TAGS.has(tag) || (open.length === 0 && (tag !== "svg" || ++roots > 1))) ok = false;
    open.push(tag);
    for (const [, name, value] of (attributes ?? "").matchAll(/([a-zA-Z][a-zA-Z0-9:-]*)="([^"]*)"/g)) {
      const grammar = VALUES[name as string];
      if (UNSAFE_ATTRIBUTE.test(name as string) || !(grammar ?? PLAIN).test((value as string).trim())) ok = false;
    }
    return "";
  });
  return ok && open.length === 0 && roots === 1 && !/[<>]/.test(rest);
}

// MathJax draws an equation as nested groups, each glyph its own path: about two dozen SVG
// elements, and react-native-svg makes a native view for every one. Flattened, the same
// picture is a few paths: the glyphs' outlines moved into place, joined while they don't
// overlap (so no glyph's winding can cut a hole in another), one join per color. Anything
// this doesn't understand keeps MathJax's own picture.

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

const format = (value: number) => String(Math.round(value * 100) / 100);

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
  if (typeof viewBox !== "string") return;
  const shapes: Shape[] = [];
  const backgrounds: string[] = [];
  const visit = (node: SvgNode, at: Transform, fill: string | undefined, stroke: string | undefined, width: string | undefined): boolean => {
    const own = node.attributes;
    const local = own.transform === undefined ? IDENTITY : parseTransform(String(own.transform));
    if (!local) return false;
    const transform = then(at, local);
    fill = own.fill === undefined ? fill : String(own.fill);
    stroke = own.stroke === undefined ? stroke : String(own.stroke);
    width = own["stroke-width"] === undefined ? width : String(own["stroke-width"]);
    if (node.kind === "g") return allowed(node, []) && node.children.every((child) => visit(child, transform, fill, stroke, width));
    if (node.children.length || fill === undefined || stroke === undefined || Number(width) !== 0) return false;
    if (node.kind === "path") {
      if (!allowed(node, ["d"]) || typeof own.d !== "string") return false;
      // MathJax gives a space an empty path.
      if (!own.d.trim()) return true;
      const moved = movePath(own.d, transform);
      if (!moved) return false;
      shapes.push({ ...moved, fill, stroke });
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
        backgrounds.push(`<rect data-bgcolor="true" fill="${fill}" x="${format(left)}" y="${format(top)}" width="${format(right - left)}" height="${format(bottom - top)}"></rect>`);
      } else shapes.push({ ...moved, fill, stroke });
      return true;
    }
    return false;
  };
  if (!allowed(root, ["viewBox", "xmlns", "role", "focusable"])) return;
  if (!root.children.every((child) => visit(child, IDENTITY, undefined, undefined, undefined))) return;
  // Each shape joins the first path of its color that it doesn't overlap.
  const joins: { fill: string; stroke: string; parts: Shape[] }[] = [];
  for (const shape of shapes) {
    const join = joins.find(({ fill, stroke, parts }) => fill === shape.fill && stroke === shape.stroke && parts.every(({ box }) => !overlaps(box, shape.box)));
    if (join) join.parts.push(shape);
    else joins.push({ fill: shape.fill, stroke: shape.stroke, parts: [shape] });
  }
  const paths = joins.map(({ fill, stroke, parts }) => `<path fill="${fill}" stroke="${stroke}" stroke-width="0" d="${parts.map(({ d }) => d).join("")}"></path>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${backgrounds.join("")}${paths.join("")}</svg>`;
}

// Math in messages, drawn with the quiz choices' MathJax drawing (choice-math.ts) and kept
// in memory so each distinct equation is drawn at most once while the app runs.
import { drawTex, type DrawnMath } from "./choice-math";
import { parseMarkdown, type MarkdownToken } from "./render-markdown";

export interface Equation {
  tex: string;
  display: boolean;
}

/** Drawn equations, oldest use first. Failed draws are kept too, so broken math isn't retried. */
const drawn = new Map<string, DrawnMath | null>();
export const EQUATION_CAP = 3000;
let draws = 0;
/** How many times MathJax has drawn an equation, for tests. */
export const drawCount = () => draws;
export const cachedEquations = () => drawn.size;

const keyOf = ({ tex, display }: Equation) => `${display ? "B" : "I"}${tex}`;

export function isDrawn(equation: Equation): boolean {
  return drawn.has(keyOf(equation));
}

/** The equation's picture, drawn now if it hasn't been. Undefined when it can't be drawn. */
export function drawEquation(equation: Equation): DrawnMath | undefined {
  const key = keyOf(equation);
  let picture = drawn.get(key);
  if (picture === undefined) {
    draws++;
    picture = drawTex(equation.tex, equation.display) ?? null;
    if (drawn.size >= EQUATION_CAP) drawn.delete(drawn.keys().next().value as string);
  } else {
    drawn.delete(key);
  }
  drawn.set(key, picture);
  return picture ?? undefined;
}

const parsed = new Map<string, ReturnType<typeof parseMarkdown>>();

/** Markdown parsed once per text, with the same cap rule as the equations. */
export function markdownOf(text: string): ReturnType<typeof parseMarkdown> {
  let result = parsed.get(text);
  if (!result) {
    result = parseMarkdown(text);
    if (parsed.size >= 1000) parsed.delete(parsed.keys().next().value as string);
    parsed.set(text, result);
  }
  return result;
}

export function equationOf(token: MarkdownToken): Equation | undefined {
  if (token.type !== "math_inline" && token.type !== "math_block") return;
  const tex = token.content.trim();
  return tex ? { tex, display: token.type === "math_block" } : undefined;
}

function collect(tokens: MarkdownToken[], found: Equation[]) {
  for (const token of tokens) {
    const equation = equationOf(token);
    if (equation) found.push(equation);
    if (token.children) collect(token.children, found);
  }
  return found;
}

/** Every equation in a markdown text, in reading order. */
export function equationsIn(text: string): Equation[] {
  return collect(markdownOf(text).tokens, []);
}

/** Draws the texts' equations that aren't drawn yet until `deadline` (a performance.now()
 * time). True when every one is drawn. */
export function drawUntil(texts: readonly string[], deadline: number, now: () => number = () => performance.now()): boolean {
  for (const text of texts) {
    for (const equation of equationsIn(text)) {
      if (isDrawn(equation)) continue;
      if (now() >= deadline) return false;
      drawEquation(equation);
    }
  }
  return true;
}

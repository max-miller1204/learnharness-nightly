// Math in messages, drawn with the quiz choices' MathJax drawing (choice-math.ts) and kept
// in memory so each distinct equation is drawn at most once while the app runs.
import { drawTex, type DrawnMath } from "./choice-math";
import { parseMarkdown, type MarkdownToken } from "./render-markdown";

export interface Equation {
  tex: string;
  display: boolean;
}

/** A map that keeps at most `cap` entries, dropping the least recently used. */
export class Capped<V> {
  private readonly entries = new Map<string, V>();
  constructor(private readonly cap: number) {}
  get size() { return this.entries.size; }
  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: V) {
    this.entries.delete(key);
    if (this.entries.size >= this.cap) this.entries.delete(this.entries.keys().next().value as string);
    this.entries.set(key, value);
  }
}

/** Drawn equations, in memory only. Failed draws are kept too, so broken math isn't retried. */
export const EQUATION_CAP = 3000;
const drawn = new Capped<DrawnMath | null>(EQUATION_CAP);
let draws = 0;
/** How many times MathJax has drawn an equation, and how many are kept, for tests. */
export const drawCount = () => draws;
export const cachedEquations = () => drawn.size;

const keyOf = ({ tex, display }: Equation) => `${display ? "B" : "I"}${tex}`;

export function isDrawn(equation: Equation): boolean {
  return drawn.get(keyOf(equation)) !== undefined;
}

/** The equation's picture, drawn now if it hasn't been. Undefined when it can't be drawn. */
export function drawEquation(equation: Equation): DrawnMath | undefined {
  const key = keyOf(equation);
  let picture = drawn.get(key);
  if (picture === undefined) {
    draws++;
    picture = drawTex(equation.tex, equation.display) ?? null;
    drawn.set(key, picture);
  }
  return picture ?? undefined;
}

const parsed = new Capped<ReturnType<typeof parseMarkdown>>(1000);

/** Markdown parsed once per text. */
export function markdownOf(text: string): ReturnType<typeof parseMarkdown> {
  let result = parsed.get(text);
  if (!result) {
    result = parseMarkdown(text);
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

/** Equations to draw in order, and how far drawing has got. Progress is kept here, never
 * read from the cache, so a text with more distinct equations than the cache holds still
 * finishes. */
export interface DrawQueue {
  equations: Equation[];
  next: number;
}

export const drawQueue = (texts: readonly string[]): DrawQueue => ({ equations: texts.flatMap(equationsIn), next: 0 });

/** Draws the queue's equations until `deadline` (a performance.now() time), at least one a
 * call. True once every one has been drawn. */
export function drawFrom(queue: DrawQueue, deadline: number, now: () => number = () => performance.now()): boolean {
  while (queue.next < queue.equations.length) {
    drawEquation(queue.equations[queue.next] as Equation);
    queue.next++;
    if (queue.next < queue.equations.length && now() >= deadline) return false;
  }
  return true;
}

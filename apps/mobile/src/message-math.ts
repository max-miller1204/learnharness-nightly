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
  constructor(public cap: number) {}
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
/** Sets the cache's cap, for tests. */
export const setEquationCap = (cap: number) => { drawn.cap = cap; };

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

/** Every math token's picture in parsed markdown, undefined where it can't be drawn. Each
 * equation is looked up once, and every one already drawn is taken before any missing one is
 * drawn, so drawing the missing ones can't evict another the same text needs (a message with
 * more distinct equations than the cache holds would otherwise redraw them in turn). */
export function drawingsOf(tokens: readonly MarkdownToken[]): Map<MarkdownToken, DrawnMath | undefined> {
  const math: [MarkdownToken, Equation][] = [];
  const walk = (list: readonly MarkdownToken[]) => {
    for (const token of list) {
      const equation = equationOf(token);
      if (equation) math.push([token, equation]);
      if (token.children) walk(token.children);
    }
  };
  walk(tokens);
  const found = new Map<string, DrawnMath | null>();
  for (const [, equation] of math) {
    const key = keyOf(equation);
    const picture = drawn.get(key);
    if (picture !== undefined) found.set(key, picture);
  }
  const pictures = new Map<MarkdownToken, DrawnMath | undefined>();
  for (const [token, equation] of math) {
    const key = keyOf(equation);
    if (!found.has(key)) found.set(key, drawEquation(equation) ?? null);
    pictures.set(token, found.get(key) ?? undefined);
  }
  return pictures;
}

export function equationOf(token: MarkdownToken): Equation | undefined {
  if (token.type !== "math_inline" && token.type !== "math_block") return;
  const tex = token.content.trim();
  return tex ? { tex, display: token.type === "math_block" } : undefined;
}

const blockCache = new Capped<MarkdownToken[][]>(1000);

/** A markdown text's top-level blocks (paragraphs, lists, block math...), each as its own
 * tokens, split once per text. */
export function blocksOf(text: string): MarkdownToken[][] {
  let blocks = blockCache.get(text);
  if (!blocks) {
    const { tokens } = markdownOf(text);
    const found: MarkdownToken[][] = [];
    let start = 0;
    let depth = 0;
    tokens.forEach((token, index) => {
      depth += token.nesting;
      if (depth !== 0) return;
      found.push(tokens.slice(start, index + 1));
      start = index + 1;
    });
    blocks = found;
    blockCache.set(text, blocks);
  }
  return blocks;
}

/** Every equation in parsed markdown, in reading order. */
export const equationsInTokens = (tokens: readonly MarkdownToken[]): Equation[] => collect(tokens, []);

function collect(tokens: readonly MarkdownToken[], found: Equation[]) {
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

export const drawQueue = (texts: readonly string[]): DrawQueue => queueOf(texts.flatMap(equationsIn));
export const queueOf = (equations: readonly Equation[]): DrawQueue => ({ equations: [...equations], next: 0 });

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

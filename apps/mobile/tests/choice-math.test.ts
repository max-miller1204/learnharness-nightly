import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { repairMathForDisplay } from "../../../src/core/math-delims.ts";
import { buildAnswer, type QuestionData } from "../../../src/core/question-core.ts";
import { drawTex, EXCLUDED_PACKAGES, hasMath, joinPieces, plainText, splitLabel, type LabelPiece } from "../src/choice-math.ts";
import { spokenLabel } from "../src/math-speech.ts";

const LABEL = "No, $P\\to Q$ is blocked.";
const kinds = (pieces: LabelPiece[]) => pieces.map((piece) => piece.kind === "math" ? `${piece.display ? "block" : "inline"}:${piece.tex}` : `text:${piece.text}`);

test("draws inline math and keeps the text around it", () => {
  const pieces = splitLabel(LABEL);
  assert.deepEqual(kinds(pieces), ["text:No, ", "inline:P\\to Q", "text: is blocked."]);
  const math = pieces[1];
  assert.ok(math?.kind === "math" && math.drawn.svg.startsWith("<svg") && math.drawn.width > 0 && math.drawn.height > 0);
  assert.equal(math.drawn.symbols, "P → Q");
});

test("reads all four delimiters; $$ and \\[ are block math", () => {
  assert.deepEqual(kinds(splitLabel("a \\(x\\) b $y$ c")), ["text:a ", "inline:x", "text: b ", "inline:y", "text: c"]);
  assert.deepEqual(kinds(splitLabel("a $$x^2$$ b \\[y\\] c")), ["text:a ", "block:x^2", "text: b ", "block:y", "text: c"]);
});

test("covers STEM packages: chemistry, matrices, physics, cancel", () => {
  for (const tex of ["\\ce{H2O}", "\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}", "\\frac{1}{2}", "\\int_0^1 x^2\\,dx", "\\dv{f}{x}", "\\cancel{x}", "\\mathbb{R}", "\\qty(\\frac{a}{b})", "\\xrightarrow{f}", "\\degree"]) {
    assert.ok(drawTex(tex, false), tex);
  }
  assert.equal(drawTex("\\ce{H2O}", false)?.symbols, "H 2 O", "no phantom letters in the symbol text");
});

test("broken math stays as its source text and the rest still renders", () => {
  assert.deepEqual(kinds(splitLabel("bad $\\frac{a}{b$ ok $x$")), ["text:bad $\\frac{a}{b$ ok ", "inline:x"]);
});

test("excluded commands render as plain text: no link, no style or id hook, nothing loaded", () => {
  assert.deepEqual(EXCLUDED_PACKAGES, ["html", "bussproofs", "noerrors", "noundefined", "colorv2"]);
  const untrusted = [
    "\\href{https://example.com}{x}", "\\style{color:red}{x}", "\\class{a}{x}", "\\cssId{a}{x}", "\\require{noerrors}",
    "\\mmlToken{mi}[href=\"https://example.com\"]{x}", "\\mmlToken{mi}[style=\"color:red\"]{x}", "\\mmlToken{mi}[id=\"a\"]{x}",
    "\\mmlToken{mi}[class=\"a\"]{x}", "\\bbox[border:1px solid]{x}", "x \\label{a} \\eqref{a}",
    "\\begin{prooftree}\\AxiomC{A}\\end{prooftree}",
  ];
  for (const tex of untrusted) {
    const label = `try $${tex}$ now`;
    assert.deepEqual(splitLabel(label), [{ kind: "text", text: label }], tex);
  }
  for (const tex of ["P\\to Q", "\\color{red}{x}", "\\unicode{x263A}", "\\boxed{x}", "\\tag{1} x"]) {
    const svg = drawTex(tex, true)?.svg ?? "";
    assert.doesNotMatch(svg, /\b(href|style|class|id)=|<a[\s>]/, tex);
  }
});

test("labels are repaired the way the web repairs them before math is read", () => {
  // JSON escaping turned "\to" into a tab and "o".
  const mangled = "No, $P\to Q$ is blocked.";
  assert.equal(repairMathForDisplay(mangled), LABEL, "the web's ToolContentResponse output");
  assert.deepEqual(kinds(splitLabel(mangled)), kinds(splitLabel(LABEL)));
});

test("typed answers and Other never go through the math reader", () => {
  assert.deepEqual(plainText("$x$ costs $5"), [{ kind: "text", text: "$x$ costs $5" }]);
  const pieces = joinPieces([plainText("typed $a$"), splitLabel("$b$"), plainText("other $c$")], ", ");
  assert.deepEqual(kinds(pieces), ["text:typed $a$, ", "inline:b", "text:, other $c$"]);
  assert.equal(hasMath(plainText("$x$")), false);
});

test("the answer sent to the server is unchanged for a math label", () => {
  const data: QuestionData = {
    id: "call-1", kind: "ask", question: "Which?", mode: "single-select", createdAt: "2026-11-19T00:00:00.000Z",
    options: [{ label: LABEL, value: "no" }, { label: "Yes", value: "yes" }],
  };
  const answer = buildAnswer(data, { values: ["no"], other: "maybe $x$" });
  assert.deepEqual(answer.answers, [{ label: LABEL, value: "no", index: 1 }]);
  assert.equal(answer.other, "maybe $x$");
});

test("reads symbol text when the engine throws, returns nothing, or isn't ready", () => {
  const pieces = splitLabel(LABEL);
  const fallback = "No, P → Q is blocked.";
  assert.equal(spokenLabel(pieces, true, () => { throw new TypeError("Cannot convert undefined value to object"); }), fallback);
  assert.equal(spokenLabel(pieces, true, () => ""), fallback);
  assert.equal(spokenLabel(pieces, false), fallback);
});

test("no web view in a choice row or an answered-card answer", () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  const between = (text: string, start: string, end: string) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
  const parts = [
    source("../src/MathLabel.tsx"), source("../src/choice-math.ts"),
    between(source("../src/BuiltinQuestion.tsx"), "function Option(", "export function questionData"),
    between(source("../src/Transcript.tsx"), "function AnsweredResponse(", "\n}\n"),
  ];
  for (const part of parts) assert.doesNotMatch(part, /WebView|react-native-webview|<Markdown|NativeMarkdown/);
});

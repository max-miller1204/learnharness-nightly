import assert from "node:assert/strict";
import test from "node:test";
import { repairMathForDisplay } from "../../../src/core/math-delims.ts";
import { buildAnswer, type QuestionData } from "../../../src/core/question-core.ts";
import { drawTex, EXCLUDED_PACKAGES, hasMath, joinPieces, plainText, splitLabel, type LabelPiece } from "../src/choice-math.ts";
import { spokenLabel } from "../src/math-speech.ts";

const LABEL = "No, $P\\to Q$ is blocked.";
const kinds = (pieces: LabelPiece[]) => pieces.map((piece) => piece.kind === "math" ? `${piece.display ? "block" : "inline"}:${piece.tex}` : `text:${piece.text}`);
const asText = (label: string) => [{ kind: "text", text: label }];
const read = (tex: string) => drawTex(tex, false)?.symbols;

test("draws inline math and keeps the text around it", () => {
  const pieces = splitLabel(LABEL);
  assert.deepEqual(kinds(pieces), ["text:No, ", "inline:P\\to Q", "text: is blocked."]);
  const math = pieces[1];
  assert.ok(math?.kind === "math" && math.drawn.svg.startsWith("<svg") && math.drawn.width > 0 && math.drawn.height > 0);
  assert.equal(math.drawn.symbols, "P → Q");
});

test("block math follows the web's parser: mid-line $$ is inline, fences and \\[ are blocks", () => {
  assert.deepEqual(kinds(splitLabel("a \\(x\\) b $y$ c")), ["text:a ", "inline:x", "text: b ", "inline:y", "text: c"]);
  assert.deepEqual(kinds(splitLabel("a $$x^2$$ b")), ["text:a ", "inline:x^2", "text: b"]);
  assert.deepEqual(kinds(splitLabel("a\n$$\nx^2\n$$\nb")), ["text:a\n", "block:x^2", "text:\nb"]);
  assert.deepEqual(kinds(splitLabel("a\n$$$\nx^2\n$$$\nb")), ["text:a\n", "block:x^2", "text:\nb"]);
  assert.deepEqual(kinds(splitLabel("a \\[y\\] c")), ["text:a ", "block:y", "text: c"]);
});

test("covers STEM packages: chemistry, matrices, cancel, units, braket", () => {
  for (const tex of ["\\ce{H2O}", "\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}", "\\frac{1}{2}", "\\int_0^1 x^2\\,dx", "\\cancel{x}", "\\mathbb{R}", "\\xrightarrow{f}", "\\degree", "\\text{café}"]) {
    assert.ok(drawTex(tex, false), tex);
  }
  assert.equal(read("\\ce{H2O}"), "H subscript 2 O", "no phantom letters");
});

test("standard commands mean what they mean on the web (no physics package)", () => {
  assert.deepEqual(EXCLUDED_PACKAGES, ["html", "bussproofs", "action", "noerrors", "noundefined"]);
  assert.equal(read("6 \\div 2"), "6 ÷ 2");
  assert.equal(read("\\braket{\\psi|\\phi}"), "⟨ ψ | ϕ ⟩");
  assert.equal(read("\\Re z"), "ℜ z");
  assert.equal(drawTex("\\dv{f}{x}", false), undefined);
});

test("TeX that throws while drawing stays as its source text", () => {
  for (const tex of ["\\toggle{a}{b}\\endtoggle", "\\mathtip{a}{b}", "\\mmlToken{mi}[mathvariant=x]{x}", "\\unicode{x110000}"]) {
    assert.equal(drawTex(tex, false), undefined, tex);
    assert.deepEqual(splitLabel(`Pick $${tex}$`), asText(`Pick $${tex}$`), tex);
  }
});

test("broken math, and a standalone undefined command, stay as source text", () => {
  assert.deepEqual(kinds(splitLabel("bad $\\frac{a}{b$ ok $x$")), ["text:bad $\\frac{a}{b$ ok ", "inline:x"]);
  assert.deepEqual(splitLabel("then $\\myterm$"), asText("then $\\myterm$"));
});

test("nothing one equation defines reaches another", () => {
  assert.equal(read("\\renewcommand{\\to}{\\leftarrow} P\\to Q"), "P ← Q");
  assert.equal(read("P\\to Q"), "P → Q");
  assert.ok(drawTex("\\newcommand{\\mine}{m} \\mine", false));
  assert.equal(drawTex("\\mine", false), undefined);
  assert.ok(drawTex("\\definecolor{mine}{rgb}{1,0,0} \\color{mine}{x}", false));
  assert.equal(drawTex("\\color{mine}{x}", false), undefined);
  assert.deepEqual(kinds(splitLabel("$\\def\\a{1}\\a$ and $\\a$")), ["inline:\\def\\a{1}\\a", "text: and $\\a$"]);
});

test("a label used twice draws once, with no multiply-defined error", () => {
  const drawn = drawTex("x \\label{a}", true);
  assert.ok(drawn);
  assert.doesNotMatch(drawn.svg, /multiply|merror/i);
  assert.ok(drawTex("y \\label{a}", true), "a later equation may use the same label");
});

test("excluded commands render as plain text: no link, no style or id hook, nothing loaded", () => {
  const untrusted = [
    "\\href{https://example.com}{x}", "\\style{color:red}{x}", "\\class{a}{x}", "\\cssId{a}{x}", "\\require{noerrors}",
    "\\mmlToken{mi}[href=\"https://example.com\"]{x}", "\\mmlToken{mi}[style=\"color:red\"]{x}", "\\mmlToken{mi}[id=\"a\"]{x}",
    "\\mmlToken{mi}[class=\"a\"]{x}", "\\mmlToken{mi}[fontfamily=Arial]{x}", "\\unicode[Arial]{x263A}", "\\unicode[serif]{x263A}",
    "\\bbox[border:1px solid]{x}", "x \\label{a} \\eqref{a}", "\\begin{prooftree}\\AxiomC{A}\\end{prooftree}",
    // MathJax gives a displayed tag an id and a full-width layout.
    "\\[x \\tag{1}\\]",
  ];
  for (const tex of untrusted) {
    const label = tex.startsWith("\\[") ? tex : `try $${tex}$ now`;
    assert.deepEqual(splitLabel(label), asText(label), tex);
  }
  for (const tex of ["P\\to Q", "\\color{red}{x}", "\\boxed{x}", "\\text{日本}"]) {
    const svg = drawTex(tex, true)?.svg;
    assert.ok(svg, tex);
    assert.doesNotMatch(svg, /\s(href|style|class|id)=|<a[\s>]/, tex);
    // MathJax's own font for characters outside its font is the only family it names.
    assert.ok([...svg.matchAll(/font-family="([^"]*)"/g)].every(([, family]) => family === "serif"), tex);
  }
});

test("colors too close to a row background, or unknown ones, stay as source text", () => {
  for (const tex of ["\\color{white}x", "\\color{black}x", "\\color[rgb]{1,1,1}x", "\\color{aliceblue}x", "\\colorbox{white}{x}"]) {
    assert.equal(drawTex(tex, false), undefined, tex);
  }
  for (const tex of ["\\color{red}x", "\\color{blue}x", "\\color{RoyalBlue}x", "\\color{#d97706}x"]) assert.ok(drawTex(tex, false), tex);
});

test("without speech, math reads as words that keep its structure", () => {
  assert.equal(read("x^2"), "x superscript 2");
  assert.equal(read("x_2"), "x subscript 2");
  assert.equal(read("x_i^2"), "x subscript i superscript 2");
  assert.equal(read("\\frac{1}{2}"), "1 over 2");
  assert.equal(read("\\frac{a+b}{c}"), "start fraction a + b over c end fraction");
  assert.equal(read("\\sqrt{x}"), "square root of x");
  assert.equal(read("\\sqrt{x+1}"), "start root x + 1 end root");
  assert.equal(read("\\sqrt[3]{x}"), "root 3 of x");
  assert.equal(read("\\sum_{i=1}^{n} i"), "∑ from i = 1 to n i");
  assert.equal(read("\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}"), "( 1, 2; 3, 4 )");
  assert.notEqual(read("x^2"), read("x_2"));
});

test("labels are repaired the way the web repairs them before math is read", () => {
  // JSON escaping turned "\to" into a tab and "o".
  const mangled = "No, $P\to Q$ is blocked.";
  assert.equal(repairMathForDisplay(mangled), LABEL, "the web's ToolContentResponse output");
  assert.deepEqual(kinds(splitLabel(mangled)), kinds(splitLabel(LABEL)));
});

test("typed answers and Other never go through the math reader", () => {
  assert.deepEqual(plainText("$x$ costs $5"), asText("$x$ costs $5"));
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

test("reads the math as words when the engine throws, returns nothing, or isn't ready", () => {
  const pieces = splitLabel(LABEL);
  const fallback = "No, P → Q is blocked.";
  assert.equal(spokenLabel(pieces, true, () => { throw new TypeError("Cannot convert undefined value to object"); }), fallback);
  assert.equal(spokenLabel(pieces, true, () => ""), fallback);
  assert.equal(spokenLabel(pieces, false), fallback);
});

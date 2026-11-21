import assert from "node:assert/strict";
import test from "node:test";
import { repairMathForDisplay } from "../../../src/core/math-delims.ts";
import { buildAnswer, type QuestionData } from "../../../src/core/question-core.ts";
import { drawTex, EXCLUDED_PACKAGES, flattening, hasMath, joinPieces, plainText, splitLabel, tagClassCount, type LabelPiece } from "../src/choice-math.ts";
import { spokenLabel } from "../src/math-speech.ts";

const LABEL = "No, $P\\to Q$ is blocked.";
const kinds = (pieces: LabelPiece[]) => pieces.map((piece) => piece.kind === "math" ? `${piece.display ? "block" : "inline"}:${piece.tex}` : `text:${piece.text}`);
const asText = (label: string) => [{ kind: "text", text: label }];
const read = (tex: string) => drawTex(tex, false)?.symbols;

test("draws inline math and keeps the text around it", () => {
  const pieces = splitLabel(LABEL);
  assert.deepEqual(kinds(pieces), ["text:No, ", "inline:P\\to Q", "text: is blocked."]);
  const math = pieces[1];
  assert.ok(math?.kind === "math" && math.drawn.svg.dark.startsWith("<svg") && math.drawn.width > 0 && math.drawn.height > 0);
  assert.equal(math.drawn.symbols, "P → Q");
});

test("block math follows the web's parser: mid-line $$ is inline, fences and \\[ are blocks", () => {
  assert.deepEqual(kinds(splitLabel("a \\(x\\) b $y$ c")), ["text:a ", "inline:x", "text: b ", "inline:y", "text: c"]);
  assert.deepEqual(kinds(splitLabel("a $$x^2$$ b")), ["text:a ", "inline:x^2", "text: b"]);
  assert.deepEqual(kinds(splitLabel("a\n$$\nx^2\n$$\nb")), ["text:a", "block:x^2", "text:b"]);
  assert.deepEqual(kinds(splitLabel("a\n$$$\nx^2\n$$$\nb")), ["text:a", "block:x^2", "text:b"]);
  assert.deepEqual(kinds(splitLabel("a \\[y\\] c")), ["text:a", "block:y", "text:c"]);
  // Indented legacy display math reads inline, as the web's transformMathDelimiters makes it.
  assert.deepEqual(kinds(splitLabel("a\n  \\[x\\]\nb")), ["text:a\n  ", "inline:x", "text:\nb"]);
});

test("block math has no blank lines around it", () => {
  assert.deepEqual(kinds(splitLabel("Area:\n$$\nx^2\n$$\nhere")), ["text:Area:", "block:x^2", "text:here"]);
});

test("covers STEM packages: matrices, cancel, units, braket", () => {
  for (const tex of ["\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}", "\\frac{1}{2}", "\\int_0^1 x^2\\,dx", "\\cancel{x}", "\\mathbb{R}", "\\xrightarrow{f}", "\\degree", "\\text{café}"]) {
    assert.ok(drawTex(tex, false), tex);
  }
});

test("standard commands mean what they mean on the web (no physics or mhchem package)", () => {
  assert.deepEqual(EXCLUDED_PACKAGES, [
    "html", "bussproofs", "action", "noerrors", "noundefined",
    "mhchem", "bbox", "cases", "centernot", "colortbl", "empheq", "enclose", "upgreek", "unicode",
  ]);
  // The web's KaTeX has none of these packages, so their commands stay source there and here.
  for (const tex of ["\\ce{H2O}", "\\bbox[5px]{x}", "\\begin{numcases}{f(x)=} 1 & x \\end{numcases}", "\\centernot\\to",
    "\\begin{array}{c}\\rowcolor{red} x\\end{array}", "\\begin{empheq}[left=\\{]{align}a\\end{empheq}", "\\enclose{circle}{x}",
    "\\upalpha", "\\unicode{x263A}"]) {
    assert.deepEqual(splitLabel(`Try $${tex}$`), asText(`Try $${tex}$`), tex);
  }
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
  assert.match(drawTex("\\definecolor{mine}{rgb}{1,0,0} \\color{mine}{x}", false)?.svg.dark ?? "", /fill="#FF0000"/i);
  assert.doesNotMatch(drawTex("\\color{mine}{x}", false)?.svg.dark ?? "", /#FF0000/i, "an unknown color is dropped");
  assert.deepEqual(kinds(splitLabel("$\\def\\a{1}\\a$ and $\\a$")), ["inline:\\def\\a{1}\\a", "text: and $\\a$"]);
});

test("a label used twice draws once, with no multiply-defined error", () => {
  const drawn = drawTex("x \\label{a}", true);
  assert.ok(drawn);
  assert.doesNotMatch(drawn.svg.dark, /multiply|merror/i);
  assert.ok(drawTex("y \\label{a}", true), "a later equation may use the same label");
});

test("excluded commands render as plain text: no link, no style or id hook, nothing loaded", () => {
  const untrusted = [
    "\\href{https://example.com}{x}", "\\style{color:red}{x}", "\\class{a}{x}", "\\cssId{a}{x}", "\\require{noerrors}",
    "\\mmlToken{mi}[href=\"https://example.com\"]{x}", "\\mmlToken{mi}[style=\"color:red\"]{x}", "\\mmlToken{mi}[id=\"a\"]{x}",
    "\\mmlToken{mi}[class=\"a\"]{x}", "\\mmlToken{mi}[class=MathML-Unit]{x}", "\\mmlToken{mi}[fontfamily=Arial]{x}", "\\unicode[Arial]{x263A}", "\\unicode[serif]{x263A}",
    "\\bbox[border:1px solid]{x}", "x \\label{a} \\eqref{a}", "\\begin{prooftree}\\AxiomC{A}\\end{prooftree}",
    // MathJax gives a displayed tag an id and a full-width layout.
    "\\[x \\tag{1}\\]",
  ];
  for (const tex of untrusted) {
    const label = tex.startsWith("\\[") ? tex : `try $${tex}$ now`;
    assert.deepEqual(splitLabel(label), asText(label), tex);
  }
  for (const tex of ["P\\to Q", "\\color{red}{x}", "\\boxed{x}", "\\text{日本}", "\\degree", "\\mmlToken{mi}[class=MathML-Unit]{\u00B0}"]) {
    const svg = drawTex(tex, true)?.svg.dark;
    assert.ok(svg, tex);
    assert.doesNotMatch(svg, /\s(href|style|class|id)=|<a[\s>]/, tex);
    // MathJax's own font for characters outside its font is the only family it names.
    assert.ok([...svg.matchAll(/font-family="([^"]*)"/g)].every(([, family]) => family === "serif"), tex);
  }
});

test("invisible colors stay as source text", () => {
  for (const tex of ["\\color{transparent}x", "\\color{none}x", "\\mmlToken{mi}[mathcolor=\"transparent\"]{x}",
    "\\mmlToken{mi}[mathbackground=\"none\"]{x}", "\\mmlToken{mi}[color=\"transparent\"]{x}"]) {
    assert.equal(drawTex(tex, false), undefined, tex);
  }
});

test("a rule is drawn in the text's color or its own \\color, and kept when a theme drops colors", () => {
  // MathJax fills a \rule with black when no \color is in effect (#317).
  const shapes = (svg: string) => svg.match(/<(?:path|rect)\b[^>]*>/g) ?? [];
  const fills = (svg: string) => shapes(svg).map((shape) => /fill="([^"]*)"/.exec(shape)?.[1]);
  for (const on of [true, false]) {
    flattening.on = on;
    try {
      const plain = drawTex("\\rule{1em}{2em}", false)?.svg;
      assert.ok(plain);
      assert.deepEqual(fills(plain.dark), ["currentColor"], `flattened ${on}`);
      assert.deepEqual(fills(plain.light), ["currentColor"], `flattened ${on}`);
      const black = drawTex("\\color{black}{\\rule{1em}{1em}}", false)?.svg;
      assert.ok(black);
      assert.ok(fills(black.light).includes("black"), "black stands out on the light theme");
      assert.ok(fills(black.dark).length > 0 && !fills(black.dark).includes("black"), "dropped to the text color on the dark theme, not dropped");
      const red = drawTex("\\color{red}{\\rule{1em}{1em}}", false)?.svg;
      assert.ok(red && fills(red.dark).includes("red") && fills(red.light).includes("red"));
      // A glyph that doesn't stand out takes the whole picture to the text color, the rule too:
      // the rule's right edge (x 1572), or its rectangle, is still drawn.
      const beside = drawTex("\\color{navy}{x}\\rule{1em}{1em}", false)?.svg;
      assert.ok(beside && fills(beside.dark).every((fill) => fill === undefined || fill === "currentColor") && /H1572V|<rect[^>]*width="1000"/.test(beside.dark), `flattened ${on}`);
    } finally {
      flattening.on = true;
    }
  }
  // A rule takes the nearest \color above it, even from math inside \text, which MathJax
  // parses apart and fills with black; a color written for the rule itself stays.
  for (const tex of ["\\textcolor{red}{x\\text{$\\rule{1em}{1em}$}}", "\\text{\\color{red}\\rule[2pt]{1em}{1em}}",
    "\\mmlToken{mspace}[width=\"1em\",height=\"1em\",mathbackground=\"red\"]{}"]) {
    const svg = drawTex(tex, false)?.svg;
    assert.ok(svg, tex);
    assert.deepEqual([...new Set([...fills(svg.light), ...fills(svg.dark)])], ["red"], tex);
  }
  // A box behind text is still a box, and still dropped where its color doesn't stand out.
  const box = drawTex("\\colorbox{yellow}{x}", false)?.svg;
  assert.ok(box && box.light.includes('<rect fill="yellow"') && !box.dark.includes("<rect"));
});

test("a color that doesn't stand out in a theme is dropped there, not shown as source", () => {
  const colored = (tex: string) => { const drawn = drawTex(tex, false); assert.ok(drawn, tex); return drawn.svg; };
  const keeps = (svg: string) => /fill="(?!currentColor|none)/.test(svg);
  // Readable in both themes.
  for (const tex of ["\\color{red}x", "\\color{teal}x", "\\color{#e11d48}x"]) assert.ok(keeps(colored(tex).dark) && keeps(colored(tex).light), tex);
  // Readable only on the light theme.
  for (const tex of ["\\color{navy}x", "\\color{darkblue}x", "\\color{maroon}x", "\\color{blue}x", "\\color{black}x"]) {
    const svg = colored(tex);
    assert.ok(!keeps(svg.dark) && keeps(svg.light), tex);
  }
  // Readable only on the dark theme.
  for (const tex of ["\\color{yellow}x", "\\color{white}x"]) {
    const svg = colored(tex);
    assert.ok(keeps(svg.dark) && !keeps(svg.light), tex);
  }
  // Text against the box drawn behind it: a solid block, or dark text on purple.
  for (const tex of ["\\colorbox{red}{\\color{red}x}", "\\colorbox{purple}{\\color{black}x}"]) {
    const svg = colored(tex);
    assert.ok(!svg.dark.includes("<rect") && !svg.light.includes("<rect") && !keeps(svg.dark) && !keeps(svg.light), tex);
  }
  // Theme text on a purple box fails on Ivory (dark text) but not on the dark theme.
  const purple = colored("\\colorbox{purple}{x}");
  assert.ok(purple.dark.includes("<rect") && !purple.light.includes("<rect"));
  // An unknown color name is dropped in both.
  const unknown = colored("\\color{aliceblue}x");
  assert.ok(!keeps(unknown.dark) && !keeps(unknown.light));
});

test("drawing never grows MathJax's tag registry", () => {
  drawTex("x", false);
  const before = tagClassCount();
  for (let index = 0; index < 50; index++) drawTex(`x_${index} \\label{a${index}}`, true);
  assert.equal(tagClassCount(), before);
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
  assert.equal(read("\\prescript{a}{b}{X}"), "pre-subscript b pre-superscript a X");
  assert.equal(read("X_b^a"), "X subscript b superscript a");
  assert.notEqual(read("x^2"), read("x_2"));
});

test("math that fails to draw shows the label's own text, not the repaired one", () => {
  const mangled = "Then $P\to Q \\frac{a}{b$ fails";
  assert.deepEqual(splitLabel(mangled), asText(mangled));
});

test("words and math that touch are read with a space between them", () => {
  assert.equal(spokenLabel(splitLabel("Area:\\[x^2\\]"), false), "Area: x superscript 2");
  assert.equal(spokenLabel(splitLabel("the $n$th term, $x$."), false), "the n th term, x.");
  assert.equal(spokenLabel(splitLabel("($x$)"), false), "(x)");
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

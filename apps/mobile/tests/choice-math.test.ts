import assert from "node:assert/strict";
import test from "node:test";
import { splitLabel } from "../src/choice-math.ts";
import { spokenLabel, startSpeech } from "../src/math-speech.ts";

const LABEL = "No, $P\\to Q$ is blocked.";

test("draws inline math and keeps the text around it", () => {
  const pieces = splitLabel(LABEL);
  assert.deepEqual(pieces.map((piece) => piece.kind), ["text", "math", "text"]);
  const math = pieces[1];
  assert.ok(math?.kind === "math" && math.drawn.svg.startsWith("<svg") && math.drawn.width > 0);
});

test("broken math stays as its source text", () => {
  assert.deepEqual(splitLabel("bad $\\frac{a}{b$ ok"), [{ kind: "text", text: "bad $\\frac{a}{b$ ok" }]);
});

test("speaks the math once the engine is ready", async () => {
  await startSpeech();
  assert.equal(spokenLabel(splitLabel(LABEL), true), "No, P right arrow Q is blocked.");
});

test("reads symbol text when the engine throws, returns nothing, or isn't ready", () => {
  const pieces = splitLabel(LABEL);
  const fallback = "No, P → Q is blocked.";
  assert.equal(spokenLabel(pieces, true, () => { throw new TypeError("Cannot convert undefined value to object"); }), fallback);
  assert.equal(spokenLabel(pieces, true, () => ""), fallback);
  assert.equal(spokenLabel(pieces, false), fallback);
});

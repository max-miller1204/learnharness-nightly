import assert from "node:assert/strict";
import test from "node:test";
import { revealOffset } from "../src/reveal.ts";

test("scrolls a field hidden below the viewport up into view", () => {
  // Thinking field at 400-472 in a 250-tall viewport scrolled to the top.
  assert.equal(revealOffset({ y: 400, height: 72 }, 250, 0), 400 + 72 + 16 - 250);
});

test("scrolls a field above the viewport back down into view", () => {
  assert.equal(revealOffset({ y: 40, height: 40 }, 250, 200), 24);
  assert.equal(revealOffset({ y: 8, height: 40 }, 250, 200), 0);
});

test("leaves a fully visible field alone", () => {
  assert.equal(revealOffset({ y: 100, height: 40 }, 250, 50), null);
});

test("aligns a field taller than the viewport by its top", () => {
  assert.equal(revealOffset({ y: 300, height: 400 }, 250, 0), 284);
  assert.equal(revealOffset({ y: 300, height: 400 }, 250, 284), null);
});

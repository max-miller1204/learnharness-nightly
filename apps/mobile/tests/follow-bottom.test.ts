import assert from "node:assert/strict";
import test from "node:test";
import { followsBottom } from "../src/follow-bottom.ts";

test("only the learner's own scrolling stops following the bottom", () => {
  const at = (distance: number, previousDistance: number, dragging = false) => ({ distance, previousDistance, dragging });
  // A scroll that did not move up keeps following, even away from the bottom.
  assert.equal(followsBottom(true, at(400, 400)), true);
  assert.equal(followsBottom(true, at(400, 600)), true);
  // The learner dragged up: stop following.
  assert.equal(followsBottom(true, at(400, 300, true)), false);
  // A screen reader or keyboard scroll up has no drag, but it moved up: stop following.
  assert.equal(followsBottom(true, at(400, 0)), false);
  // Not following, and a scroll that did not come back down near the bottom: stay put.
  assert.equal(followsBottom(false, at(900, 900)), false);
  // Back near the bottom, by any scroll (also the end of a fling): follow again.
  assert.equal(followsBottom(false, at(40, 900)), true);
  assert.equal(followsBottom(false, at(40, 30, true)), true);
});

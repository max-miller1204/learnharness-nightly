import assert from "node:assert/strict";
import test from "node:test";
import { followsBottom, openSettle } from "../src/open-settle.ts";

test("settles once the content stops growing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = 0;
  const settler = openSettle(() => settled++, { quietMs: 250, maxMs: 2000 });
  t.mock.timers.tick(200);
  settler.changed(); // a math block finished loading and grew
  t.mock.timers.tick(200);
  assert.equal(settled, 0);
  t.mock.timers.tick(50);
  assert.equal(settled, 1);
  settler.changed();
  t.mock.timers.tick(5000);
  assert.equal(settled, 1);
});

test("settles at the cap while the content keeps growing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = 0;
  const settler = openSettle(() => settled++, { quietMs: 250, maxMs: 2000 });
  for (let elapsed = 0; elapsed < 1900; elapsed += 100) {
    t.mock.timers.tick(100);
    settler.changed();
  }
  assert.equal(settled, 0);
  t.mock.timers.tick(100);
  assert.equal(settled, 1);
});

test("a cancelled open never settles", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = 0;
  const settler = openSettle(() => settled++);
  settler.cancel();
  t.mock.timers.tick(5000);
  assert.equal(settled, 0);
});

test("waits for math views that have not reported their height", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = 0;
  let loading = 2;
  const settler = openSettle(() => settled++, { quietMs: 250, maxMs: 2000, loading: () => loading > 0 });
  t.mock.timers.tick(1000);
  assert.equal(settled, 0);
  loading = 0;
  settler.changed(); // the last math view reported
  t.mock.timers.tick(250);
  assert.equal(settled, 1);
});

test("math views that never report still settle at the cap", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = 0;
  openSettle(() => settled++, { quietMs: 250, maxMs: 2000, loading: () => true });
  t.mock.timers.tick(1999);
  assert.equal(settled, 0);
  t.mock.timers.tick(1);
  assert.equal(settled, 1);
});

test("only the learner's own scrolling stops following the bottom", () => {
  // Our jump to the end, reported after the content grew by 400: keep following.
  assert.equal(followsBottom(true, 400, false), true);
  // The learner scrolled up: stop following.
  assert.equal(followsBottom(true, 400, true), false);
  // Not following, and content keeps growing: stay put.
  assert.equal(followsBottom(false, 900, false), false);
  // Back near the bottom, by any scroll: follow again.
  assert.equal(followsBottom(false, 40, false), true);
  assert.equal(followsBottom(false, 40, true), true);
});

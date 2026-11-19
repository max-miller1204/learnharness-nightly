import assert from "node:assert/strict";
import test from "node:test";
import { atBottom, followsBottom, openSettle, pendingCounter } from "../src/open-settle.ts";

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
  const at = (distance: number, offset: number, previousOffset: number, dragging = false) => ({ distance, offset, previousOffset, dragging });
  // Our jump to the end, reported after the content grew by 400: keep following.
  assert.equal(followsBottom(true, at(400, 1000, 600)), true);
  assert.equal(followsBottom(true, at(400, 1000, 1000)), true);
  // The learner dragged up: stop following.
  assert.equal(followsBottom(true, at(400, 900, 1000, true)), false);
  // A screen reader or keyboard scroll up has no drag, but it moved up: stop following.
  assert.equal(followsBottom(true, at(400, 600, 1000)), false);
  // Not following, and content keeps growing: stay put.
  assert.equal(followsBottom(false, at(900, 600, 600)), false);
  // Back near the bottom, by any scroll (also the end of a fling): follow again.
  assert.equal(followsBottom(false, at(40, 1500, 600)), true);
  assert.equal(followsBottom(false, at(40, 1500, 1400, true)), true);
});

test("the loading counter counts each view once and reports when all are done", () => {
  let idle = 0;
  const counter = pendingCounter(() => idle++);
  const first = counter.begin();
  const second = counter.begin();
  assert.equal(counter.count, 2);
  first();
  first(); // the same view reports twice
  assert.equal(counter.count, 1);
  assert.equal(idle, 0);
  second();
  assert.equal(counter.count, 0);
  assert.equal(idle, 1);
  second(); // it unmounts after reporting
  assert.equal(counter.count, 0);
  assert.equal(idle, 1);
});

test("a view that goes away before reporting stops counting", () => {
  let idle = 0;
  const counter = pendingCounter(() => idle++);
  const unmount = counter.begin();
  unmount();
  assert.equal(counter.count, 0);
  assert.equal(idle, 1);
});

test("waits until the view is at the bottom before settling", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = 0;
  let bottom = false;
  const settler = openSettle(() => settled++, { quietMs: 250, maxMs: 2000, ready: () => bottom });
  t.mock.timers.tick(500);
  assert.equal(settled, 0); // quiet, but the jump to the end has not landed
  bottom = true;
  settler.changed(); // the scroll event of the jump arrived
  t.mock.timers.tick(250);
  assert.equal(settled, 1);
});

test("a view that never reaches the bottom still settles at the cap", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = 0;
  openSettle(() => settled++, { quietMs: 250, maxMs: 2000, ready: () => false });
  t.mock.timers.tick(1999);
  assert.equal(settled, 0);
  t.mock.timers.tick(1);
  assert.equal(settled, 1);
});

test("at the bottom means the reported position reaches the reported end", () => {
  assert.equal(atBottom({ content: 5000, offset: 4200, viewport: 800 }), true);
  assert.equal(atBottom({ content: 5000, offset: 4199, viewport: 800 }), true); // rounding
  assert.equal(atBottom({ content: 5000, offset: 900, viewport: 800 }), false); // turn 10 of 64
  assert.equal(atBottom({ content: 400, offset: 0, viewport: 800 }), true); // shorter than the screen
  assert.equal(atBottom({ content: 0, offset: 0, viewport: 0 }), false); // nothing measured yet
});

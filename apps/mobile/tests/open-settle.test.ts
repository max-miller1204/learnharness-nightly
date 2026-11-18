import assert from "node:assert/strict";
import test from "node:test";
import { openSettle } from "../src/open-settle.ts";

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

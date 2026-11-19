import assert from "node:assert/strict";
import test from "node:test";
import { pressInGuard } from "../src/press-in.ts";

test("a touch acts once, on press-in", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let acted = 0;
  const act = () => acted++;
  const guard = pressInGuard();
  guard.pressIn(act);
  guard.pressOut();
  guard.press(act); // the same gesture's press, before the deferred reset
  assert.equal(acted, 1);
  t.mock.timers.tick(0);
  guard.pressIn(act); // the next touch acts again
  assert.equal(acted, 2);
});

test("an activation with no touch (a TalkBack double tap) acts through onPress", () => {
  let acted = 0;
  pressInGuard().press(() => acted++);
  assert.equal(acted, 1);
});

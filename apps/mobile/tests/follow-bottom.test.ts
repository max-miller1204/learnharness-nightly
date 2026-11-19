import assert from "node:assert/strict";
import test from "node:test";
import { createFollower, followsBottom, listMode, scrollPosition } from "../src/follow-bottom.ts";

test("only the learner's own scrolling stops following the bottom", () => {
  const at = (distance: number, movedUp: boolean, dragging = false) => ({ distance, movedUp, dragging });
  // A scroll that did not move up keeps following, even away from the bottom.
  assert.equal(followsBottom(true, at(400, false)), true);
  // The learner dragged: stop following.
  assert.equal(followsBottom(true, at(400, false, true)), false);
  // A screen reader or keyboard scroll up has no drag, but it moved up: stop following.
  assert.equal(followsBottom(true, at(400, true)), false);
  // Not following, and a scroll that did not come back near the bottom: stay put.
  assert.equal(followsBottom(false, at(900, false)), false);
  // Back near the bottom, by any scroll (also the end of a fling): follow again.
  assert.equal(followsBottom(false, at(40, false)), true);
  assert.equal(followsBottom(false, at(40, true, true)), true);
});

test("the inverted list measures from the bottom", () => {
  // At the latest message.
  assert.deepEqual(scrollPosition(true, { offset: 0, content: 5000, viewport: 800 }, 0), { distance: 0, movedUp: false });
  // Scrolled up toward older messages: the offset grows.
  assert.deepEqual(scrollPosition(true, { offset: 600, content: 5000, viewport: 800 }, 0), { distance: 600, movedUp: true });
  // Older messages growing above do not change the offset, so it is not a move.
  assert.deepEqual(scrollPosition(true, { offset: 0, content: 5600, viewport: 800 }, 0), { distance: 0, movedUp: false });
});

test("the plain list (screen reader on) measures from the top", () => {
  assert.deepEqual(scrollPosition(false, { offset: 4200, content: 5000, viewport: 800 }, 4200), { distance: 0, movedUp: false });
  // Scrolled up: the offset shrinks.
  assert.deepEqual(scrollPosition(false, { offset: 3600, content: 5000, viewport: 800 }, 4200), { distance: 600, movedUp: true });
  // New content below grows the distance, but the offset did not move up.
  assert.deepEqual(scrollPosition(false, { offset: 4200, content: 5600, viewport: 800 }, 4200), { distance: 600, movedUp: false });
});

test("the scroll-to-end button shows while scrolled away and hides again at the end", () => {
  const shown: boolean[] = [];
  const follower = createFollower((following) => shown.push(!following));
  // Inverted list: scrolling up toward older messages.
  follower.scrolled(true, { offset: 600, content: 5000, viewport: 800 }, true);
  assert.equal(follower.following, false);
  assert.deepEqual(shown, [true]);
  // The button jumps to the end and follows again.
  follower.follow(true);
  assert.deepEqual(shown, [true, false]);
  // Its own scroll down does not stop following.
  follower.scrolled(true, { offset: 300, content: 5000, viewport: 800 }, false);
  follower.scrolled(true, { offset: 0, content: 5000, viewport: 800 }, false);
  assert.equal(follower.following, true);
  assert.deepEqual(shown, [true, false]);
});

test("switching list mode starts the new list at the bottom", () => {
  const shown: boolean[] = [];
  const follower = createFollower((following) => shown.push(!following));
  follower.scrolled(true, { offset: 600, content: 5000, viewport: 800 }, true);
  follower.reset();
  assert.equal(follower.following, true);
  assert.equal(follower.lastOffset, 0);
  assert.deepEqual(shown, [true, false]);
  // In the plain list the first jump to the end moves down: still following.
  follower.scrolled(false, { offset: 4200, content: 5000, viewport: 800 }, false);
  assert.equal(follower.following, true);
});

test("the list waits for the screen reader state, then picks the order", () => {
  assert.equal(listMode(null), "unknown");
  assert.equal(listMode(false), "inverted");
  assert.equal(listMode(true), "plain");
});

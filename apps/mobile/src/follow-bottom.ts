/**
 * Where a scroll event puts the transcript: its distance from the bottom, and
 * whether it moved up on screen. An inverted list (newest message first) has
 * its offset measured from the bottom; a plain list (used while a screen
 * reader is on, so it reads oldest to newest) from the top.
 */
export function scrollPosition(inverted: boolean, { offset, content, viewport }: { offset: number; content: number; viewport: number }, previousOffset: number) {
  return inverted
    ? { distance: offset, movedUp: offset > previousOffset }
    : { distance: content - offset - viewport, movedUp: offset < previousOffset };
}

/**
 * Whether the transcript keeps following new messages. Near the bottom it
 * follows. Only the learner's own scrolling turns it off: a drag or fling,
 * or any scroll that moved up (a screen reader or keyboard scroll has no
 * drag). Content growing doesn't move the offset, and our own jumps to the
 * bottom only move down.
 */
export function followsBottom(following: boolean, scroll: { distance: number; movedUp: boolean; dragging: boolean }, threshold = 100) {
  if (scroll.distance < threshold) return true;
  return scroll.dragging || scroll.movedUp ? false : following;
}

/**
 * The transcript's follow state. `following` is false while the learner is
 * scrolled away, which is when the scroll-to-end button shows. A new list
 * (switching between the inverted and the plain one) starts at the bottom.
 */
export function createFollower(onChange: (following: boolean) => void) {
  let following = true;
  let lastOffset = 0;
  const follow = (next: boolean) => {
    if (next === following) return;
    following = next;
    onChange(next);
  };
  return {
    get following() { return following; },
    get lastOffset() { return lastOffset; },
    follow,
    scrolled(inverted: boolean, metrics: { offset: number; content: number; viewport: number }, dragging: boolean) {
      const { distance, movedUp } = scrollPosition(inverted, metrics, lastOffset);
      lastOffset = metrics.offset;
      follow(followsBottom(following, { distance, movedUp, dragging }));
    },
    reset() {
      lastOffset = 0;
      follow(true);
    },
  };
}

/** Which transcript list to show: the inverted one, the plain one while a
 *  screen reader is on, or none until the screen reader state is known. */
export function listMode(screenReader: boolean | null): "inverted" | "plain" | "unknown" {
  return screenReader === null ? "unknown" : screenReader ? "plain" : "inverted";
}

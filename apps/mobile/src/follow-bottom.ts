/**
 * Whether the transcript keeps following new messages. The transcript is an
 * inverted list, so its scroll offset is the distance from the bottom. Near
 * the bottom it follows. Only the learner's own scrolling turns it off: a
 * drag or fling, or any scroll that moved up (a screen reader or keyboard
 * scroll has no drag). Content growing does not move an inverted list's
 * offset, and our own jumps to the bottom only move down.
 */
export function followsBottom(following: boolean, scroll: { distance: number; previousDistance: number; dragging: boolean }, threshold = 100) {
  if (scroll.distance < threshold) return true;
  return scroll.dragging || scroll.distance > scroll.previousDistance ? false : following;
}

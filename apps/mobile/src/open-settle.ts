/**
 * Opening a session waits out its first layout. Math blocks are web views
 * that grow as they load, so the transcript keeps getting taller for a
 * moment. Start this from the first real layout of the transcript. `settle`
 * runs once the content has not changed for `quietMs` and nothing is still
 * `loading` (math views that have not reported their height), or after
 * `maxMs` at the latest, so the screen can stay hidden while it pins to the
 * bottom and then appear already showing the latest message (the web's
 * instant initial scroll).
 */
export function openSettle(settle: () => void, { quietMs = 250, maxMs = 2000, loading = (): boolean => false } = {}) {
  let done = false;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    done = true;
    clearTimeout(quiet);
    clearTimeout(cap);
  };
  const finish = () => {
    if (done) return;
    stop();
    settle();
  };
  const cap = setTimeout(finish, maxMs);
  // A view that finishes loading calls `changed` again, which restarts the quiet wait.
  const changed = () => {
    if (done) return;
    clearTimeout(quiet);
    quiet = setTimeout(() => { if (!loading()) finish(); }, quietMs);
  };
  changed();
  return { changed, cancel: stop };
}

/**
 * Whether the transcript keeps following new content. Only the learner's own
 * scrolling turns it off. A scroll event that follows our own jump to the
 * end can report content that grew in the meantime, which looks like being
 * scrolled away from the bottom.
 */
export function followsBottom(following: boolean, distanceFromBottom: number, userScrolling: boolean, threshold = 100) {
  if (distanceFromBottom < threshold) return true;
  return userScrolling ? false : following;
}

/**
 * Opening a session waits out its first layout. Math blocks are web views
 * that grow as they load, so the transcript keeps getting taller for a
 * moment. `settle` runs once the content has not changed for `quietMs`, or
 * after `maxMs` at the latest, so the screen can stay hidden while it pins
 * to the bottom and then appear already showing the latest message (the
 * web's instant initial scroll).
 */
export function openSettle(settle: () => void, { quietMs = 250, maxMs = 2000 } = {}) {
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
  const changed = () => {
    if (done) return;
    clearTimeout(quiet);
    quiet = setTimeout(finish, quietMs);
  };
  changed();
  return { changed, cancel: stop };
}

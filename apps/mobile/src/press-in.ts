/**
 * T3's ControlPill activation (ControlPill.tsx): a touch acts on press-in, and
 * `onPress` stays as the fallback for activations with no touch (a TalkBack
 * double tap or a keyboard), skipped when press-in already acted. Keep one
 * guard for the control's life, so a re-render between press-in and press
 * can't act twice.
 */
export function pressInGuard() {
  let activated = false;
  return {
    pressIn(action: () => void) {
      activated = true;
      action();
    },
    pressOut() {
      // Pressability calls onPressOut before onPress for the same gesture.
      setTimeout(() => { activated = false; }, 0);
    },
    press(action: () => void) {
      if (!activated) action();
    },
  };
}

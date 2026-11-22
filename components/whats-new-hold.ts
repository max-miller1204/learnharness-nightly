/**
 * Holds the What's new popup (components/whats-new-dialog.tsx) back while the sidebar's
 * Update everything capsule shows a run (components/sidebar-update-pill.tsx): a modal over the
 * countdown would keep its Later from the keyboard. Held back, it is not marked seen, so it
 * shows once the run ends, or on the next launch after the restart.
 */

import { useSyncExternalStore } from "react";

let held = false;
const listeners = new Set<() => void>();

export function holdWhatsNew(hold: boolean) {
	if (held === hold) return;
	held = hold;
	for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
};

export function useWhatsNewHeld(): boolean {
	return useSyncExternalStore(subscribe, () => held, () => false);
}

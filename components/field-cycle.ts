"use client";

import { useEffect } from "react";
import { useOptionalInteractionLayers, type InteractionLayersController } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";

/**
 * TAB CYCLES THE ACTIVE SURFACE'S TEXT FIELDS (owner, keyboard round
 * 2026-10-06): forward-only, wrapping; Tab from outside the chain
 * focuses the FIRST field — "navigate in". Shift+Tab is NOT ours (the
 * global thinking-level cycle owns it — owner ruling the same round),
 * so there is no reverse gear; the chain wraps.
 *
 * The event (not a prop bridge): the global Tab handler dispatches
 * `lh:kbd-cycle-fields` and each composer-bearing surface answers with
 * its own chain, gathered at event time from live DOM — the fields
 * mount/unmount with the docks, so a query beats stale refs. The quiz
 * dock's own Tab claim (rows ↔ thinking, while an option question is
 * expanded) stops propagation at the document level, so this hook only
 * ever hears Tab on surfaces WITHOUT an active claim — no double act.
 */
export function useFieldCycle(
	fields: () => readonly HTMLElement[],
	/** Which of them Tab may land on; by default the strict command scope (covered, hidden,
	 *  disabled or aria-disabled fields never take it). */
	eligible: (el: HTMLElement, controller: InteractionLayersController | null) => boolean = isInteractionScopeEligible,
) {
	const controller = useOptionalInteractionLayers();
	useEffect(() => {
		const onCycle = () => {
			const list = fields().filter((el) => eligible(el, controller));
			if (list.length === 0) return;
			const active = document.activeElement;
			// Where focus is: the control itself, else the deepest one holding it (the last in page
			// order). A control nested in another (a link inside a row's button) is then its own
			// stop, never matched as its container, which would hand Tab straight back to it.
			let idx = active ? list.indexOf(active as HTMLElement) : -1;
			if (idx < 0 && active) idx = list.findLastIndex((el) => el.contains(active));
			if (idx < 0) {
				list[0]!.focus();
				return;
			}
			list[(idx + 1) % list.length]!.focus();
		};
		window.addEventListener("lh:kbd-cycle-fields", onCycle);
		return () => window.removeEventListener("lh:kbd-cycle-fields", onCycle);
	}, [fields, eligible, controller]);
}

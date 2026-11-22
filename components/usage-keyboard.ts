"use client";

import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";

const origins = new WeakMap<HTMLElement, HTMLElement>();
export function rememberUsageFocus(target: HTMLElement, origin: HTMLElement | null) {
	if (origin && origin !== target) origins.set(target, origin);
}

/** Keyboard navigation for the usage toggle and its details. */
export function useUsageKeyboard(toggle: RefObject<HTMLButtonElement | null>, panel: RefObject<HTMLElement | null>, open: boolean, setOpen: (open: boolean) => void) {
	const controller = useOptionalInteractionLayers();
	const restore = () => {
		const button = toggle.current;
		const origin = button && origins.get(button);
		if (origin && origin.isConnected && isInteractionScopeEligible(origin, controller)) origin.focus();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const button = toggle.current;
		if (!button) return;
		if (event.key === "Escape") {
			controller?.claimEscape(event.nativeEvent);
			event.preventDefault(); event.stopPropagation();
			if (open) {
				setOpen(false);
				if (event.target === button) setTimeout(restore, 0); else button.focus();
			} else restore();
			return;
		}
		if (open && event.key === "Tab") {
			const items = [button, ...Array.from(panel.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])].filter(el => isInteractionScopeEligible(el, controller) || el === button);
			const i = items.indexOf(document.activeElement as HTMLElement);
			event.preventDefault(); event.stopPropagation();
			items[(i + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
			return;
		}
		if ((event.key === "Enter" || event.key === " ") && event.target === button) {
			event.stopPropagation(); event.nativeEvent.stopImmediatePropagation();
		}
	};
	const onClick = (event: MouseEvent<HTMLButtonElement>) => {
		if (open && event.detail === 0) setTimeout(restore, 0);
		setOpen(!open);
	};
	return { onKeyDown, onClick };
}

"use client";

import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";

const origins = new WeakMap<HTMLElement, HTMLElement>();
export function rememberUsageFocus(target: HTMLElement, origin: HTMLElement | null) {
	if (origin && origin !== target && origin !== origin.ownerDocument.body) origins.set(target, origin);
	else origins.delete(target);
}

/** Keyboard navigation for the usage toggle and its details. */
export function useUsageKeyboard(toggle: RefObject<HTMLButtonElement | null>, panel: RefObject<HTMLElement | null>, open: boolean, setOpen: (open: boolean) => void) {
	const controller = useOptionalInteractionLayers();
	const usableOrigin = (button: HTMLElement) => {
		const origin = origins.get(button);
		return origin && origin !== origin.ownerDocument.body && origin.isConnected && isInteractionScopeEligible(origin, controller) ? origin : null;
	};
	const restore = (button: HTMLButtonElement) => {
		const origin = usableOrigin(button);
		origins.delete(button);
		origin?.focus();
	};
	const deferRestore = (button: HTMLButtonElement) => {
		const revision = controller?.getFocusRevision();
		setTimeout(() => {
			if (document.activeElement !== button || (controller && controller.getFocusRevision() !== revision)) return;
			restore(button);
		}, 0);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const button = toggle.current;
		if (!button) return;
		if (event.key === "Escape") {
			if (!open && !usableOrigin(button)) { origins.delete(button); return; }
			controller?.claimEscape(event.nativeEvent);
			event.preventDefault(); event.stopPropagation();
			if (open) {
				setOpen(false);
				button.focus();
			} else restore(button);
			return;
		}
		if (open && event.key === "Tab") {
			const items = [button, ...Array.from(panel.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])].filter(el => isInteractionScopeEligible(el, controller) || el === button);
			const i = items.indexOf(document.activeElement as HTMLElement);
			event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation();
			items[i < 0 ? (event.shiftKey ? items.length - 1 : 0) : (i + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
			return;
		}
		if ((event.key === "Enter" || event.key === " ") && event.target === button) {
			event.stopPropagation(); event.nativeEvent.stopImmediatePropagation();
		}
	};
	const onClick = (event: MouseEvent<HTMLButtonElement>) => {
		if (event.detail !== 0 && toggle.current) origins.delete(toggle.current);
		if (open && event.detail === 0 && toggle.current) deferRestore(toggle.current);
		setOpen(!open);
	};
	return { onKeyDown, onClick };
}

"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";
import { pluginQuestionKeySuppressed, composingQuestionKey } from "./plugin-question-keys";
import { isTypingSurface } from "@/src/core";

const OVERLAY_ROOTS = '[data-lh-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]';
let pointerFocusedSidebarControl: EventTarget | null = null;

export function setPointerFocusedSidebarControl(target: EventTarget | null): void {
	pointerFocusedSidebarControl = target;
}

export function buttonKeepsNativeEnter(el: HTMLElement): boolean {
	if (el === pointerFocusedSidebarControl && el.matches('[data-testid="settings-entry"], [data-testid="update-pill"], [data-testid="update-capsule-button"]')) return false;
	// Guarded because linkedom in the test harness does not support :focus-visible.
	try {
		if (el.matches(":focus-visible")) return true;
	} catch {
		// Treat unsupported selector engines as pointer focus.
	}
	return !!el.closest(OVERLAY_ROOTS);
}

export function useEnterSubmits(submit: () => void, scopeRef?: RefObject<HTMLElement | null>, enabled = true): void {
	const controller = useOptionalInteractionLayers();
	const submitRef = useRef(submit);
	submitRef.current = submit;
	useEffect(() => {
		if (!enabled) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Enter" || e.defaultPrevented || pluginQuestionKeySuppressed(e) || composingQuestionKey(e)) return;
			if (!isInteractionScopeEligible(scopeRef ? scopeRef.current : document.body, controller)) return;
			if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			if (isTypingSurface(e)) return;
			const target = e.target as HTMLElement | null;
			if (target?.tagName === "BUTTON" && buttonKeepsNativeEnter(target)) return;
			e.preventDefault();
			submitRef.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [controller, scopeRef, enabled]);
}

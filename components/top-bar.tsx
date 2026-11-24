"use client";

/**
 * Electron's app-region subtraction resolves by DOM order, not z-index: a
 * full-bleed overlay containing a TopBar must be the last child of its
 * container so later no-drag elements cannot punch dead zones through it.
 */

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { SidebarToggle } from "@/components/sidebar-toggle";

export function TopBar({
	drag = true,
	onMouseDown,
	children,
	sidebarToggle = true,
}: {
	drag?: boolean;
	onMouseDown?: React.MouseEventHandler<HTMLElement>;
	children?: ReactNode;
	/** Host picker chrome: native clearance without changing sidebar state. */
	sidebarToggle?: boolean;
}) {
	const header = useRef<HTMLElement>(null);
	useLayoutEffect(() => {
		if (sidebarToggle || !header.current) return;
		const element = header.current;
		let previous: number | undefined;
		const measure = () => {
			const left = element.getBoundingClientRect().left;
			if (left === previous) return;
			previous = left;
			element.style.setProperty("--lh-header-left", `${left}px`);
		};
		measure();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		observer?.observe(element);
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		const offZoom = window.lh?.onZoom?.(measure);
		return () => {
			observer?.disconnect(); offZoom?.();
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
		};
	}, [sidebarToggle]);
	return (
		<header
			ref={header}
			onMouseDown={onMouseDown}
			className={`${drag ? "lh-drag " : ""}${sidebarToggle ? "" : "lh-native-window-clearance "}lh-wco-gutter flex h-15 select-none items-center gap-3 border-b border-border px-3`}
		>
			{sidebarToggle && <SidebarToggle />}
			{children}
		</header>
	);
}

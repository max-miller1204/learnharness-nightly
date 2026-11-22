"use client";
/**
 * The sidebar's open state and the header hamburger, apart from the sidebar
 * itself. Page headers (top-bar, home, new session) import the toggle from
 * here, never sidebar.tsx: the sidebar mounts Settings, and Settings reaches
 * those headers, so importing the sidebar from them makes an import cycle.
 * In the production server bundle a cycle through async modules can render
 * a provider before its module has finished initializing.
 */
import { createContext, useContext } from "react";
import { PanelLeftOpenIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Provided by SidebarProvider (sidebar.tsx). */
export const SidebarContext = createContext<{ open: boolean; toggle: () => void }>({
	open: false,
	toggle: () => {},
});

export function useSidebar() {
	return useContext(SidebarContext);
}

/** Hamburger for page headers, only visible when the sidebar is closed.
 *
 *  Owner, round 6c: the toggle is ALWAYS MOUNTED, owning a slot whose
 *  width+margin animate in LOCKSTEP with the sidebar's own width
 *  transition (same duration-200, same easing, both gated on mount):
 *  before, it mounted/unmounted in one frame, so its 48px footprint
 *  (button + gap) popped and dragged the title and chips sideways while
 *  the sidebar was still mid-slide. When open the slot is exactly zero
 *  (w-0 -mr-3: width 0, the negative margin cancels the header's gap-3),
 *  so resting layouts are pixel-identical to the old conditional render.
 *  The icon fades with the slot and is clipped by it as it collapses:
 *  no popping in either direction. */
export function SidebarToggle() {
	const { open, toggle } = useSidebar();
	return (
		<span
			className={cn(
				"sidebar-motion lh-no-drag lh-closed-toggle relative flex h-9 shrink-0 overflow-hidden duration-200",
				"w-0 -mr-3 sidebar-closed:w-9 sidebar-closed:mr-0",
			)}
		>
			<Hint label="Open sidebar" action="toggle-sidebar">
			<Button
				variant="ghost"
				size="icon"
				aria-label="Open sidebar"
				aria-hidden={open}
				tabIndex={open ? -1 : 0}
				onClick={toggle}
				className="sidebar-motion duration-200 pointer-events-none opacity-0 sidebar-closed:pointer-events-auto sidebar-closed:opacity-100"
			>
				{/* Owner, round 6: size-4, SAME as the close glyph: the toggle
				    must not grow when the sidebar is closed (it did: size-5 here).
				    The small look is the standard, both directions. */}
				<PanelLeftOpenIcon className="size-4" />
			</Button>
			</Hint>
		</span>
	);
}

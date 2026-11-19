"use client";

/**
 * The one-time "What's new in X" popup (docs/specs/t3-style-updates.md,
 * section 6). The server decides (GET /api/whats-new): it answers the notes
 * of every version since the one last seen on this server, or null. Any
 * dismissal marks the running version seen (POST /api/whats-new/seen), which
 * emits "whats-new-changed", so the popup closes on every other open device
 * too. Mounted once in the root layout, inside the events provider.
 *
 * Held back while the server runs a newer version than this page's code
 * (docs/specs/update-control.md): the old page reloads by itself (or shows
 * the sidebar's "Updated to X. Click to reload." button until it does), and
 * the popup shows on the first page that runs X (after the reload, or the
 * next time the app opens). It is
 * not marked seen while held back, so it is neither lost nor shown twice.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { HostDialog } from "@/components/host-dialog";
import { ReleaseNoteSections, releaseUrl } from "@/components/release-notes-view";
import { useNotifyHub } from "@/components/server-events";
import { APP_VERSION, HOMEPAGE } from "@/components/settings/update-settings";
import { isNewerVersion } from "@/selfhost/src/version-order.ts";
import type { ReleaseNoteGroup } from "@/src/core";

export type WhatsNew = {
	version: string;
	releaseNotes: ReleaseNoteGroup[];
	omittedReleaseCount: number;
};

function isWhatsNew(value: unknown): value is WhatsNew {
	return typeof value === "object" && value !== null && typeof (value as WhatsNew).version === "string"
		&& Array.isArray((value as WhatsNew).releaseNotes) && typeof (value as WhatsNew).omittedReleaseCount === "number";
}

/** The pure body, exported for render pins. */
export function WhatsNewBody({ whatsNew, homepage, onDone, doneRef }: {
	whatsNew: WhatsNew;
	homepage: string;
	onDone: () => void;
	doneRef?: React.RefObject<HTMLButtonElement | null>;
}) {
	const link = releaseUrl(homepage, whatsNew.version);
	return (
		<>
			<h2 className="text-sm font-semibold text-card-foreground" data-testid="whats-new-title">{`What's new in ${whatsNew.version}`}</h2>
			<div className="mt-3 min-h-0 overflow-y-auto pr-1">
				{whatsNew.releaseNotes.length > 0 ? (
					<ReleaseNoteSections groups={whatsNew.releaseNotes} omittedReleaseCount={whatsNew.omittedReleaseCount} homepage={homepage} />
				) : (
					<div data-testid="whats-new-empty">
						<p className="text-xs text-popover-foreground/90">{`Updated to version ${whatsNew.version}.`}</p>
						{link && (
							<a href={link} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
								Read more
							</a>
						)}
					</div>
				)}
			</div>
			<div className="mt-4 flex justify-end">
				<button
					type="button"
					ref={doneRef}
					data-testid="whats-new-done"
					onClick={onDone}
					className="rounded-sm bg-accent px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/80"
				>
					Got it
				</button>
			</div>
		</>
	);
}

export default function WhatsNewDialog({ pageVersion = APP_VERSION }: { pageVersion?: string } = {}) {
	const [whatsNew, setWhatsNew] = useState<WhatsNew | null>(null);
	const hub = useNotifyHub();
	const doneRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		let live = true;
		const refetch = () => {
			void fetch("/api/whats-new", { cache: "no-store" })
				.then((response) => (response.ok ? response.json() : null))
				.then((body: unknown) => { if (live) setWhatsNew(isWhatsNew(body) ? body : null); })
				.catch(() => { /* offline: keep what we have */ });
		};
		const offEvent = hub?.subscribe("whats-new-changed", refetch);
		const offResync = hub?.onResync(refetch);
		refetch();
		return () => { live = false; offEvent?.(); offResync?.(); };
	}, [hub]);

	const done = useCallback(() => {
		const version = whatsNew?.version;
		setWhatsNew(null);
		if (!version) return;
		void fetch("/api/whats-new/seen", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ version }),
		}).catch(() => { /* shows again on the next load */ });
	}, [whatsNew]);

	// The server's running version is whatsNew.version: newer than this page's code means reload first.
	if (!whatsNew || isNewerVersion(whatsNew.version, pageVersion)) return null;
	return (
		<HostDialog
			open
			aria-label={`What's new in ${whatsNew.version}`}
			initialFocusRef={doneRef}
			onClose={() => { done(); return "closed"; }}
			backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm", "data-testid": "whats-new-dialog" }}
			frame={<div className="mx-4 flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border bg-card p-5 shadow-lg" onClick={(event) => event.stopPropagation()} />}
		>
			<WhatsNewBody whatsNew={whatsNew} homepage={HOMEPAGE} onDone={done} doneRef={doneRef} />
		</HostDialog>
	);
}

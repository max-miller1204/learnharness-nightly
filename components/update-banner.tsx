"use client";

/**
 * The auto-update banner (Wave C, owner 2026-10-10: silent download +
 * restart-banner UX). The shell pushes "lh:update-status" once a staged
 * update exists (electron/main.cjs update-downloaded). Snapshot retrieval
 * also covers a late load. The card offers Restart alongside Settings.
 * Browser builds that aren't self-hosted get a "disabled" state and
 * render null.
 *
 * Self-hosted installs (the `lh` launcher) reach the same card through
 * GET /api/updates; there, a downloaded update also installs on its own
 * once no agent is working. The banner additionally shows the outcome of
 * the last switch once ("Updated to X", or a rollback), dismissible and
 * remembered per browser.
 *
 * Dismissing the ready card hides this version for the mounted window
 * only; the update still installs (on quit, when idle, or via Settings).
 */

import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import { useUpdateState, type UpdateNotice } from "@/components/settings/update-settings.tsx";

const NOTICE_KEY = "lh:update-notice-dismissed";
const noticeId = (notice: UpdateNotice) => `${notice.kind}:${notice.version}:${notice.at}`;

function readDismissedNotice(): string | null {
	try { return window.localStorage.getItem(NOTICE_KEY); } catch { return null; }
}

function rememberDismissedNotice(id: string): void {
	try { window.localStorage.setItem(NOTICE_KEY, id); } catch { /* per-browser convenience only */ }
}

const CARD = "fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg";
const DISMISS = "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function UpdateBanner() {
	const { state: ready, transport, install } = useUpdateState();
	const [dismissedVersion, setDismissedVersion] = useState<string | null>();
	const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
	useEffect(() => setDismissedNotice(readDismissedNotice()), []);

	if (ready?.status === "downloaded" && ready.version !== dismissedVersion) {
		const tail = transport === "web" ? ". Restart now, or it installs when no agent is working." : " — restart to finish installing.";
		return (
			<div data-testid="update-banner" className={CARD}>
				<div className="text-sm">
					<span className="font-medium">LearnHarness {ready.version ?? "update"} is ready</span>
					<span className="text-muted-foreground">{tail}</span>
				</div>
				<button
					type="button"
					onClick={install}
					className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
				>
					Restart
				</button>
				<button type="button" aria-label="Dismiss update notification" onClick={() => setDismissedVersion(ready.version)} className={DISMISS}>
					<XIcon className="size-4" aria-hidden="true" />
				</button>
			</div>
		);
	}

	const notice = ready?.notice;
	if (!notice || noticeId(notice) === dismissedNotice) return null;
	return (
		<div data-testid="update-notice" role="status" className={CARD}>
			<div className="text-sm">
				<span className={notice.kind === "rolled-back" ? "font-medium text-destructive" : "font-medium"}>{notice.text}</span>
			</div>
			<button
				type="button"
				aria-label="Dismiss update notice"
				onClick={() => {
					const id = noticeId(notice);
					rememberDismissedNotice(id);
					setDismissedNotice(id);
				}}
				className={DISMISS}
			>
				<XIcon className="size-4" aria-hidden="true" />
			</button>
		</div>
	);
}

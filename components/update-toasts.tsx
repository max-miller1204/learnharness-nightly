"use client";

/**
 * The desktop app's update toasts (docs/specs/t3-style-updates.md, revision
 * PR 4), T3 Code's at df09ced7:
 *   - "Update downloaded" / "Restart the app from the update button to
 *     install it." / "Read more ↗": showDesktopUpdateDownloadedToast,
 *     apps/web/src/components/desktopUpdate.toast.tsx:24-64.
 *   - The error titles of the sidebar control's actions:
 *     apps/web/src/components/sidebar/SidebarUpdatePill.tsx:143-195 (download
 *     and install) and :340-368 (check).
 *   - "Update did not apply", once per launch:
 *     apps/web/src/components/sidebar/updateEverythingRun.tsx:368-402.
 * Raised by the sidebar control's own clicks (components/sidebar-update-pill.tsx)
 * and, for main's notices ("did not apply", and "Could not install update"
 * after an install main recovered from), by UpdateLaunchNotice in the app
 * shell, which claims each from main once per launch; never by Settings. Descriptions are LearnHarness's fixed messages (the updater state's
 * `message`, or the fallbacks below), never raw updater errors.
 * T3 Code is MIT licensed, Copyright (c) 2026 T3 Tools Inc. (the full notice is
 * in components/release-notes-view.tsx).
 */

import { useEffect, useRef } from "react";
import { ArrowRightIcon } from "lucide-react";
import { releaseUrl } from "@/components/release-notes-view";
import { APP_VERSION, HOMEPAGE, useUpdateState } from "@/components/settings/update-settings";
import { toastManager } from "@/components/ui/toast";

export const UPDATE_DOWNLOADED_TITLE = "Update downloaded";
export const UPDATE_DOWNLOADED_LINE = "Restart the app from the update button to install it.";
export const CHECK_FAILED_TITLE = "Could not check for updates";
export const DOWNLOAD_FAILED_TITLE = "Could not download update";
export const DOWNLOAD_START_FAILED_TITLE = "Could not start update download";
export const INSTALL_FAILED_TITLE = "Could not install update";
export const NOT_APPLIED_TITLE = "Update did not apply";
/** T3's fallbacks where its description would be a thrown error's text (kept fixed here). */
export const UNEXPECTED_ERROR = "An unexpected error occurred.";
export const CHECK_ERROR = "Update check failed.";
export const CHECK_UNAVAILABLE = "Automatic updates are not available in this build.";

export const notAppliedLine = (current: string, version: string) =>
	`LearnHarness is still on ${current}. Install ${version} again from the update button.`;

/** T3's ReleaseNotesLink: "Read more" with its arrow turned to point up and out. */
function ReadMore({ href }: { href: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			data-testid="toast-read-more"
			className="ml-2 inline cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
		>
			Read more
			<ArrowRightIcon aria-hidden className="ml-1 inline size-3 -rotate-45 align-[-0.125em]" strokeWidth={2.25} />
		</a>
	);
}

export function showUpdateDownloadedToast(version: string | null | undefined, homepage: string = HOMEPAGE): void {
	const link = version ? releaseUrl(homepage, version) : null;
	toastManager.add({
		type: "success",
		title: UPDATE_DOWNLOADED_TITLE,
		description: <>{UPDATE_DOWNLOADED_LINE}{link ? <ReadMore href={link} /> : null}</>,
		announce: `${UPDATE_DOWNLOADED_TITLE}. ${UPDATE_DOWNLOADED_LINE}`,
	});
}

export function showUpdateErrorToast(title: string, description: string): void {
	toastManager.add({ type: "error", title, description });
}

/** Main's notices, each once per launch (main's claim, so a reload or a new local window never
 *  repeats one): "did not apply" (T3's startDesktopUpdateLaunchNotice), and "Could not install
 *  update" for an install main recovered from, after it reloaded this page onto the restarted
 *  server (so the toast isn't lost with the old page). Desktop app's local window only. */
export function UpdateLaunchNotice({ current = APP_VERSION }: { current?: string } = {}) {
	const { state, transport } = useUpdateState();
	const desktop = transport === "desktop";
	const notApplied = desktop ? state?.notAppliedVersion : undefined;
	const installFailed = desktop ? state?.installFailedNotice : undefined;
	// The state's fixed message as it is when the notice comes.
	const message = useRef(state?.message);
	message.current = state?.message;
	useEffect(() => {
		if (!notApplied) return;
		void claim(`not-applied:${notApplied}`).then((first) => {
			if (first) showUpdateErrorToast(NOT_APPLIED_TITLE, notAppliedLine(current, notApplied));
		});
	}, [notApplied, current]);
	useEffect(() => {
		if (!installFailed) return;
		void claim(`install-failed:${installFailed}`).then((first) => {
			if (first) showUpdateErrorToast(INSTALL_FAILED_TITLE, message.current ?? UNEXPECTED_ERROR);
		});
	}, [installFailed]);
	return null;
}

/** Main's once-per-launch claim; no bridge (or a throw) means no toast rather than a repeat. */
async function claim(key: string): Promise<boolean> {
	try {
		return (await window.lh?.claimUpdateNotice?.(key)) === true;
	} catch {
		return false;
	}
}

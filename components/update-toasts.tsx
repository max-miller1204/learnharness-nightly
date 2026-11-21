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
 * and, for "did not apply", by UpdateLaunchNotice in the app shell; never by
 * Settings. Descriptions are LearnHarness's fixed messages (the updater state's
 * `message`, or the fallbacks below), never raw updater errors.
 * T3 Code is MIT licensed, Copyright (c) 2026 T3 Tools Inc. (the full notice is
 * in components/release-notes-view.tsx).
 */

import { useEffect } from "react";
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
export const CONFIRM_FAILED_TITLE = "Could not confirm update";
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
	});
}

export function showUpdateErrorToast(title: string, description: string): void {
	toastManager.add({ type: "error", title, description });
}

export const NOT_APPLIED_KEY = "lh-update-not-applied-notified";
// Without usable sessionStorage this window still says it once.
let notifiedWithoutStorage: string | null = null;

/** Once per launch for each version: a window's sessionStorage lasts until the app quits, across reloads. */
export function claimNotAppliedNotice(version: string): boolean {
	try {
		const storage = window.sessionStorage;
		if (storage.getItem(NOT_APPLIED_KEY) === version) return false;
		storage.setItem(NOT_APPLIED_KEY, version);
		return true;
	} catch {
		if (notifiedWithoutStorage === version) return false;
		notifiedWithoutStorage = version;
		return true;
	}
}

/** Tests: forget the in-memory claim. */
export function resetNotAppliedNotice(): void {
	notifiedWithoutStorage = null;
}

/** The app shell's once-per-launch "Update did not apply" (T3's startDesktopUpdateLaunchNotice). */
export function UpdateLaunchNotice({ current = APP_VERSION }: { current?: string } = {}) {
	const { state, transport } = useUpdateState();
	const version = transport === "desktop" ? state?.notAppliedVersion : undefined;
	useEffect(() => {
		if (!version || !claimNotAppliedNotice(version)) return;
		showUpdateErrorToast(NOT_APPLIED_TITLE, notAppliedLine(current, version));
	}, [version, current]);
	return null;
}

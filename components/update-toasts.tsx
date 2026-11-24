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
import { APP_VERSION } from "@/components/app-info";
import { useUpdateState } from "@/components/settings/update-settings";
import {
	CHECK_ERROR,
	CHECK_FAILED_TITLE,
	CHECK_UNAVAILABLE,
	DOWNLOAD_FAILED_TITLE,
	DOWNLOAD_START_FAILED_TITLE,
	INSTALL_FAILED_LINE,
	INSTALL_FAILED_TITLE,
	NOT_APPLIED_TITLE,
	notAppliedLine,
	showUpdateDownloadedToast,
	showUpdateErrorToast,
	showUpdateEverythingResult,
	UNEXPECTED_ERROR,
	UPDATE_DOWNLOADED_LINE,
	UPDATE_DOWNLOADED_TITLE,
} from "@/components/update-toast-helpers";

export {
	CHECK_ERROR,
	CHECK_FAILED_TITLE,
	CHECK_UNAVAILABLE,
	DOWNLOAD_FAILED_TITLE,
	DOWNLOAD_START_FAILED_TITLE,
	INSTALL_FAILED_LINE,
	INSTALL_FAILED_TITLE,
	NOT_APPLIED_TITLE,
	notAppliedLine,
	showUpdateDownloadedToast,
	showUpdateErrorToast,
	showUpdateEverythingResult,
	UNEXPECTED_ERROR,
	UPDATE_DOWNLOADED_LINE,
	UPDATE_DOWNLOADED_TITLE,
};

/**
 * Main's notices, each once per launch: "did not apply" (T3's startDesktopUpdateLaunchNotice), and
 * "Could not install update" for an install the sidebar started that failed (after main reloaded
 * this page onto the restarted server, so the toast isn't lost with the old page), with the fixed
 * text main carries in the notice. Two steps with main: only a visible page claims a notice, shows
 * the toast, then acks it, so a page that closes or hides first never spends it. Desktop app's
 * local window only.
 */
export function UpdateLaunchNotice({ current = APP_VERSION }: { current?: string } = {}) {
	const { state, transport } = useUpdateState();
	const desktop = transport === "desktop";
	const notApplied = desktop ? state?.notAppliedVersion : undefined;
	const installFailed = desktop ? state?.installFailedNotice : undefined;
	const installFailedLine = state?.installFailedNoticeMessage;
	const line = useRef(installFailedLine);
	line.current = installFailedLine;
	useEffect(() => {
		if (!notApplied) return;
		return showNotice(`not-applied:${notApplied}`, () => showUpdateErrorToast(NOT_APPLIED_TITLE, notAppliedLine(current, notApplied)));
	}, [notApplied, current]);
	useEffect(() => {
		if (!installFailed) return;
		return showNotice(`install-failed:${installFailed}`, () => showUpdateErrorToast(INSTALL_FAILED_TITLE, line.current ?? INSTALL_FAILED_LINE));
	}, [installFailed]);
	return null;
}

const pageHidden = () => document.visibilityState === "hidden";

/**
 * Once the page is visible: claim the notice from main, show it, ack it. Visibility is checked
 * again when main's reply arrives: a page hidden by then keeps its reservation and shows the toast
 * (then acks it) only once it is visible again, so a hidden window never spends a notice unseen.
 * (A toast's timer also stops while the page is hidden, components/ui/toast.tsx.) Returns a cancel.
 */
function showNotice(key: string, show: () => void): () => void {
	let live = true;
	let claimed = false;
	const reveal = () => {
		if (!live || pageHidden()) return;
		document.removeEventListener("visibilitychange", reveal);
		show();
		void window.lh?.ackUpdateNotice?.(key)?.catch?.(() => {});
	};
	const attempt = () => {
		if (!live || claimed || pageHidden()) return;
		claimed = true;
		document.removeEventListener("visibilitychange", attempt);
		void claim(key).then((first) => {
			if (!first || !live) return;
			if (pageHidden()) document.addEventListener("visibilitychange", reveal);
			else reveal();
		});
	};
	document.addEventListener("visibilitychange", attempt);
	attempt();
	return () => {
		live = false;
		document.removeEventListener("visibilitychange", attempt);
		document.removeEventListener("visibilitychange", reveal);
	};
}

/** Main's claim; no bridge (or a throw) means no toast rather than a repeat. */
async function claim(key: string): Promise<boolean> {
	try {
		return (await window.lh?.claimUpdateNotice?.(key)) === true;
	} catch {
		return false;
	}
}

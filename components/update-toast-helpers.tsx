"use client";

import { ArrowRightIcon } from "lucide-react";
import { APP_VERSION, HOMEPAGE } from "@/components/app-info";
import { releaseUrl } from "@/components/release-notes-view";
import { toastManager } from "@/components/ui/toast";
import { getUpdateEverythingToastView, type UpdateEverythingResult } from "@/components/update-everything-logic";

export const UPDATE_DOWNLOADED_TITLE = "Update downloaded";
export const UPDATE_DOWNLOADED_LINE = "Restart the app from the update button to install it.";
export const CHECK_FAILED_TITLE = "Could not check for updates";
export const DOWNLOAD_FAILED_TITLE = "Could not download update";
export const DOWNLOAD_START_FAILED_TITLE = "Could not start update download";
export const INSTALL_FAILED_TITLE = "Could not install update";
export const NOT_APPLIED_TITLE = "Update did not apply";
export const UNEXPECTED_ERROR = "An unexpected error occurred.";
export const CHECK_ERROR = "Update check failed.";
export const CHECK_UNAVAILABLE = "Automatic updates are not available in this build.";
export const INSTALL_FAILED_LINE = "Couldn’t install the update.";

export const notAppliedLine = (current: string, version: string) =>
	`LearnHarness is still on ${current}. Install ${version} again from the update button.`;

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

export function showUpdateEverythingResult(result: UpdateEverythingResult, appVersion: string = APP_VERSION): void {
	const view = getUpdateEverythingToastView(result, appVersion);
	if (!view) return;
	toastManager.add({
		type: view.type,
		title: view.title,
		...(view.description ? { description: <span className="whitespace-pre-line">{view.description}</span>, announce: `${view.title}. ${view.description}` } : {}),
	});
}

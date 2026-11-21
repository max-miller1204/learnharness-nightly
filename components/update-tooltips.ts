/**
 * The update button's tooltip lines, shared by the sidebar update control
 * and Settings > General (docs/specs/t3-style-updates.md, revision PR 5).
 * Ported from T3 Code's getDesktopUpdateButtonTooltip
 * (apps/web/src/components/desktopUpdate.logic.ts:109-178 at df09ced7, MIT,
 * Copyright (c) 2026 T3 Tools Inc.), without its update-track line (one
 * channel) and with LearnHarness's "Preparing update" (the server checks and
 * unpacks a download, owner decision 2026-11-19).
 */
import type { UpdateState } from "@/components/settings/update-settings";

/**
 * T3's retry lines (desktopUpdate.logic.ts:113-131, 148-159), or null for the plain line.
 * The retry fields come from the desktop's state and, for a failed download, the server's.
 */
export function retryTooltip(state: UpdateState): string | null {
	const offered = state.downloadedVersion ?? state.availableVersion ?? null;
	if (state.notAppliedVersion && (state.status === "available" || state.status === "downloaded") && offered === state.notAppliedVersion) {
		return `Update ${state.notAppliedVersion} did not apply. Click to retry.`;
	}
	if ((state.status === "available" || state.status === "error") && state.errorContext === "download" && state.availableVersion) {
		return `Download failed for ${state.availableVersion}. Click to retry.`;
	}
	if (state.status === "error") {
		if (state.errorContext === "install" && state.downloadedVersion) return `Install failed for ${state.downloadedVersion}. Click to retry.`;
		if (state.downloadedVersion) return `Update ${state.downloadedVersion} downloaded. Click to restart and install.`;
	}
	return null;
}

export const PREPARING_LABEL = "Preparing update";

/** T3's downloading label (desktopUpdate.logic.ts:134-139): the percent floored, or the plain
 *  label while the size is unknown. */
export function downloadingTooltip(percent: number | null | undefined): string {
	return typeof percent === "number" && Number.isFinite(percent) ? `Downloading update (${Math.floor(percent)}%)` : "Downloading update";
}

/** The whole of T3's getDesktopUpdateButtonTooltip: Settings' About button reads it. */
export function updateButtonTooltip(state: UpdateState): string {
	const retry = retryTooltip(state);
	if (retry) return retry;
	switch (state.status) {
		case "available": {
			const version = state.availableVersion ?? state.version;
			return version ? `Update ${version} ready to download` : "Update available ready to download";
		}
		case "downloading": return state.preparing ? PREPARING_LABEL : downloadingTooltip(state.downloadPercent);
		case "downloaded": {
			const version = state.downloadedVersion ?? state.availableVersion ?? state.version;
			return version ? `Update ${version} downloaded. Click to restart and install.` : "Update ready downloaded. Click to restart and install.";
		}
		case "error": return state.message ?? "Update failed";
		default: return "Up to date";
	}
}

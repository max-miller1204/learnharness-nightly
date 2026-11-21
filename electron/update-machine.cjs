"use strict";
/**
 * The desktop app's update state, one pure reducer per updater event
 * (docs/specs/t3-style-updates.md, revision PR 3). electron/main.cjs owns
 * the state and runs these; nothing here touches Electron.
 *
 * Ported from T3 Code's apps/desktop/src/updates/updateMachine.ts
 * (https://github.com/pingdotgg/t3code at df09ced7): every reducer, the
 * install record and resolveNotAppliedInstallVersion, plus
 * getCanRetryFromState, isOffered and the updater-error reducer inlined in
 * apps/desktop/src/updates/DesktopUpdates.ts (:317-323, :1150-1158).
 * Changes: plain CommonJS; no channel, architecture or `enabled` fields (one
 * channel; "disabled" is a status here); the state keeps LearnHarness's
 * `version` (the downloaded version, else the offered one) and `revision`
 * for its existing readers; timestamps come from the caller. T3 Code
 * carries this notice:
 *
 *   MIT License
 *
 *   Copyright (c) 2026 T3 Tools Inc.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */

/** The file under userData that says which install was started from which version. */
const INSTALL_RECORD_FILE = "desktop-update-install.json";
/** Updater messages go to the local window only; this long at most. */
const MAX_MESSAGE_LENGTH = 300;

/** LearnHarness's `version`: the downloaded version, else the offered one (T3's getDesktopUpdateDownloadedVersion). */
const withVersion = (state) => ({ ...state, version: state.downloadedVersion ?? state.availableVersion ?? null });

const boundedMessage = (message) => {
	const text = typeof message === "string" ? message.trim() : "";
	return text ? text.slice(0, MAX_MESSAGE_LENGTH) : null;
};

function createInitialUpdateState() {
	return withVersion({
		status: "idle",
		revision: 0,
		availableVersion: null,
		downloadedVersion: null,
		releaseNotes: [],
		omittedReleaseCount: 0,
		downloadPercent: null,
		checkedAt: null,
		message: null,
		errorContext: null,
		canRetry: false,
	});
}

const isOffered = (state) => state.status === "available" || state.status === "downloaded";
const getCanRetryFromState = (state) => state.availableVersion !== null || state.downloadedVersion !== null;

function reduceOnCheckStart(state, checkedAt) {
	const hasDownloadedUpdate = state.downloadedVersion !== null;
	return withVersion({
		...state,
		status: "checking",
		checkedAt,
		releaseNotes: hasDownloadedUpdate ? state.releaseNotes : [],
		omittedReleaseCount: hasDownloadedUpdate ? state.omittedReleaseCount : 0,
		message: null,
		downloadPercent: hasDownloadedUpdate ? 100 : null,
		errorContext: null,
		canRetry: false,
	});
}

function reduceOnCheckFailure(state, message, checkedAt) {
	if (state.downloadedVersion !== null) {
		return withVersion({ ...state, status: "downloaded", message: null, checkedAt, downloadPercent: 100, errorContext: null, canRetry: true });
	}
	return withVersion({ ...state, status: "error", message: boundedMessage(message), checkedAt, downloadPercent: null, errorContext: "check", canRetry: true });
}

function reduceOnUpdateAvailable(state, version, checkedAt, releaseNotes = [], omittedReleaseCount = 0) {
	const isDownloadedVersion = state.downloadedVersion === version;
	const preserveReleaseNotes = isDownloadedVersion && releaseNotes.length === 0;
	return withVersion({
		...state,
		status: isDownloadedVersion ? "downloaded" : "available",
		availableVersion: version,
		downloadedVersion: isDownloadedVersion ? version : null,
		releaseNotes: preserveReleaseNotes ? state.releaseNotes : releaseNotes,
		omittedReleaseCount: preserveReleaseNotes ? state.omittedReleaseCount : omittedReleaseCount,
		downloadPercent: isDownloadedVersion ? 100 : null,
		checkedAt,
		message: null,
		errorContext: null,
		canRetry: isDownloadedVersion,
	});
}

function reduceOnNoUpdate(state, checkedAt) {
	if (state.downloadedVersion !== null) {
		return withVersion({ ...state, status: "downloaded", availableVersion: state.downloadedVersion, downloadPercent: 100, checkedAt, message: null, errorContext: null, canRetry: true });
	}
	return withVersion({
		...state,
		status: "up-to-date",
		availableVersion: null,
		downloadedVersion: null,
		releaseNotes: [],
		omittedReleaseCount: 0,
		downloadPercent: null,
		checkedAt,
		message: null,
		errorContext: null,
		canRetry: false,
	});
}

function reduceOnDownloadStart(state) {
	return withVersion({ ...state, status: "downloading", downloadPercent: 0, message: null, errorContext: null, canRetry: false });
}

function reduceOnDownloadFailure(state, message) {
	return withVersion({
		...state,
		status: state.availableVersion ? "available" : "error",
		message: boundedMessage(message),
		downloadPercent: null,
		errorContext: "download",
		canRetry: state.availableVersion !== null,
	});
}

function reduceOnDownloadProgress(state, percent) {
	return withVersion({ ...state, status: "downloading", downloadPercent: percent, message: null, errorContext: null, canRetry: false });
}

function reduceOnDownloadComplete(state, version) {
	return withVersion({ ...state, status: "downloaded", availableVersion: version, downloadedVersion: version, downloadPercent: 100, message: null, errorContext: null, canRetry: true });
}

function reduceOnInstallFailure(state, message) {
	return withVersion({ ...state, status: "downloaded", message: boundedMessage(message), errorContext: "install", canRetry: true });
}

/** An updater "error" event outside an action of ours (T3's handleUpdaterError): the context stays. */
function reduceOnUpdaterError(state, message, checkedAt) {
	return withVersion({ ...state, status: "error", message: boundedMessage(message), checkedAt, downloadPercent: null, errorContext: state.errorContext, canRetry: getCanRetryFromState(state) });
}

/** The version an install from `record` meant to reach, when this launch is still the old one. */
function resolveNotAppliedInstallVersion(record, appVersion) {
	if (!record || typeof record.fromVersion !== "string" || typeof record.targetVersion !== "string") return null;
	return record.fromVersion === appVersion && record.targetVersion !== appVersion ? record.targetVersion : null;
}

/** The install a "downloaded" (or failed-install) state allows (T3's hasInstallableDownload). */
const hasInstallableDownload = (state) =>
	state.downloadedVersion !== null && (state.status === "downloaded" || (state.status === "error" && (state.errorContext === null || state.errorContext === "install")));

module.exports = {
	INSTALL_RECORD_FILE,
	createInitialUpdateState,
	isOffered,
	getCanRetryFromState,
	hasInstallableDownload,
	reduceOnCheckStart,
	reduceOnCheckFailure,
	reduceOnUpdateAvailable,
	reduceOnNoUpdate,
	reduceOnDownloadStart,
	reduceOnDownloadFailure,
	reduceOnDownloadProgress,
	reduceOnDownloadComplete,
	reduceOnInstallFailure,
	reduceOnUpdaterError,
	resolveNotAppliedInstallVersion,
	withVersion,
};

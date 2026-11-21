/**
 * The desktop updater's reducers (electron/update-machine.cjs), ported from
 * T3 Code's apps/desktop/src/updates/updateMachine.ts at df09ced7: one test
 * per transition, with T3's expected fields.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
type State = Record<string, unknown> & { status: string; version: string | null; availableVersion: string | null; downloadedVersion: string | null };
const m = require("../electron/update-machine.cjs") as Record<string, (...args: never[]) => never> & { INSTALL_RECORD_FILE: string };
const call = <T = State>(name: string, ...args: unknown[]): T => (m[name] as unknown as (...a: unknown[]) => T)(...args);

const AT = "2026-11-21T10:00:00.000Z";
const notes = [{ version: "0.3.8", items: ["a"], totalItems: 1 }];
const initial = (): State => call("createInitialUpdateState");
const available = () => call("reduceOnUpdateAvailable", initial(), "0.3.8", AT, notes, 2);
const downloaded = () => call("reduceOnDownloadComplete", call("reduceOnDownloadStart", available()), "0.3.8");
const pick = (state: State, ...keys: string[]) => Object.fromEntries(keys.map((key) => [key, state[key]]));

describe("T3's update reducers", () => {
	it("starts idle with nothing offered, and keeps LearnHarness's version and revision", () => {
		assert.deepEqual(initial(), {
			status: "idle", revision: 0, availableVersion: null, downloadedVersion: null, releaseNotes: [], omittedReleaseCount: 0,
			downloadPercent: null, checkedAt: null, message: null, errorContext: null, canRetry: false, version: null,
		});
	});

	it("check start: checking, notes cleared, unless a download is staged (then its notes stay and the ring is full)", () => {
		const plain = call("reduceOnCheckStart", available(), AT);
		assert.deepEqual(pick(plain, "status", "checkedAt", "releaseNotes", "downloadPercent", "errorContext", "canRetry"), { status: "checking", checkedAt: AT, releaseNotes: [], downloadPercent: null, errorContext: null, canRetry: false });
		const staged = call("reduceOnCheckStart", downloaded(), AT);
		assert.deepEqual(pick(staged, "status", "releaseNotes", "downloadPercent", "version"), { status: "checking", releaseNotes: notes, downloadPercent: 100, version: "0.3.8" });
	});

	it("check failure: error with the check context and a retry, but a staged download stays downloaded", () => {
		const failed = call("reduceOnCheckFailure", initial(), "Couldn’t check for updates. Try again later.", AT);
		assert.deepEqual(pick(failed, "status", "message", "checkedAt", "errorContext", "canRetry"), { status: "error", message: "Couldn’t check for updates. Try again later.", checkedAt: AT, errorContext: "check", canRetry: true });
		const staged = call("reduceOnCheckFailure", downloaded(), "x", AT);
		assert.deepEqual(pick(staged, "status", "message", "downloadPercent", "errorContext", "canRetry"), { status: "downloaded", message: null, downloadPercent: 100, errorContext: null, canRetry: true });
	});

	it("update available: the offered version and its notes; the version already downloaded reads downloaded", () => {
		assert.deepEqual(pick(available(), "status", "availableVersion", "downloadedVersion", "releaseNotes", "omittedReleaseCount", "version", "canRetry"), { status: "available", availableVersion: "0.3.8", downloadedVersion: null, releaseNotes: notes, omittedReleaseCount: 2, version: "0.3.8", canRetry: false });
		const again = call("reduceOnUpdateAvailable", downloaded(), "0.3.8", AT, [], 0);
		assert.deepEqual(pick(again, "status", "downloadedVersion", "releaseNotes", "downloadPercent", "canRetry"), { status: "downloaded", downloadedVersion: "0.3.8", releaseNotes: notes, downloadPercent: 100, canRetry: true }, "no new notes keeps the old ones");
	});

	it("no update: up to date with everything cleared, but a staged download stays", () => {
		assert.deepEqual(pick(call("reduceOnNoUpdate", available(), AT), "status", "availableVersion", "releaseNotes", "version"), { status: "up-to-date", availableVersion: null, releaseNotes: [], version: null });
		assert.deepEqual(pick(call("reduceOnNoUpdate", downloaded(), AT), "status", "availableVersion", "downloadPercent", "canRetry"), { status: "downloaded", availableVersion: "0.3.8", downloadPercent: 100, canRetry: true });
	});

	it("download: start at 0, progress, complete; a failure keeps the offer with the download context", () => {
		const start = call("reduceOnDownloadStart", available());
		assert.deepEqual(pick(start, "status", "downloadPercent", "errorContext", "canRetry"), { status: "downloading", downloadPercent: 0, errorContext: null, canRetry: false });
		assert.equal(call("reduceOnDownloadProgress", start, 40).downloadPercent, 40);
		assert.deepEqual(pick(downloaded(), "status", "downloadedVersion", "downloadPercent", "canRetry", "version"), { status: "downloaded", downloadedVersion: "0.3.8", downloadPercent: 100, canRetry: true, version: "0.3.8" });
		const failed = call("reduceOnDownloadFailure", start, "Couldn’t download the update. Try again.");
		assert.deepEqual(pick(failed, "status", "errorContext", "canRetry", "downloadPercent", "availableVersion"), { status: "available", errorContext: "download", canRetry: true, downloadPercent: null, availableVersion: "0.3.8" });
		const nothingOffered = call("reduceOnDownloadFailure", call("reduceOnDownloadStart", initial()), "x");
		assert.deepEqual(pick(nothingOffered, "status", "canRetry"), { status: "error", canRetry: false });
	});

	it("install failure keeps the download with the install context; an updater error then reads error, context kept", () => {
		const failed = call("reduceOnInstallFailure", downloaded(), "Couldn’t install the update.");
		assert.deepEqual(pick(failed, "status", "errorContext", "canRetry", "message"), { status: "downloaded", errorContext: "install", canRetry: true, message: "Couldn’t install the update." });
		const after = call("reduceOnUpdaterError", failed, "Couldn’t install the update.", AT);
		assert.deepEqual(pick(after, "status", "errorContext", "canRetry", "downloadPercent", "downloadedVersion"), { status: "error", errorContext: "install", canRetry: true, downloadPercent: null, downloadedVersion: "0.3.8" });
		assert.equal(call<boolean>("hasInstallableDownload", after), true, "still installable (T3's hasInstallableDownload)");
		assert.equal(call<boolean>("hasInstallableDownload", call("reduceOnUpdaterError", { ...downloaded(), errorContext: "download" }, "x", AT)), false);
		assert.equal(call<boolean>("hasInstallableDownload", available()), false);
	});

	it("messages are bounded, and the offer counts for a retry (T3's getCanRetryFromState)", () => {
		assert.equal((call("reduceOnCheckFailure", initial(), "x".repeat(1000), AT).message as string).length, 300);
		assert.equal(call("reduceOnCheckFailure", initial(), "   ", AT).message, null);
		assert.equal(call<boolean>("getCanRetryFromState", available()), true);
		assert.equal(call<boolean>("getCanRetryFromState", initial()), false);
	});

	it("an install that didn't apply: the record's old version is still running (T3's resolveNotAppliedInstallVersion)", () => {
		assert.equal(m.INSTALL_RECORD_FILE, "desktop-update-install.json");
		assert.equal(call("resolveNotAppliedInstallVersion", { fromVersion: "0.3.7", targetVersion: "0.3.8" }, "0.3.7"), "0.3.8");
		assert.equal(call("resolveNotAppliedInstallVersion", { fromVersion: "0.3.7", targetVersion: "0.3.8" }, "0.3.8"), null, "it applied");
		assert.equal(call("resolveNotAppliedInstallVersion", { fromVersion: "0.3.6", targetVersion: "0.3.7" }, "0.3.7"), null);
		assert.equal(call("resolveNotAppliedInstallVersion", { fromVersion: "0.3.7", targetVersion: "0.3.7" }, "0.3.7"), null);
		for (const bad of [null, {}, { fromVersion: 1, targetVersion: "0.3.8" }, "junk"]) assert.equal(call("resolveNotAppliedInstallVersion", bad, "0.3.7"), null);
	});
});

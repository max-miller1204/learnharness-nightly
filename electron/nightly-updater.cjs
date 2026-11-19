"use strict";

const { GenericProvider } = require("electron-updater/out/providers/GenericProvider");
const { newUrlFromBase } = require("electron-updater/out/util");
const { compareVersions } = require("./release-notes.cjs");

const NIGHTLY_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.[1-9]\d{7}\.(?:0|[1-9]\d*)$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

class NightlyProvider extends GenericProvider {
	constructor({ repository }, updater, runtimeOptions) {
		if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid nightly repository");
		const releaseRoot = new URL(`https://github.com/${repository}/releases/download/`);
		super({ provider: "generic", url: releaseRoot.href }, updater, {
			...runtimeOptions,
			// GitHub redirects release downloads to object storage, as with GitHubProvider.
			isUseMultipleRangeRequest: false,
		});
		this.releaseRoot = releaseRoot;
	}

	providerFor(version) {
		if (typeof version !== "string" || !NIGHTLY_VERSION.test(version)) throw new Error("Invalid nightly version");
		return new GenericProvider({
			provider: "generic",
			url: new URL(`v${version}/`, this.releaseRoot).href,
		}, this.updater, this.runtimeOptions);
	}

	async getLatestVersion() {
		// An app-only retry of Update everything's pinned version reads that exact
		// release, never the moving pointer (electron/update-actions.cjs downloadExact).
		const pinned = NightlyProvider.pinned;
		const pointer = pinned
			? { version: pinned, tag: `v${pinned}`, notes: [] }
			: JSON.parse(await this.httpRequest(newUrlFromBase("nightly/latest.json", this.releaseRoot, true), { "Cache-Control": "no-cache" }));
		const { version, tag, notes, publishedAt } = pointer ?? {};
		if (tag !== `v${version}`) throw new Error("Nightly pointer tag and version disagree");
		const provider = this.providerFor(version);
		provider.setRequestHeaders(this.requestHeaders);
		const info = await provider.getLatestVersion();
		if (info?.version !== version) throw new Error("Nightly manifest and pointer versions disagree");
		if (!Array.isArray(info.files) || info.files.length === 0 ||
			info.files.some((file) => typeof file?.url !== "string" || !ASSET_NAME.test(file.url)) ||
			typeof info.path !== "string" || !ASSET_NAME.test(info.path) || info.packages != null) {
			throw new Error("Nightly manifest must reference release asset filenames");
		}
		const current = this.updater.currentVersion.version;
		const releaseNotes = Array.isArray(notes) ? notes
			.filter((entry) => typeof entry?.version === "string" && NIGHTLY_VERSION.test(entry.version) &&
				compareVersions(entry.version, current) > 0 && compareVersions(entry.version, version) <= 0 &&
				Array.isArray(entry.items))
			.map((entry) => ({
				version: entry.version,
				note: entry.items.filter((item) => typeof item === "string").map((item) => `- ${item}`).join("\n"),
			})) : [];
		return { ...info, releaseDate: typeof publishedAt === "string" ? publishedAt : info.releaseDate, releaseNotes };
	}

	resolveFiles(info) {
		// The updater keeps the offered info during later checks. Derive its
		// download directory from that version even if the pointer has moved.
		return this.providerFor(info.version).resolveFiles(info);
	}

	getBlockMapFiles(baseUrl, oldVersion, newVersion, oldBlockMapFileBaseUrl) {
		if (oldBlockMapFileBaseUrl || !NIGHTLY_VERSION.test(oldVersion)) {
			return super.getBlockMapFiles(baseUrl, oldVersion, newVersion, oldBlockMapFileBaseUrl);
		}
		const filename = baseUrl.pathname.split("/").at(-1);
		return [
			new URL(`v${oldVersion}/${filename.replace(newVersion, oldVersion)}.blockmap`, this.releaseRoot),
			new URL(`${baseUrl.pathname}.blockmap`, baseUrl),
		];
	}
}

/** While set, every check offers exactly this nightly (see getLatestVersion). */
NightlyProvider.pinned = null;

module.exports = { NightlyProvider };

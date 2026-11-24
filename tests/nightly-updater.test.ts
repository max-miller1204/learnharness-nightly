import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { DATE_CASES, OFFERED, OLDER } from "./release-date-cases.ts";

const require = createRequire(import.meta.url);
const { NightlyProvider } = require("../electron/nightly-updater.cjs");
const { releaseNoteGroups } = require("../electron/release-notes.cjs");
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider");
const semver = createRequire(require.resolve("electron-updater"))("semver");

const root = "https://github.com/example/learnharness-nightly/releases/download/";
const current = "0.6.1-nightly.20261118.1";
const version = "0.6.1-nightly.20261118.3";
const newer = "0.6.1-nightly.20261118.4";
const pointer = {
	tag: `v${version}`, version, publishedAt: "2026-11-18T13:00:00Z",
	notes: [
		{ version: newer, items: ["After this release."] },
		{ version, items: ["**New.** Example update."], stats: "4 changes from 2 contributors", footer: "Plus 1 more bug fix." },
		{ version: "0.6.1-nightly.20261118.2", publishedAt: "2026-11-12T06:00:00Z", items: ["**HTML.** Preserve <br> in exports.", "- not a bullet", "### not a heading", "**v1** · not stats", "<details><summary>Full changelog</summary>"] },
		{ version: current, items: ["Already installed."] },
	],
};

function fixture(platform: string, manifest: string, extension: string) {
	let feed: unknown = pointer;
	let manifestVersion: string | undefined;
	let overrideFilename: string | undefined;
	const requests: string[] = [];
	const updater = { currentVersion: semver.parse(current), allowPrerelease: true };
	const options = {
		platform,
		executor: {
			async request(options: { path: string }) {
				const pathname = options.path.split("?")[0]!;
				requests.push(pathname);
				if (pathname.endsWith(".atom")) {
					const previews = Array.from({ length: 10 }, (_, i) =>
						`<entry><link href="https://github.com/example/learnharness-nightly/releases/tag/preview-pr-${i}"/></entry>`);
					return `<feed>${previews.join("")}</feed>`;
				}
				if (pathname.endsWith("/nightly/latest.json")) return JSON.stringify(feed);
				const tag = /\/download\/v([^/]+)\//.exec(pathname)?.[1];
				assert.match(pathname, new RegExp(`/v${tag}/${manifest}$`));
				const filename = overrideFilename ?? `LearnHarness-Nightly-${tag}.${extension}`;
				return `version: ${manifestVersion ?? tag}\npath: ${filename}\nfiles:\n  - url: ${filename}\n    sha512: fixture\n`;
			},
		},
	};
	return {
		provider: new NightlyProvider({ repository: "example/learnharness-nightly" }, updater, options),
		atom: new GitHubProvider({ owner: "example", repo: "learnharness-nightly" }, updater, options),
		requests,
		setFeed: (value: unknown) => { feed = value; },
		setManifestVersion: (value: string) => { manifestVersion = value; },
		setManifestFilename: (value: string) => { overrideFilename = value; },
	};
}

for (const [platform, manifest, extension] of [
	["darwin", "latest-mac.yml", "zip"],
	["win32", "latest.yml", "exe"],
	["linux", "latest-linux.yml", "AppImage"],
] as const) {
	test(`${platform} discovers a nightly when ten preview tags crowd out Atom`, async () => {
		const { atom, provider, requests } = fixture(platform, manifest, extension);
		await assert.rejects(atom.getLatestVersion(), { code: "ERR_UPDATER_NO_PUBLISHED_VERSIONS" });
		assert.equal(requests.length, 1);
		assert.match(requests.pop()!, /\.atom$/);

		const info = await provider.getLatestVersion();
		assert.deepEqual(requests, [
			"/example/learnharness-nightly/releases/download/nightly/latest.json",
			`/example/learnharness-nightly/releases/download/v${version}/${manifest}`,
		]);
		assert.equal(info.version, version);
		assert.equal(info.releaseDate, pointer.publishedAt);
		// The feed's own fields, structured, never through Markdown.
		const tricky = ["**HTML.** Preserve <br> in exports.", "- not a bullet", "### not a heading", "**v1** · not stats", "<details><summary>Full changelog</summary>"];
		assert.deepEqual(info.releaseNotes, [
			{ version, items: ["**New.** Example update."], stats: "4 changes from 2 contributors", footer: "Plus 1 more bug fix." },
			{ version: "0.6.1-nightly.20261118.2", items: tricky, releasedAt: "2026-11-12T06:00:00Z" },
		]);
		// The desktop reads them as they are: HTML-looking and Markdown-looking text stays one item each.
		assert.deepEqual(releaseNoteGroups(info), [
			{ version, items: ["**New.** Example update."], totalItems: 1, stats: "4 changes from 2 contributors", footer: "Plus 1 more bug fix.", releasedAt: pointer.publishedAt },
			// Its own publish time, as the server shows it, not its build day.
			{ version: "0.6.1-nightly.20261118.2", items: tricky, totalItems: 5, releasedAt: "2026-11-12T06:00:00Z" },
		]);
		assert.equal(provider.resolveFiles(info)[0].url.href, `${root}v${version}/LearnHarness-Nightly-${version}.${extension}`);
	});
}

test("the nightly provider rejects a mismatched tag, preview version and manifest with a different version or external URL", async () => {
	const f = fixture("win32", "latest.yml", "exe");
	f.setFeed({ ...pointer, tag: "preview-pr-12" });
	await assert.rejects(f.provider.getLatestVersion(), /tag and version disagree/);
	f.setFeed({ tag: "v0.6.1-preview.20261118.3", version: "0.6.1-preview.20261118.3" });
	await assert.rejects(f.provider.getLatestVersion(), /Invalid nightly version/);
	assert.equal(f.requests.length, 2, "invalid pointers make no manifest requests");
	f.setFeed(pointer);
	f.setManifestVersion(current);
	await assert.rejects(f.provider.getLatestVersion(), /manifest and pointer versions disagree/);
	f.setManifestVersion(version);
	f.setManifestFilename("https://example.com/installer.exe");
	await assert.rejects(f.provider.getLatestVersion(), /release asset filenames/);
});

test("Windows resolves old and new blockmaps by exact tag even when a later check advances the pointer", async () => {
	const f = fixture("win32", "latest.yml", "exe");
	const offered = await f.provider.getLatestVersion();
	f.setFeed({ version: newer, tag: `v${newer}` });
	assert.equal((await f.provider.getLatestVersion()).version, newer);
	const [{ url }] = f.provider.resolveFiles(offered);
	assert.deepEqual(f.provider.getBlockMapFiles(url, current, offered.version).map(String), [
		`${root}v${current}/LearnHarness-Nightly-${current}.exe.blockmap`,
		`${root}v${version}/LearnHarness-Nightly-${version}.exe.blockmap`,
	]);
	assert.equal(f.provider.isUseMultipleRangeRequest, false);
});

test("a pinned retry reads exactly that release, never the moving pointer", async (t) => {
	t.after(() => { NightlyProvider.pinned = null; });
	const { provider, requests, setFeed } = fixture("darwin", "latest-mac.yml", "zip");
	setFeed({ ...pointer, version: newer, tag: `v${newer}` });
	NightlyProvider.pinned = version;
	const info = await provider.getLatestVersion();
	assert.equal(info.version, version, "the pinned version, though the pointer has moved on");
	assert.deepEqual(requests, [`/example/learnharness-nightly/releases/download/v${version}/latest-mac.yml`]);
	NightlyProvider.pinned = null;
	assert.equal((await provider.getLatestVersion()).version, newer, "unpinned: the newest again");
	NightlyProvider.pinned = "../evil";
	await assert.rejects(provider.getLatestVersion(), /Invalid nightly version/);
});

test("pinFeed pins the real feed through the provider, and the LH_UPDATE_FEED test feed to its v<version>/ folder", (t) => {
	const { pinFeed } = require("../electron/nightly-updater.cjs");
	t.after(() => { NightlyProvider.pinned = null; });
	const feeds: unknown[] = [];
	const updater = { setFeedURL: (options: unknown) => feeds.push(options) };
	pinFeed(updater, version);
	assert.equal(NightlyProvider.pinned, version);
	pinFeed(updater, null);
	assert.equal(NightlyProvider.pinned, null);
	assert.deepEqual(feeds, [], "the real feed keeps its provider");

	pinFeed(updater, version, { override: "http://127.0.0.1:4100" });
	pinFeed(updater, null, { override: "http://127.0.0.1:4100" });
	assert.deepEqual(feeds, [
		{ provider: "generic", url: `http://127.0.0.1:4100/v${version}/` },
		{ provider: "generic", url: "http://127.0.0.1:4100" },
	], "the test feed's own folder for that version, then the newest again");
	assert.throws(() => pinFeed(updater, "../evil", { override: "http://127.0.0.1:4100/" }), /Invalid nightly version/);
	assert.equal(feeds.length, 2);
});

test("the provider hands the pointer's time to the note reader, so a note dates as it does on the server", async () => {
	for (const c of DATE_CASES) {
		const f = fixture("linux", "latest-linux.yml", "AppImage");
		f.setFeed({
			tag: `v${version}`, version, publishedAt: c.pointer,
			notes: [OFFERED, OLDER].map((v) => ({ version: v, ...(c.own ? { publishedAt: c.own } : {}), items: ["changed"] })),
		});
		const info = await f.provider.getLatestVersion();
		assert.deepEqual(releaseNoteGroups(info).map((g: { version: string; releasedAt?: string }) => [g.version, g.releasedAt]), [[OFFERED, c.offered], [OLDER, c.older]], c.name);
	}
});

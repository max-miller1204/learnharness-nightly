/**
 * Release feed, versions, staging and service state, shared by the `lh`
 * launcher and the LearnHarness server (src/server/self-update.ts), so the
 * logic exists once. The launcher needs it when the server is down
 * (install, `lh update --now`); the server uses it for in-app updates.
 *
 * Node built-ins only, erasable TypeScript only (see protocol.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { layout, versionPaths } from "./paths.ts";
import { compareVersions, isExactVersion } from "./version-order.ts";

export const STATE_PROTOCOL = 1;

// Versions live in version-order.ts (no imports, so the web app can use it too).
export { compareVersions, isExactVersion };

// ---------------------------------------------------------------------------
// Platform

/** Every arch the nightly builds. Old launchers read only the keys they know, so adding one is safe. */
export const ARCHES = ["linux-x64", "linux-arm64", "darwin-arm64"] as const;
export type Arch = (typeof ARCHES)[number];

export function currentArch(platform: string = process.platform, arch: string = process.arch): Arch | undefined {
	if (platform === "linux" && arch === "x64") return "linux-x64";
	if (platform === "linux" && arch === "arm64") return "linux-arm64";
	if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
	return undefined;
}

// ---------------------------------------------------------------------------
// Feed: latest.json on the fixed `nightly` release.

export const DEFAULT_FEED_URL = "https://github.com/max-miller1204/learnharness-nightly/releases/download/nightly/latest.json";

export interface FeedAsset {
	url: string;
	sha256: string;
}

/** One nightly's release notes in latest.json (docs/specs/t3-style-updates.md). */
export interface FeedNote {
	version: string;
	publishedAt: string;
	/** Plain sentences; `**Label.** detail` renders the label bold. */
	items: string[];
	/** The generated summary's counts, "12 changes from 2 contributors" (T3's release header). Optional: older feeds have none. */
	stats?: string;
	/** A summary paragraph, in place of items ("3 bug fixes." when no change got a highlight). */
	intro?: string;
	/** The summary's last line, "Plus 3 more bug fixes.". */
	footer?: string;
}

/** Bounds for the optional summary fields: longer ones are dropped. */
export const FEED_NOTE_LIMITS = { stats: 120, intro: 600, footer: 220 } as const;

function summaryField(value: unknown, limit: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/\s+/g, " ");
	return text && text.length <= limit ? text : undefined;
}

/** latest.json keeps the notes of this many newest nightlies (the same 30 nightly.yml keeps). */
export const FEED_NOTES_KEEP = 30;

export interface LatestFeed {
	version: string;
	tag: string;
	sha: string;
	publishedAt: string;
	launcherProtocol: number;
	minLauncherProtocol: number;
	assets: Partial<Record<Arch, FeedAsset>>;
	/** Newest first. Optional: older feeds have none, and old readers ignore it. */
	notes?: FeedNote[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function parseFeed(value: unknown): LatestFeed {
	if (!isRecord(value)) throw new Error("latest.json is not an object");
	const { version, tag, sha, publishedAt, launcherProtocol, minLauncherProtocol, assets, notes } = value;
	if (typeof version !== "string" || !isExactVersion(version)) throw new Error("latest.json has no valid version");
	if (typeof tag !== "string" || typeof sha !== "string" || typeof publishedAt !== "string") {
		throw new Error("latest.json is missing tag, sha or publishedAt");
	}
	if (!Number.isInteger(launcherProtocol) || !Number.isInteger(minLauncherProtocol)) {
		throw new Error("latest.json is missing launcher protocol numbers");
	}
	if (!isRecord(assets)) throw new Error("latest.json has no assets");
	const parsed: Partial<Record<Arch, FeedAsset>> = {};
	for (const arch of ARCHES) {
		const asset = assets[arch];
		if (asset === undefined) continue;
		if (!isRecord(asset) || typeof asset.url !== "string" || typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
			throw new Error(`latest.json has an invalid ${arch} asset`);
		}
		parsed[arch] = { url: asset.url, sha256: asset.sha256 };
	}
	const feed: LatestFeed = {
		version,
		tag,
		sha,
		publishedAt,
		launcherProtocol: launcherProtocol as number,
		minLauncherProtocol: minLauncherProtocol as number,
		assets: parsed,
	};
	if (notes !== undefined) feed.notes = parseFeedNotes(notes);
	return feed;
}

/** Notes never break an update: malformed entries are dropped, not thrown. */
export function parseFeedNotes(value: unknown): FeedNote[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const notes: FeedNote[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.version !== "string" || !isExactVersion(entry.version) || seen.has(entry.version)) continue;
		if (!Array.isArray(entry.items)) continue;
		seen.add(entry.version);
		const stats = summaryField(entry.stats, FEED_NOTE_LIMITS.stats);
		const intro = summaryField(entry.intro, FEED_NOTE_LIMITS.intro);
		const footer = summaryField(entry.footer, FEED_NOTE_LIMITS.footer);
		notes.push({
			version: entry.version,
			publishedAt: typeof entry.publishedAt === "string" ? entry.publishedAt : "",
			items: entry.items.filter((item): item is string => typeof item === "string" && item.trim() !== ""),
			...(stats ? { stats } : {}),
			...(intro ? { intro } : {}),
			...(footer ? { footer } : {}),
		});
	}
	return notes;
}

/** This release's entry first, then the previous feed's, deduped by version, newest FEED_NOTES_KEEP kept. */
export function mergeFeedNotes(entry: FeedNote, previous: readonly FeedNote[]): FeedNote[] {
	const merged = [entry, ...previous.filter((note) => note.version !== entry.version)];
	merged.sort((a, b) => compareVersions(b.version, a.version));
	return merged.slice(0, FEED_NOTES_KEEP);
}

/** Bytes received so far and the total from Content-Length (null when the server doesn't say). */
export type DownloadBytes = (received: number, total: number | null) => void;

/** Read a URL (https: or file:) as bytes. */
async function readUrl(url: string, signal?: AbortSignal, onBytes?: DownloadBytes): Promise<Buffer> {
	if (url.startsWith("file:")) {
		const bytes = await fsp.readFile(fileURLToPath(url));
		onBytes?.(bytes.length, bytes.length);
		return bytes;
	}
	const response = await fetch(url, { signal, redirect: "follow", headers: { "User-Agent": "learnharness-selfhost" } });
	if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
	return readBody(response, onBytes);
}

/** A response's whole body, reporting each chunk as it arrives (the sidebar's download ring). */
export async function readBody(response: Response, onBytes?: DownloadBytes): Promise<Buffer> {
	if (!onBytes || !response.body) return Buffer.from(await response.arrayBuffer());
	// A compressed transfer's Content-Length counts the compressed bytes, not the ones read here.
	const encoded = (response.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity";
	const length = Number(response.headers.get("content-length"));
	const total = !encoded && Number.isSafeInteger(length) && length > 0 ? length : null;
	const chunks: Uint8Array[] = [];
	let received = 0;
	onBytes(0, total);
	const reader = response.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.byteLength;
		onBytes(received, total);
	}
	return Buffer.concat(chunks);
}

export async function fetchLatest(feedUrl: string = DEFAULT_FEED_URL, signal?: AbortSignal): Promise<LatestFeed> {
	const body = await readUrl(feedUrl, signal);
	return parseFeed(JSON.parse(body.toString("utf8")));
}

/** One exact nightly's own latest.json, uploaded beside its archives: the
 *  feed URL with the `nightly` tag swapped for `v<version>` (as previewFeedUrl does). */
export function releaseFeedUrl(version: string, nightlyFeedUrl: string = DEFAULT_FEED_URL): string {
	if (!isExactVersion(version)) throw new Error("The requested target is not an exact version.");
	const match = /^(.*\/)nightly\/latest\.json$/.exec(nightlyFeedUrl);
	if (!match) throw new Error(`Can't find version ${version} next to the feed ${nightlyFeedUrl}.`);
	return `${match[1]}v${version}/latest.json`;
}

/** Update everything pins one exact version: read that release's own feed entry, never the moving pointer. */
export async function fetchRelease(version: string, nightlyFeedUrl: string = DEFAULT_FEED_URL, signal?: AbortSignal): Promise<LatestFeed> {
	const feed = await fetchLatest(releaseFeedUrl(version, nightlyFeedUrl), signal);
	if (feed.version !== version || feed.tag !== `v${version}`) throw new Error(`The release feed for ${version} names ${feed.version}.`);
	return feed;
}

// ---------------------------------------------------------------------------
// Durable writes (T3's replaceFileDurably): temp, fsync, rename, fsync dir.

export function writeFileDurably(file: string, contents: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	const fd = fs.openSync(temp, "w", 0o600);
	try {
		fs.writeFileSync(fd, contents);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(temp, file);
	try {
		const dir = fs.openSync(path.dirname(file), "r");
		try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
	} catch {
		/* directory fsync is best effort */
	}
}

// ---------------------------------------------------------------------------
// Service state (runtime/service-state.json). Only the launcher writes it.

export type UpdateStatus = "pending" | "committed" | "rolled-back" | "failed";

export interface UpdateRecord {
	id: string;
	fromVersion: string;
	targetVersion: string;
	status: UpdateStatus;
	reason?: string;
	/** Snapshot to restore if the trial fails. */
	backup?: string;
	/** Epoch ms of the last status change. */
	at: number;
}

export interface ServiceState {
	protocol: number;
	activeVersion: string;
	previousVersion?: string;
	badVersions: string[];
	update?: UpdateRecord;
}

export function parseState(value: unknown): ServiceState {
	if (!isRecord(value)) throw new Error("service state is not an object");
	if (typeof value.activeVersion !== "string" || !isExactVersion(value.activeVersion)) {
		throw new Error("service state has no valid activeVersion");
	}
	const state: ServiceState = {
		protocol: typeof value.protocol === "number" ? value.protocol : STATE_PROTOCOL,
		activeVersion: value.activeVersion,
		badVersions: Array.isArray(value.badVersions) ? value.badVersions.filter((v): v is string => typeof v === "string") : [],
	};
	if (typeof value.previousVersion === "string" && isExactVersion(value.previousVersion)) state.previousVersion = value.previousVersion;
	const u = value.update;
	if (isRecord(u) && typeof u.id === "string" && typeof u.fromVersion === "string" && typeof u.targetVersion === "string"
		&& (u.status === "pending" || u.status === "committed" || u.status === "rolled-back" || u.status === "failed")) {
		state.update = {
			id: u.id,
			fromVersion: u.fromVersion,
			targetVersion: u.targetVersion,
			status: u.status,
			at: typeof u.at === "number" ? u.at : 0,
			...(typeof u.reason === "string" ? { reason: u.reason } : {}),
			...(typeof u.backup === "string" ? { backup: u.backup } : {}),
		};
	}
	return state;
}

export function readState(home: string): ServiceState | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(layout(home).state, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return parseState(JSON.parse(raw));
}

export function writeState(home: string, state: ServiceState): void {
	writeFileDurably(layout(home).state, `${JSON.stringify({ ...state, protocol: STATE_PROTOCOL }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Installed versions

export function isInstalled(home: string, version: string): boolean {
	const p = versionPaths(home, version);
	try {
		return fs.readFileSync(p.complete, "utf8").trim() === version && fs.existsSync(p.serverEntry) && fs.existsSync(p.node);
	} catch {
		return false;
	}
}

export function installedVersions(home: string): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(layout(home).versions);
	} catch {
		return [];
	}
	return entries.filter((v) => isExactVersion(v) && isInstalled(home, v)).sort(compareVersions);
}

const run = (file: string, args: string[]) =>
	new Promise<void>((resolve, reject) => {
		execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
			if (error) reject(new Error(`${file} ${args.join(" ")} failed: ${stderr || error.message}`));
			else resolve();
		});
	});

export interface StageOptions {
	signal?: AbortSignal;
	/** Never install these (state.badVersions). */
	badVersions?: readonly string[];
	onProgress?: (phase: "downloading" | "verifying" | "extracting") => void;
	/** The archive's bytes as they arrive. */
	onBytes?: DownloadBytes;
}

/**
 * Download the arch tarball, check its SHA-256, extract it into
 * versions/<v>.tmp, check its VERSION file, rename it into place and write
 * .install-complete. Idempotent: an installed version returns immediately.
 */
export async function stageVersion(home: string, feed: LatestFeed, arch: Arch, options: StageOptions = {}): Promise<string> {
	const { version } = feed;
	if (options.badVersions?.includes(version)) throw new Error(`Version ${version} is marked bad on this install.`);
	if (isInstalled(home, version)) return version;
	const asset = feed.assets[arch];
	if (!asset) throw new Error(`Version ${version} has no ${arch} build.`);
	const dirs = layout(home);
	fs.mkdirSync(dirs.downloads, { recursive: true });
	fs.mkdirSync(dirs.versions, { recursive: true });

	options.onProgress?.("downloading");
	const archive = path.join(dirs.downloads, `learnharness-${version}-${arch}.tar.gz`);
	const bytes = await readUrl(asset.url, options.signal, options.onBytes);
	options.onProgress?.("verifying");
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== asset.sha256) throw new Error(`Checksum mismatch for ${version} (${arch}): expected ${asset.sha256}, got ${actual}.`);
	fs.writeFileSync(archive, bytes);

	options.onProgress?.("extracting");
	const final = versionPaths(home, version).dir;
	const temp = `${final}.tmp`;
	fs.rmSync(temp, { recursive: true, force: true });
	fs.mkdirSync(temp, { recursive: true });
	try {
		await run("tar", ["-xzf", archive, "-C", temp, "--no-same-owner"]);
		const declared = fs.readFileSync(path.join(temp, "VERSION"), "utf8").trim();
		if (declared !== version) throw new Error(`Archive declares version ${declared}, expected ${version}.`);
		fs.rmSync(final, { recursive: true, force: true });
		fs.renameSync(temp, final);
		writeFileDurably(versionPaths(home, version).complete, `${version}\n`);
	} catch (error) {
		fs.rmSync(temp, { recursive: true, force: true });
		throw error;
	} finally {
		fs.rmSync(archive, { force: true });
	}
	return version;
}

/**
 * Unit tests for the launcher's building blocks: versions and the feed,
 * staging, durable state, backups (copies, not links), log bounding,
 * locks, the child environment, the systemd unit, the launchd agent, the
 * installer and the frozen protocol.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { listBackups, pruneBackups, restore, snapshot, spaceForSnapshot } from "../src/backup.ts";
import { buildChildEnv, DEFAULT_CONFIG, detectChrome, MANAGED_ENV_NAMES, readConfig, writeConfig } from "../src/config.ts";
import { lockIsHeld, tryAcquireLock } from "../src/locks.ts";
import { boundLog } from "../src/logs.ts";
import { layout, versionPaths } from "../src/paths.ts";
import { ENV, parseChildMessage, parseParentMessage } from "../src/protocol.ts";
import { compareVersions, currentArch, FEED_NOTES_KEEP, installedVersions, isInstalled, mergeFeedNotes, parseFeed, readState, stageVersion, writeState, type LatestFeed } from "../src/release.ts";
import { launchdLabel, launchdPath, parseLaunchdState, renderPlist, renderUnit, repointService, repointUnitText, serviceManager, shimPath, unitVersion } from "../src/service.ts";
import { MAC_APP_CLI, tailscaleBin } from "../src/tailscale.ts";
import { pruneVersions } from "../src/versions.ts";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mod-")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const V = (date: string, run: number) => `0.6.1-nightly.${date}.${run}`;

describe("versions and feed", () => {
	it("orders versions by base, then date, then run", () => {
		const sorted = [V("20261117", 3), "0.6.1", V("20261116", 9), "0.7.0-nightly.20261101.1", V("20261116", 10)].sort(compareVersions);
		assert.deepEqual(sorted, [V("20261116", 9), V("20261116", 10), V("20261117", 3), "0.6.1", "0.7.0-nightly.20261101.1"]);
		assert.throws(() => compareVersions("latest", "0.6.1"));
	});

	it("parses latest.json and rejects bad checksums", () => {
		const good = { version: V("20261116", 1), tag: "v1", sha: "abc", publishedAt: "now", launcherProtocol: 1, minLauncherProtocol: 1, assets: { "linux-x64": { url: "u", sha256: "a".repeat(64) } } };
		assert.equal(parseFeed(good).assets["linux-x64"]?.url, "u");
		assert.throws(() => parseFeed({ ...good, assets: { "linux-x64": { url: "u", sha256: "nope" } } }));
		const mac = parseFeed({ ...good, assets: { ...good.assets, "darwin-arm64": { url: "m", sha256: "c".repeat(64) }, "plan9-mips": { url: "x", sha256: "d".repeat(64) } } });
		assert.equal(mac.assets["darwin-arm64"]?.url, "m");
		assert.deepEqual(Object.keys(mac.assets).sort(), ["darwin-arm64", "linux-x64"], "unknown arches are dropped, as old launchers drop darwin-arm64");
		assert.throws(() => parseFeed({ ...good, version: "latest" }));
		assert.throws(() => parseFeed({ ...good, launcherProtocol: undefined }));
	});

	it("reads optional release notes, dropping malformed entries instead of failing", () => {
		const good = { version: V("20261116", 1), tag: "v1", sha: "abc", publishedAt: "now", launcherProtocol: 1, minLauncherProtocol: 1, assets: {} };
		assert.equal(parseFeed(good).notes, undefined, "a feed without notes still parses");
		const feed = parseFeed({ ...good, notes: [
			{ version: V("20261116", 1), publishedAt: "t", items: ["a", 3, ""] },
			{ version: "latest", items: ["x"] },
			{ version: V("20261115", 1) },
			"junk",
			{ version: V("20261116", 1), items: ["dupe"] },
		] });
		assert.deepEqual(feed.notes, [{ version: V("20261116", 1), publishedAt: "t", items: ["a"] }]);
		assert.deepEqual(parseFeed({ ...good, notes: "nope" }).notes, []);
	});

	it("merges this release's notes over the previous feed's, newest first, newest 30 kept", () => {
		const previous = Array.from({ length: 35 }, (_, i) => ({ version: V("20261101", i + 1), publishedAt: "", items: [`old ${i + 1}`] }));
		const merged = mergeFeedNotes({ version: V("20261117", 1), publishedAt: "", items: ["new"] }, [{ version: V("20261117", 1), publishedAt: "", items: ["stale"] }, ...previous]);
		assert.equal(merged.length, FEED_NOTES_KEEP);
		assert.deepEqual(merged[0], { version: V("20261117", 1), publishedAt: "", items: ["new"] });
		assert.equal(merged[1]!.version, V("20261101", 35));
	});

	it("make-feed writes the notes history into latest.json", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-feed-"));
		try {
			const version = V("20261117", 2);
			fs.writeFileSync(path.join(dir, `learnharness-${version}-linux-x64.tar.gz.sha256`), `${"b".repeat(64)}  file\n`);
			fs.writeFileSync(path.join(dir, "notes.json"), JSON.stringify({ version, publishedAt: "t", items: ["**New.** thing"] }));
			fs.writeFileSync(path.join(dir, "previous.json"), JSON.stringify({ version: V("20261116", 1), notes: [{ version: V("20261116", 1), publishedAt: "s", items: ["older"] }] }));
			const script = path.join(import.meta.dirname, "..", "scripts", "make-feed.ts");
			const out = execFileSync(process.execPath, [script, "--version", version, "--tag", `v${version}`, "--sha", "abc", "--repo", "o/r", "--dir", dir,
				"--notes", path.join(dir, "notes.json"), "--previous", path.join(dir, "previous.json")], { encoding: "utf8" });
			const feed = parseFeed(JSON.parse(out));
			assert.deepEqual(feed.notes?.map((n) => n.version), [version, V("20261116", 1)]);
			const bare = execFileSync(process.execPath, [script, "--version", version, "--tag", `v${version}`, "--sha", "abc", "--repo", "o/r", "--dir", dir,
				"--previous", path.join(dir, "missing.json")], { encoding: "utf8" });
			assert.deepEqual(parseFeed(JSON.parse(bare)).notes, [], "no notes and no previous feed: an empty history");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

function buildArchive(dir: string, version: string, declared = version): { file: string; sha256: string } {
	const stage = fs.mkdtempSync(path.join(os.tmpdir(), "lh-stage-"));
	fs.mkdirSync(path.join(stage, "node", "bin"), { recursive: true });
	fs.writeFileSync(path.join(stage, "node", "bin", "node"), "#!/bin/sh\n");
	fs.mkdirSync(path.join(stage, "server"), { recursive: true });
	fs.writeFileSync(path.join(stage, "server", "server.js"), "// server\n");
	fs.writeFileSync(path.join(stage, "VERSION"), `${declared}\n`);
	const file = path.join(dir, `lh-${version}.tar.gz`);
	execFileSync("tar", ["-czf", file, "-C", stage, "."]);
	fs.rmSync(stage, { recursive: true, force: true });
	return { file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
}

const feedFor = (version: string, file: string, sha256: string): LatestFeed => ({
	version, tag: `v${version}`, sha: "c0ffee", publishedAt: "2026-11-16T00:00:00Z", launcherProtocol: 1, minLauncherProtocol: 1,
	assets: { "linux-x64": { url: pathToFileURL(file).href, sha256 } },
});

describe("staging", () => {
	it("downloads, verifies, extracts and marks a version complete (idempotent)", async () => {
		const version = V("20261116", 1);
		const { file, sha256 } = buildArchive(home, version);
		await stageVersion(home, feedFor(version, file, sha256), "linux-x64");
		assert.ok(isInstalled(home, version));
		assert.deepEqual(installedVersions(home), [version]);
		await stageVersion(home, feedFor(version, file, "0".repeat(64)), "linux-x64");
	});

	it("refuses a checksum mismatch, a wrong VERSION file and a bad version", async () => {
		const version = V("20261116", 2);
		const { file, sha256 } = buildArchive(home, version);
		await assert.rejects(stageVersion(home, feedFor(version, file, "0".repeat(64)), "linux-x64"), /Checksum mismatch/);
		const wrong = buildArchive(home, V("20261116", 3), "0.0.1");
		await assert.rejects(stageVersion(home, feedFor(V("20261116", 3), wrong.file, wrong.sha256), "linux-x64"), /declares version/);
		await assert.rejects(stageVersion(home, feedFor(version, file, sha256), "linux-x64", { badVersions: [version] }), /marked bad/);
		assert.equal(isInstalled(home, version), false);
		assert.equal(fs.existsSync(`${versionPaths(home, V("20261116", 3)).dir}.tmp`), false, "no leftover temp folder");
	});

	it("prunes installed versions beyond three, never the protected ones", async () => {
		const versions = [1, 2, 3, 4, 5].map((n) => V("20261116", n));
		for (const v of versions) {
			fs.mkdirSync(versionPaths(home, v).serverDir, { recursive: true });
			fs.mkdirSync(path.dirname(versionPaths(home, v).node), { recursive: true });
			fs.writeFileSync(versionPaths(home, v).serverEntry, "");
			fs.writeFileSync(versionPaths(home, v).node, "");
			fs.writeFileSync(versionPaths(home, v).complete, `${v}\n`);
		}
		pruneVersions(home, [versions[0], versions[4]]);
		assert.deepEqual(installedVersions(home), versions.filter((_, i) => [0, 3, 4].includes(i)).sort(compareVersions));
	});
});

describe("durable state", () => {
	it("writes through a temp file and reads back", () => {
		writeState(home, { protocol: 1, activeVersion: V("20261116", 1), badVersions: [], update: { id: "u", fromVersion: V("20261116", 1), targetVersion: V("20261117", 2), status: "pending", at: 5 } });
		const state = readState(home);
		assert.equal(state?.update?.status, "pending");
		assert.deepEqual(fs.readdirSync(layout(home).runtime).filter((n) => n.endsWith(".tmp")), []);
	});
});

describe("backups", () => {
	it("snapshots are full copies: an append after the snapshot doesn't change it", () => {
		const dirs = layout(home);
		fs.mkdirSync(path.join(dirs.data, "graph"), { recursive: true });
		const ledger = path.join(dirs.data, "graph", "ledger.jsonl");
		fs.writeFileSync(ledger, "one\n");
		fs.writeFileSync(dirs.auth, "{}\n");
		fs.mkdirSync(dirs.logs, { recursive: true });
		fs.writeFileSync(dirs.serverLog, "log\n");
		const snap = snapshot(home, "v1-a");
		fs.appendFileSync(ledger, "two\n");
		assert.equal(fs.readFileSync(path.join(snap, "data", "graph", "ledger.jsonl"), "utf8"), "one\n");
		assert.equal(fs.existsSync(path.join(snap, "logs")), false, "logs aren't snapshotted");
		restore(home, snap);
		assert.equal(fs.readFileSync(ledger, "utf8"), "one\n");
		assert.equal(fs.readFileSync(dirs.serverLog, "utf8"), "log\n", "restore leaves logs alone");
	});

	it("keeps the newest three and reports missing space", () => {
		for (const n of [1, 2, 3, 4]) {
			const dir = snapshot(home, `v-${n}`);
			const t = new Date(2026, 10, n);
			fs.utimesSync(dir, t, t);
		}
		pruneBackups(home, 3);
		assert.deepEqual(listBackups(home).map((d) => path.basename(d)), ["v-2", "v-3", "v-4"]);
		assert.equal(spaceForSnapshot(home, () => 10 * 1024 ** 3), undefined);
		assert.match(spaceForSnapshot(home, () => 1) ?? "", /Not enough disk space/);
	});
});

describe("log bounding", () => {
	it("copies an oversized log to .1 and empties the same file in place", () => {
		const log = path.join(home, "server.log");
		fs.writeFileSync(log, Buffer.alloc(11 * 1024 * 1024, 120));
		const inode = fs.statSync(log).ino;
		boundLog(log);
		assert.equal(fs.statSync(log).size, 0);
		assert.equal(fs.statSync(log).ino, inode, "not replaced: systemd keeps it open");
		assert.equal(fs.statSync(`${log}.1`).size, 11 * 1024 * 1024);
		fs.writeFileSync(log, "small");
		boundLog(log);
		assert.equal(fs.readFileSync(log, "utf8"), "small");
	});
});

describe("locks", () => {
	it("is exclusive and released on close", () => {
		const file = path.join(home, "x.lock");
		const first = tryAcquireLock(file);
		assert.ok(first);
		assert.equal(tryAcquireLock(file), undefined);
		assert.equal(lockIsHeld(file), true);
		first.close();
		assert.equal(lockIsHeld(file), false);
	});
});

describe("child environment", () => {
	it("service.env can't override managed names; the Tailscale name is no longer merged into LH_ALLOWED_HOSTS", () => {
		const ignored: string[] = [];
		const env = buildChildEnv({
			home,
			config: { ...DEFAULT_CONFIG, tailscale: { enabled: true, port: 8443, hostname: "box.tail.ts.net" }, chromePath: "/usr/bin/chromium" },
			inherited: { PATH: "/usr/bin", LH_DESKTOP_API_SECRET: "x", LH_TRIAL_UPDATE_ID: "stale" } as unknown as NodeJS.ProcessEnv,
			serviceEnv: { PORT: "9", LH_DATA_DIR: "/elsewhere", OPENAI_API_KEY: "sk-test", LH_ALLOWED_HOSTS: "mine.example" },
			onIgnored: (n) => ignored.push(n),
		});
		assert.equal(env.PORT, "3774");
		assert.equal(env.LH_DATA_DIR, layout(home).data);
		assert.equal(env.OPENAI_API_KEY, "sk-test");
		assert.equal(env.HOSTNAME, "127.0.0.1");
		assert.equal(env[ENV.selfhost], "1");
		assert.equal(env.LH_ALLOWED_HOSTS, "mine.example", "an unmanaged service.env name passes through; nothing reads it now");
		assert.equal(env.CHROME_PATH, "/usr/bin/chromium");
		assert.equal(env.LH_DESKTOP_API_SECRET, undefined);
		assert.equal(env.LH_TRIAL_UPDATE_ID, undefined);
		assert.ok(env.PATH?.split(":").includes(path.join(os.homedir(), ".local", "bin")));
		assert.deepEqual(ignored.sort(), ["LH_DATA_DIR", "PORT"]);
		assert.ok(MANAGED_ENV_NAMES.has("PATH"));
	});

	it("round-trips config.json with defaults", () => {
		assert.equal(readConfig(home).port, 3774);
		writeConfig(home, { ...DEFAULT_CONFIG, port: 4000 });
		assert.equal(readConfig(home).port, 4000);
		assert.equal(readConfig(home).tailscale.port, 8443);
	});
});

describe("systemd unit", () => {
	it("repoints ExecStart to another version", () => {
		const unit = renderUnit(home, V("20261116", 1), "learnharness-test");
		assert.equal(unitVersion(unit), V("20261116", 1));
		const next = repointUnitText(unit, V("20261117", 2));
		assert.equal(unitVersion(next), V("20261117", 2));
		assert.match(next, /Restart=always/);
		assert.match(next, /KillMode=mixed/);
	});
});

describe("platforms", () => {
	it("maps platform and CPU to a build", () => {
		assert.equal(currentArch("linux", "x64"), "linux-x64");
		assert.equal(currentArch("linux", "arm64"), "linux-arm64");
		assert.equal(currentArch("darwin", "arm64"), "darwin-arm64");
		assert.equal(currentArch("darwin", "x64"), undefined, "no Intel Mac builds");
		assert.equal(currentArch("win32", "x64"), undefined);
	});

	it("picks launchd on macOS and systemd elsewhere", () => {
		assert.equal(serviceManager("darwin", "learnharness").kind, "launchd");
		assert.equal(serviceManager("darwin", "learnharness").displayName, "com.learnharness.server");
		assert.match(serviceManager("darwin", "learnharness").file, /Library\/LaunchAgents\/com\.learnharness\.server\.plist$/);
		assert.equal(serviceManager("linux", "learnharness").displayName, "learnharness.service");
		assert.equal(launchdLabel("lh-test"), "com.learnharness.lh-test");
	});

	it("finds Chrome in a Mac's Applications folders", () => {
		const app = path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome");
		fs.mkdirSync(path.dirname(app), { recursive: true });
		fs.writeFileSync(app, "#!/bin/sh\n", { mode: 0o755 });
		const appDirs = ["/nonexistent", path.join(home, "Applications")];
		assert.equal(detectChrome("/nonexistent", { platform: "darwin", systemDirs: [], appDirs }), app);
		assert.equal(detectChrome("/nonexistent", { platform: "linux", systemDirs: [], appDirs }), undefined, "Linux never looks in Applications");
		const onPath = path.join(home, "bin", "chromium");
		fs.mkdirSync(path.dirname(onPath));
		fs.writeFileSync(onPath, "#!/bin/sh\n", { mode: 0o755 });
		assert.equal(detectChrome(path.dirname(onPath), { platform: "darwin", systemDirs: [], appDirs }), onPath, "PATH comes first");
	});

	it("falls back to the Tailscale app's CLI on a Mac", () => {
		assert.equal(tailscaleBin("darwin", () => false, (file) => file === MAC_APP_CLI), MAC_APP_CLI);
		assert.equal(tailscaleBin("darwin", () => true, () => true), "tailscale");
		assert.equal(tailscaleBin("darwin", () => false, () => false), "tailscale");
		assert.equal(tailscaleBin("linux", () => false, () => true), "tailscale");
	});
});

describe("launchd agent", () => {
	it("runs the lh shim with T3's keys, and escapes XML", () => {
		const odd = path.join(home, "a&b<c>");
		const plist = renderPlist(odd, "learnharness", "/usr/bin:/bin");
		assert.match(plist, /<key>Label<\/key>\n {2}<string>com\.learnharness\.server<\/string>/);
		assert.ok(plist.includes(`<string>${shimPath().replaceAll("&", "&amp;")}</string>\n    <string>__service</string>`), "ProgramArguments is the shim, never a version folder");
		assert.ok(!plist.includes("runtime/versions"));
		assert.ok(plist.includes("a&amp;b&lt;c&gt;"));
		assert.ok(!plist.includes("a&b<c>"));
		for (const key of ["RunAtLoad", "KeepAlive"]) assert.match(plist, new RegExp(`<key>${key}</key>\\n {2}<true/>`));
		assert.match(plist, /<key>ExitTimeOut<\/key>\n {2}<integer>30<\/integer>/);
		assert.match(plist, /<key>ProcessType<\/key>\n {2}<string>Interactive<\/string>/);
		assert.ok(plist.includes(`${layout(odd).serviceLog.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string>`));
		assert.match(plist, /<key>PATH<\/key>\n {4}<string>\/usr\/bin:\/bin<\/string>/);
	});

	it("builds PATH from the shell's, minus version folders, plus Homebrew", () => {
		const versions = layout(home).versions;
		const built = launchdPath(home, `/Users/me/.local/bin:${versions}/1.0.0/node/bin:/usr/bin:/custom\u0001bad:/opt/homebrew/bin`);
		assert.deepEqual(built.split(":"), ["/Users/me/.local/bin", "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin", "/bin", "/usr/sbin", "/sbin"]);
	});

	it("reads the job state from launchctl print", () => {
		assert.equal(parseLaunchdState("gui/501/com.learnharness.server = {\n\tactive count = 1\n\tstate = running\n\n\tprogram = /x\n"), "running");
		assert.equal(parseLaunchdState("\tstate = not running\n"), "not running");
		assert.equal(parseLaunchdState(""), undefined);
	});

	it("repoints only the shim on macOS", () => {
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lh-bin-"));
		const saved = process.env.LH_BIN_DIR;
		process.env.LH_BIN_DIR = bin;
		try {
			assert.equal(repointService(home, V("20261117", 2), "lh-test-none", "darwin"), undefined);
			assert.match(fs.readFileSync(path.join(bin, "lh"), "utf8"), new RegExp(`versions/${V("20261117", 2).replaceAll(".", "\\.")}/lh`));
		} finally {
			if (saved === undefined) delete process.env.LH_BIN_DIR;
			else process.env.LH_BIN_DIR = saved;
			fs.rmSync(bin, { recursive: true, force: true });
		}
	});
});

describe("install.sh", () => {
	// A stub archive whose `lh` records how the installer called it.
	it("installs the feed's version, not a release-notes entry's", () => {
		const version = V("20261118", 2);
		const stage = path.join(home, "stage");
		fs.mkdirSync(stage);
		fs.writeFileSync(path.join(stage, "VERSION"), `${version}\n`);
		fs.writeFileSync(path.join(stage, "lh"), `#!/bin/sh\necho "$*" >> "${path.join(home, "calls")}"\n`, { mode: 0o755 });
		const arch = currentArch();
		if (!arch) return;
		const archive = path.join(home, "lh.tar.gz");
		execFileSync("tar", ["-czf", archive, "-C", stage, "."]);
		const sha256 = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
		const feed = {
			version, tag: `v${version}`, sha: "abc", publishedAt: "now", launcherProtocol: 1, minLauncherProtocol: 1,
			assets: { [arch]: { url: pathToFileURL(archive).href, sha256 } },
			notes: [{ version, publishedAt: "now", items: ["new"] }, { version: V("20261117", 1), publishedAt: "then", items: ["old"] }],
		};
		const feedFile = path.join(home, "latest.json");
		fs.writeFileSync(feedFile, JSON.stringify(feed, null, 2));
		const lhHomeDir = path.join(home, "lhhome");
		execFileSync("sh", [path.join(import.meta.dirname, "..", "install.sh")], {
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LH_HOME: lhHomeDir, LH_FEED_URL: pathToFileURL(feedFile).href, LH_YES: "1", NODE_ENV: "test" },
			stdio: "pipe",
		});
		assert.ok(fs.existsSync(path.join(lhHomeDir, "runtime", "versions", version, "VERSION")));
		assert.deepEqual(fs.readFileSync(path.join(home, "calls"), "utf8").trim().split("\n"), ["__install", `up --yes --feed-url=${pathToFileURL(feedFile).href}`]);
	});
});

describe("frozen handshake", () => {
	// These shapes must never change: any running launcher has to be able to
	// trial and commit any newer server. Add new message types instead.
	it("accepts exactly the protocol-1 messages", () => {
		assert.deepEqual(parseChildMessage({ type: "request-update", targetVersion: "1.0.0" }), { type: "request-update", targetVersion: "1.0.0" });
		assert.deepEqual(parseChildMessage({ type: "prepared", updateId: "u" }), { type: "prepared", updateId: "u" });
		assert.deepEqual(parseParentMessage({ type: "update-accepted", updateId: "u" }), { type: "update-accepted", updateId: "u" });
		assert.deepEqual(parseParentMessage({ type: "update-rejected", reason: "r" }), { type: "update-rejected", reason: "r" });
		assert.deepEqual(parseParentMessage({ type: "committed", updateId: "u" }), { type: "committed", updateId: "u" });
		assert.equal(parseChildMessage({ type: "request-update" }), undefined);
		assert.equal(parseParentMessage({ type: "committed" }), undefined);
	});
});

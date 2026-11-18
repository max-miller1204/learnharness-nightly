/**
 * `lh preview <N>` (docs/specs/pr-previews.md): the pure helpers, and a real
 * run of the launcher against a file: feed whose archive holds a stub server
 * (the host Node behind a shell script, plus a server.js that answers
 * /api/health and records its environment).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_CONFIG, writeConfig } from "../src/config.ts";
import { layout } from "../src/paths.ts";
import { parsePrNumber, previewConfig, previewFeedUrl, previewHome, previewLockPath, previewPidPath, previewServeMarker } from "../src/preview.ts";

const LH = path.join(import.meta.dirname, "..", "lh.ts");
const VERSION = "0.6.1-preview.20261117.42";

describe("preview helpers", () => {
	it("reads PR numbers", () => {
		assert.equal(parsePrNumber("12"), 12);
		assert.equal(parsePrNumber("#240"), 240);
		for (const bad of [undefined, "", "0", "012", "-3", "12a", "1.5", "pr-12"]) assert.equal(parsePrNumber(bad), undefined, String(bad));
	});

	it("finds the preview release next to the nightly feed", () => {
		assert.equal(previewFeedUrl(12), "https://github.com/max-miller1204/learnharness-nightly/releases/download/preview-pr-12/latest.json");
		assert.equal(previewFeedUrl(3, "file:///tmp/x/nightly/latest.json"), "file:///tmp/x/preview-pr-3/latest.json");
		assert.throws(() => previewFeedUrl(3, "https://mirror.example/feed.json"), /--feed-url/);
	});

	it("uses the real ports + 1 and keeps the Tailscale name", () => {
		assert.deepEqual(previewConfig(DEFAULT_CONFIG), { port: 3775, tailscale: { enabled: false, port: 8444 } });
		const real = { port: 4000, tailscale: { enabled: true, port: 9000, hostname: "box.tail.ts.net" }, chromePath: "/usr/bin/chromium", feedUrl: "x" };
		assert.deepEqual(previewConfig(real, 4002), { port: 4002, tailscale: { enabled: true, port: 9002, hostname: "box.tail.ts.net" }, chromePath: "/usr/bin/chromium" });
		assert.equal(previewConfig(real).tailscale.port, 9001);
		assert.equal(previewConfig(real, 4000).tailscale.enabled, false, "never the real Tailscale port or an invalid one");
		assert.equal(previewHome("/h", 7), path.join("/h", "previews", "pr-7"));
		assert.equal(previewLockPath("/h", 7), path.join("/h", "previews", "pr-7.lock"));
	});
});

const STUB_SERVER = `
const fs = require("node:fs");
const http = require("node:http");
fs.writeFileSync(process.env.STUB_ENV_OUT, JSON.stringify({ env: process.env, ipc: typeof process.send === "function" }));
http.createServer((req, res) => {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(req.url === "/api/health" ? { ok: true, idle: true, version: fs.readFileSync(__dirname + "/../VERSION", "utf8").trim(), selfhost: false } : {}));
}).listen(Number(process.env.PORT), process.env.HOSTNAME);
`;

function buildFeed(dir: string): string {
	const stage = fs.mkdtempSync(path.join(os.tmpdir(), "lh-preview-stage-"));
	fs.mkdirSync(path.join(stage, "node", "bin"), { recursive: true });
	fs.writeFileSync(path.join(stage, "node", "bin", "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
	fs.mkdirSync(path.join(stage, "server"), { recursive: true });
	fs.writeFileSync(path.join(stage, "server", "server.js"), STUB_SERVER);
	fs.writeFileSync(path.join(stage, "VERSION"), `${VERSION}\n`);
	const releaseDir = path.join(dir, "preview-pr-7");
	fs.mkdirSync(releaseDir, { recursive: true });
	const file = path.join(releaseDir, `learnharness-${VERSION}-linux-x64.tar.gz`);
	execFileSync("tar", ["-czf", file, "-C", stage, "."]);
	fs.rmSync(stage, { recursive: true, force: true });
	const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	const arch = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	const feed = { version: VERSION, tag: "preview-pr-7", sha: "abcdef0123456789", publishedAt: "2026-11-17T00:00:00Z", launcherProtocol: 1, minLauncherProtocol: 1, assets: { [arch]: { url: pathToFileURL(file).href, sha256 } } };
	fs.writeFileSync(path.join(releaseDir, "latest.json"), JSON.stringify(feed));
	return pathToFileURL(path.join(releaseDir, "latest.json")).href;
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = net.createServer().listen(0, "127.0.0.1", () => {
			const port = (server.address() as net.AddressInfo).port;
			server.close(() => resolve(port));
		});
	});
}

function waitFor(child: ChildProcess, text: RegExp, output: () => string, ms = 30_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${text}; output:\n${output()}`)), ms);
		const check = () => { if (text.test(output())) { clearTimeout(timer); resolve(); } };
		child.stdout?.on("data", check);
		child.once("exit", () => { clearTimeout(timer); text.test(output()) ? resolve() : reject(new Error(`exited before ${text}; output:\n${output()}`)); });
	});
}

describe("lh preview", { skip: process.platform !== "linux" }, () => {
	let home: string;
	let work: string;
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-preview-home-"));
		work = fs.mkdtempSync(path.join(os.tmpdir(), "lh-preview-work-"));
		fs.mkdirSync(layout(home).data, { recursive: true });
		fs.writeFileSync(path.join(layout(home).data, "real.txt"), "real data\n");
		fs.writeFileSync(layout(home).auth, '{"anthropic":"real-key"}\n');
		fs.writeFileSync(layout(home).serviceEnv, "FROM_SERVICE_ENV=1\n");
	});
	// Every `lh preview` a case spawns, so a failed case can't leave one holding a port.
	const running: ChildProcess[] = [];
	const track = (child: ChildProcess) => { running.push(child); return child; };
	afterEach(async () => {
		for (const child of running.splice(0)) {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			child.kill("SIGKILL");
			await new Promise((resolve) => child.once("exit", resolve));
		}
		// The preview server it started outlives a killed launcher.
		try {
			const pid = Number(fs.readFileSync(previewPidPath(home, 7), "utf8"));
			if (fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`LH_HOME=${previewHome(home, 7)}`)) process.kill(pid, "SIGKILL");
		} catch { /* nothing left running */ }
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	it("runs the build beside the real server on fresh data, then deletes it on Ctrl+C", async () => {
		const feedUrl = buildFeed(work);
		const port = await freePort();
		const envOut = path.join(work, "env.json");
		let output = "";
		const child = track(spawn(process.execPath, [LH, "preview", "7", "--port", String(port), "--feed-url", feedUrl], {
			env: { ...process.env, LH_HOME: home, STUB_ENV_OUT: envOut, DISPLAY: "", WAYLAND_DISPLAY: "" },
			stdio: ["ignore", "pipe", "pipe"],
		}));
		child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		await waitFor(child, /Ctrl\+C stops the preview/, () => output);

		assert.match(output, new RegExp(`PR #7 preview ${VERSION.replace(/\./g, "\\.")} \\(abcdef012345\\) is running`));
		assert.match(output, new RegExp(`http://127\\.0\\.0\\.1:${port}/pair#token=`));
		const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { version: string };
		assert.equal(health.version, VERSION);

		const pHome = previewHome(home, 7);
		const { env, ipc } = JSON.parse(fs.readFileSync(envOut, "utf8")) as { env: Record<string, string>; ipc: boolean };
		assert.equal(ipc, false, "no IPC channel, so the in-app updater stays off");
		assert.equal(env.LH_HOME, pHome);
		assert.equal(env.LH_DATA_DIR, layout(pHome).data);
		assert.equal(env.LH_AUTH_FILE, layout(pHome).auth);
		assert.equal(env.PORT, String(port));
		assert.equal(env.HOSTNAME, "127.0.0.1");
		assert.equal(env.FROM_SERVICE_ENV, undefined, "service.env is not passed to a preview");
		assert.ok(fs.existsSync(path.join(layout(pHome).data, "auth")), "the pairing link lives in the preview's own login store");
		assert.equal(fs.existsSync(path.join(layout(pHome).data, "real.txt")), false);
		assert.equal(JSON.parse(fs.readFileSync(layout(pHome).config, "utf8")).port, port);

		// A second preview of the same PR is refused while this one runs.
		const second = track(spawn(process.execPath, [LH, "preview", "7", "--port", String(port + 1), "--feed-url", feedUrl], { env: { ...process.env, LH_HOME: home }, stdio: ["ignore", "pipe", "pipe"] }));
		let secondOut = "";
		second.stderr?.on("data", (chunk: Buffer) => { secondOut += chunk.toString(); });
		const secondCode = await new Promise<number | null>((resolve) => second.once("exit", resolve));
		assert.equal(secondCode, 1);
		assert.match(secondOut, /already running/);

		child.kill("SIGINT");
		const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
		assert.equal(code, 0, output);
		assert.equal(fs.existsSync(pHome), false, "the preview folder is deleted");
		assert.equal(fs.existsSync(previewLockPath(home, 7)), false);
		await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`), "the preview server stopped");
		assert.equal(fs.readFileSync(path.join(layout(home).data, "real.txt"), "utf8"), "real data\n", "real data untouched");
		assert.equal(fs.readFileSync(layout(home).auth, "utf8"), '{"anthropic":"real-key"}\n');
	});

	it("explains a missing preview and leaves nothing behind", async () => {
		const port = await freePort();
		let stderr = "";
		const child = track(spawn(process.execPath, [LH, "preview", "9", "--port", String(port), "--feed-url", pathToFileURL(path.join(work, "nope", "latest.json")).href], { env: { ...process.env, LH_HOME: home }, stdio: ["ignore", "pipe", "pipe"] }));
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
		assert.equal(code, 1);
		assert.match(stderr, /No preview build for PR #9/);
		assert.equal(fs.existsSync(previewHome(home, 9)), false);
	});

	it("refuses the real server's port and a bad PR number", () => {
		for (const [args, message] of [[["preview", "7", "--port", "3774"], /your real server's port/], [["preview", "abc"], /usage: lh preview/]] as const) {
			const r = spawnSync(process.execPath, [LH, ...args], { env: { ...process.env, LH_HOME: home }, encoding: "utf8" });
			assert.equal(r.status, 1, args.join(" "));
			assert.match(r.stderr, message);
		}
	});

	// A stub `tailscale` on PATH that logs each call.
	function stubTailscale(): { env: Record<string, string>; calls: () => string } {
		const bin = path.join(work, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = path.join(work, "tailscale.log");
		fs.writeFileSync(path.join(bin, "tailscale"), `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
		return { env: { PATH: `${bin}:${process.env.PATH}` }, calls: () => { try { return fs.readFileSync(log, "utf8"); } catch { return ""; } } };
	}

	it("serves the preview on the shifted Tailscale port and turns it off when the terminal goes away", async () => {
		const feedUrl = buildFeed(work);
		const port = await freePort();
		writeConfig(home, { port: port - 1, tailscale: { enabled: true, port: 8443, hostname: "box.tail.ts.net" } });
		const ts = stubTailscale();
		let output = "";
		const child = track(spawn(process.execPath, [LH, "preview", "7", "--feed-url", feedUrl], {
			env: { ...process.env, ...ts.env, LH_HOME: home, STUB_ENV_OUT: path.join(work, "env.json"), DISPLAY: "", WAYLAND_DISPLAY: "" },
			stdio: ["ignore", "pipe", "pipe"],
		}));
		child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		await waitFor(child, /Ctrl\+C stops the preview/, () => output);
		assert.match(ts.calls(), new RegExp(`serve --bg --https=8444 http://127\\.0\\.0\\.1:${port}`));
		assert.match(output, /https:\/\/box\.tail\.ts\.net:8444\/pair#token=/);
		assert.equal(fs.readFileSync(previewServeMarker(home, 7), "utf8").trim(), "8444");

		// An SSH drop: the output pipes close, then SIGHUP.
		child.stdout?.destroy();
		child.stderr?.destroy();
		child.kill("SIGHUP");
		const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
		assert.equal(code, 0);
		assert.match(ts.calls(), /serve --https=8444 off/);
		assert.equal(fs.existsSync(previewHome(home, 7)), false);
		assert.equal(fs.existsSync(previewServeMarker(home, 7)), false);
		assert.equal(fs.existsSync(previewLockPath(home, 7)), false);
	});

	it("stops a preview server whose launcher died, then starts fresh", async () => {
		const feedUrl = buildFeed(work);
		const port = await freePort();
		const start = async () => {
			let output = "";
			const child = track(spawn(process.execPath, [LH, "preview", "7", "--port", String(port), "--feed-url", feedUrl], {
				env: { ...process.env, LH_HOME: home, STUB_ENV_OUT: path.join(work, "env.json"), DISPLAY: "", WAYLAND_DISPLAY: "" },
				stdio: ["ignore", "pipe", "pipe"],
			}));
			child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
			child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
			await waitFor(child, /Ctrl\+C stops the preview/, () => output);
			return { child, output: () => output };
		};
		const first = await start();
		const orphan = Number(fs.readFileSync(previewPidPath(home, 7), "utf8").trim());
		first.child.kill("SIGKILL");
		await new Promise((resolve) => first.child.once("exit", resolve));
		assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { ok: boolean }).ok, true, "the orphan still serves");

		const second = await start();
		assert.match(second.output(), new RegExp(`crashed \`lh preview\` left running \\(pid ${orphan}\\)`));
		assert.throws(() => process.kill(orphan, 0), "the orphan is gone");
		assert.notEqual(Number(fs.readFileSync(previewPidPath(home, 7), "utf8").trim()), orphan);
		second.child.kill("SIGINT");
		assert.equal(await new Promise((resolve) => second.child.once("exit", resolve)), 0);
		assert.equal(fs.existsSync(previewHome(home, 7)), false);
		assert.equal(fs.existsSync(previewPidPath(home, 7)), false);
	});

	it("keeps the orphan PID when recovery is interrupted", async () => {
		const port = await freePort();
		const feedUrl = buildFeed(work);
		const args = [LH, "preview", "7", "--port", String(port), "--feed-url", feedUrl];
		const env = { ...process.env, LH_HOME: home, STUB_ENV_OUT: path.join(work, "env.json") };
		function start() {
			const child = track(spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] }));
			let output = "";
			child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
			child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
			return { child, output: () => output };
		}
		const first = start();
		await waitFor(first.child, /Ctrl\+C stops the preview/, first.output);
		const pidFile = previewPidPath(home, 7);
		const orphan = Number(fs.readFileSync(pidFile, "utf8"));
		try {
			process.kill(orphan, "SIGSTOP");
			first.child.kill("SIGKILL");
			await new Promise((resolve) => first.child.once("exit", resolve));

			const recovery = start();
			await waitFor(recovery.child, /Stopping the PR #7 preview server/, recovery.output);
			recovery.child.kill("SIGINT");
			assert.equal(await new Promise((resolve) => recovery.child.once("exit", (_code, signal) => resolve(signal))), "SIGINT");
			assert.equal(Number(fs.readFileSync(pidFile, "utf8")), orphan);
		} finally {
			process.kill(orphan, "SIGCONT");
		}

		const retry = start();
		await waitFor(retry.child, /Ctrl\+C stops the preview/, retry.output);
		assert.notEqual(Number(fs.readFileSync(pidFile, "utf8")), orphan);
		retry.child.kill("SIGINT");
		assert.equal(await new Promise((resolve) => retry.child.once("exit", resolve)), 0);
		assert.equal(fs.existsSync(pidFile), false);
	});

	it("waits for the port of a preview server that is already dying", async () => {
		// The pid file names a process whose environment no longer names the
		// preview, as while it exits, but which holds the port until just after
		// the launcher starts (its lock file appears).
		const port = await freePort();
		const feedUrl = buildFeed(work);
		const holder = track(spawn(process.execPath, ["-e", `
const fs = require("node:fs");
const [port, lock] = process.argv.slice(1);
const server = require("node:net").createServer().listen(Number(port), "127.0.0.1", () => {
	console.log("holding");
	const timer = setInterval(() => { if (fs.existsSync(lock)) { clearInterval(timer); setTimeout(() => server.close(), 500); } }, 10);
});
`, String(port), previewLockPath(home, 7)], { stdio: ["ignore", "pipe", "inherit"] }));
		await new Promise((resolve) => holder.stdout?.once("data", resolve));
		fs.mkdirSync(path.dirname(previewPidPath(home, 7)), { recursive: true });
		fs.writeFileSync(previewPidPath(home, 7), `${holder.pid}\n`);

		let output = "";
		const child = track(spawn(process.execPath, [LH, "preview", "7", "--port", String(port), "--feed-url", feedUrl], {
			env: { ...process.env, LH_HOME: home, STUB_ENV_OUT: path.join(work, "env.json") },
			stdio: ["ignore", "pipe", "pipe"],
		}));
		child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		await waitFor(child, /Ctrl\+C stops the preview/, () => output);
		assert.doesNotMatch(output, /Stopping/, "not ours, so not signalled");
		child.kill("SIGINT");
		assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
	});

	it("does not start a server if the launcher dies before recording its PID", async () => {
		const port = await freePort();
		const feedUrl = buildFeed(work);
		const pidFile = previewPidPath(home, 7);
		const envOut = path.join(work, "env.json");
		const preload = path.join(work, "crash.cjs");
		fs.writeFileSync(preload, `
const fs = require("node:fs");
const write = fs.writeFileSync;
fs.writeFileSync = (file, ...args) => {
	if (file === ${JSON.stringify(pidFile)}) process.kill(process.pid, "SIGKILL");
	return write(file, ...args);
};
require("node:module").syncBuiltinESMExports();
`);
		const args = [LH, "preview", "7", "--port", String(port), "--feed-url", feedUrl];
		const env = { ...process.env, LH_HOME: home, STUB_ENV_OUT: envOut };
		const crashed = spawnSync(process.execPath, ["--require", preload, ...args], { env, timeout: 10_000 });
		assert.equal(crashed.signal, "SIGKILL");
		assert.equal(fs.existsSync(pidFile), false);

		const retry = track(spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] }));
		let output = "";
		retry.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		retry.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		try {
			await waitFor(retry, /Ctrl\+C stops the preview/, () => output, 10_000);
			assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).ok, true);
		} finally {
			if (retry.exitCode === null && retry.signalCode === null) {
				retry.kill("SIGINT");
				await new Promise((resolve) => retry.once("exit", resolve));
			}
		}
	});

	it("clears what a crashed preview left, including its Tailscale port", async () => {
		const ts = stubTailscale();
		fs.mkdirSync(path.join(previewHome(home, 7), "userdata", "data"), { recursive: true });
		fs.writeFileSync(path.join(previewHome(home, 7), "userdata", "data", "old.txt"), "old\n");
		fs.writeFileSync(previewServeMarker(home, 7), "8444\n");
		const port = await freePort();
		const r = spawnSync(process.execPath, [LH, "preview", "7", "--port", String(port), "--feed-url", pathToFileURL(path.join(work, "nope", "latest.json")).href], { env: { ...process.env, ...ts.env, LH_HOME: home }, encoding: "utf8" });
		assert.equal(r.status, 1);
		assert.match(ts.calls(), /serve --https=8444 off/);
		assert.equal(fs.existsSync(previewHome(home, 7)), false);
		assert.equal(fs.existsSync(previewServeMarker(home, 7)), false);
	});

	it("refuses a port that is already in use", async () => {
		const blocker = net.createServer();
		const port = await new Promise<number>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve((blocker.address() as net.AddressInfo).port)));
		try {
			const r = spawnSync(process.execPath, [LH, "preview", "7", "--port", String(port), "--feed-url", "file:///nope/latest.json"], { env: { ...process.env, LH_HOME: home }, encoding: "utf8" });
			assert.equal(r.status, 1);
			assert.match(r.stderr, new RegExp(`Port ${port} is in use`));
		} finally {
			blocker.close();
		}
	});
});

// pr-preview-check.sh, the publish gate, against a stub `gh` answering from
// fixtures for the PR, label timeline, trusted approval runs and build artifacts.
const CHECK = path.join(import.meta.dirname, "..", "scripts", "pr-preview-check.sh");
const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
fx="$FIXTURES"
if [ "$1" = run ] && [ "$2" = download ]; then
  dest=""; name=""; pattern=""
  shift 3
  while [ $# -gt 0 ]; do case "$1" in -D) dest=$2; shift 2 ;; -n) name=$2; shift 2 ;; -p) pattern=$2; shift 2 ;; *) shift ;; esac; done
  if [ -n "$name" ]; then [ -d "$fx/$name" ] || exit 1; cp -r "$fx/$name/." "$dest/"; exit 0; fi
  for d in "$fx"/selfhost-*; do [ -d "$d" ] && cp -r "$d" "$dest/"; done
  exit 0
fi
args="$*"
case "$args" in
  *"/permission"*) [ -f "$fx/perm" ] && cat "$fx/perm" || exit 1 ;;
  *"/events"*) cat "$fx/labels" ;;
  *"/actions/workflows/pr-preview-approval.yml/runs "*) cat "$fx/approval.tsv" ;;
  *"/actions/runs/23/artifacts "*) if [ -f "$fx/approval" ] && [[ "$args" == *"name=$(cat "$fx/approval") "* ]]; then echo 1; else echo 0; fi ;;
  *"DELETE "*"/labels/preview"*) touch "$fx/consumed"; if [ -f "$fx/after" ]; then cp "$fx/after" "$fx/pr.tsv"; fi ;;
  *"/pulls/"*) cat "$fx/pr.tsv" ;;
esac
`;

describe("publish gate (pr-preview-check.sh)", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-preview-gate-"));
		fs.mkdirSync(path.join(dir, "bin"));
		fs.writeFileSync(path.join(dir, "bin", "gh"), GH_STUB, { mode: 0o755 });
	});
	afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

	const RUN_AT = "2026-11-17T12:00:00Z";
	const APPROVAL = "preview-approval-12-abc";
	const LABEL = ["10", "labeled", "max", "2026-11-17T11:59:55Z"];
	interface Case {
		pr?: string; tsv?: string[]; perm?: string; actor?: string; labels?: string[][];
		approval?: string; approvalRuns?: string[][]; runAt?: string;
		version?: string; extra?: boolean; noMeta?: boolean; confirm?: string; after?: string[];
	}
	function gate(c: Case): { code: number; out: Record<string, string>; log: string; files: string[]; outDir: string; consumed: boolean } {
		const fx = fs.mkdtempSync(path.join(dir, "fx-"));
		if (!c.noMeta) { fs.mkdirSync(path.join(fx, "preview-meta")); fs.writeFileSync(path.join(fx, "preview-meta", "pr"), `${c.pr ?? "12"}\n`); }
		fs.writeFileSync(path.join(fx, "pr.tsv"), `${(c.tsv ?? ["open", "abc", "max", "false"]).join("\t")}\n`);
		if (c.perm !== "") fs.writeFileSync(path.join(fx, "perm"), `${c.perm ?? "admin"}\n`);
		fs.writeFileSync(path.join(fx, "labels"), (c.labels ?? []).map((label) => `${label.join("\t")}\n`).join(""));
		if (c.approval) fs.writeFileSync(path.join(fx, "approval"), c.approval);
		fs.writeFileSync(path.join(fx, "approval.tsv"), (c.approvalRuns ?? [["23", "Approve preview #12 at abc", "success", RUN_AT]]).map((run) => `${run.join("\t")}\n`).join(""));
		if (c.after) fs.writeFileSync(path.join(fx, "after"), `${c.after.join("\t")}\n`);
		const version = c.version ?? "0.6.1-preview.20261117.5";
		for (const arch of ["linux-x64", "linux-arm64"]) {
			fs.mkdirSync(path.join(fx, `selfhost-${arch}`));
			fs.writeFileSync(path.join(fx, `selfhost-${arch}`, `learnharness-${version}-${arch}.tar.gz`), arch);
		}
		if (c.extra) fs.writeFileSync(path.join(fx, "selfhost-linux-x64", "learnharness-9.9.9-preview.20261117.5-linux-x64.tar.gz"), "x");
		const work = fs.mkdtempSync(path.join(dir, "work-"));
		const output = path.join(work, "github-output");
		fs.writeFileSync(output, "");
		const env = { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, FIXTURES: fx, GITHUB_OUTPUT: output, GH_REPO: "o/r", OWNER: "max", RUN_ID: "99", RUN_NUMBER: "5", RUN_CREATED_AT: c.runAt ?? RUN_AT, HEAD_SHA: "abc", ACTOR: c.actor ?? "max", FILES: path.join(work, "files"), OUT: path.join(work, "out") };
		const identify = spawnSync("bash", [CHECK, "--identify"], { encoding: "utf8", env });
		const identified = /^pr=(\d+)$/m.exec(fs.readFileSync(output, "utf8"));
		const result = identified ? spawnSync("bash", c.confirm === undefined ? [CHECK] : [CHECK, "--confirm"], {
			encoding: "utf8",
			env: { ...env, PR: identified[1], APPROVAL_LABEL: c.confirm ?? "" },
		}) : identify;
		const out = Object.fromEntries(fs.readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split("=", 2) as [string, string]));
		const outDir = path.join(work, "out");
		return { code: result.status ?? -1, out, log: `${result.stdout}${result.stderr}`, files: fs.existsSync(outDir) ? fs.readdirSync(outDir).sort() : [], outDir, consumed: fs.existsSync(path.join(fx, "consumed")) };
	}
	const stranger = (labeled: boolean) => ["open", "abc", "stranger", String(labeled)];

	it("publishes the owner's PR and checksums the archives itself", () => {
		const r = gate({});
		assert.equal(r.code, 0, r.log);
		assert.deepEqual(r.out, { publish: "true", pr: "12", version: "0.6.1-preview.20261117.5", approval_label: "", by_owner: "true" });
		assert.equal(r.files.length, 4);
		const name = "learnharness-0.6.1-preview.20261117.5-linux-x64.tar.gz";
		assert.equal(fs.readFileSync(path.join(r.outDir, `${name}.sha256`), "utf8"), `${createHash("sha256").update("linux-x64").digest("hex")}  ${name}\n`);
	});

	it("requires a trusted owner record for the exact outside PR and commit", () => {
		const labeled = gate({ tsv: stranger(true), labels: [LABEL], approval: APPROVAL });
		assert.equal(labeled.out.publish, "true", labeled.log);
		assert.equal(labeled.out.by_owner, "false");
		assert.equal(labeled.out.approval_label, "10");
		const cases: Array<[Case, RegExp]> = [
			[{ approval: "preview-approval-12-def" }, /No trusted owner approval/],
			[{ approval: "preview-approval-13-abc" }, /No trusted owner approval/],
			[{ approval: APPROVAL, approvalRuns: [] }, /No trusted owner approval/],
			[{ approval: APPROVAL, approvalRuns: [["23", "Approve preview #12 at abc", "pending", RUN_AT]] }, /No trusted owner approval/],
			[{ approval: APPROVAL, approvalRuns: [["24", "Approve preview #12 at def", "pending", RUN_AT], ["23", "Approve preview #12 at abc", "success", RUN_AT]] }, /No trusted owner approval/],
			[{ approval: APPROVAL, actor: "helper", perm: "write" }, /Only max can request/],
			[{ approval: APPROVAL, labels: [["11", "labeled", "helper", RUN_AT], LABEL] }, /latest|current preview label/],
			[{ approval: APPROVAL, runAt: "2026-11-17T12:02:00Z" }, /did not run for the current preview label/],
			[{ approval: APPROVAL, labels: [["11", "labeled", "max", "2026-11-17T11:59:55Z"], LABEL], approvalRuns: [["23", "Approve preview #12 at abc", "success", "2026-11-17T11:58:00Z"]] }, /No trusted owner approval/],
		];
		for (const [c, message] of cases) {
			const r = gate({ tsv: stranger(true), labels: [LABEL], ...c });
			assert.equal(r.code, 0, r.log);
			assert.equal(r.out.publish, "false", r.log);
			assert.match(r.log, message);
			assert.deepEqual(r.files, []);
		}
	});

	it("rechecks the head and consumes the same label before publishing", () => {
		const c = { tsv: stranger(true), labels: [LABEL], approval: APPROVAL, confirm: "10" };
		const current = gate(c);
		assert.equal(current.out.publish, "true", current.log);
		assert.equal(current.consumed, true);
		const stale = gate({ ...c, confirm: "9" });
		assert.equal(stale.out.publish, "false", stale.log);
		assert.equal(stale.consumed, false);
		const moved = gate({ ...c, tsv: ["open", "def", "stranger", "true"] });
		assert.equal(moved.out.publish, "false", moved.log);
		assert.equal(moved.consumed, false);
		const movedDuringDelete = gate({ ...c, after: ["open", "def", "stranger", "false"] });
		assert.equal(movedDuringDelete.out.publish, "false", movedDuringDelete.log);
		assert.equal(movedDuringDelete.consumed, true);
	});

	it("skips what nobody with write access asked for", () => {
		const cases: Array<[Case, RegExp]> = [
			[{ tsv: stranger(false) }, /has no `preview` label/],
			[{ tsv: stranger(true), perm: "read", actor: "stranger" }, /no write access/],
			[{ tsv: ["open", "abc", "learnharness-nightly-bot[bot]", "true"], perm: "", actor: "learnharness-nightly-bot[bot]" }, /no write access/],
			[{ tsv: ["open", "def", "max", "false"] }, /moved on to def/],
			[{ tsv: ["closed", "abc", "max", "false"] }, /is closed/],
			[{ actor: "max; rm -rf /" }, /unexpected actor/],
			[{ noMeta: true }, /left no PR number/],
		];
		for (const [c, message] of cases) {
			const r = gate(c);
			assert.equal(r.code, 0, r.log);
			assert.equal(r.out.publish, "false", r.log);
			assert.match(r.log, message);
			assert.deepEqual(r.files, [], "nothing gathered");
		}
	});

	it("fails on malformed build files", () => {
		const cases: Array<[Case, RegExp]> = [
			[{ pr: "12;rm" }, /no valid PR number/],
			[{ version: "0.6.1-nightly.20261117.5" }, /Unexpected archive name/],
			[{ version: "0.6.1-preview.20261117.6" }, /not from build run 5/],
			[{ extra: true }, /Expected one linux-x64 archive, found 2/],
		];
		for (const [c, message] of cases) {
			const r = gate(c);
			assert.equal(r.code, 1, r.log);
			assert.match(r.log, message);
		}
	});
});

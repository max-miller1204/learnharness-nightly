/**
 * `lh preview <N>` (docs/specs/pr-previews.md): the pure helpers, and a real
 * run of the launcher against a file: feed whose archive holds a stub server
 * (the host Node behind a shell script, plus a server.js that answers
 * /api/health and records its environment).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { layout } from "../src/paths.ts";
import { parsePrNumber, previewConfig, previewFeedUrl, previewHome, previewLockPath } from "../src/preview.ts";

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
		assert.deepEqual(previewConfig(real, 5000), { port: 5000, tailscale: { enabled: true, port: 9001, hostname: "box.tail.ts.net" }, chromePath: "/usr/bin/chromium" });
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
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	it("runs the build beside the real server on fresh data, then deletes it on Ctrl+C", async () => {
		const feedUrl = buildFeed(work);
		const port = await freePort();
		const envOut = path.join(work, "env.json");
		let output = "";
		const child = spawn(process.execPath, [LH, "preview", "7", "--port", String(port), "--feed-url", feedUrl], {
			env: { ...process.env, LH_HOME: home, STUB_ENV_OUT: envOut, DISPLAY: "", WAYLAND_DISPLAY: "" },
			stdio: ["ignore", "pipe", "pipe"],
		});
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
		const second = spawn(process.execPath, [LH, "preview", "7", "--port", String(port + 1), "--feed-url", feedUrl], { env: { ...process.env, LH_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
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
		const child = spawn(process.execPath, [LH, "preview", "9", "--port", String(port), "--feed-url", pathToFileURL(path.join(work, "nope", "latest.json")).href], { env: { ...process.env, LH_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
		assert.equal(code, 1);
		assert.match(stderr, /No preview build for PR #9/);
		assert.equal(fs.existsSync(previewHome(home, 9)), false);
	});

	it("refuses the real server's port and a bad PR number", () => {
		for (const args of [["preview", "7", "--port", "3774"], ["preview", "abc"]]) {
			let failed = false;
			try { execFileSync(process.execPath, [LH, ...args], { env: { ...process.env, LH_HOME: home }, stdio: "pipe" }); } catch { failed = true; }
			assert.ok(failed, args.join(" "));
		}
	});
});

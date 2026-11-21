/**
 * `lh update` against a running server (docs/specs/t3-style-updates.md,
 * revision PR 5): without `--now` it only checks, and says how to download
 * an offered version; `--now` installs. A stand-in server answers health and
 * the update routes and records what was asked.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { writeConfig } from "../src/config.ts";
import { layout } from "../src/paths.ts";
import { writeState } from "../src/release.ts";

const LH = path.resolve(import.meta.dirname, "../lh.ts");
const NEXT = "0.6.1-nightly.20261121.2";

let home: string;
let server: http.Server;
let posts: string[];
let answer: { status: string; version: string | null; message: string | null };
/** The HTTP status of the update routes' answers, and whether /api/health answers. */
let routeStatus = 200;
let healthy = true;

beforeEach(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-update-cmd-"));
	posts = [];
	routeStatus = 200;
	healthy = true;
	server = http.createServer((request, response) => {
		response.setHeader("Content-Type", "application/json");
		if (request.url === "/api/health") {
			if (!healthy) { response.statusCode = 500; return response.end("{}"); }
			return response.end(JSON.stringify({ ok: true, selfhost: true, idle: true, version: "0.6.1-nightly.20261120.1" }));
		}
		posts.push(`${request.method} ${request.url} ${/^Bearer \S+$/.test(request.headers.authorization ?? "") ? "bearer" : "none"}`);
		response.statusCode = routeStatus;
		response.end(JSON.stringify(routeStatus === 200 ? answer : { error: "Cross-site requests to LearnHarness are not allowed." }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	writeState(home, { protocol: 1, activeVersion: "0.6.1-nightly.20261120.1", badVersions: [] });
	// A feed offering NEXT, with no build for any platform: staging it would fail.
	const feedFile = path.join(home, "feed-latest.json");
	fs.writeFileSync(feedFile, JSON.stringify({ version: NEXT, tag: `v${NEXT}`, sha: "x", publishedAt: "now", launcherProtocol: 1, minLauncherProtocol: 1, assets: {} }));
	writeConfig(home, { port: (server.address() as AddressInfo).port, tailscale: { enabled: false, port: 8443 }, feedUrl: pathToFileURL(feedFile).href });
});
afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	fs.rmSync(home, { recursive: true, force: true });
});

// Asynchronous, so the stand-in server in this process can answer.
const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
	execFile(process.execPath, [LH, ...args], { encoding: "utf8", env: { ...process.env, LH_HOME: home }, timeout: 60_000 }, (error, stdout, stderr) => {
		resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
	});
});
const lh = async (...args: string[]) => {
	const result = await run(...args);
	if (result.code !== 0) throw new Error(`lh ${args.join(" ")} exited ${result.code}\n${result.stderr}`);
	return result.stdout;
};

describe("lh update", () => {
	it("only checks, and says how to download an offered version", async () => {
		answer = { status: "available", version: NEXT, message: null };
		const output = await lh("update");
		assert.deepEqual(posts, ["POST /api/updates/check bearer"], "a check, never a download or an install");
		assert.deepEqual(output.trimEnd().split("\n"), [
			`available ${NEXT}`,
			"Download it with Download in the app (the update button or Settings → General), or run `lh update --now` to download and install it now.",
		]);
	});

	it("says how to install a version that is already downloaded, and nothing more when up to date", async () => {
		answer = { status: "downloaded", version: NEXT, message: null };
		assert.match(await lh("update"), /It installs when you click Install in the app, or run `lh update --now`\./);
		answer = { status: "up-to-date", version: null, message: null };
		assert.equal(await lh("update"), "up-to-date\n");
		assert.deepEqual(posts, ["POST /api/updates/check bearer", "POST /api/updates/check bearer"]);
	});

	it("with the server not answering, it still only checks: nothing staged, requested or restarted", async () => {
		healthy = false;
		const output = await lh("update");
		assert.deepEqual(output.trimEnd().split("\n"), [
			"The server isn't answering; checking the feed from the launcher.",
			`available ${NEXT}`,
			"Run `lh update --now` to download and install it through the launcher.",
		]);
		assert.equal(fs.existsSync(layout(home).updateRequest), false, "no update request for the launcher");
		assert.deepEqual(posts, []);
	});

	it("a refusal from the server is an error, not a success", async () => {
		routeStatus = 403;
		const result = await run("update", "--now");
		assert.notEqual(result.code, 0);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /the server refused the update install \(HTTP 403\): Cross-site requests to LearnHarness are not allowed\./);
		const check = await run("update");
		assert.notEqual(check.code, 0, "a refused check too");
		assert.match(check.stderr, /refused the update check \(HTTP 403\)/);
	});

	it("--now installs (the server re-checks and downloads first)", async () => {
		answer = { status: "downloaded", version: NEXT, message: `Restarting to install version ${NEXT}…` };
		const output = await lh("update", "--now");
		assert.deepEqual(posts, ["POST /api/updates/install bearer"]);
		assert.equal(output, `downloaded ${NEXT}: Restarting to install version ${NEXT}…\n`);
	});
});

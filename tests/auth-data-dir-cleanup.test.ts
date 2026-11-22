/**
 * Issue #350: tests/helpers/auth-data-dir.ts removes the lh-auth-test-*
 * folder it made when the process exits (a normal exit, process.exit(), or
 * an uncaught error; a signal such as an unhandled SIGTERM skips exit
 * handlers and isn't covered), and never a folder it didn't make (an
 * LH_DATA_DIR set beforehand). Each case runs the
 * helper in a child process with its own TMPDIR, so what's left behind is
 * exactly what the helper left.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const HELPER = path.resolve(import.meta.dirname, "helpers/auth-data-dir.ts");

function runChild(tmp: string, body: string, env: Record<string, string> = {}) {
	// A file URL, not a native path: on Windows a "C:\..." path reaches the ESM loader as a "c:" URL.
	const script = `import { AUTH_TEST_DATA_DIR, mintToken } from ${JSON.stringify(pathToFileURL(HELPER).href)};\nconsole.log("DIR=" + AUTH_TEST_DATA_DIR);\nmintToken("cleanup");\n${body}`;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
		cwd: path.resolve(import.meta.dirname, ".."),
		// SystemRoot: Node on Windows needs it to start.
		env: { PATH: process.env.PATH ?? "", HOME: tmp, TMPDIR: tmp, TEMP: tmp, TMP: tmp, NODE_ENV: "test", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env },
		encoding: "utf8",
		timeout: 30000,
	});
	// A launch failure or a timeout is the error to report, not a parse of missing output.
	if (result.error) throw result.error;
	if (result.signal) throw new Error(`the child was stopped by ${result.signal} (the 30 s timeout?): ${result.stderr?.slice(0, 300) ?? ""}`);
	const dir = /DIR=(.+)/.exec(result.stdout ?? "")?.[1]?.trim();
	return { status: result.status, dir, stderr: result.stderr ?? "" };
}
const leftovers = (tmp: string) => fs.readdirSync(tmp).filter((name) => name.startsWith("lh-auth-test-"));

test("the helper removes the folder it made on a normal exit, process.exit() and an uncaught error", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-auth-cleanup-check-"));
	try {
		for (const [label, body, status] of [
			["a normal exit", "", 0],
			["process.exit(3)", "process.exit(3);", 3],
			["an uncaught error", "throw new Error('boom');", 1],
		] as const) {
			const tmp = fs.mkdtempSync(path.join(root, "case-"));
			const run = runChild(tmp, body);
			assert.equal(run.status, status, `${label}: ${run.stderr.slice(0, 300)}`);
			assert.ok(run.dir && path.basename(run.dir).startsWith("lh-auth-test-") && path.dirname(run.dir) === tmp, `${label}: the helper made its folder in TMPDIR`);
			assert.equal(fs.existsSync(run.dir), false, `${label}: the folder is gone`);
			assert.deepEqual(leftovers(tmp), [], `${label}: no lh-auth-test-* folder is left`);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("an LH_DATA_DIR set beforehand is left alone", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-auth-cleanup-check-"));
	try {
		const tmp = fs.mkdtempSync(path.join(root, "case-"));
		const preset = path.join(root, "preset-data");
		fs.mkdirSync(preset);
		const run = runChild(tmp, "", { LH_DATA_DIR: preset });
		assert.equal(run.status, 0, run.stderr.slice(0, 300));
		assert.equal(run.dir, preset);
		assert.equal(fs.existsSync(path.join(preset, "auth")), true, "the caller's folder and what the test wrote in it stay");
		assert.deepEqual(leftovers(tmp), [], "and the helper made no folder of its own");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

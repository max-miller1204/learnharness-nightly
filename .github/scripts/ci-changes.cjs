// Decides which CI jobs a change needs. An unreadable diff runs every job.
// See docs/specs/ci-foundation.md.
//
// Adapted from T3 Code's .github/scripts/ci-changes.cjs
// (https://github.com/pingdotgg/t3code), which carries this notice:
//
//   MIT License
//
//   Copyright (c) 2026 T3 Tools Inc.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
//
// The independently installed mobile app and the web app share source,
// so path gates follow the source they consume.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

// Docs the app or its plugin-authoring bundle ships, so they are not inert:
// AUTHORING_DOCS in scripts/build-plugin-authoring.mjs, the generated API
// reference, and the license notice electron-builder.yml packages.
// Also files the build or the tests read: LICENSE goes into the plugin-authoring
// bundle, and tests/plugin-setup.test.ts checks docs/development.md.
const SHIPPED_DOCS = [
	/^LICENSE$/,
	/^docs\/development\.md$/,
	/^docs\/(plugin-authoring|plugin-architecture|plugin-question-contract|plugin-problem-contract|plugin-session-extension-contract|plugin-tree-contract|plugin-view-context|dialog-overlay-contract|plugin-examples)\.md$/,
	/^docs\/plugin-api\//,
	/^docs\/compaction-accounting\.md$/,
];

const INERT = [
	/^docs\//,
	/^[^/]+\.md$/,
	/^\.claude\//,
	/^\.github\/ISSUE_TEMPLATE\//,
	/^\.github\/workflows\/pr-agent\.yml$/,
];

// The standalone job runs these tests natively on each OS, and helpers and
// fixtures can be shared with them, so they count as more than test-only.
const STANDALONE_TESTS = [
	/^tests\/(pdf-native-render|pdf-ops|svg-native-render|browser-service)\.test\.ts$/,
	/^tests\/(helpers|fixtures)\//,
];

const WEB_GATES = ["typecheck", "test", "selfhost", "standalone"];
const GATES = [...WEB_GATES, "mobile", "iphone"];
// The iPhone job runs whenever the mobile job does, and also when the
// fixtures, scenario and scripts it drives the app and server with change.
const IPHONE_OWN = [
	/^scripts\/iphone-check\//,
	/^tests\/fixtures\/(mobile-lesson|mobile-quiz)\//,
	/^\.claude\/skills\/prove-learnharness\/scripts\/(lib\.sh|knobs\.env|new-run\.sh|build\.sh|start\.sh|seed\.mjs|sign-in\.mjs|fake-model\.mjs)$/,
];
const MOBILE_SHARED = /^(src\/(client-protocol|core)\/|\.github\/|package(-lock)?\.json$|build\/icon\.png$|public\/fonts\/cmunbx\.ttf$)/;

/** Web gate class for one repo-relative path. */
function classify(file) {
	if (file.startsWith("apps/mobile/")) return "mobile";
	if (SHIPPED_DOCS.some((pattern) => pattern.test(file))) return "everything";
	// TypeScript anywhere is typechecked (tsconfig includes **/*.ts).
	if (INERT.some((pattern) => pattern.test(file))) return /\.[cm]?tsx?$/.test(file) ? "tests" : "inert";
	if (/^tests\//.test(file) && !STANDALONE_TESTS.some((pattern) => pattern.test(file))) return "tests";
	return "everything";
}

/** files: changed paths, or null when the diff is unknown. full: run every
 *  job, except that with a known diff (a push to main) the iPhone job still
 *  follows its own gate, so merges that can't affect it don't wait on it. */
function decide(files, full = false) {
	const outputs = Object.fromEntries(GATES.map((gate) => [gate, false]));
	if (full && files !== null) {
		const gated = decide(files);
		for (const gate of GATES) outputs[gate] = gate === "iphone" ? gated.iphone : true;
		return outputs;
	}
	if (full || files === null) {
		for (const gate of GATES) outputs[gate] = true;
		return outputs;
	}
	for (const file of files) {
		const kind = classify(file);
		// Mobile imports the protocol and its portable core dependencies. CI
		// configuration and root dependency pins can also change its result.
		if (kind === "mobile" || (kind !== "inert" && MOBILE_SHARED.test(file))) {
			outputs.mobile = true;
		}
		if (outputs.mobile || IPHONE_OWN.some((pattern) => pattern.test(file))) outputs.iphone = true;
		if (kind === "tests") {
			outputs.typecheck = true;
			outputs.test = true;
		} else if (kind === "everything") {
			for (const gate of WEB_GATES) outputs[gate] = true;
		}
	}
	return outputs;
}

/** The paths a push changed, from the commit main was at before it to HEAD,
 *  or null when that commit is unknown (a new branch, the all-zero SHA, or a
 *  commit gone after a force push). A shallow checkout fetches it first. */
function pushPaths(before, cwd = process.cwd()) {
	if (!/^[0-9a-f]{40}$/.test(before ?? "") || /^0+$/.test(before)) return null;
	const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	try { git("cat-file", "-e", `${before}^{commit}`); } catch {
		try { git("fetch", "-q", "--no-tags", "--depth=1", "origin", before); } catch { return null; }
	}
	try {
		return git("diff", "--name-only", "--no-renames", before, "HEAD").split("\n").map((line) => line.trim()).filter(Boolean);
	} catch {
		return null;
	}
}

function main() {
	const args = process.argv.slice(2);
	const pathsIndex = args.indexOf("--paths");
	const beforeIndex = args.indexOf("--push-before");
	const files = beforeIndex !== -1
		? pushPaths(args[beforeIndex + 1])
		: pathsIndex === -1
			? null
			: fs.readFileSync(args[pathsIndex + 1], "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
	const full = args.includes("--full");
	for (const file of files ?? []) console.error(`${classify(file)}: ${file}`);
	if (files === null) console.error("No diff: running every job.");
	if (full) console.error(files === null ? "Full run: running every job." : "Full run: running every job but iPhone, which follows the diff.");
	for (const [key, value] of Object.entries(decide(files, full))) console.log(`${key}=${value}`);
}

module.exports = { classify, decide, pushPaths, GATES };

if (require.main === module) main();

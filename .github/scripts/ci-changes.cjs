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
const GATES = [...WEB_GATES, "mobile"];
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

/** files: changed paths, or null when the diff is unknown. full: run every job. */
function decide(files, full = false) {
	const outputs = Object.fromEntries(GATES.map((gate) => [gate, false]));
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
		if (kind === "tests") {
			outputs.typecheck = true;
			outputs.test = true;
		} else if (kind === "everything") {
			for (const gate of WEB_GATES) outputs[gate] = true;
		}
	}
	return outputs;
}

/** Paths from `git diff -z --name-only`: NUL-separated and never quoted, so
 *  a name with a non-ASCII character or a newline (which Git quotes without
 *  -z) comes through as is. */
function splitPaths(text) {
	return text.split("\0").filter(Boolean);
}

/** A --paths file, or null (run every job) when it isn't `-z` output: `-z`
 *  ends every name with NUL, so a non-empty file without one is some other
 *  format, and reading it as one name would skip jobs. */
function pathsFile(text) {
	return text.length > 0 && !text.includes("\0") ? null : splitPaths(text);
}

function main() {
	const args = process.argv.slice(2);
	const pathsIndex = args.indexOf("--paths");
	const files = pathsIndex === -1 ? null : pathsFile(fs.readFileSync(args[pathsIndex + 1], "utf8"));
	const full = args.includes("--full");
	for (const file of files ?? []) console.error(`${classify(file)}: ${JSON.stringify(file)}`);
	if (files === null) console.error(pathsIndex !== -1 ? "The paths file is not NUL-separated (git diff -z): running every job." : "No diff: running every job.");
	if (full) console.error("Full run: running every job.");
	for (const [key, value] of Object.entries(decide(files, full))) console.log(`${key}=${value}`);
}

module.exports = { classify, decide, pathsFile, splitPaths, GATES };

if (require.main === module) main();

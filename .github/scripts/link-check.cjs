// Fails when a Markdown link in a tracked .md file, or a docs/... path named in
// any other tracked text file, points at a file that does not exist. It checks
// files and folders only, not #anchors. It skips URLs, fenced code blocks,
// inline code, any line that contains "link-check-ignore", and any file whose
// first line contains "link-check-ignore-file" (for test fixtures that name a
// missing path on purpose).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const IGNORE_MARKER = "link-check-ignore";
const IGNORE_FILE_MARKER = "link-check-ignore-file";
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_LINK = /\]\(\s*(<[^>\n]*>|[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>\n]*>|\S+)/;
const INLINE_CODE = /(`+)[^`][\s\S]*?\1/g;
const DOCS_PATH = /(?<![\w.\/@$-])docs\/[\w.\/@-]*/g;

/** Markdown link targets in one file's text, with their 1-based line numbers. */
function markdownTargets(text) {
	const targets = [];
	let fence = null;
	text.split("\n").forEach((line, index) => {
		const marker = FENCE.exec(line);
		if (fence) {
			if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) fence = null;
			return;
		}
		if (marker) { fence = marker[1]; return; }
		if (line.includes(IGNORE_MARKER)) return;
		const prose = line.replace(INLINE_CODE, match => " ".repeat(match.length));
		for (const match of prose.matchAll(INLINE_LINK)) targets.push({ line: index + 1, target: match[1] });
		const definition = REFERENCE_DEFINITION.exec(prose);
		if (definition) targets.push({ line: index + 1, target: definition[1] });
	});
	return targets;
}

/** docs/... paths named in a non-Markdown file's text. */
function docsPathTargets(text) {
	const targets = [];
	text.split("\n").forEach((line, index) => {
		if (line.includes(IGNORE_MARKER)) return;
		for (const match of line.matchAll(DOCS_PATH)) {
			// A glob or template path (docs/plugin-*.md, docs/specs/${x}.md) names no single file.
			if ("*{$".includes(line[match.index + match[0].length] ?? " ")) continue;
			targets.push({ line: index + 1, target: "/" + match[0].replace(/[./-]+$/, "") });
		}
	});
	return targets;
}

/** The repository path a link points at, or null when it isn't a file link. */
function resolveTarget(file, target) {
	let value = target.startsWith("<") ? target.slice(1, -1) : target;
	if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("#") || value.startsWith("//")) return null;
	value = value.replace(/[#?].*$/, "");
	if (!value) return null;
	try { value = decodeURIComponent(value); } catch { /* keep it as written */ }
	return path.posix.normalize(value.startsWith("/") ? value.slice(1) : path.posix.join(path.posix.dirname(file), value)).replace(/\/$/, "") || ".";
}

/**
 * Check the given repository-relative files under root. Every file and folder
 * that exists is the given files plus their parent folders. Returns one
 * problem per dead link: { file, line, target }.
 */
function check({ root, files }) {
	const existing = new Set(["."]);
	for (const file of files) {
		for (let current = file; current !== "."; current = path.posix.dirname(current)) existing.add(current);
	}
	const problems = [];
	for (const file of files) {
		let bytes;
		try { bytes = fs.readFileSync(path.join(root, file)); } catch { continue; }
		if (bytes.subarray(0, 8000).includes(0)) continue;
		const text = bytes.toString("utf8");
		if (text.split("\n", 1)[0].includes(IGNORE_FILE_MARKER)) continue;
		const targets = file.endsWith(".md") ? markdownTargets(text) : docsPathTargets(text);
		for (const { line, target } of targets) {
			const resolved = resolveTarget(file, target);
			if (resolved === null) continue;
			if (resolved.startsWith("../") || resolved === ".." || !existing.has(resolved)) problems.push({ file, line, target: target.replace(/^\//, "") });
		}
	}
	return problems;
}

function trackedFiles(root) {
	return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean)
		.filter(file => fs.existsSync(path.join(root, file)));
}

if (require.main === module) {
	const root = process.cwd();
	const files = trackedFiles(root);
	const problems = check({ root, files });
	for (const { file, line, target } of problems) console.log(`::error file=${file},line=${line}::Dead link: ${target}`);
	if (problems.length) {
		console.log(`Link check: ${problems.length} dead link(s) in ${files.length} tracked files.`);
		process.exit(1);
	}
	console.log(`Link check: no dead links in ${files.length} tracked files.`);
}

module.exports = { check, trackedFiles, markdownTargets, docsPathTargets, resolveTarget };

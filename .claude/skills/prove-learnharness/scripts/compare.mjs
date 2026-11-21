#!/usr/bin/env node
/**
 * compare.mjs <base result.json> <head result.json> [--out <file.md>] [--allow '<key>=<item>' ...]
 *
 * --allow drops one known, deliberate difference from both sides before the
 * diff (only for differences listed under "Known and deliberate" in SKILL.md,
 * e.g. --allow 'apiCalls=GET /api/updates 200' for Electron vs browser).
 *
 * Compares one scripted check's results from the base commit and the change:
 *   - every head step passed (the drive did what the recipe says),
 *   - `observations` are identical on both sides (existing-flow answer key:
 *     the app before the change). Any difference is listed and fails until
 *     the user approves it,
 *   - head budgets against budgets.json (console errors, CLS by CLS_MODE,
 *     axe ids not present on base).
 * Prints a markdown summary (and writes it with --out). Exit 0 = "checks
 * passed" (still not a verdict: the checker looks at the evidence), 1 = a
 * check failed, 2 = bad input (BLOCKED).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const argv = process.argv.slice(2);
const allow = [];
// --skip <key>: an observation only one kind of side has (the desktop window's
// `desktop` against a browser). --only <key>: diff just these observations
// (a base desktop window against the change's, where only desktop output is the key).
const skip = [];
const only = [];
// --base-is-key: the base side is an answer key this run set up (the base
// desktop window), not the code under test: if its own drive failed, the
// comparison can't be made, which is BLOCKED (exit 2), never the change's failure.
let baseIsKey = false;
let outPath;
const positional = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--out") outPath = argv[++i];
	else if (argv[i] === "--allow") { const [k, ...v] = argv[++i].split("="); allow.push([k, v.join("=")]); }
	else if (argv[i] === "--skip") skip.push(argv[++i]);
	else if (argv[i] === "--only") only.push(argv[++i]);
	else if (argv[i] === "--base-is-key") baseIsKey = true;
	else positional.push(argv[i]);
}
const [basePath, headPath] = positional;
if (!basePath || !headPath) { console.error("usage: compare.mjs <base result.json> <head result.json> [--out file.md]"); process.exit(2); }
let base, head;
try {
	base = JSON.parse(fs.readFileSync(basePath, "utf8"));
	head = JSON.parse(fs.readFileSync(headPath, "utf8"));
} catch (error) {
	console.error(`BLOCKED: cannot read results: ${error.message}`);
	process.exit(2);
}
const budgets = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "budgets.json"), "utf8")).web;
// A real CLS_MODE wins; otherwise knobs.env's default (compare.mjs runs as
// plain `node`, so nothing has sourced knobs.env for it).
const knobCls = /\$\{CLS_MODE:=([a-z]+)\}/.exec(fs.readFileSync(path.join(import.meta.dirname, "knobs.env"), "utf8"))?.[1];
const clsMode = process.env.CLS_MODE || knobCls || "relative";
const lines = [];
let failed = 0;
const row = (ok, what, detail) => { if (!ok) failed++; lines.push(`- [${ok ? "PASS" : "FAIL"}] ${what}${detail ? `: ${detail}` : ""}`); };

lines.push(`## ${path.basename(path.dirname(headPath))}: base ${base.build} vs head ${head.build}`);

// 1. both drives completed
if (baseIsKey) {
	const bad = base.steps.filter((s) => !s.ok);
	if (bad.length || !base.steps.length) {
		const text = `## ${path.basename(path.dirname(headPath))}\nprove: BLOCKED: the answer-key side (${basePath}) failed its own drive: ${bad.map((s) => s.name).join("; ") || "no steps"}\n`;
		if (outPath) fs.writeFileSync(outPath, text);
		process.stdout.write(text);
		process.exit(2);
	}
}
for (const [side, r] of [["base", base], ["head", head]]) {
	const bad = r.steps.filter((s) => !s.ok);
	row(bad.length === 0 && r.steps.length > 0, `${side} drive: ${r.steps.length} steps`, bad.map((s) => `${s.name} (${s.note ?? ""})`).join("; "));
}

// Known and deliberate differences, dropped from both sides.
for (const [key, item] of allow) {
	for (const r of [base, head]) if (Array.isArray(r.observations?.[key])) r.observations[key] = r.observations[key].filter((x) => String(x) !== item);
	lines.push(`- [ALLOWED] ${key}: "${item}" ignored on both sides (known and deliberate)`);
}

// 2. observations identical
for (const key of skip) lines.push(`- [SKIPPED] observation ${key}: not comparable between these two sides`);
const keys = [...new Set([...Object.keys(base.observations ?? {}), ...Object.keys(head.observations ?? {})])].sort()
	.filter((key) => !skip.includes(key) && (only.length === 0 || only.includes(key)));
for (const key of only) if (!(key in (base.observations ?? {})) || !(key in (head.observations ?? {}))) row(false, `observation ${key} missing`, `base ${key in (base.observations ?? {})}, head ${key in (head.observations ?? {})}`);
for (const key of keys) {
	const b = JSON.stringify(base.observations?.[key]);
	const h = JSON.stringify(head.observations?.[key]);
	if (b === h) { row(true, `observation ${key} same as base`); continue; }
	const bs = new Set(Array.isArray(base.observations?.[key]) ? base.observations[key].map(String) : [b]);
	const hs = new Set(Array.isArray(head.observations?.[key]) ? head.observations[key].map(String) : [h]);
	const added = [...hs].filter((x) => !bs.has(x));
	const removed = [...bs].filter((x) => !hs.has(x));
	row(false, `observation ${key} differs from base`, `added ${JSON.stringify(added)}, removed ${JSON.stringify(removed)}${!added.length && !removed.length ? `, order or values changed: base ${b} head ${h}` : ""}`);
}

// 3. budgets. Not with --only: that compares two different kinds of window
// (a base dev shell with a packaged head), and the head's budgets are judged
// in its own comparison with the browser.
if (only.length) lines.push(`- [SKIPPED] budgets: --only ${only.join(", ")} compares those observations alone`);
else {
const known = budgets.consoleErrors.known;
const isKnown = (e) => known.some((k) => (e.url ?? "").endsWith(k.urlEndsWith) && e.text.includes(`status of ${k.status}`));
const unknown = (head.budgets?.consoleErrors ?? []).filter((e) => !isKnown(e));
row(unknown.length <= budgets.consoleErrors.max, `console errors (head): ${unknown.length} not on the known list (max ${budgets.consoleErrors.max})`, unknown.map((e) => `${e.page}: ${e.text} ${e.url ?? ""}`).join("; "));

// Relative rule (budgets.json cls.relativeRule): head's median vs base's highest
// sample on the same page, plus the noise. One-sample pages compare directly.
const samplesOf = (r, page) => r.budgets?.clsSamples?.[page] ?? (r.budgets?.cls?.[page] !== undefined ? [r.budgets.cls[page]] : []);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
for (const pageName of Object.keys(head.budgets?.cls ?? {})) {
	const headSamples = samplesOf(head, pageName);
	const baseSamples = samplesOf(base, pageName);
	const value = median(headSamples);
	if (clsMode === "absolute") row(value < budgets.cls.absoluteMax, `CLS ${pageName}: head median ${value} of ${JSON.stringify(headSamples)} (absolute < ${budgets.cls.absoluteMax}; base ${JSON.stringify(baseSamples)})`);
	else {
		const baseMax = baseSamples.length ? Math.max(...baseSamples) : undefined;
		row(baseMax !== undefined && value <= baseMax + budgets.cls.relativeNoise, `CLS ${pageName}: head median ${value} of ${JSON.stringify(headSamples)} vs base max ${baseMax ?? "missing"} of ${JSON.stringify(baseSamples)} (relative, +${budgets.cls.relativeNoise}; absolute target < ${budgets.cls.absoluteMax})`);
	}
}

for (const [pageName, list] of Object.entries(head.budgets?.axe ?? {})) {
	if (!Array.isArray(list)) { row(false, `axe ${pageName}`, `BLOCKED: ${list}`); continue; }
	const baseIds = new Set((Array.isArray(base.budgets?.axe?.[pageName]) ? base.budgets.axe[pageName] : []).map((v) => v.id));
	const fresh = list.filter((v) => budgets.axe.impacts.includes(v.impact) && !baseIds.has(v.id));
	row(fresh.length === 0, `axe ${pageName}: ${list.length} serious/critical on head, ${fresh.length} not on base`, fresh.map((v) => `${v.id} (${v.impact}, ${v.nodes} nodes)`).join("; ") || list.map((v) => v.id).join(", "));
}
}

lines.push("", failed ? `checks failed: ${failed}` : "checks passed (not a verdict: look at the evidence)");
const text = `${lines.join("\n")}\n`;
if (outPath) fs.writeFileSync(outPath, text);
process.stdout.write(text);
process.exit(failed ? 1 : 0);

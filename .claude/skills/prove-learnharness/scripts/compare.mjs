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
let outPath;
const positional = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--out") outPath = argv[++i];
	else if (argv[i] === "--allow") { const [k, ...v] = argv[++i].split("="); allow.push([k, v.join("=")]); }
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
const clsMode = process.env.CLS_MODE || "relative";
const lines = [];
let failed = 0;
const row = (ok, what, detail) => { if (!ok) failed++; lines.push(`- [${ok ? "PASS" : "FAIL"}] ${what}${detail ? `: ${detail}` : ""}`); };

lines.push(`## ${path.basename(path.dirname(headPath))}: base ${base.build} vs head ${head.build}`);

// 1. both drives completed
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
const keys = [...new Set([...Object.keys(base.observations ?? {}), ...Object.keys(head.observations ?? {})])].sort();
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

// 3. budgets
const known = budgets.consoleErrors.known;
const isKnown = (e) => known.some((k) => (e.url ?? "").endsWith(k.urlEndsWith) && e.text.includes(`status of ${k.status}`));
const unknown = (head.budgets?.consoleErrors ?? []).filter((e) => !isKnown(e));
row(unknown.length <= budgets.consoleErrors.max, `console errors (head): ${unknown.length} not on the known list (max ${budgets.consoleErrors.max})`, unknown.map((e) => `${e.page}: ${e.text} ${e.url ?? ""}`).join("; "));

for (const [pageName, value] of Object.entries(head.budgets?.cls ?? {})) {
	const baseValue = base.budgets?.cls?.[pageName];
	if (clsMode === "absolute") row(value < budgets.cls.absoluteMax, `CLS ${pageName}: head ${value} (absolute < ${budgets.cls.absoluteMax}; base ${baseValue ?? "n/a"})`);
	else row(baseValue !== undefined && value <= baseValue + budgets.cls.relativeNoise, `CLS ${pageName}: head ${value} vs base ${baseValue ?? "missing"} (relative, +${budgets.cls.relativeNoise}; absolute target < ${budgets.cls.absoluteMax})`);
}

for (const [pageName, list] of Object.entries(head.budgets?.axe ?? {})) {
	if (!Array.isArray(list)) { row(false, `axe ${pageName}`, `BLOCKED: ${list}`); continue; }
	const baseIds = new Set((Array.isArray(base.budgets?.axe?.[pageName]) ? base.budgets.axe[pageName] : []).map((v) => v.id));
	const fresh = list.filter((v) => budgets.axe.impacts.includes(v.impact) && !baseIds.has(v.id));
	row(fresh.length === 0, `axe ${pageName}: ${list.length} serious/critical on head, ${fresh.length} not on base`, fresh.map((v) => `${v.id} (${v.impact}, ${v.nodes} nodes)`).join("; ") || list.map((v) => v.id).join(", "));
}

lines.push("", failed ? `checks failed: ${failed}` : "checks passed (not a verdict: look at the evidence)");
const text = `${lines.join("\n")}\n`;
if (outPath) fs.writeFileSync(outPath, text);
process.stdout.write(text);
process.exit(failed ? 1 : 0);

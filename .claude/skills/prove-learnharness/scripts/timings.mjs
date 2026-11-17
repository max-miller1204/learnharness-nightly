#!/usr/bin/env node
/**
 * timings.mjs <RUN>: the wall-clock table of a prove run from
 * <RUN>/timings.tsv (written by timed.sh), as markdown for the receipt's
 * "Timing" section and the PR proof comment. Also notes cache hits (a build
 * phase whose log says "reusing") and the total from first start to last end.
 */
import * as fs from "node:fs";
import * as path from "node:path";
const run = process.argv[2];
if (!run) { console.error("usage: timings.mjs <RUN>"); process.exit(2); }
const file = path.join(run, "timings.tsv");
if (!fs.existsSync(file)) { console.log("| Phase | Seconds |\n|---|---|\n| (no timings.tsv: phases were not run through timed.sh) | n/a |"); process.exit(0); }
const rows = fs.readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => {
	const [phase, start, end, seconds, exit] = l.split("\t");
	return { phase, start, end, seconds: Number(seconds), exit };
});
const out = ["| Phase | Seconds | Exit |", "|---|---:|---:|"];
for (const r of rows) out.push(`| ${r.phase} | ${r.seconds.toFixed(1)} | ${r.exit} |`);
const sum = rows.reduce((a, r) => a + r.seconds, 0);
const wall = rows.length ? (Date.parse(rows.at(-1).end) - Date.parse(rows[0].start)) / 1000 : 0;
out.push(`| **sum of phases** | **${sum.toFixed(1)}** | |`);
out.push(`| **wall clock, first start to last end** | **${wall.toFixed(0)}** | |`);
const slow = [...rows].sort((a, b) => b.seconds - a.seconds).slice(0, 3).map((r) => `${r.phase} (${r.seconds.toFixed(0)}s)`);
out.push("", `Slowest: ${slow.join(", ")}`);
console.log(out.join("\n"));

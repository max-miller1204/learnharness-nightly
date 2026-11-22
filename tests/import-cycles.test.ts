/**
 * The modules that mount app-wide providers stay off runtime import cycles.
 * In the production server bundle, a cycle through async modules can let a
 * page render a provider before its module has finished initializing: the
 * 0.7.0 sync's first signed-in /chat/new returned 500 with "Cannot access
 * 'R' before initialization" in SettingsDialogProvider, because the
 * settings dialog's prompt editor reached the chat, which reached the
 * sidebar, which mounts the dialog. Type-only imports are erased and don't
 * count.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];

function resolve(from: string, spec: string): string | null {
	const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
	if (!base) return null; // a package
	for (const extension of EXTENSIONS) {
		const file = base + extension;
		if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
	}
	return null;
}

const graph = new Map<string, Set<string>>();
function imports(file: string): Set<string> {
	const known = graph.get(file);
	if (known) return known;
	const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const found = new Set<string>();
	for (const [, clause, spec] of source.matchAll(/^\s*(?:import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gm)) {
		const names = clause!.trim();
		if (/^type\b/.test(names)) continue;
		const braced = names.match(/^\{([\s\S]*)\}$/);
		if (braced && braced[1]!.split(",").map((name) => name.trim()).filter(Boolean).every((name) => name.startsWith("type "))) continue;
		const target = resolve(file, spec!);
		if (target) found.add(target);
	}
	for (const [, spec] of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
		const target = resolve(file, spec!);
		if (target) found.add(target);
	}
	graph.set(file, found);
	return found;
}

/** One import path from `file` back to itself, or null. */
function cycleThrough(file: string): string[] | null {
	const previous = new Map<string, string | null>();
	const queue: string[] = [];
	for (const next of imports(file)) { previous.set(next, null); queue.push(next); }
	while (queue.length) {
		const current = queue.shift()!;
		for (const next of imports(current)) {
			if (next === file) {
				const trail = [current];
				for (let step = previous.get(current); step; step = previous.get(step)) trail.unshift(step);
				return [file, ...trail, file].map((entry) => path.relative(root, entry));
			}
			if (!previous.has(next)) { previous.set(next, current); queue.push(next); }
		}
	}
	return null;
}

for (const file of ["components/settings/settings-dialog.tsx", "components/sidebar.tsx"]) {
	it(`${file} is on no runtime import cycle`, () => {
		const cycle = cycleThrough(path.join(root, file));
		assert.equal(cycle, null, cycle?.join(" -> "));
	});
}

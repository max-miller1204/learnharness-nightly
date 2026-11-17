/** Prepare source-plugin dependencies for checkout validation, never distribution.
 * Invoke through npm so npm_execpath works identically on Windows and Unix.
 * `--sdk-only` regenerates the SDK types without installing: CI uses it when it
 * restored the plugins' node_modules from a cache keyed on their lockfiles. It
 * also recreates the lockfile's local `file:` links (learnharness-plugin-api ->
 * .sdk): npm makes them relative symlinks on POSIX but junctions with absolute
 * targets on Windows, which don't survive the cache, so it relinks them the way
 * npm would. */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function runNpm(args, cwd) {
	const npm = process.env.npm_execpath;
	if (!npm) throw new Error("Run this helper through npm run plugins:setup");
	const result = spawnSync(process.execPath, [npm, ...args], { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${path.basename(cwd)}: npm ${args.join(" ")} failed (${result.signal ?? result.status})`);
}

/** Recreate every `link: true` entry of a plugin's package-lock.json, as npm ci would. */
export function relinkLocalPackages(directory) {
	const name = path.basename(directory);
	const modules = path.join(directory, "node_modules");
	const lock = JSON.parse(readFileSync(path.join(directory, "package-lock.json"), "utf8"));
	for (const [key, entry] of Object.entries(lock.packages ?? {})) {
		if (!key || entry?.link !== true) continue;
		if (typeof entry.resolved !== "string") throw new Error(`${name}: ${key} is a link without a resolved path`);
		const link = path.join(directory, key);
		const inside = path.relative(modules, link);
		if (!key.startsWith("node_modules/") || !inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`${name}: refusing link entry outside node_modules: ${key}`);
		const target = path.resolve(directory, entry.resolved);
		if (!existsSync(target)) throw new Error(`${name}: ${key} links to missing ${entry.resolved}`);
		// Remove a link (Node reports junctions as symlinks) without following it;
		// only a real folder or file the restore left behind is deleted recursively.
		const existing = lstatSync(link, { throwIfNoEntry: false });
		if (existing?.isSymbolicLink()) unlinkSync(link);
		else if (existing) rmSync(link, { recursive: true, force: true });
		mkdirSync(path.dirname(link), { recursive: true });
		// Exactly what npm does: a relative target with type "junction", which Node
		// turns into an absolute junction on Windows and ignores elsewhere.
		symlinkSync(path.relative(path.dirname(link), target), link, "junction");
		if (!existsSync(path.join(link, "package.json"))) throw new Error(`${name}: ${key} does not resolve to a package after relinking`);
	}
}

export function setupPlugins(root, { run = runNpm, sdkOnly = false } = {}) {
	const source = path.join(root, "plugins");
	const packages = readdirSync(source, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => path.join(source, entry.name))
		.filter(directory => existsSync(path.join(directory, "package.json")))
		.sort()
		.map(directory => {
			if (!existsSync(path.join(directory, "package-lock.json"))) throw new Error(`${path.basename(directory)}: package-lock.json is required for reproducible setup`);
			return { directory, manifest: JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) };
		});
	for (const { directory, manifest } of packages) {
		console.log(`[plugin-setup] ${path.basename(directory)}`);
		if (typeof manifest.scripts?.sdk === "string") run(["run", "sdk"], directory);
		if (sdkOnly) relinkLocalPackages(directory);
		else run(["ci"], directory);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { setupPlugins(path.resolve(import.meta.dirname, ".."), { sdkOnly: process.argv.includes("--sdk-only") }); }
	catch (error) { console.error("[plugin-setup]", error); process.exitCode = 1; }
}

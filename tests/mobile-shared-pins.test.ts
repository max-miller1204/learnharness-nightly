/**
 * The phone runs the shared core (src/) against its own install, so the
 * packages that core parses and types tool input with must be the same
 * versions in apps/mobile as at the root. A drift would let the phone
 * accept or reject a tool call differently from the server.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
const SHARED = ["@earendil-works/pi-schema", "typebox", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core"];

it("apps/mobile pins the shared core's parser and Pi packages to the root's installed versions", () => {
	const rootLock = read("package-lock.json");
	const mobile = read("apps/mobile/package.json");
	const mobileLock = read("apps/mobile/package-lock.json");
	for (const name of SHARED) {
		const version = rootLock.packages[`node_modules/${name}`]?.version;
		assert.ok(version, `${name} is installed at the root`);
		assert.equal(mobile.dependencies?.[name] ?? mobile.devDependencies?.[name], version, `${name}: apps/mobile/package.json pins the root's version exactly`);
		assert.equal(mobileLock.packages[`node_modules/${name}`]?.version, version, `${name}: apps/mobile/package-lock.json installs the root's version`);
	}
});

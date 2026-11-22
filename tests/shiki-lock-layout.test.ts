/**
 * The packaged Windows app needs shiki and @shikijs/* at the top level of
 * package-lock.json. The NSIS installer turns Next's .next/node_modules/shiki-<hash>
 * link into a plain copy, and from that copy a package nested under
 * node_modules/@streamdown/code/node_modules cannot be resolved, so every page
 * answers 500. A lock regeneration can silently move them back.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
	packages: Record<string, { version?: string }>;
};
const packages = lock.packages;

const why =
	"The Windows installer copies Next's shiki link, so shiki and @shikijs/* must sit at the top level of package-lock.json. " +
	"Keep shiki as a direct dependency in package.json at the version the lock uses, then run `npm install --package-lock-only`.";

describe("shiki lock layout", () => {
	it("keeps shiki at the top level", () => {
		assert.ok(packages["node_modules/shiki"], `node_modules/shiki is missing. ${why}`);
		assert.ok(packages["node_modules/@shikijs/core"], `node_modules/@shikijs/core is missing. ${why}`);
	});

	it("leaves shiki and @shikijs/* out of @streamdown/code/node_modules", () => {
		const nested = Object.keys(packages).filter(
			(key) =>
				key === "node_modules/@streamdown/code/node_modules/shiki" ||
				key.startsWith("node_modules/@streamdown/code/node_modules/@shikijs/"),
		);
		assert.deepEqual(nested, [], `Nested shiki packages found. ${why}`);
	});
});

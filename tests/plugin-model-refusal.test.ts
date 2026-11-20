import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

// Keys come only from the environment here: an empty auth file, no saved keys.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-model-refusal-"));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_DATA_DIR = directory;
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { pluginKeyMissing } = await import("../src/server/plugin-model-refusal.ts");

it("the host asks for a key only when the plugin's model still exists", () => {
	const saved = process.env.OPENCODE_API_KEY;
	try {
		delete process.env.OPENCODE_API_KEY;
		assert.equal(pluginKeyMissing("opencode-go", "minimax-m3.1-flash-free"), null, "a retired model is model_unavailable even without a key");
		assert.equal((pluginKeyMissing("opencode-go", "gemini-4-argon") as { code?: string } | null)?.code, "provider_key_missing");
		process.env.OPENCODE_API_KEY = "test-plugin-key";
		assert.equal(pluginKeyMissing("opencode-go", "gemini-4-argon"), null);
	} finally {
		if (saved === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = saved;
	}
});

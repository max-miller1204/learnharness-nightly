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
const { pluginKeyMissing, pluginKnowsProvider } = await import("../src/server/plugin-model-refusal.ts");

it("the host asks for a key only when the plugin's model still exists", async () => {
	const saved = process.env.OPENCODE_API_KEY;
	try {
		delete process.env.OPENCODE_API_KEY;
		assert.equal(await pluginKeyMissing("opencode-go", "minimax-m3.1-flash-free"), null, "a retired model is model_unavailable even without a key");
		assert.equal((await pluginKeyMissing("opencode-go", "gemini-4-argon") as { code?: string } | null)?.code, "provider_key_missing");
		process.env.OPENCODE_API_KEY = "test-plugin-key";
		assert.equal(await pluginKeyMissing("opencode-go", "gemini-4-argon"), null);
	} finally {
		if (saved === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = saved;
	}
});

it("the host knows every provider it could refuse for, whatever the connection state, and no others", async () => {
	const { CUSTOM_PROVIDER } = await import("../src/core/auth-keys.ts");
	const { catalogProviders } = await import("../src/server/model-catalog.ts");
	for (const known of ["opencode-go", "chatgpt", "claude-code", CUSTOM_PROVIDER.id]) assert.equal(await pluginKnowsProvider(known), true, `${known} stays known with no key, endpoint or connection`);
	for (const row of catalogProviders()) assert.equal(await pluginKnowsProvider(row.id), true, `catalog row ${row.id}`);
	for (const unknown of ["github", "../x", " opencode-go", "opencode-go ", ""]) assert.equal(await pluginKnowsProvider(unknown), false, JSON.stringify(unknown));
});

/**
 * The prove skill's api-check.mjs deletes the session a build makes when it
 * accepts the cross-site fetch-metadata probe (issue #303). A DELETE that
 * fails must be reported as a failed step naming the file left on disk,
 * never passed over. Driven against a stub server that accepts the probe and
 * refuses the cleanup.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const SCRIPT = path.resolve(import.meta.dirname, "../.claude/skills/prove-learnharness/scripts/api-check.mjs");
const LEFT = "chat_zzproveit_left_behind";

test("a failed cleanup DELETE is a failed step that names the fixture left on disk", async () => {
	const deletes: string[] = [];
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stub");
		const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
		req.resume();
		req.on("end", () => {
			if (req.method === "POST" && url.pathname === "/api/chats") {
				// Like main before the fix: the probe's cookie write is accepted.
				const probe = req.headers["sec-fetch-site"] === "cross-site" && req.headers.origin === undefined;
				return json(200, { id: probe ? LEFT : "chat_zzproveit_other", title: "zz-prove-it" });
			}
			if (req.method === "DELETE") {
				deletes.push(url.pathname);
				return url.pathname === `/api/chats/${LEFT}` ? json(500, { error: "stub refuses" }) : json(200, { ok: true });
			}
			return json(200, {});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-api-check-stub-"));
	const dataDir = path.join(dir, "data");
	fs.writeFileSync(path.join(dir, "instance.env"), [
		"SIDE=head", `APP_URL=http://127.0.0.1:${port}`, `APP_PORT=${port}`, "APP_TOKEN=stub.token",
		`FAKE_CONTROL=http://127.0.0.1:${port}`, `DATA_DIR=${dataDir}`, "BUILD_STAMP=stub",
	].join("\n") + "\n");
	try {
		const output = await new Promise<string>((resolve) => {
			const child = spawn(process.execPath, [SCRIPT, path.join(dir, "instance.env")], { env: { ...process.env, TURN_TIMEOUT_S: "1" } });
			let text = "";
			child.stdout.on("data", (chunk) => { text += chunk; });
			child.stderr.on("data", (chunk) => { text += chunk; });
			child.on("close", () => resolve(text));
		});
		assert.ok(deletes.includes(`/api/chats/${LEFT}`), "the script tried to delete what the probe made");
		const line = output.split("\n").find((l) => l.startsWith("[FAIL] cleanup after"));
		assert.ok(line, "the failed cleanup is a failed step");
		assert.match(line, /cross-site fetch metadata write with a cookie is refused/);
		assert.ok(line.includes(path.join(dataDir, "chats", `${LEFT}.json`)), "it names the file left on disk");
		assert.match(line, /-> 500/);
	} finally {
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

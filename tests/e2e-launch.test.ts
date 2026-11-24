// The launch record that ties the e2e config's `pairing-code` secret to the
// instance serve.ts started (tests/e2e/support/instance.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { instanceDir, launchPointer, pairingCode, publishLaunch, stateFile, unpublishLaunch, type InstanceState } from "./e2e/support/instance.ts";

const made: string[] = [];
afterEach(() => { for (const file of made.splice(0)) fs.rmSync(file, { recursive: true, force: true }); });

/** A launch id with a state.json for a made-up port, as serve.ts leaves them. */
function instanceFor(state: Partial<InstanceState>, port = String(40000 + Math.floor(Math.random() * 20000))) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-e2e-launch-data-"));
	const id = randomUUID();
	fs.mkdirSync(instanceDir(port), { recursive: true });
	fs.writeFileSync(stateFile(port), JSON.stringify({ dataDir, pid: process.pid, ...state }));
	made.push(dataDir, instanceDir(port), launchPointer(id), `${launchPointer(id)}.tmp`);
	return { id, port, dataDir };
}

describe("the launch record", () => {
	it("is removed by the process that published it and by nobody else", () => {
		const id = randomUUID();
		made.push(launchPointer(id));
		publishLaunch(id, "4000");
		assert.equal(JSON.parse(fs.readFileSync(launchPointer(id), "utf8")).pid, process.pid);
		// Another instance's record (another pid) survives this process stopping.
		fs.writeFileSync(launchPointer(id), JSON.stringify({ port: "4001", pid: process.pid + 1 }));
		unpublishLaunch(id);
		assert.ok(fs.existsSync(launchPointer(id)));
		fs.writeFileSync(launchPointer(id), JSON.stringify({ port: "4000", pid: process.pid }));
		unpublishLaunch(id);
		assert.ok(!fs.existsSync(launchPointer(id)));
		unpublishLaunch(id); // nothing there: no error
	});

	it("mints a pairing code only against the instance of that launch", async () => {
		const { id, port, dataDir } = instanceFor({});
		fs.writeFileSync(path.join(path.dirname(stateFile(port)), "state.json"), JSON.stringify({ dataDir, pid: process.pid, launchId: id }));
		publishLaunch(id, port);
		assert.match(await pairingCode(id), /^[A-Z0-9]{4}(-[A-Z0-9]{4})+$/);
		assert.ok(fs.readdirSync(dataDir).length > 0, "the code went into this instance's data folder");
	});

	it("refuses a stale or reused record: another launch's state, or another pid", async () => {
		const other = instanceFor({ launchId: randomUUID() });
		publishLaunch(other.id, other.port);
		await assert.rejects(pairingCode(other.id), /is not launch/);
		assert.deepEqual(fs.readdirSync(other.dataDir), [], "nothing was minted");

		const reused = instanceFor({});
		fs.writeFileSync(path.join(path.dirname(stateFile(reused.port)), "state.json"), JSON.stringify({ dataDir: reused.dataDir, pid: process.pid + 1, launchId: reused.id }));
		publishLaunch(reused.id, reused.port);
		await assert.rejects(pairingCode(reused.id), /is not launch/);
		assert.deepEqual(fs.readdirSync(reused.dataDir), []);
	});

	it("fails fast when the recorded process is gone", async () => {
		const id = randomUUID();
		made.push(launchPointer(id));
		fs.writeFileSync(launchPointer(id), JSON.stringify({ port: "4002", pid: 2 ** 22 + 12345 }));
		await assert.rejects(pairingCode(id), /no longer running/);
	});
});

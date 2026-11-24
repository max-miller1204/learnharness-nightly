// The proof the `ios` target demands before it touches a simulator (tests/e2e/support/ios-device.ts):
// only one ios.sh created for this run. The refusals need no Mac, so they run everywhere.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { verifyOwnedSimulator } from "./e2e/support/ios-device.ts";

const SHARED = "8C1A7F98-6DCD-4EFC-AA99-D249EEE90B44";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-e2e-ios-device-"));
const saved = { device: process.env.E2E_IOS_DEVICE, record: process.env.E2E_IOS_SIM_RECORD };
const restore = (key: "E2E_IOS_DEVICE" | "E2E_IOS_SIM_RECORD", value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
beforeEach(() => { delete process.env.E2E_IOS_DEVICE; delete process.env.E2E_IOS_SIM_RECORD; });
afterEach(() => { restore("E2E_IOS_DEVICE", saved.device); restore("E2E_IOS_SIM_RECORD", saved.record); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function record(fields: object) {
	const file = path.join(dir, `${Math.random().toString(16).slice(2)}.json`);
	fs.writeFileSync(file, JSON.stringify(fields));
	process.env.E2E_IOS_SIM_RECORD = file;
}

describe("the simulator the ios target may drive", () => {
	it("is refused when no run made one", () => {
		assert.throws(() => verifyOwnedSimulator(undefined), /ios\.sh e2e/);
		assert.throws(() => verifyOwnedSimulator(SHARED), /E2E_IOS_SIM_RECORD is not set/);
	});

	it("is refused when the record names another simulator, even the shared one", () => {
		process.env.E2E_IOS_DEVICE = SHARED;
		record({ udid: "11111111-2222-3333-4444-555555555555", name: "lh-e2e-ab", pid: process.pid, run: "ab" });
		assert.throws(() => verifyOwnedSimulator(SHARED), /not the simulator ios\.sh created/);
	});

	it("is refused when its name is not an ios.sh name", () => {
		process.env.E2E_IOS_DEVICE = SHARED;
		record({ udid: SHARED, name: "iPhone 17 Pro", pid: process.pid, run: "ab" });
		assert.throws(() => verifyOwnedSimulator(SHARED), /not named like an ios\.sh simulator/);
	});

	it("is refused when the run that made it is gone", () => {
		process.env.E2E_IOS_DEVICE = "11111111-2222-3333-4444-555555555555";
		record({ udid: "11111111-2222-3333-4444-555555555555", name: "lh-e2e-ab", pid: 2 ** 22 + 12345, run: "ab" });
		assert.throws(() => verifyOwnedSimulator("11111111-2222-3333-4444-555555555555"), /no longer running/);
	});

	it("is refused when E2E_IOS_DEVICE names another simulator than the one asked about", () => {
		process.env.E2E_IOS_DEVICE = "99999999-2222-3333-4444-555555555555";
		record({ udid: "11111111-2222-3333-4444-555555555555", name: "lh-e2e-ab", pid: process.pid, run: "ab" });
		assert.throws(() => verifyOwnedSimulator("11111111-2222-3333-4444-555555555555"), /not the simulator ios\.sh created/);
	});
});

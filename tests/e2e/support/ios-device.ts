/**
 * The simulator the `ios` target drives, and the proof that `ios.sh` made it.
 *
 * `ios.sh e2e` creates a simulator named `lh-e2e-<run id>`, writes a record
 * for it (its udid, name, run id and the wrapper's pid) and passes the
 * udid and the record's path in E2E_IOS_DEVICE and E2E_IOS_SIM_RECORD. Nothing
 * here prepares, provisions or drives a simulator without that proof, so a
 * simulator the owner uses, the shared one above all, is never touched.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

/** The prefix every simulator `ios.sh` creates carries in its name. */
export const SIMULATOR_PREFIX = "lh-e2e-";

type SimulatorRecord = { udid: string; name: string; pid: number; run: string };

/** Throws unless `udid` is a simulator the live `ios.sh` run named in E2E_IOS_SIM_RECORD created. Returns its record. */
export function verifyOwnedSimulator(udid: string | undefined): SimulatorRecord {
	if (!udid) throw new Error("no simulator: run the ios target through tests/e2e/support/ios.sh e2e, which creates one");
	const file = process.env.E2E_IOS_SIM_RECORD;
	if (!file) throw new Error("E2E_IOS_SIM_RECORD is not set: run the ios target through tests/e2e/support/ios.sh e2e");
	let record: SimulatorRecord;
	try { record = JSON.parse(fs.readFileSync(file, "utf8")) as SimulatorRecord; } catch { throw new Error(`no simulator record at ${file}`); }
	if (record.udid !== udid || process.env.E2E_IOS_DEVICE !== udid) throw new Error(`${udid} is not the simulator ios.sh created for this run (${record.udid})`);
	if (!record.name.startsWith(SIMULATOR_PREFIX)) throw new Error(`${record.name} is not named like an ios.sh simulator`);
	try { process.kill(record.pid, 0); } catch { throw new Error(`the ios.sh run that created ${udid} (pid ${record.pid}) is no longer running`); }
	const listing = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" })) as { devices: { [runtime: string]: Array<{ udid: string; name: string }> } };
	const found = Object.values(listing.devices).flat().find((device) => device.udid === udid);
	if (found?.name !== record.name) throw new Error(`simulator ${udid} is named ${found?.name ?? "(missing)"}, not ${record.name}`);
	return record;
}

/** Boots the simulator if it is down, trusts the launch's CA in it and installs the build, so the app starts with no saved servers. */
export function provisionSimulator(options: { udid: string; ca: string; appPath: string; bundleId: string }) {
	verifyOwnedSimulator(options.udid);
	// Boots a shut-down simulator and waits for it (`boot` on a booted one exits 149; bootstatus -b does not). The engine
	// boots it too when it prepares the device; whichever comes first, the other waits.
	execFileSync("xcrun", ["simctl", "bootstatus", options.udid, "-b"], { stdio: "ignore" });
	execFileSync("xcrun", ["simctl", "keychain", options.udid, "add-root-cert", options.ca], { stdio: "inherit" });
	try { execFileSync("xcrun", ["simctl", "uninstall", options.udid, options.bundleId], { stdio: "ignore" }); } catch { /* not installed */ }
	execFileSync("xcrun", ["simctl", "install", options.udid, options.appPath], { stdio: "inherit" });
}

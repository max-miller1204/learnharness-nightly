/**
 * The phone app's test: `test`, `describe` and `beforeEach` from
 * @e2e-dev/mobile, plus a worker fixture that prepares the simulator once.
 *
 * The phone accepts only https servers, so the instance serve.ts started for
 * the `ios` target sits behind a TLS front with a throwaway CA (see
 * LH_E2E_TLS_PORT there). The fixture trusts that CA in the simulator, then
 * installs the build ios.sh made, with `reinstall` so the app starts with no
 * saved servers. A device has no saved sessions to restore, so a test that
 * needs a paired phone calls `pairPhone`.
 */
import { execFileSync } from "node:child_process";
import { test as base, type Device } from "@e2e-dev/mobile";
import { expect, secrets, type Screen } from "e2e";
import { instance } from "./instance.ts";
import { phoneBase } from "./phone-config.ts";

export { beforeEach, describe } from "@e2e-dev/mobile";

/** The `ios` target's instance, once serve.ts has finished seeding it. */
export const phoneInstance = () => instance(phoneBase);

export const test = base.extend<object, { phoneBuild: void }>({
	phoneBuild: [async ({ device }, use) => {
		const state = await phoneInstance();
		if (!state.tls) throw new Error("the ios target's server has no TLS front: serve.ts needs LH_E2E_TLS_PORT");
		execFileSync("xcrun", ["simctl", "keychain", device.unstable_raw.deviceId, "add-root-cert", state.tls.ca]);
		await device.installApp(undefined, { reinstall: true });
		await use();
	}, { scope: "worker", auto: true }],
});

/** The https address the phone is given. */
export async function phoneAddress() {
	const { tls } = await phoneInstance();
	if (!tls) throw new Error("the ios target's server has no TLS front");
	return tls.url;
}

/** A fresh one-time code for the phone's server, as a secret handle: the code stays out of the report and traces. */
export const freshCode = () => secrets.get("phone-pairing-code");

/** From a fresh launch to the Pair screen. The app keeps its data between tests, so each one starts from none. */
export async function openPairScreen({ app, device, screen }: { app: { clearState(): Promise<void>; open(): Promise<void> }; device: Device; screen: Screen }) {
	await device.clearKeychain();
	await app.clearState();
	await app.open();
	await screen.getByRole("button", "Pair a server").tap();
	await expect(screen.getByRole("textbox", "Server address")).toBeVisible();
}

/** Types an address and a code on the Pair screen and taps Connect. */
export async function connect(screen: Screen, address: string, code: string | ReturnType<typeof freshCode>) {
	await screen.getByLabel("Server address").fill(address);
	await screen.getByLabel("Pairing code").fill(code);
	await screen.getByRole("button", "Connect").tap();
}

/** iOS offers to save the pairing code as a password once a pairing has worked, in a system sheet over the app. */
export async function declineSavePassword(screen: Screen) {
	await screen.getByRole("button", "Not Now").tap({ timeout: 60_000 });
}

/** A fresh launch, paired with a new code: ends on the session list. */
export async function pairPhone(fixtures: { app: { clearState(): Promise<void>; open(): Promise<void> }; device: Device; screen: Screen }) {
	const address = await phoneAddress();
	await openPairScreen(fixtures);
	await connect(fixtures.screen, address, freshCode());
	await declineSavePassword(fixtures.screen);
	await expect(fixtures.screen.getByRole("button", "New teaching session")).toBeVisible({ timeout: 60_000 });
}

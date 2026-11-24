/**
 * What e2e.config.ts and the phone tests agree on for the `ios` target. It
 * imports nothing, so the config can load it.
 *
 * The phone's server starts from the target's `app.command`, which has no
 * `url` to take a free port from, so its ports are fixed: the app listens on
 * `phonePort` over http and serves the phone over https on the next port.
 * E2E_IOS_PORT moves both.
 */
export const phonePort = process.env.E2E_IOS_PORT ?? "47831";
export const phoneTlsPort = String(Number(phonePort) + 1);
/** The app's http address, which instance() reads the run's state from. */
export const phoneBase = `http://127.0.0.1:${phonePort}`;
/** The bundle id the shipped app and the e2e build share (apps/mobile/app.json). */
export const phoneBundleId = "com.maxmiller.learnharness.nightly";
/** Where tests/e2e/support/ios.sh build leaves the app. */
export const phoneAppPath = process.env.E2E_IOS_APP ?? ".e2e/ios/LearnHarnessNightly.app";

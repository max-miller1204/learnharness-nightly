/**
 * What e2e.config.ts needs for the `ios` target. `ios.sh e2e` sets the
 * environment below for one run: a simulator it created, two free ports, a run
 * id and the build's path. A run started any other way has none of it, and the
 * config makes the `ios` target refuse to start (see e2e.config.ts).
 *
 * The phone's server starts from the target's `app.command`, which has no
 * `url` to take a free port from, so the wrapper allocates the ports: the app
 * listens on E2E_IOS_PORT over http and is served to the phone over https on
 * E2E_IOS_TLS_PORT.
 */
import * as path from "node:path";

/** The bundle id the shipped app and the e2e build share (apps/mobile/app.json). */
export const phoneBundleId = "com.maxmiller.learnharness.nightly";
/** Where `ios.sh build` leaves the app, relative to the repo root unless E2E_IOS_APP says otherwise. */
export const phoneAppPath = path.resolve(process.env.E2E_IOS_APP ?? ".e2e/ios/LearnHarnessNightly.app");
export const phoneRunId = process.env.E2E_IOS_RUN;
export const phonePort = process.env.E2E_IOS_PORT;
export const phoneTlsPort = process.env.E2E_IOS_TLS_PORT;
/** Whether this process belongs to an `ios.sh e2e` run. */
export const phoneWrapped = Boolean(phoneRunId && phonePort && phoneTlsPort && process.env.E2E_IOS_DEVICE && process.env.E2E_IOS_SIM_RECORD);

/**
 * The launcher <-> server contract, shared by `selfhost/` (the `lh`
 * launcher) and the LearnHarness server (`src/server/self-update.ts`).
 *
 * Modeled on T3 Code's SERVICE_LAUNCHER_PROTOCOL: an old launcher keeps
 * working with newer servers. The update handshake below is FROZEN: its
 * message shapes never change, so any running launcher can trial and commit
 * any newer server. New capabilities get NEW message types, which a server
 * only uses when LH_LAUNCHER_PROTOCOL is high enough.
 *
 * Node built-ins only, erasable TypeScript only: Node runs this file
 * directly (type stripping) and Next bundles it into the server.
 */

/** This launcher's protocol. Bump when the launcher gains a capability a server may rely on. */
export const LAUNCHER_PROTOCOL = 1;
/** The oldest launcher protocol this version's server works with. */
export const MIN_LAUNCHER_PROTOCOL = 1;

/** Exit code a server uses when another server already holds its data folder (T3 uses 78 too). */
export const EXIT_DATA_DIR_IN_USE = 78;
/** Exit code the launcher uses to ask systemd to restart it onto a newer launcher. */
export const EXIT_RELAUNCH = 75;

/** Environment names the launcher manages. `service.env` can never override these. */
export const ENV = {
	selfhost: "LH_SELFHOST",
	home: "LH_HOME",
	launcherProtocol: "LH_LAUNCHER_PROTOCOL",
	trialUpdateId: "LH_TRIAL_UPDATE_ID",
	feedUrl: "LH_FEED_URL",
	dataDir: "LH_DATA_DIR",
	authFile: "LH_AUTH_FILE",
	chromePath: "CHROME_PATH",
} as const;

/** Messages a server sends to its launcher. FROZEN. */
export type ChildMessage =
	| { type: "request-update"; targetVersion: string }
	| { type: "prepared"; updateId: string };

/** Messages a launcher sends to its server. FROZEN. */
export type ParentMessage =
	| { type: "update-accepted"; updateId: string }
	| { type: "update-rejected"; reason: string }
	| { type: "committed"; updateId: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function parseChildMessage(value: unknown): ChildMessage | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type === "request-update" && typeof value.targetVersion === "string") {
		return { type: "request-update", targetVersion: value.targetVersion };
	}
	if (value.type === "prepared" && typeof value.updateId === "string") {
		return { type: "prepared", updateId: value.updateId };
	}
	return undefined;
}

export function parseParentMessage(value: unknown): ParentMessage | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type === "update-accepted" && typeof value.updateId === "string") {
		return { type: "update-accepted", updateId: value.updateId };
	}
	if (value.type === "update-rejected" && typeof value.reason === "string") {
		return { type: "update-rejected", reason: value.reason };
	}
	if (value.type === "committed" && typeof value.updateId === "string") {
		return { type: "committed", updateId: value.updateId };
	}
	return undefined;
}

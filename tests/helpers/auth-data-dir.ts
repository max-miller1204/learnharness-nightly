/**
 * Import FIRST in a test that drives proxy.ts or the auth routes: points
 * LH_DATA_DIR at a throwaway folder before config.ts reads it, and mints
 * sessions straight into its login store, the way `lh` does. The folder is
 * removed when the process exits, only when this helper made it: an
 * LH_DATA_DIR set beforehand (by a caller, or inherited by a child process
 * the test spawned) is left alone.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { issueSession } from "../../selfhost/src/auth-store.ts";

if (!process.env.LH_DATA_DIR) {
	const created = fs.mkdtempSync(path.join(os.tmpdir(), "lh-auth-test-"));
	process.env.LH_DATA_DIR = created;
	process.on("exit", () => {
		try { fs.rmSync(created, { recursive: true, force: true }); } catch { /* best effort at exit */ }
	});
}
export const AUTH_TEST_DATA_DIR = path.resolve(process.env.LH_DATA_DIR);

export function mintToken(label = "test"): string {
	return issueSession(AUTH_TEST_DATA_DIR, { method: "pairing", client: { label, deviceType: "desktop" } }).token;
}

export const cookieName = () => `lh_session_${process.env.PORT && /^\d+$/.test(process.env.PORT) ? process.env.PORT : "3000"}`;

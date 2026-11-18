/**
 * T3's startup link (docs/specs/login-pairing.md): a server started outside
 * the desktop app and outside `lh` (`npm run dev`, `next start`) prints a
 * one-time pairing link to its own terminal. stdout only, never a log file
 * (`lh` sends server stdout to server.log, so self-hosted servers skip this;
 * `lh up` and `lh pair` print links instead).
 */
import { createPairingLink, DEV_STARTUP_TTL_MS, PAIRING_TTL_MS, pairingUrl } from "../../selfhost/src/auth-store.ts";
import { authDataDir } from "./auth.ts";

export function printStartupPairingLink(env: Record<string, string | undefined> = process.env, write: (line: string) => void = (line) => console.log(line)): void {
	if (env.LH_SELFHOST === "1" || env.LH_DESKTOP_SERVER === "1") return;
	try {
		const dev = env.NODE_ENV === "development";
		const link = createPairingLink(authDataDir(), { hidden: true, ttlMs: dev ? DEV_STARTUP_TTL_MS : PAIRING_TTL_MS });
		const port = env.PORT && /^\d+$/.test(env.PORT) ? env.PORT : "3000";
		const url = pairingUrl(`http://localhost:${port}`, link.code);
		write(`[auth] Pair a browser: ${url} (one-time, expires in ${dev ? "24 hours" : "5 minutes"}). Make another with Settings → Devices, or \`npm run pair\`.`);
	} catch (error) {
		console.error("[auth] Could not make a startup pairing link:", error);
	}
}

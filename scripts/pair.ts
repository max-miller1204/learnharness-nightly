/**
 * `npm run pair`: a one-time pairing link for a dev or `next start` server
 * (docs/specs/login-pairing.md). Writes into ./data, or LH_DATA_DIR, and
 * prints the link for PORT (default 3000). Self-hosted installs use `lh pair`.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createPairingLink, formatCode, pairingUrl } from "../selfhost/src/auth-store.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(root, "data");
const port = process.env.PORT && /^\d+$/.test(process.env.PORT) ? process.env.PORT : "3000";
const link = createPairingLink(dataDir, process.argv[2] ? { label: process.argv[2] } : {});
console.log(`Pair a browser: ${pairingUrl(`http://localhost:${port}`, link.code)}`);
console.log(`Code: ${formatCode(link.code)} (one-time, expires in 5 minutes)`);

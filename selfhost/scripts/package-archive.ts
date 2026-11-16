/**
 * Assemble one self-hosted archive (CI, nightly.yml):
 *
 *   node selfhost/scripts/package-archive.ts --version V --arch linux-x64 \
 *     --node-dir <extracted official node-v26 tarball> --standalone .next/standalone --out dist-selfhost
 *
 * Archive root: node/ (bin/node + LICENSE), server/ (the curated standalone
 * server from scripts/build-server.mjs), selfhost/ (this launcher), lh,
 * VERSION, PROTOCOL.json. Writes <name>.tar.gz and <name>.tar.gz.sha256.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { LAUNCHER_PROTOCOL, MIN_LAUNCHER_PROTOCOL } from "../src/protocol.ts";
import { isExactVersion } from "../src/release.ts";

const { values } = parseArgs({
	options: {
		version: { type: "string" },
		arch: { type: "string" },
		"node-dir": { type: "string" },
		standalone: { type: "string", default: ".next/standalone" },
		out: { type: "string", default: "dist-selfhost" },
	},
});
const version = values.version ?? "";
const arch = values.arch ?? "";
if (!isExactVersion(version)) throw new Error(`--version must be an exact version, got "${version}"`);
if (arch !== "linux-x64" && arch !== "linux-arm64") throw new Error(`--arch must be linux-x64 or linux-arm64, got "${arch}"`);
const nodeDir = path.resolve(values["node-dir"] ?? "");
const standalone = path.resolve(values.standalone);
const outDir = path.resolve(values.out);
const selfhostDir = path.resolve(import.meta.dirname, "..");
for (const required of [path.join(nodeDir, "bin", "node"), path.join(standalone, "server.js")]) {
	if (!fs.existsSync(required)) throw new Error(`missing ${required}`);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "lh-archive-"));
try {
	fs.mkdirSync(path.join(stage, "node", "bin"), { recursive: true });
	fs.copyFileSync(path.join(nodeDir, "bin", "node"), path.join(stage, "node", "bin", "node"));
	fs.chmodSync(path.join(stage, "node", "bin", "node"), 0o755);
	for (const extra of ["LICENSE", "README.md"]) {
		if (fs.existsSync(path.join(nodeDir, extra))) fs.copyFileSync(path.join(nodeDir, extra), path.join(stage, "node", extra));
	}
	fs.cpSync(standalone, path.join(stage, "server"), { recursive: true, verbatimSymlinks: true });
	fs.mkdirSync(path.join(stage, "selfhost"), { recursive: true });
	for (const entry of ["lh.ts", "package.json", "src"]) {
		fs.cpSync(path.join(selfhostDir, entry), path.join(stage, "selfhost", entry), { recursive: true });
	}
	fs.copyFileSync(path.join(selfhostDir, "lh.sh"), path.join(stage, "lh"));
	fs.chmodSync(path.join(stage, "lh"), 0o755);
	fs.writeFileSync(path.join(stage, "VERSION"), `${version}\n`);
	fs.writeFileSync(path.join(stage, "PROTOCOL.json"), `${JSON.stringify({ launcherProtocol: LAUNCHER_PROTOCOL, minLauncherProtocol: MIN_LAUNCHER_PROTOCOL })}\n`);

	fs.mkdirSync(outDir, { recursive: true });
	const name = `learnharness-${version}-${arch}.tar.gz`;
	const archive = path.join(outDir, name);
	execFileSync("tar", ["-czf", archive, "--owner=0", "--group=0", "-C", stage, "."], { stdio: "inherit" });
	const sha = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
	fs.writeFileSync(`${archive}.sha256`, `${sha}  ${name}\n`);
	process.stdout.write(`${archive}\n${sha}\n`);
} finally {
	fs.rmSync(stage, { recursive: true, force: true });
}

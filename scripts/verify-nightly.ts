/** Verify the combined nightly's staged assets and platform manifests against CI output. */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ARCHES, parseFeed } from "../selfhost/src/release.ts";
import { expectedAssets, feedExpectations, verifyAssets, verifyMetadataFiles, type ReleaseAsset } from "./verify-release.ts";

const [version, sha, repository, desktopDir, serverDir, draftPath] = process.argv.slice(2);
if (!version || !sha || !repository || !desktopDir || !serverDir || !draftPath) {
	throw new Error("Usage: verify-nightly.ts VERSION SHA REPO DESKTOP_DIR SERVER_DIR DRAFT_JSON");
}
const tag = `v${version}`;
const read = (dir: string, name: string) => readFileSync(resolve(dir, name), "utf8");
const feed = parseFeed(JSON.parse(read(serverDir, "latest.json")));
if (feed.tag !== tag || feed.version !== version || feed.sha !== sha) {
	throw new Error("Nightly pointer does not identify this build");
}
const desktop = expectedAssets(version, true);
const server = ["latest.json"];
const archiveHashes = new Map<string, string>();
for (const arch of ARCHES) {
	const name = `learnharness-${version}-${arch}.tar.gz`;
	const asset = feed.assets[arch];
	if (asset?.url !== `https://github.com/${repository}/releases/download/${tag}/${name}` ||
		asset.sha256 !== read(serverDir, `${name}.sha256`).trim().split(/\s+/)[0]) {
		throw new Error(`Nightly pointer has invalid archive metadata for ${arch}`);
	}
	server.push(name, `${name}.sha256`);
	archiveHashes.set(name, asset.sha256);
}

const { id, tag_name, target_commitish, draft, prerelease, assets } = JSON.parse(readFileSync(draftPath, "utf8")) as {
	id: number;
	tag_name: string;
	target_commitish: string;
	draft: boolean;
	prerelease: boolean;
	assets?: Array<ReleaseAsset & { digest?: string }>;
};
if (tag_name !== tag || target_commitish !== sha || draft !== true || prerelease !== true || !Array.isArray(assets)) {
	throw new Error("GitHub draft does not identify this build");
}
const release = { id, tag_name, draft, assets };
const inventory = verifyAssets(release, { ...desktop, files: [...desktop.files, ...server] });
if (!inventory.ok) throw new Error(inventory.errors.join("\n"));
const metadata = Object.fromEntries(feedExpectations(desktop).map(({ file }) => [file, read(desktopDir, file)]));

// GitHub reports the SHA-256 of each uploaded asset. Compare it with the
// CI artifact, including the manifests verified above and the download maps.
for (const [dir, names] of [[desktopDir, desktop.files], [serverDir, server]] as const) {
	if (JSON.stringify(readdirSync(dir).sort()) !== JSON.stringify([...names].sort())) {
		throw new Error(`Unexpected asset inventory in ${dir}`);
	}
	for (const name of names) {
		const asset = assets.find((entry) => entry.name === name)!;
		const file = resolve(dir, name);
		const sha256 = createHash("sha256");
		const sha512 = createHash("sha512");
		for await (const chunk of createReadStream(file)) {
			sha256.update(chunk);
			sha512.update(chunk);
		}
		const digest = sha256.digest("hex");
		asset.sha512 = sha512.digest("base64");
		if (asset.size !== statSync(file).size || asset.digest !== `sha256:${digest}`) {
			throw new Error(`GitHub draft asset differs from CI output: ${name}`);
		}
		if (archiveHashes.has(name) && archiveHashes.get(name) !== digest) {
			throw new Error(`Archive checksum differs from the nightly pointer: ${name}`);
		}
	}
}
const manifests = verifyMetadataFiles(metadata, release, desktop);
if (!manifests.ok) throw new Error(manifests.errors.join("\n"));
console.log(`Verified GitHub draft for ${tag} at ${sha}: ${assets.length} assets and three desktop manifests.`);

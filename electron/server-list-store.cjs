"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { parseOrigin, validToken, ServerProblem } = require("./remote-server.cjs");

// `setUp`: the first setup has saved a default, so a later empty default (the default
// was removed) stays empty. Lists from before the field have it whenever a default is set.
// With no saved server and no default left, the list is back at first setup (owner, 2026-11-20).
const emptyList = () => ({ defaultServer: null, servers: [], setUp: false });
const settled = (list) => ({ ...list, setUp: list.setUp && (list.servers.length > 0 || list.defaultServer !== null) });

async function openServerList(file, safeStorage, platform = process.platform) {
	let state = emptyList();
	let damaged = false;
	try {
		const info = await fs.lstat(file);
		if (!info.isFile() || (platform !== "win32" && (info.mode & 0o7777) !== 0o600)) throw new Error("Invalid server list permissions.");
		const saved = JSON.parse(await fs.readFile(file, "utf8"));
		if (saved?.version !== 1 || !Array.isArray(saved.servers) ||
			saved.servers.some((entry) => !entry?.origin || entry.origin !== parseOrigin(entry.origin) || typeof entry.credential !== "string") ||
			!(saved.defaultServer === null || saved.defaultServer === "local" || saved.servers.some(({ origin }) => origin === saved.defaultServer))) {
			throw new Error("Invalid server list.");
		}
		state = settled({ ...saved, setUp: saved.setUp === true || saved.defaultServer !== null });
	} catch (error) {
		damaged = error.code !== "ENOENT";
	}

	async function save(next) {
		if (damaged) throw new Error("Reset the damaged server list first.");
		const temporary = `${file}.${randomUUID()}.tmp`;
		await fs.mkdir(path.dirname(file), { recursive: true });
		try {
			const handle = await fs.open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify({ ...next, version: 1 }));
				await handle.sync();
			} finally { await handle.close(); }
			await fs.rename(temporary, file);
			state = next;
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}
	// Opaque handles for saved pairings: the same one until that server is paired again or removed.
	const pairings = new WeakMap();
	const linux = platform === "linux";
	async function requireEncryption() {
		// On Linux the synchronous API reports which backend will actually
		// encrypt this record. Require a system keyring over the basic fallback.
		const available = linux
			? safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend() !== "basic_text"
			: await safeStorage.isAsyncEncryptionAvailable();
		if (!available) {
			throw new ServerProblem("retry", "Unlock or enable your system credential store before connecting to a remote server.");
		}
	}
	return {
		get damaged() { return damaged; },
		async reset() {
			if (!damaged) return;
			// Clear the active path without following a symlink or deleting
			// contents if a directory is occupying the file's place.
			try { await fs.rename(file, `${file}.${randomUUID()}.damaged`); }
			catch (error) { if (error.code !== "ENOENT") throw error; }
			state = emptyList();
			damaged = false;
		},
		get defaultServer() { return state.defaultServer; },
		/** Nothing set up yet, or everything removed since: the next successful setup saves the launch default. */
		get firstSetup() { return !state.setUp; },
		get origins() { return state.servers.map(({ origin }) => origin); },
		async saveDefault(server) {
			if (server !== "local" && !this.origins.includes(server)) throw new Error("Unknown server.");
			await save({ ...state, defaultServer: server, setUp: true });
		},
		requireEncryption,
		async savePairing(origin, token) {
			await requireEncryption();
			const secret = JSON.stringify({ origin, token });
			const encrypted = linux ? safeStorage.encryptString(secret) : await safeStorage.encryptStringAsync(secret);
			const credential = encrypted.toString("base64");
			const servers = state.servers.filter((saved) => saved.origin !== origin).concat({ origin, credential });
			await save({ ...state, servers });
		},
		/** The saved pairing of `origin` as an opaque handle, or null: compare it with ===. */
		pairing(origin) {
			const saved = state.servers.find((entry) => entry.origin === origin);
			if (!saved) return null;
			if (!pairings.has(saved)) pairings.set(saved, Object.freeze({}));
			return pairings.get(saved);
		},
		/** Forgets a saved server and its credential. The launch default falls back to none. */
		async remove(origin) {
			if (!this.origins.includes(origin)) return;
			await save(settled({
				...state,
				defaultServer: state.defaultServer === origin ? null : state.defaultServer,
				servers: state.servers.filter((saved) => saved.origin !== origin),
			}));
		},
		async readToken(origin) {
			const saved = state.servers.find((entry) => entry.origin === origin);
			if (!saved) throw new ServerProblem("pair", "Pair this desktop with the server first.");
			await requireEncryption();
			try {
				const bytes = Buffer.from(saved.credential, "base64");
				const result = linux ? safeStorage.decryptString(bytes) : (await safeStorage.decryptStringAsync(bytes)).result;
				const secret = JSON.parse(result);
				if (secret.origin !== origin || !validToken(secret.token)) throw new Error("Invalid credential.");
				return secret.token;
			} catch {
				throw new ServerProblem("retry", "Couldn’t read this server’s saved credential. Unlock your system credential store, then retry.");
			}
		},
	};
}

module.exports = { openServerList };

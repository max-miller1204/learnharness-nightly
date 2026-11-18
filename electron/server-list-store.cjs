"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { parseOrigin, validToken, ServerProblem } = require("./remote-server.cjs");

const emptyList = () => ({ defaultServer: null, servers: [] });

async function openServerList(file, safeStorage, platform = process.platform) {
	let state = emptyList();
	try {
		const info = await fs.lstat(file);
		if (!info.isFile() || (platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("Invalid server list permissions.");
		state = JSON.parse(await fs.readFile(file, "utf8"));
		if (state?.version !== 1 || !Array.isArray(state.servers) ||
			state.servers.some((entry) => !entry?.origin || entry.origin !== parseOrigin(entry.origin) || typeof entry.credential !== "string") ||
			!(state.defaultServer === null || state.defaultServer === "local" || state.servers.some(({ origin }) => origin === state.defaultServer))) {
			throw new Error("Invalid server list.");
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}

	async function save(next) {
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
		get defaultServer() { return state.defaultServer; },
		get origins() { return state.servers.map(({ origin }) => origin); },
		async saveDefault(server) {
			if (server !== "local" && !this.origins.includes(server)) throw new Error("Unknown server.");
			await save({ ...state, defaultServer: server });
		},
		requireEncryption,
		async savePairing(origin, token) {
			await requireEncryption();
			const secret = JSON.stringify({ origin, token });
			const encrypted = linux ? safeStorage.encryptString(secret) : await safeStorage.encryptStringAsync(secret);
			const credential = encrypted.toString("base64");
			const servers = state.servers.filter((saved) => saved.origin !== origin).concat({ origin, credential });
			await save({ defaultServer: state.defaultServer, servers });
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

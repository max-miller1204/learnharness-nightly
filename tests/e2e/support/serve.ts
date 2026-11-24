/**
 * The app the e2e runner starts (e2e.config.ts `app.command`):
 *
 *   node tests/e2e/support/serve.ts <port>
 *
 * Boots one isolated LearnHarness on 127.0.0.1:<port>. Its HOME, data folder
 * and key store live in instanceDir(port), under the OS temp folder (wiped at
 * each start), no ambient provider key reaches it (LH_IGNORE_ENV_KEYS=1),
 * the checkout's .env* files cannot redirect it (isolatedEnv), and a scripted fake model
 * (fake-model.ts) fills the Strong, Cheap and Vision slots through the same
 * API routes the Settings page uses. When the instance is usable it writes
 * state.json there (read it with instance.ts), and it stops the app
 * and the fake model when the runner stops it.
 *
 * LH_E2E_SERVER=standalone serves the production build
 * (.next/standalone/server.js from `npm run build`) instead of `next dev`.
 * LH_E2E_SCENARIO=<file> picks another fake-model scenario.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { issueSession } from "../../../selfhost/src/auth-store.ts";
import { startFakeModel } from "./fake-model.ts";
import { instanceDir, RUN_ENV, runPointer, stateFile, type InstanceState } from "./instance.ts";

const port = process.argv[2];
if (!port || !/^\d+$/.test(port)) {
	console.error("usage: node tests/e2e/support/serve.ts <port>");
	process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const mode = process.env.LH_E2E_SERVER === "standalone" ? "standalone" : "dev";
const scenario = path.resolve(root, process.env.LH_E2E_SCENARIO ?? "tests/e2e/support/scenarios/teach.json");
const dir = instanceDir(port);
const home = path.join(dir, "home");
const dataDir = path.join(dir, "data");
const authFile = path.join(dir, "auth.json");
const modelLog = path.join(dir, "model-requests.jsonl");
const appUrl = `http://127.0.0.1:${port}`;

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(authFile, "{}\n", { mode: 0o600 });
// The teaching scenario reads these files. The second has no final newline,
// so line handling that only works when a file ends in "\n" shows up.
const fixture = path.join(home, "zz-e2e-fixture.txt");
const fixtureNoNewline = path.join(home, "zz-e2e-fixture-nonl.txt");
fs.writeFileSync(fixture, "E2E-FIXTURE-SKY: Rayleigh scattering makes short (blue) wavelengths scatter most.\nzz-e2e second line.\n");
fs.writeFileSync(fixtureNoNewline, "E2E-FIXTURE-NONL: this file has no final newline.\nzz-e2e last line, nothing after it.");

const fake = await startFakeModel({ scenario, log: modelLog, vars: { FIXTURE: fixture, FIXTURE_NONL: fixtureNoNewline } });

let server: [string, ...string[]];
if (mode === "standalone") {
	const entry = path.join(root, ".next/standalone/server.js");
	if (!fs.existsSync(entry)) {
		console.error(`serve: no production build at ${entry}. Run \`npm run build && node scripts/build-server.mjs\` first.`);
		process.exit(1);
	}
	server = [process.execPath, entry];
} else {
	// `npm run dev` builds the core plugins and the authoring package first; so does this.
	for (const script of ["plugins:build-core", "plugins:build-authoring"]) {
		const built = spawnSync("npm", ["run", "--silent", script], { cwd: root, stdio: "inherit" });
		if (built.status !== 0) process.exit(built.status ?? 1);
	}
	server = [process.execPath, path.join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", port];
}

// `next dev` loads the checkout's .env* files, and a variable passed to the
// process wins over them. So every variable that could point the instance at
// real data, a real install or a real account is set here, to an isolated
// value or to empty/off, even when this file does not need it: a .env.local
// then changes nothing. Add a variable here when the app starts reading one.
const isolatedEnv: Record<string, string> = {
	// Where the instance keeps its data.
	LH_DATA_DIR: dataDir,
	LH_AUTH_FILE: authFile,
	LH_HOME: path.join(dir, "lh-home"),
	XDG_CONFIG_HOME: path.join(home, ".config"),
	CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
	// Never the self-hosted server, a desktop-shell child or a running launcher.
	LH_SELFHOST: "0",
	LH_DESKTOP_SERVER: "0",
	LH_DESKTOP_API_SECRET: "",
	LH_LAUNCHER_PROTOCOL: "",
	LH_TRIAL_UPDATE_ID: "",
	LH_FEED_URL: "",
	LH_BIN_DIR: "",
	LH_SERVICE_NAME: "",
	LH_DEV_URL: "",
	// No ambient provider key, and no diagnostic capture of what the model sees.
	LH_IGNORE_ENV_KEYS: "1",
	LH_PROVIDER_EVENTS: "",
	LH_BACKGROUND_CAPTURE: "",
	// Nothing that changes how Node or a browser binary is found.
	NODE_OPTIONS: "",
	CHROME_PATH: "",
};

const app: ChildProcess = spawn(server[0], server.slice(1), {
	cwd: mode === "standalone" ? path.join(root, ".next/standalone") : root,
	// Its own process group, so stopping it also stops the server Next forks.
	detached: true,
	stdio: ["ignore", "inherit", "inherit"],
	// Next types NODE_ENV as always set; `next dev` sets it itself.
	env: {
		PATH: process.env.PATH,
		HOME: home,
		LANG: "C.UTF-8",
		TMPDIR: process.env.TMPDIR,
		...(mode === "standalone" ? { NODE_ENV: "production" } : {}),
		HOSTNAME: "127.0.0.1",
		PORT: port,
		NEXT_TELEMETRY_DISABLED: "1",
		...isolatedEnv,
	} as NodeJS.ProcessEnv,
});

let stopping = false;
async function stop(code: number) {
	if (stopping) return;
	stopping = true;
	if (app.pid && app.exitCode === null) {
		try { process.kill(-app.pid, "SIGTERM"); } catch { /* already gone */ }
		const deadline = Date.now() + 10_000;
		while (app.exitCode === null && app.signalCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		try { process.kill(-app.pid, "SIGKILL"); } catch { /* already gone */ }
	}
	await fake.close();
	process.exit(code);
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void stop(0));
app.on("exit", (code) => {
	if (stopping) return;
	console.error(`serve: the app exited (${code ?? "signal"})`);
	void stop(1);
});

async function until(what: string, timeoutMs: number, check: () => Promise<boolean>) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check().catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 500));
	}
	console.error(`serve: ${what} not within ${timeoutMs / 1000}s`);
	await stop(1);
}
await until("/api/health answering", 180_000, async () => (await fetch(`${appUrl}/api/health`)).ok);

// Seed the fake model the way Settings does, signed in as a hidden CLI session.
const { token } = issueSession(dataDir, { method: "cli", hidden: true, ttlMs: 3600_000, client: { label: "e2e seed", deviceType: "bot" } });
const api = (route: string, init: RequestInit = {}) => fetch(`${appUrl}${route}`, {
	...init,
	headers: { authorization: `Bearer ${token}`, origin: appUrl, "content-type": "application/json", ...init.headers },
});
async function seed() {
	const current = await api("/api/custom-provider");
	const etag = current.headers.get("etag");
	if (!current.ok || !etag) throw new Error(`GET /api/custom-provider: ${current.status}, etag ${etag}`);
	const connect = await api("/api/custom-provider", { method: "POST", headers: { "if-match": etag }, body: JSON.stringify({ baseUrl: fake.url, authMode: "keyless" }) });
	if (!connect.ok) throw new Error(`connect the fake model: ${connect.status} ${await connect.text()}`);
	const slot = (id: string) => ({ model: { provider: "custom", id } });
	const put = await api("/api/settings/models", { method: "PUT", body: JSON.stringify({ strong: slot("e2e-strong"), cheap: slot("e2e-cheap"), vision: slot("e2e-vision") }) });
	if (!put.ok) throw new Error(`PUT /api/settings/models: ${put.status} ${await put.text()}`);
	const models = JSON.stringify(await (await api("/api/models")).json());
	for (const id of ["e2e-strong", "e2e-cheap", "e2e-vision"]) if (!models.includes(id)) throw new Error(`/api/models has no ${id}: ${models.slice(0, 300)}`);
}
try {
	await seed();
} catch (error) {
	console.error("serve: seeding the fake model failed:", error);
	await stop(1);
}

// `next dev` compiles a page and its client chunks when first asked, and a
// browser that gets there first sees Fast Refresh reload the page under a test
// (a typed pairing code vanishes). Load the pages the tests open, and the
// scripts they name, once before declaring the instance ready.
async function warm(route: string, headers: Record<string, string> = {}) {
	const html = await (await fetch(`${appUrl}${route}`, { headers, redirect: "manual" })).text();
	const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1] as string);
	await Promise.all(scripts.map((src) => fetch(new URL(src, appUrl), { headers }).then((r) => r.arrayBuffer())));
}
if (mode === "dev") {
	for (const route of ["/pair", "/chat/new", "/chat/chat_zzwarmup"]) await warm(route, route === "/pair" ? {} : { authorization: `Bearer ${token}` }).catch(() => {});
}

const state: InstanceState = { appUrl, mode, dataDir, home, authFile, modelLog, fixture, fixtureNoNewline, fakeModel: fake.url, fakeControl: fake.control, scenario };
fs.writeFileSync(stateFile(port), `${JSON.stringify(state, null, 2)}\n`);
// Last, so a reader that finds the pointer finds a usable instance.
if (process.env[RUN_ENV]) fs.writeFileSync(runPointer(process.env[RUN_ENV]), `${JSON.stringify({ port })}\n`);
console.log(`serve: ready (${mode}) at ${appUrl}, state in ${stateFile(port)}`);

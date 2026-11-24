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
 * LH_E2E_FIXTURES=<dir>,<dir> copies each folder's chat_*.json and job_*.json
 * into the data folder before the app starts (tests/fixtures/mobile-lesson).
 * LH_E2E_TLS_PORT=<port> also serves the app over https on 127.0.0.1:<port>
 * for the phone app, which accepts only https servers. The CA and the
 * certificate (scripts/iphone-check/tls-cert.sh) live in a private folder made
 * for this launch; the CA's key is deleted once the certificate is signed, the
 * certificate's key once the proxy (tls-front.mjs) answers over https with
 * this CA, and the folder when the instance stops or fails to start.
 * state.json names the address and the CA file. With LH_E2E_IOS_DEVICE (a
 * simulator ios.sh created, checked by ios-device.ts) it also trusts that CA
 * in the simulator and installs the app at LH_E2E_IOS_APP.
 *
 * Everything this process starts is registered for cleanup before it starts, so
 * a failure at any step, or a signal, stops what is already running.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as https from "node:https";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { issueSession } from "../../../selfhost/src/auth-store.ts";
import { startFakeModel } from "./fake-model.ts";
import { provisionSimulator } from "./ios-device.ts";
import { phoneBundleId } from "./phone-config.ts";
import { instanceDir, LAUNCH_ID_ENV, publishLaunch, stateFile, unpublishLaunch, type InstanceState } from "./instance.ts";

const port = process.argv[2];
if (!port || !/^\d+$/.test(port)) {
	console.error("usage: node tests/e2e/support/serve.ts <port>");
	process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const mode = process.env.LH_E2E_SERVER === "standalone" ? "standalone" : "dev";
const scenario = path.resolve(root, process.env.LH_E2E_SCENARIO ?? "tests/e2e/support/scenarios/teach.json");
// The launch this instance serves (e2e.config.ts); a hand start has none.
const launchId = process.env[LAUNCH_ID_ENV];
if (launchId && !/^[0-9a-f-]{36}$/.test(launchId)) {
	console.error(`serve: ${LAUNCH_ID_ENV} is not a launch id`);
	process.exit(2);
}

// What this process has started, undone in reverse order by stop(): registered before
// the thing it undoes starts, so a failure or a signal at any step leaves nothing behind.
const cleanups: Array<() => void | Promise<void>> = [];
let stopping = false;
async function stop(code: number): Promise<never> {
	if (!stopping) {
		stopping = true;
		for (const undo of cleanups.reverse()) await Promise.resolve(undo()).catch(() => {});
	}
	process.exit(code);
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void stop(0));
async function fail(message: string): Promise<never> {
	console.error(`serve: ${message}`);
	return stop(1);
}

const dir = instanceDir(port);
const home = path.join(dir, "home");
const dataDir = path.join(dir, "data");
const authFile = path.join(dir, "auth.json");
const modelLog = path.join(dir, "model-requests.jsonl");
const appUrl = `http://127.0.0.1:${port}`;

const alive = (pid: unknown) => { try { process.kill(Number(pid), 0); return Number.isInteger(pid) && pid !== process.pid; } catch { return false; } };
// A live instance on this port keeps its folder: a second start never wipes it.
try {
	const running = (JSON.parse(fs.readFileSync(stateFile(port), "utf8")) as { pid?: number }).pid;
	if (alive(running)) await fail(`port ${port} already belongs to a live instance (serve.ts pid ${running}); its folder ${dir} is left alone`);
} catch { /* no state.json, or half written */ }
// One `next dev` per checkout: its build folder (.next/dev) is locked by the first.
if (mode === "dev") {
	const lock = path.join(os.tmpdir(), "learnharness-e2e", `dev-${createHash("sha1").update(root).digest("hex").slice(0, 12)}.lock`);
	fs.mkdirSync(path.dirname(lock), { recursive: true });
	for (let attempt = 0; ; attempt++) {
		try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); break; } catch {
			const holder = Number(fs.readFileSync(lock, "utf8"));
			if (alive(holder)) await fail(`another \`next dev\` of this checkout (serve.ts pid ${holder}) is running; start only one, or serve the production build with LH_E2E_SERVER=standalone`);
			if (attempt > 2) await fail(`cannot take ${lock}`);
			fs.rmSync(lock, { force: true });
		}
	}
	cleanups.push(() => { if (fs.readFileSync(lock, "utf8") === String(process.pid)) fs.rmSync(lock, { force: true }); });
}
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
// Session records and research jobs a test opens instead of teaching one first.
for (const folder of (process.env.LH_E2E_FIXTURES ?? "").split(",").filter(Boolean)) {
	for (const [prefix, target] of [["chat_", "chats"], ["job_", "jobs"]] as const) {
		for (const file of fs.readdirSync(path.resolve(root, folder)).filter((name) => name.startsWith(prefix) && name.endsWith(".json"))) {
			fs.mkdirSync(path.join(dataDir, target), { recursive: true });
			fs.copyFileSync(path.resolve(root, folder, file), path.join(dataDir, target, file));
		}
	}
}

// A 1x1 PNG, for tests that put an image snapshot in a session record.
const fixtureImage = path.join(home, "zz-e2e-image.png");
fs.writeFileSync(fixtureImage, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

const fake = await startFakeModel({ scenario, log: modelLog, vars: { FIXTURE: fixture, FIXTURE_NONL: fixtureNoNewline } });
cleanups.push(() => fake.close());

let server: [string, ...string[]];
if (mode === "standalone") {
	const entry = path.join(root, ".next/standalone/server.js");
	if (!fs.existsSync(entry)) {
		await fail(`no production build at ${entry}. Run \`npm run build && node scripts/build-server.mjs\` first.`);
	}
	server = [process.execPath, entry];
} else {
	// `npm run dev` builds the core plugins and the authoring package first; so does this.
	for (const script of ["plugins:build-core", "plugins:build-authoring"]) {
		const built = spawnSync("npm", ["run", "--silent", script], { cwd: root, stdio: "inherit" });
		if (built.status !== 0) await stop(built.status ?? 1);
	}
	server = [process.execPath, path.join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", port];
}

// `next dev` loads the checkout's .env* files, and a variable passed to the
// process wins over them, an empty one included. So every key any of those
// files defines is passed empty (found with the loader Next itself uses, not
// from a list), and the variables that could point the instance at real data,
// a real install or a real account are set below to an isolated value or to
// empty/off even when no file defines them.
function checkoutEnvKeys(dirs: string[]): string[] {
	const { loadEnvConfig, resetEnv } = createRequire(path.join(root, "node_modules/next/package.json"))("@next/env") as {
		loadEnvConfig(dir: string, dev: boolean, log: { info(): void; error(): void }, forceReload: boolean): { loadedEnvFiles: Array<{ env: Record<string, string | undefined> }> };
		resetEnv(): void;
	};
	const quiet = { info() {}, error() {} };
	const keys = new Set<string>();
	const nodeEnv = process.env.NODE_ENV;
	// Which files load depends on NODE_ENV and the dev flag, so ask for each combination.
	for (const [env, dev] of [["development", true], ["production", false], ["test", false]] as const) {
		process.env.NODE_ENV = env;
		for (const dir of dirs) for (const file of loadEnvConfig(dir, dev, quiet, true).loadedEnvFiles) for (const key of Object.keys(file.env)) keys.add(key);
	}
	resetEnv();
	if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
	keys.delete("NODE_ENV");
	return [...keys];
}
const blankedEnv: Record<string, string> = Object.fromEntries(checkoutEnvKeys([root, path.join(root, ".next/standalone")]).map((key) => [key, ""]));
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

// TLS in front of the app, for the phone: a CA and a certificate for 127.0.0.1 in a folder
// private to this launch, made before anything else starts so a failure here leaves nothing running.
const tlsPort = process.env.LH_E2E_TLS_PORT;
let tls: InstanceState["tls"];
let tlsDir = "";
if (tlsPort) {
	if (!/^\d+$/.test(tlsPort) || tlsPort === port) await fail(`LH_E2E_TLS_PORT is not a port other than the app's: ${tlsPort}`);
	fs.mkdirSync(path.join(os.tmpdir(), "learnharness-e2e"), { recursive: true });
	tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "learnharness-e2e", "tls-"));
	cleanups.push(() => fs.rmSync(tlsDir, { recursive: true, force: true }));
	const made = spawnSync("bash", [path.join(root, "scripts/iphone-check/tls-cert.sh"), tlsDir], { stdio: ["ignore", "ignore", "inherit"] });
	if (made.status !== 0) await fail("the TLS certificate could not be made");
	// The CA signed the certificate; nothing may sign with it again.
	for (const name of ["ca.key", "ca.srl", "server.csr", "openssl.cnf"]) fs.rmSync(path.join(tlsDir, name), { force: true });
	tls = { url: `https://127.0.0.1:${tlsPort}`, ca: path.join(tlsDir, "ca.pem") };
}

const app: ChildProcess = spawn(server[0], server.slice(1), {
	cwd: mode === "standalone" ? path.join(root, ".next/standalone") : root,
	// Its own process group, so stopping it also stops the server Next forks.
	detached: true,
	stdio: ["ignore", "pipe", "pipe"],
	// Next types NODE_ENV as always set; `next dev` sets it itself.
	env: {
		...blankedEnv,
		// Concrete values: an undefined one would let the checkout's .env file supply it.
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: home,
		LANG: "C.UTF-8",
		TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
		...(mode === "standalone" ? { NODE_ENV: "production" } : {}),
		HOSTNAME: "127.0.0.1",
		PORT: port,
		NEXT_TELEMETRY_DISABLED: "1",
		...isolatedEnv,
	} as NodeJS.ProcessEnv,
});
cleanups.push(async () => {
	if (app.pid && app.exitCode === null) {
		try { process.kill(-app.pid, "SIGTERM"); } catch { /* already gone */ }
		const deadline = Date.now() + 10_000;
		while (app.exitCode === null && app.signalCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		try { process.kill(-app.pid, "SIGKILL"); } catch { /* already gone */ }
	}
});
app.on("exit", (code) => {
	if (stopping) return;
	console.error(`serve: the app exited (${code ?? "signal"})`);
	void stop(1);
});

// The app's output passes through with pairing codes redacted: the app prints
// a startup pairing link, and the runner quotes this output in its errors and traces.
function passThrough(from: NodeJS.ReadableStream, to: NodeJS.WritableStream) {
	let pending = "";
	const write = (line: string) => to.write(line.replace(/#token=[^\s&"')]+/g, "#token=<redacted>"));
	from.setEncoding?.("utf8");
	from.on("data", (chunk: string) => {
		pending += chunk;
		const end = pending.lastIndexOf("\n");
		if (end < 0) return;
		write(pending.slice(0, end + 1));
		pending = pending.slice(end + 1);
	});
	from.on("end", () => { if (pending) write(pending); });
}
passThrough(app.stdout!, process.stdout);
passThrough(app.stderr!, process.stderr);

// The proxy that ends TLS. If it dies the phone has no server, so the instance stops.
if (tls) {
	const front: ChildProcess = spawn(process.execPath, [path.join(root, "scripts/iphone-check/tls-front.mjs"), tlsPort!, port, path.join(tlsDir, "cert.pem"), path.join(tlsDir, "key.pem")], { stdio: ["ignore", "inherit", "inherit"] });
	cleanups.push(() => { front.kill(); });
	front.on("exit", (code, signal) => {
		if (stopping) return;
		console.error(`serve: the TLS proxy exited (${code ?? signal})`);
		void stop(1);
	});
}

async function until(what: string, timeoutMs: number, check: () => Promise<boolean>) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check().catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 500));
	}
	await fail(`${what} not within ${timeoutMs / 1000}s`);
}
await until("/api/health answering", 180_000, async () => (await fetch(`${appUrl}/api/health`)).ok);
if (tls) {
	// Over https, verified against this launch's CA only: another listener on the port cannot pass.
	const ca = fs.readFileSync(tls.ca);
	await until("/api/health over https with this launch's CA", 20_000, () => new Promise<boolean>((resolve) => {
		const request = https.get({ host: "127.0.0.1", port: Number(tlsPort), path: "/api/health", ca, timeout: 5_000 }, (response) => { response.resume(); resolve(response.statusCode === 200); });
		request.on("error", () => resolve(false));
		request.on("timeout", () => { request.destroy(); resolve(false); });
	}));
	// The proxy has the certificate's key in memory; the files are not needed again.
	for (const name of ["cert.pem", "key.pem"]) fs.rmSync(path.join(tlsDir, name), { force: true });
	if (process.env.LH_E2E_IOS_DEVICE) {
		const appPath = process.env.LH_E2E_IOS_APP;
		if (!appPath) await fail("LH_E2E_IOS_APP is not set");
		try { provisionSimulator({ udid: process.env.LH_E2E_IOS_DEVICE, ca: tls.ca, appPath: appPath!, bundleId: phoneBundleId }); } catch (error) { await fail(`the simulator could not be prepared: ${error instanceof Error ? error.message : error}`); }
	}
}

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
	await fail(`seeding the fake model failed: ${error instanceof Error ? error.message : error}`);
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

const state: InstanceState = { appUrl, mode, dataDir, home, authFile, modelLog, fixture, fixtureNoNewline, fixtureImage, fakeModel: fake.url, fakeControl: fake.control, scenario, tls, ...(launchId ? { launchId } : {}), pid: process.pid };
fs.writeFileSync(stateFile(port), `${JSON.stringify(state, null, 2)}\n`);
// Last, so a reader that finds the record finds a usable instance.
if (launchId) { cleanups.push(() => unpublishLaunch(launchId)); publishLaunch(launchId, port); }
console.log(`serve: ready (${mode}) at ${appUrl}, state in ${stateFile(port)}`);

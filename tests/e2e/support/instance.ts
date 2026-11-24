/**
 * What a test knows about the instance serve.ts started for this run: its
 * data folder, the fake model's request log and control URL, the fixture
 * files. Keyed by the app's port, which `app.baseUrl` carries.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPairingLink, formatCode } from "../../../selfhost/src/auth-store.ts";

export type InstanceState = {
	appUrl: string;
	mode: "dev" | "standalone";
	dataDir: string;
	home: string;
	authFile: string;
	modelLog: string;
	fixture: string;
	fixtureNoNewline: string;
	/** A 1x1 PNG, for a test that puts an image snapshot in a session record. */
	fixtureImage: string;
	fakeModel: string;
	fakeControl: string;
	scenario: string;
	/** The launch this instance serves (LAUNCH_ID_ENV), when started by the config. */
	launchId?: string;
	/** serve.ts's pid. */
	pid: number;
	/** Set when serve.ts ran with LH_E2E_TLS_PORT: the https address in front of the app and the CA file that signs it (its key is gone). */
	tls?: { url: string; ca: string };
};

/** Outside the checkout: `next dev` reloads the page when a file under it changes. */
export const instanceDir = (port: string) => path.join(os.tmpdir(), "learnharness-e2e", port);
export const stateFile = (port: string) => path.join(instanceDir(port), "state.json");

/**
 * One launch's id, shared by the config's `app.command` (as LH_E2E_LAUNCH_ID)
 * and the `pairing-code` secret provider, which has no `app.baseUrl` to find
 * its instance by. serve.ts records its port and pid under the id once the
 * instance is usable and removes the record when it stops.
 */
export const LAUNCH_ID_ENV = "LH_E2E_LAUNCH_ID";
/** The environment variable that hands the id from a process that evaluated the config to the ones it starts. */
export const LAUNCH_HANDOFF_ENV = "LH_E2E_LAUNCH";
const LAUNCH_ID = /^[0-9a-f-]{36}$/;
export const launchPointer = (id: string) => {
	if (!LAUNCH_ID.test(id)) throw new Error(`not a launch id: ${id}`);
	return path.join(os.tmpdir(), "learnharness-e2e", `launch-${id}.json`);
};

/**
 * The id for the config being evaluated. The runner evaluates the config and
 * starts the app; its workers evaluate it again and must use the runner's id,
 * so the id is handed down in LH_E2E_LAUNCH as `<pid>:<id>`. A second
 * evaluation in the same process (one `e2e mcp` server opening two sessions)
 * is a different launch and gets its own id.
 */
export function launchIdForConfig(): string {
	const [owner, inherited] = (process.env[LAUNCH_HANDOFF_ENV] ?? "").split(":");
	if (owner && inherited && Number(owner) !== process.pid && LAUNCH_ID.test(inherited)) return inherited;
	const id = randomUUID();
	process.env[LAUNCH_HANDOFF_ENV] = `${process.pid}:${id}`;
	return id;
}

/** Publishes `{ port, pid }` for a launch, whole or not at all (the record is renamed into place). */
export function publishLaunch(id: string, port: string) {
	const file = launchPointer(id);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ port, pid: process.pid })}\n`);
	fs.renameSync(`${file}.tmp`, file);
}
/** Removes the record of launch `id`, but only a record this process published: another instance's is left alone. */
export function unpublishLaunch(id: string) {
	const file = launchPointer(id);
	let owner: number | undefined;
	try { owner = (JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number }).pid; } catch { /* no record, or half written */ }
	if (owner === process.pid) fs.rmSync(file, { force: true });
	fs.rmSync(`${file}.tmp`, { force: true });
}

/** The id of the launch this process belongs to, as handed down by the runner (LAUNCH_HANDOFF_ENV). */
export function currentLaunchId(): string {
	const inherited = (process.env[LAUNCH_HANDOFF_ENV] ?? "").split(":")[1];
	if (!inherited || !LAUNCH_ID.test(inherited)) throw new Error(`${LAUNCH_HANDOFF_ENV} is not set: this process was not started by a run of e2e.config.ts`);
	return inherited;
}

/**
 * The instance of launch `id`, found through its launch record and checked
 * against its state.json: a stale record, a reused pid or a reused port never
 * resolves to another instance.
 */
export async function launchedInstance(id: string): Promise<InstanceState> {
	const file = launchPointer(id);
	const deadline = Date.now() + 120_000;
	while (!fs.existsSync(file)) {
		if (Date.now() > deadline) throw new Error(`no instance for launch ${id}: serve.ts did not finish starting (see .e2e/logs/app.log)`);
		await new Promise((r) => setTimeout(r, 250));
	}
	const { port, pid } = JSON.parse(fs.readFileSync(file, "utf8")) as { port: string; pid: number };
	try { process.kill(pid, 0); } catch { throw new Error(`the instance of launch ${id} (serve.ts pid ${pid}) is no longer running`); }
	const state = await instance(`http://127.0.0.1:${port}`);
	if (state.launchId !== id || state.pid !== pid) throw new Error(`the instance on port ${port} is not launch ${id} (it serves ${state.launchId ?? "no launch"}, pid ${state.pid})`);
	return state;
}

/**
 * A fresh one-time pairing code for the instance of launch `id`, as the
 * pairing screen shows it. Backs the `pairing-code` secret in e2e.config.ts, so a
 * test fills it as a secret handle and the code never reaches a report or a
 * trace. A provider runs on every fill, so each fill gets its own code.
 */
export async function pairingCode(id: string): Promise<string> {
	const state = await launchedInstance(id);
	return formatCode(createPairingLink(state.dataDir, { label: "e2e" }).code);
}

/**
 * The `ios` target's server is a second launch of the same run: its id is
 * derived from the run's (last hex digit swapped), so the runner, the workers
 * and the secret provider, which all evaluate the config, agree on it without
 * a handoff of their own.
 */
export const phoneLaunchId = (id: string) => `${id.slice(0, -1)}${id.endsWith("0") ? "1" : "0"}`;

/** The instance behind `baseUrl`, once serve.ts has finished seeding it. */
export async function instance(baseUrl: string, timeoutMs = 120_000): Promise<InstanceState> {
	const file = stateFile(new URL(baseUrl).port);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(file)) {
		if (Date.now() > deadline) throw new Error(`no ${file}: serve.ts did not finish starting (see .e2e/logs/app.log)`);
		await new Promise((r) => setTimeout(r, 250));
	}
	return JSON.parse(fs.readFileSync(file, "utf8")) as InstanceState;
}

export type ModelRequest = {
	n: number;
	rule: string;
	request: { messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> };
	reply: { text?: string; toolCalls?: unknown[] };
};

/** Every chat request the app has sent the fake model, oldest first. */
export function modelRequests(state: InstanceState): ModelRequest[] {
	if (!fs.existsSync(state.modelLog)) return [];
	return fs.readFileSync(state.modelLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ModelRequest);
}

/** The requests of one session: the ones whose first user message holds `goal`. */
export function sessionRequests(state: InstanceState, goal: string): ModelRequest[] {
	return modelRequests(state).filter((r) => {
		const first = r.request.messages?.find((m) => m.role === "user");
		return JSON.stringify(first?.content ?? "").includes(goal);
	});
}

/**
 * The question the tutor asked (its `probe` tool call) and the tool results persisted for
 * it, from the stored record. One answer is exactly one result; a double submit stored
 * twice shows as two, whatever the model was sent.
 */
export function probeResults(state: InstanceState, chatId: string): { toolCallId: string | undefined; results: unknown[] } {
	type Part = { type?: string; name?: string; id?: string };
	const messages = (storedChat(state, chatId).messages ?? []) as Array<{ role?: string; content?: unknown; toolCallId?: string }>;
	const asked = messages
		.flatMap((message) => (message.role === "assistant" && Array.isArray(message.content) ? (message.content as Part[]) : []))
		.find((part) => part.type === "toolCall" && part.name === "probe");
	return { toolCallId: asked?.id, results: messages.filter((message) => message.role === "toolResult" && message.toolCallId === asked?.id) };
}

/** A stored session record, as the server wrote it to disk. */
export function storedChat(state: InstanceState, chatId: string): { messages?: unknown[] } & Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(state.dataDir, "chats", `${chatId}.json`), "utf8"));
}

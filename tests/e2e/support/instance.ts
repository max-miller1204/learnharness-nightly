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
	fakeModel: string;
	fakeControl: string;
	scenario: string;
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
	fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ port, pid: process.pid })}\n`);
	fs.renameSync(`${file}.tmp`, file);
}
export function unpublishLaunch(id: string) {
	fs.rmSync(launchPointer(id), { force: true });
	fs.rmSync(`${launchPointer(id)}.tmp`, { force: true });
}

/**
 * A fresh one-time pairing code for the instance of launch `id`, as the
 * pairing screen shows it. Backs the `pairing-code` secret in e2e.config.ts, so a
 * test fills it as a secret handle and the code never reaches a report or a
 * trace. A provider runs on every fill, so each fill gets its own code.
 */
export async function pairingCode(id: string): Promise<string> {
	const file = launchPointer(id);
	const deadline = Date.now() + 120_000;
	while (!fs.existsSync(file)) {
		if (Date.now() > deadline) throw new Error(`no instance for launch ${id}: serve.ts did not finish starting (see .e2e/logs/app.log)`);
		await new Promise((r) => setTimeout(r, 250));
	}
	const { port, pid } = JSON.parse(fs.readFileSync(file, "utf8")) as { port: string; pid: number };
	try { process.kill(pid, 0); } catch { throw new Error(`the instance of launch ${id} (serve.ts pid ${pid}) is no longer running`); }
	const state = await instance(`http://127.0.0.1:${port}`);
	return formatCode(createPairingLink(state.dataDir, { label: "e2e" }).code);
}

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

/** A stored session record, as the server wrote it to disk. */
export function storedChat(state: InstanceState, chatId: string): { messages?: unknown[] } & Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(state.dataDir, "chats", `${chatId}.json`), "utf8"));
}

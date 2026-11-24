/**
 * What a test knows about the instance serve.ts started for this run: its
 * data folder, the fake model's request log and control URL, the fixture
 * files. Keyed by the app's port, which `app.baseUrl` carries.
 */
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
 * One run's id. e2e.config.ts sets it once when the runner loads the config;
 * the runner's workers and serve.ts (through `inheritEnv`) inherit it. serve.ts
 * records the port it got under it, so a secret provider, which has no
 * `app.baseUrl`, can find the run's instance.
 */
export const RUN_ENV = "LH_E2E_RUN";
export const runPointer = (run: string) => path.join(os.tmpdir(), "learnharness-e2e", `run-${run}.json`);

/**
 * A fresh one-time pairing code for this run's instance, as the pairing
 * screen shows it. Backs the `pairing-code` secret in e2e.config.ts, so a
 * test fills it as a secret handle and the code never reaches a report or a
 * trace. A provider runs on every fill, so each fill gets its own code.
 */
export async function pairingCode(): Promise<string> {
	const run = process.env[RUN_ENV];
	if (!run) throw new Error(`${RUN_ENV} is not set: tests/e2e/support/instance.ts needs e2e.config.ts to have loaded`);
	const deadline = Date.now() + 120_000;
	while (!fs.existsSync(runPointer(run))) {
		if (Date.now() > deadline) throw new Error(`no instance for run ${run}: serve.ts did not finish starting (see .e2e/logs/app.log)`);
		await new Promise((r) => setTimeout(r, 250));
	}
	const { port } = JSON.parse(fs.readFileSync(runPointer(run), "utf8")) as { port: string };
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

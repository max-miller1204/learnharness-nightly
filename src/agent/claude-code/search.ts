import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { externalCliEnv } from "../../core/auth-env.ts";
import { isWebSourceUrl } from "../../core/contracts/jobs.ts";
import type { SearchHit } from "../../core/search.ts";
import { getClaudeBinary } from "./binary.ts";
import { createClaudeLauncher } from "./launch.ts";
import type { RunClaude } from "./stream.ts";

/** The signed-in CLI account as `claude auth status --json` reports it.
 * Only non-secret identity fields; the CLI never returns credentials here. */
export interface ClaudeAccount {
	label: string;
	/** Non-secret binding for the search selection: changes with the account. */
	selection: string;
	/** A claude.ai subscription sign-in (plan usage), not an API account. */
	plan: boolean;
	method: string;
}

export type ReadClaudeAuthStatus = (binary: string) => Promise<string>;

/** No shell. The command exits non-zero when signed out, still printing JSON. */
export const readClaudeAuthStatus: ReadClaudeAuthStatus = (binary) => new Promise((resolve, reject) => {
	execFile(binary, ["auth", "status", "--json"], {
		cwd: tmpdir(), env: externalCliEnv(), windowsHide: true,
		timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 16_384,
	}, (error, stdout) => stdout.trim() ? resolve(stdout) : reject(error ?? new Error("empty auth status")));
});

const text = (value: unknown, max = 200) => typeof value === "string" ? value.trim().slice(0, max) : "";
const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Null when signed out or unreadable. */
export function parseClaudeAccount(stdout: string): ClaudeAccount | null {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(stdout) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object" || raw.loggedIn !== true) return null;
	const email = text(raw.email);
	const method = text(raw.authMethod, 60) || "an unknown sign-in method";
	const subscription = text(raw.subscriptionType, 40);
	const plan = raw.authMethod === "claude.ai" && !!subscription;
	const detail = plan ? `Claude ${capitalized(subscription)}` : method;
	const selection = createHash("sha256")
		.update(JSON.stringify([email, text(raw.orgId), text(raw.authMethod), text(raw.apiProvider)]))
		.digest("hex")
		.slice(0, 32);
	return { label: `${email || "Claude Code account"} · ${detail}`, selection, plan, method };
}

export async function inspectClaudeAccount(
	findBinary: () => string | null = getClaudeBinary,
	read: ReadClaudeAuthStatus = readClaudeAuthStatus,
): Promise<ClaudeAccount | null> {
	const binary = findBinary();
	if (!binary) return null;
	try {
		return parseClaudeAccount(await read(binary));
	} catch {
		return null;
	}
}

const SYSTEM_PROMPT = "Search the web for the user's query with the WebSearch tool, then reply with one short line. Do not answer from memory.";
/** The documented headless exception to the --tools restriction. */
const PERMITTED_TOOLS = new Set(["WebSearch", "EndConversation"]);
const TIMEOUT_MS = 60_000;

export const NOT_SIGNED_IN = "Claude Code is not signed in. Run `claude auth login` in a terminal on the LearnHarness server, then reselect Claude Code in Settings → Agent → Tools.";

export function claudeSearchArgs(): string[] {
	return [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--model",
		"haiku",
		"--effort",
		"low",
		"--system-prompt",
		SYSTEM_PROMPT,
		"--tools",
		"WebSearch",
		"--allowedTools",
		"WebSearch",
		"--strict-mcp-config",
		"--setting-sources",
		"user",
		"--settings",
		JSON.stringify({ disableAllHooks: true, outputStyle: "default", env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } }),
		"--disable-slash-commands",
		"--no-session-persistence",
		"--permission-prompts",
		"none",
	];
}

type Line = {
	type?: string;
	subtype?: string;
	tools?: unknown;
	error?: unknown;
	is_error?: boolean;
	result?: unknown;
	errors?: unknown;
	message?: { content?: { type?: string; name?: string; content?: unknown; is_error?: boolean }[] };
	tool_use_result?: { results?: unknown };
};

type Link = { title?: unknown; url?: unknown };

const resultText = (content: unknown): string => typeof content === "string"
	? content.trim()
	: Array.isArray(content) ? content.map((part: { text?: unknown }) => text(part?.text, Infinity)).join("\n") : "";

/** Native WebSearch links: the structured tool result, else the CLI's
 * `Links: [...]` line that the model itself received. */
function resultLinks(line: Line): Link[] {
	const results = line.tool_use_result?.results;
	if (Array.isArray(results)) {
		return results.flatMap((entry) => entry && typeof entry === "object" && Array.isArray((entry as { content?: unknown }).content)
			? (entry as { content: Link[] }).content
			: []);
	}
	const links: Link[] = [];
	for (const block of Array.isArray(line.message?.content) ? line.message.content : []) {
		if (block?.type !== "tool_result" || block.is_error) continue;
		const body = resultText(block.content);
		const match = /^Links: (\[.*\])$/m.exec(body);
		if (!match) continue;
		try {
			const parsed: unknown = JSON.parse(match[1]!);
			if (Array.isArray(parsed)) links.push(...(parsed as Link[]));
		} catch { /* not native links */ }
	}
	return links;
}

/** Folds the CLI's stream-json lines into hits; throws the actionable failure. */
export class ClaudeSearchCollector {
	private readonly hits = new Map<string, SearchHit>();
	private searched = false;
	private initialized = false;
	private toolError: string | undefined;
	private failure: string | undefined;

	constructor(private readonly count: number) {}

	/** Returns a failure that must stop the process at once. */
	add(raw: string): string | undefined {
		let line: Line;
		try {
			line = JSON.parse(raw) as Line;
		} catch {
			return;
		}
		if (!line || typeof line !== "object") return;
		if (line.type === "system" && line.subtype === "init") {
			this.initialized = true;
			const tools = Array.isArray(line.tools) ? line.tools : [];
			const extra = tools.filter((tool) => typeof tool !== "string" || !PERMITTED_TOOLS.has(tool));
			if (extra.length || !tools.includes("WebSearch")) {
				return this.failure = "Claude Code did not restrict this search to the WebSearch tool, so LearnHarness stopped it. Check managed settings or plugins in Claude Code.";
			}
		}
		if (line.type === "assistant") {
			if (line.error === "authentication_failed") return this.failure = NOT_SIGNED_IN;
			const content = Array.isArray(line.message?.content) ? line.message.content : [];
			if (content.some((block) => block?.type === "tool_use" && block.name === "WebSearch")) this.searched = true;
		}
		if (line.type === "user") {
			const content = Array.isArray(line.message?.content) ? line.message.content : [];
			for (const block of content) {
				if (block?.type === "tool_result" && block.is_error) this.toolError ??= resultText(block.content).slice(0, 500);
			}
			for (const { title, url } of resultLinks(line)) {
				if (typeof url !== "string" || !isWebSourceUrl(url) || this.hits.has(url)) continue;
				this.hits.set(url, { url, title: text(title, 300) || url, snippet: "" });
			}
		}
		if (line.type === "result" && line.is_error === true) {
			const errors = Array.isArray(line.errors) ? line.errors.filter((entry) => typeof entry === "string").join("\n") : "";
			this.failure ??= text(line.result, 500) || errors.slice(0, 500) || `Claude Code search failed: ${line.subtype ?? "unknown error"}.`;
		}
	}

	finish(): SearchHit[] {
		if (this.failure) throw new Error(this.failure);
		if (!this.initialized) throw new Error("Claude Code did not report its tool list, so LearnHarness discarded this search. Check the Claude Code installation.");
		if (!this.searched) throw new Error("Claude Code did not run a native web search. Check the account's WebSearch access or try again.");
		if (!this.hits.size && this.toolError) throw new Error(`Claude Code web search failed: ${this.toolError}`);
		if (!this.hits.size) throw new Error("Claude Code completed web search without source links. Try a more specific search query.");
		return [...this.hits.values()].slice(0, this.count);
	}
}

/** One headless `claude -p` with only WebSearch. Never retries. */
export async function searchClaudeCode(
	query: string,
	count: number,
	signal?: AbortSignal,
	runClaude: RunClaude = createClaudeLauncher(),
): Promise<SearchHit[]> {
	signal?.throwIfAborted();
	const limit = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
	const cwd = await mkdtemp(join(tmpdir(), "claude-code-search-"));
	try {
		const env = { ...externalCliEnv(), CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" };
		const child = await runClaude(claudeSearchArgs(), { cwd, env, signal: limit });
		if (!child) throw new Error("Claude Code CLI was not found on the LearnHarness server.");
		const collector = new ClaudeSearchCollector(count);
		// Resolve on exit, not stdio close: a grandchild holding the pipe
		// must not outlive the kill, the timeout or the temp directory.
		const exited = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", () => resolve());
		});
		exited.catch(() => { /* awaited below */ });
		const lines = createInterface({ input: child.stdout });
		const kill = () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			lines.close();
			child.stdout.destroy();
		};
		limit.addEventListener("abort", kill, { once: true });
		if (limit.aborted) kill();
		child.stderr.resume();
		child.stdin.on("error", () => { /* reported by exit */ });
		child.stdin.end(query);
		try {
			for await (const raw of lines) {
				if (collector.add(raw)) { kill(); break; }
			}
			// A hung exit is ended by the timeout or abort kill.
			await exited;
		} finally {
			limit.removeEventListener("abort", kill);
			kill();
		}
		if (limit.aborted) {
			signal?.throwIfAborted();
			throw new Error("Claude Code search timed out. Retry when ready.");
		}
		return collector.finish();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

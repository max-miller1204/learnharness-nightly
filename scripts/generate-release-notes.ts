/**
 * AI release notes for a nightly (docs/specs/t3-style-updates.md, section 2).
 *
 *   node scripts/generate-release-notes.ts --repository owner/name --tag vV \
 *     --ref <sha> --previous-tag <tag> --version V --output notes.json
 *
 * Reads the commits of previous..ref on main (imported upstream changes
 * included) and the PR descriptions their subjects name, asks OpenRouter
 * (OPENROUTER_API_KEY; model OPENROUTER_MODEL, default
 * anthropic/claude-haiku-5.5) for up to 7 user-facing highlights, and writes
 * { version, publishedAt, items } to --output. On any failure it writes
 * nothing and exits non-zero; nightly.yml then falls back to the plain
 * commit list (fallbackItems below, via --fallback).
 *
 *   node scripts/generate-release-notes.ts --fallback --ref <sha> \
 *     --previous-tag <tag> --version V --output notes.json
 *
 * Adapted from T3 Code's scripts/generate-release-notes.ts
 * (https://github.com/pingdotgg/t3code at 54ad956): the prompt, the PR body
 * trimming, the commit-number check and the "Plus N more bug fixes." count.
 * Changes: plain Node (no Effect), OpenRouter chat completions instead of
 * OpenAI responses, JSON items instead of a markdown body, no contributor
 * header. T3 Code carries this notice:
 *
 *   MIT License
 *
 *   Copyright (c) 2026 T3 Tools Inc.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { parseArgs } from "node:util";

export const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PULL_REQUEST_NUMBER = /\s*\(#(\d+)\)$/;
const PULL_REQUEST_BODY_LIMIT = 300;
export const MAX_HIGHLIGHTS = 7;
export const MAX_FALLBACK_ITEMS = 8;

export const SUMMARY_INSTRUCTIONS = `Write up to 7 bullet points for the LearnHarness update popover. LearnHarness is a learning app with a web app, a desktop app and a self-hosted server. Cover all three.

Give a feature a bullet only when it lets users do something they could not do before, removes a real limitation they hit in normal use, or cuts meaningful steps or wait time from a common task. Judge the outcome, regardless of the commit prefix. A new setting, a large diff, or support for one more edge case is not enough.

Lead with new capabilities. Give a bug fix its own bullet only when the source shows lost work or a core workflow that users could not complete in normal use. Leave isolated failures, cosmetic polish, and routine fixes in the count. Skip internal work, docs, tests, CI, and dependency bumps. Group commits only when they deliver the same user outcome. Seven is a ceiling. Stop when the qualifying changes run out, even if that leaves zero bullets.

Each bullet has a short feature name and one sentence of at most 20 words. Say what the user can do or what now works. Use product names people see in the app and leave out protocol or implementation details. Describe the shipped behavior at the end of the range. Skip dev-only features. No title, headings, introduction, example prompts, hype, PR numbers, or em dashes.

Return only JSON with a "highlights" array. For each highlight, give "label" (plain text, no final period), "detail" (one sentence), and "commits" (the bracketed input numbers of all commits it covers). Use the subjects and PR descriptions as source material. The release script adds the formatting and the count of remaining fixes.`;

export interface Highlight {
	label: string;
	detail: string;
	commits: number[];
}

export interface NotesEntry {
	version: string;
	publishedAt: string;
	items: string[];
}

const stripPullRequestNumber = (subject: string) => subject.replace(PULL_REQUEST_NUMBER, "").trim();

const pullRequestNumber = (subject: string) => {
	const match = PULL_REQUEST_NUMBER.exec(subject);
	return match ? Number(match[1]) : undefined;
};

/** Oldest first, as the model reads them (T3's order). */
export function readCommits(previousTag: string, ref: string): string[] {
	const range = previousTag ? `${previousTag}..${ref}` : ref;
	const log = execFileSync("git", ["log", "--no-merges", "--reverse", "--format=%s", range], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	return log.split("\n").filter((line) => line.trim() !== "");
}

/** The plain fallback: commit subjects, newest first, " (#N)" removed, first 8. */
export function fallbackItems(subjectsOldestFirst: readonly string[]): string[] {
	return [...subjectsOldestFirst].reverse().map(stripPullRequestNumber).filter(Boolean).slice(0, MAX_FALLBACK_ITEMS);
}

/** Keeps the prose of a PR body: no images, tables, headings, HTML, or verification sections (T3). */
export function trimPullRequestBody(body: string, limit = PULL_REQUEST_BODY_LIMIT): string {
	const [prose = ""] = body.split(/\n#+\s*(?:Verification|Council|Test|Testing|Screenshots)\b/i);
	const text = prose
		.split("\n")
		.filter((line) => line.trim() !== "" && !/^\s*[!|#<]/.test(line))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function buildSummaryInput(subjects: readonly string[], bodies: ReadonlyMap<number, string>): string {
	return subjects
		.flatMap((subject, index) => {
			const line = `[${index + 1}] ${subject}`;
			const number = pullRequestNumber(subject);
			const body = number === undefined ? "" : trimPullRequestBody(bodies.get(number) ?? "");
			return body ? [line, `  > ${body}`] : [line];
		})
		.join("\n");
}

/** Parse the model's JSON; null when it is not the promised shape. */
export function parseHighlights(text: string): Highlight[] | null {
	const json = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	let value: unknown;
	try { value = JSON.parse(json); } catch { return null; }
	const list = typeof value === "object" && value !== null ? (value as { highlights?: unknown }).highlights : undefined;
	if (!Array.isArray(list)) return null;
	const highlights: Highlight[] = [];
	for (const entry of list) {
		if (typeof entry !== "object" || entry === null) return null;
		const { label, detail, commits } = entry as Record<string, unknown>;
		if (typeof label !== "string" || !label.trim() || typeof detail !== "string" || !detail.trim()) return null;
		if (!Array.isArray(commits) || commits.length === 0 || !commits.every((n) => Number.isInteger(n))) return null;
		highlights.push({ label: label.trim(), detail: detail.trim(), commits: commits as number[] });
	}
	return highlights;
}

/**
 * Items from the chosen highlights (T3's formatReleaseSummary): one
 * "**Label.** detail" per highlight, then a count of the fix/perf commits
 * no highlight covers. Null when a highlight names a commit that is not in
 * the input (the whole result is rejected).
 */
export function formatItems(subjects: readonly string[], selected: readonly Highlight[]): string[] | null {
	const highlights = selected.slice(0, MAX_HIGHLIGHTS);
	const covered = new Set(highlights.flatMap((highlight) => highlight.commits));
	for (const id of covered) if (id < 1 || id > subjects.length) return null;
	const items = highlights.map(({ label, detail }) => `**${label.replace(/\.$/, "")}.** ${detail.replace(/\s*\u2014\s*/g, ", ")}`);
	const remaining = subjects.flatMap((subject, index) => {
		if (covered.has(index + 1)) return [];
		const kind = /^(fix|perf)(?:\([^)]*\))?!?:/i.exec(subject)?.[1]?.toLowerCase();
		return kind ? [kind] : [];
	});
	if (remaining.length === 0) return items;
	const count = remaining.length;
	let kind = "bug fixes and performance improvements";
	if (!remaining.includes("perf")) kind = count === 1 ? "bug fix" : "bug fixes";
	if (!remaining.includes("fix")) kind = count === 1 ? "performance improvement" : "performance improvements";
	return [...items, items.length > 0 ? `Plus ${count} more ${kind}.` : `${count} ${kind}.`];
}

function readPullRequestBodies(repository: string, numbers: readonly number[]): Map<number, string> {
	const [owner, name] = repository.split("/");
	const bodies = new Map<number, string>();
	for (let start = 0; start < numbers.length; start += 100) {
		const fields = numbers.slice(start, start + 100).map((n) => `pr${n}: pullRequest(number: ${n}) { body }`).join("\n");
		const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
		try {
			const out = execFileSync("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
			const repo = (JSON.parse(out) as { data?: { repository?: Record<string, { body?: string } | null> } }).data?.repository ?? {};
			for (const [alias, pr] of Object.entries(repo)) if (pr && typeof pr.body === "string") bodies.set(Number(alias.slice(2)), pr.body);
		} catch {
			/* PR bodies are extra context; subjects alone still work (imported upstream PRs may not exist here) */
		}
	}
	return bodies;
}

async function summarize(input: string, apiKey: string, model: string): Promise<Highlight[]> {
	const response = await fetch(OPENROUTER_URL, {
		method: "POST",
		signal: AbortSignal.timeout(3 * 60 * 1000),
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			reasoning: { effort: "low" },
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: SUMMARY_INSTRUCTIONS },
				{ role: "user", content: `Choose highlights as JSON from these commits:\n${input}` },
			],
		}),
	});
	if (!response.ok) throw new Error(`OpenRouter answered HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
	const body = (await response.json()) as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }>; usage?: unknown };
	const choice = body.choices?.[0];
	// A cut-off answer can carry partial JSON; publishing it would cut the notes short (T3).
	if (!choice || (choice.finish_reason && choice.finish_reason !== "stop")) throw new Error(`incomplete answer (${choice?.finish_reason ?? "no choice"})`);
	const highlights = parseHighlights(choice.message?.content ?? "");
	if (!highlights) throw new Error("the answer is not the promised JSON");
	console.error(`release summary generated by ${model}: ${highlights.length} highlights`, JSON.stringify(body.usage ?? {}));
	return highlights;
}

function writeAtomically(file: string, entry: NotesEntry) {
	fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(entry, null, 2)}\n`);
	fs.renameSync(`${file}.tmp`, file);
}

async function main() {
	const { values } = parseArgs({
		options: {
			repository: { type: "string" },
			tag: { type: "string" },
			ref: { type: "string" },
			"previous-tag": { type: "string" },
			version: { type: "string" },
			output: { type: "string" },
			"published-at": { type: "string" },
			fallback: { type: "boolean" },
		},
	});
	const { ref, version, output } = values;
	if (!ref || !version || !output) throw new Error("--ref, --version and --output are required");
	const subjects = readCommits(values["previous-tag"] ?? "", ref);
	const publishedAt = values["published-at"] ?? new Date().toISOString();
	if (values.fallback) {
		writeAtomically(output, { version, publishedAt, items: fallbackItems(subjects) });
		return;
	}
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
	if (!values.repository) throw new Error("--repository is required");
	if (subjects.length === 0) throw new Error(`no commits in ${values["previous-tag"]}..${ref}`);
	const numbers = [...new Set(subjects.flatMap((subject) => pullRequestNumber(subject) ?? []))];
	const bodies = readPullRequestBodies(values.repository, numbers);
	const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
	const highlights = await summarize(buildSummaryInput(subjects, bodies), apiKey, model);
	const items = formatItems(subjects, highlights);
	if (!items) throw new Error("a highlight names a commit that is not in the range");
	writeAtomically(output, { version, publishedAt, items });
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(`generate-release-notes: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}

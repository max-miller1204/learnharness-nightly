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
 * commit list (fallbackItems below, via --fallback). Both write T3's
 * summary extras: `stats` ("12 changes from 2 contributors", its release
 * header without the version), and `footer` ("Plus 3 more bug fixes.") or,
 * with no highlights, `intro` ("3 bug fixes.").
 *
 *   node scripts/generate-release-notes.ts --fallback --ref <sha> \
 *     --previous-tag <tag> --version V --output notes.json
 *
 * Adapted from T3 Code's scripts/generate-release-notes.ts
 * (https://github.com/pingdotgg/t3code at 54ad956, refreshed at df09ced7):
 * the prompt, the PR body trimming, the commit-number check, the "Plus N
 * more bug fixes." count (formatReleaseSummary) and the contributor count
 * (countContributors, buildReleaseHeader). Changes: plain Node (no Effect),
 * OpenRouter chat completions instead of OpenAI responses, JSON fields
 * instead of a markdown body (electron/release-notes.cjs summaryBody writes
 * the body). T3 Code carries this notice:
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
	stats?: string;
	intro?: string;
	footer?: string;
}

export interface ReleaseCommit {
	subject: string;
	authorName: string;
}

export interface PullRequest {
	body: string;
	author: { __typename: string; login: string; name?: string | null } | null;
}

/** A summary's parts: the highlight items, and the count of the rest as a footer, or as the intro with no highlights. */
export interface ReleaseSummary {
	items: string[];
	footer?: string;
	intro?: string;
}

const stripPullRequestNumber = (subject: string) => subject.replace(PULL_REQUEST_NUMBER, "").trim();

const pullRequestNumber = (subject: string) => {
	const match = PULL_REQUEST_NUMBER.exec(subject);
	return match ? Number(match[1]) : undefined;
};

/** Oldest first, as the model reads them (T3's order), each with its git author. */
export function readCommits(previousTag: string, ref: string): ReleaseCommit[] {
	const range = previousTag ? `${previousTag}..${ref}` : ref;
	const log = execFileSync("git", ["log", "--no-merges", "--reverse", "--format=%s%x1f%an", range], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	return log.split("\n").filter((line) => line.trim() !== "").map((line) => {
		const [subject = "", authorName = ""] = line.split("\x1f");
		return { subject, authorName };
	});
}

/** PR authors without bots, plus authors of direct pushes who have no PR in the range (T3's countContributors). */
export function countContributors(commits: readonly ReleaseCommit[], pullRequests: ReadonlyMap<number, PullRequest>): number {
	const people = new Set<string>();
	// A PR's squash commit carries its author's git name, which may differ from the profile name.
	const prAuthorNames = new Set<string>();
	const directAuthors: string[] = [];
	for (const commit of commits) {
		const number = pullRequestNumber(commit.subject);
		const author = number === undefined ? undefined : pullRequests.get(number)?.author;
		if (!author) {
			directAuthors.push(commit.authorName);
			continue;
		}
		if (author.__typename === "Bot" || author.login.endsWith("[bot]")) continue;
		people.add(author.login);
		prAuthorNames.add(commit.authorName);
		if (author.name) prAuthorNames.add(author.name);
	}
	for (const name of directAuthors) {
		if (name && !name.endsWith("[bot]") && !prAuthorNames.has(name)) people.add(name);
	}
	return people.size;
}

/**
 * The entry's `items` as older clients read them: the highlights, then the
 * intro or footer as a plain last item, so a server or desktop app from
 * before the summary fields still shows "Plus 3 more bug fixes." or
 * "3 bug fixes." (T3 keeps old popovers working the same way, with a
 * "### Plus N more" line they skip). Newer clients drop that copy.
 */
export function entryItems(summary: ReleaseSummary): string[] {
	return [...summary.items, ...(summary.intro ? [summary.intro] : []), ...(summary.footer ? [summary.footer] : [])];
}

/** T3's buildReleaseHeader without the "**vX** · " the release body adds. */
export function releaseStats(changes: number, contributors: number): string {
	const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
	return `${plural(changes, "change")} from ${plural(contributors, "contributor")}`;
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

/**
 * A commit number as the model wrote it: 8, or the strings "8" and "[8]"
 * (seen from anthropic/claude-haiku-5.5 in real runs). Anything else is not one.
 */
export function commitNumber(value: unknown): number | null {
	if (Number.isInteger(value)) return value as number;
	if (typeof value !== "string") return null;
	const match = /^\s*\[?\s*(\d+)\s*\]?\s*$/.exec(value);
	return match ? Number(match[1]) : null;
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
		if (!Array.isArray(commits) || commits.length === 0) return null;
		const numbers = commits.map(commitNumber);
		if (numbers.some((n) => n === null)) return null;
		highlights.push({ label: label.trim(), detail: detail.trim(), commits: numbers as number[] });
	}
	return highlights;
}

/**
 * The summary from the chosen highlights (T3's formatReleaseSummary): one
 * "**Label.** detail" item per highlight, and the count of the fix/perf
 * commits no highlight covers as the footer ("Plus 2 more bug fixes."), or
 * as the intro when there are no highlights ("2 bug fixes."). Null when a
 * highlight names a commit that is not in the input (the whole result is
 * rejected).
 */
export function formatSummary(subjects: readonly string[], selected: readonly Highlight[]): ReleaseSummary | null {
	const highlights = selected.slice(0, MAX_HIGHLIGHTS);
	const covered = new Set(highlights.flatMap((highlight) => highlight.commits));
	for (const id of covered) if (id < 1 || id > subjects.length) return null;
	const items = highlights.map(({ label, detail }) => `**${label.replace(/\.$/, "")}.** ${detail.replace(/\s*\u2014\s*/g, ", ")}`);
	const remaining = subjects.flatMap((subject, index) => {
		if (covered.has(index + 1)) return [];
		const kind = /^(fix|perf)(?:\([^)]*\))?!?:/i.exec(subject)?.[1]?.toLowerCase();
		return kind ? [kind] : [];
	});
	if (remaining.length === 0) return { items };
	const count = remaining.length;
	let kind = "bug fixes and performance improvements";
	if (!remaining.includes("perf")) kind = count === 1 ? "bug fix" : "bug fixes";
	if (!remaining.includes("fix")) kind = count === 1 ? "performance improvement" : "performance improvements";
	return items.length > 0 ? { items, footer: `Plus ${count} more ${kind}.` } : { items, intro: `${count} ${kind}.` };
}

/** `gh` with these arguments: its stdout. Throws on a non-zero exit (the error carries stdout). */
export type GhRunner = (args: string[]) => string;
const runGh: GhRunner = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

/**
 * The PRs' bodies and authors, 100 per GraphQL query. A query naming a PR that doesn't exist here
 * (an imported upstream number) makes gh exit non-zero, but its stdout still holds the data for the
 * others: read that, so their bodies and authors (the contributor count) aren't lost.
 */
export function readPullRequests(repository: string, numbers: readonly number[], gh: GhRunner = runGh): Map<number, PullRequest> {
	const [owner, name] = repository.split("/");
	const pullRequests = new Map<number, PullRequest>();
	for (let start = 0; start < numbers.length; start += 100) {
		const fields = numbers.slice(start, start + 100)
			.map((n) => `pr${n}: pullRequest(number: ${n}) { body author { __typename login ... on User { name } } }`).join("\n");
		const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
		let out = "";
		try {
			out = gh(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`]);
		} catch (error) {
			const stdout = (error as { stdout?: unknown }).stdout;
			out = typeof stdout === "string" ? stdout : Buffer.isBuffer(stdout) ? stdout.toString("utf8") : "";
		}
		try {
			const repo = (JSON.parse(out) as { data?: { repository?: Record<string, { body?: string; author?: PullRequest["author"] } | null> } }).data?.repository ?? {};
			for (const [alias, pr] of Object.entries(repo)) {
				if (!pr || typeof pr.body !== "string") continue;
				const author = pr.author && typeof pr.author.login === "string" ? pr.author : null;
				pullRequests.set(Number(alias.slice(2)), { body: pr.body, author });
			}
		} catch {
			/* PR bodies are extra context; subjects alone still work */
		}
	}
	return pullRequests;
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
	const commits = readCommits(values["previous-tag"] ?? "", ref);
	const subjects = commits.map((commit) => commit.subject);
	const publishedAt = values["published-at"] ?? new Date().toISOString();
	if (values.fallback) {
		// No PR authors here: every git author counts once, bots aside.
		const stats = commits.length > 0 ? { stats: releaseStats(commits.length, countContributors(commits, new Map())) } : {};
		writeAtomically(output, { version, publishedAt, items: fallbackItems(subjects), ...stats });
		return;
	}
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
	if (!values.repository) throw new Error("--repository is required");
	if (subjects.length === 0) throw new Error(`no commits in ${values["previous-tag"]}..${ref}`);
	const numbers = [...new Set(subjects.flatMap((subject) => pullRequestNumber(subject) ?? []))];
	const pullRequests = readPullRequests(values.repository, numbers);
	const bodies = new Map([...pullRequests].map(([number, pullRequest]) => [number, pullRequest.body]));
	const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
	const highlights = await summarize(buildSummaryInput(subjects, bodies), apiKey, model);
	const summary = formatSummary(subjects, highlights);
	if (!summary) throw new Error("a highlight names a commit that is not in the range");
	writeAtomically(output, { version, publishedAt, ...summary, items: entryItems(summary), stats: releaseStats(commits.length, countContributors(commits, pullRequests)) });
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(`generate-release-notes: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { capOutput, formatSize, MAX_OUTPUT_BYTES, resolveSourcePath, sourceSearchRoots } from "./fs-shared.ts";
import { resolvePolicy } from "./file-access.ts";
import { isAttachmentSource, learnerFileErrorMessage, resolveLearnerFile, type ResolveAttachment } from "./learner-file.ts";

/**
 * The ls tool — sources v1 (2026-09-19): a Node port of pi's
 * dist/core/tools/ls.js, home-anchored (fs-shared.ts). Schemas and the
 * output format are pi-verbatim; the only semantic deltas: the default
 * directory is the learner's home, and the path description says so.
 * Read-only by construction — readdir/stat only, no mutation APIs.
 */

const DEFAULT_LIMIT = 500;

const lsInput = Type.Object({
	path: Type.Optional(
		Type.String({ description: "Directory to list. Default: home when unrestricted, the allowed folder paths when restricted. Explicit relative paths are home-relative." }),
	),
	limit: Type.Optional(
		Type.Integer({ description: "Maximum number of entries to return (default: 500)" }),
	),
});

/** `resolveAttachment` lets `path` name an uploaded folder of the current
 * chat (`attachment:<id>` or a subfolder of it), in restricted mode too. */
export function createLsTool(resolveAttachment?: ResolveAttachment): AgentTool<typeof lsInput> {
	return {
		name: "ls",
		label: "ls",
		description: `List directory contents, or list the allowed folder paths when restriction is enabled and no path is supplied. Inspect a listed folder by supplying its path. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${formatSize(MAX_OUTPUT_BYTES)} (whichever is hit first).`,
		parameters: lsInput,
		execute: serverExecute("ls", lsInput, async (input) => {
			const policy = resolvePolicy();
			const upload = isAttachmentSource(input.path) ? resolveLearnerFile(input.path, resolveAttachment) : undefined;
			if (!input.path && policy.restricted) {
				const { roots, notices } = sourceSearchRoots(undefined, policy);
				const limit = Math.max(0, input.limit ?? DEFAULT_LIMIT);
				const { content, truncated } = capOutput(["Allowed folders:", ...roots.slice(0, limit)]);
				if (roots.length > limit) notices.push(`${limit} entries limit`);
				if (truncated) notices.push(`${formatSize(MAX_OUTPUT_BYTES)} limit`);
				return notices.length ? `${content}\n\n[${notices.join(". ")}]` : content;
			}
			const dirPath = upload?.filename ?? resolveSourcePath(input.path, policy);
			const shown = upload?.source ?? dirPath;

			let stat;
			try {
				stat = await fs.stat(dirPath);
			} catch {
				throw new Error(`Path not found: ${shown}`);
			}
			if (!stat.isDirectory()) throw new Error(`Not a directory: ${shown}`);

			let entries: string[];
			try {
				entries = await fs.readdir(dirPath);
			} catch (e) {
				throw new Error(`Cannot read directory: ${upload ? learnerFileErrorMessage(e, upload) : (e as Error).message}`);
			}

			// pi: alphabetical, case-insensitive.
			entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

			const effectiveLimit = input.limit ?? DEFAULT_LIMIT;
			const lines: string[] = [];
			let entryLimitReached = false;
			for (const entry of entries) {
				if (lines.length >= effectiveLimit) {
					entryLimitReached = true;
					break;
				}
				try {
					const fullPath = policy.restricted && !upload ? resolveSourcePath(path.join(dirPath, entry), policy) : path.join(dirPath, entry);
					const entryStat = await (upload ? fs.lstat(fullPath) : fs.stat(fullPath));
					lines.push(entryStat.isDirectory() ? `${entry}/` : entry);
				} catch {
					// pi: skip entries it cannot stat
				}
			}

			const { content, truncated } = capOutput(lines);
			if (lines.length === 0) return "Directory is empty";
			const notices: string[] = [];
			if (entryLimitReached) notices.push(`${effectiveLimit} entries limit`);
			if (truncated) notices.push(`${formatSize(MAX_OUTPUT_BYTES)} limit`);
			return notices.length > 0 ? `${content}\n\n[Truncated: ${notices.join(", ")}]` : content;
		}),
	};
}

export const lsTool = createLsTool();

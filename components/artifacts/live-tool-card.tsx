"use client";

import { ChevronRight } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { plainToolText, streamingToolInput, toolActivityLabel } from "@/src/core";
import type { ArtifactPartProps } from "@/src/core";

/**
 * The LIVE tool-input card (owner, streaming round 2026-10-01): what a
 * tool call looks like while the agent WRITES it. A tool part sits in
 * `input-streaming` for its whole execution (the bridge defers
 * input-available to tool_execution_end), so this card IS the working
 * state — spinner + shimmered activity label in the header (the retired
 * transcript bottom line's text, same recipe as the thinking row), and
 * the streaming input of a tool with declared input fields watchable on
 * expand (any other tool's arguments are never shown). The moment the call
 * settles, the part re-renders through the artifact registry and the
 * quiet settled card replaces this one.
 *
 * The one working-state grammar everywhere (owner): Braille spinner +
 * Shimmer(duration 1) — the thinking row, this card, the sidebar row.
 */
interface StreamingToolPart {
	type: string;
	state: string;
	toolCallId: string;
	input?: unknown;
}

export function LiveToolCard({ part }: ArtifactPartProps) {
	const p = part as StreamingToolPart;
	const tool = p.type.replace(/^tool-/, "");
	// Only a tool with declared input fields shows any input while it streams: the
	// arguments of every other tool may carry hidden data (a problem's solution and
	// tests), and the settled card decides what of them the learner sees.
	const shown = streamingToolInput(tool, p.input);
	const inp = (shown ?? {}) as Record<string, unknown>;
	// The headline argument (ToolCallCard's rule, shown as given): path for
	// read/ls, pattern for find/grep, session for list_propositions.
	let arg = "";
	if (typeof inp.path === "string" && inp.path) arg = plainToolText(inp.path);
	else if (typeof inp.pattern === "string" && inp.pattern) arg = plainToolText(inp.pattern);
	else if (typeof inp.session === "string" && inp.session) arg = plainToolText(inp.session);

	const hasInput = shown != null && Object.keys(inp).length > 0;
	const header = (
		<>
			<BrailleSpinner label={`${toolActivityLabel(tool)}, live`} />
			<Shimmer duration={1} className="text-xs">
				{toolActivityLabel(tool)}
			</Shimmer>
			{arg && <span className="truncate">{arg}</span>}
		</>
	);

	if (shown === undefined) return (
		<div data-testid="live-tool-card" data-tool={tool} className="my-1 flex w-full max-w-2xl select-none items-center gap-2 text-xs text-muted-foreground">
			{header}
		</div>
	);

	return (
		<details
			data-testid="live-tool-card"
			data-tool={tool}
			className="group my-1 w-full max-w-2xl select-none"
		>
			<summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
				{header}
				<ChevronRight className="size-3 shrink-0 opacity-50 transition-transform group-open:rotate-90" />
			</summary>
			<div className="mt-2 rounded-xl border bg-card p-3 text-xs">
				<div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">Input (streaming)</div>
				<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
					{hasInput ? plainToolText(JSON.stringify(shown, null, 2)) : "…"}
				</pre>
			</div>
		</details>
	);
}

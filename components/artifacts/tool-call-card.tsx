"use client";

import { ChevronRight } from "lucide-react";
import { capToolText, toolStepHeadline, toolStepOutput, type ArtifactPartProps } from "@/src/core";

/**
 * The generic tool-call card (sources v1, 2026-09-19): a quiet, collapsed
 * one-liner per synchronous tool call — the tool name plus the headline
 * argument — expandable to the full input and output. The user's spec:
 * "at least the tool name; for read, the file name; everything collapsed
 * by default; not distracting — background stuff." Unregistered tools
 * still render nothing (chat.tsx's registry default); this card is only
 * for the tools in TOOL_STEPS (src/core/tool-steps.ts), where the call IS
 * worth a trace in the transcript. Long input, output and error text shows
 * its start, with a note of how much (capToolText).
 */

/** A step's text, cut by capToolText, and its note when it was cut. */
function Capped({ text, className }: { text: string; className: string }) {
	const { text: shown, note } = capToolText(text);
	return (
		<>
			<pre className={className}>{shown}</pre>
			{note && <div className="mt-1 text-muted-foreground">{note}</div>}
		</>
	);
}

interface ToolCallPart {
	type: string;
	state: string;
	toolCallId: string;
	input?: unknown;
	output?: unknown;
	errorText?: string;
}

export function ToolCallCard({ part }: ArtifactPartProps) {
	const p = part as ToolCallPart;
	const tool = p.type.replace(/^tool-/, "");
	const arg = toolStepHeadline(tool, p.input);
	const out = toolStepOutput(p.output);
	const failed = p.state === "output-error" || typeof p.errorText === "string";
	return (
		<details
			data-testid="tool-call-card"
			data-tool={tool}
			className="group my-1 w-full max-w-2xl select-none"
		>
			<summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
				<span className={`font-medium uppercase tracking-wide ${failed ? "text-error" : ""}`}>
					{tool}
				</span>
				{arg && <span className="truncate">{arg}</span>}
				<ChevronRight className="size-3 shrink-0 opacity-50 transition-transform group-open:rotate-90" />
			</summary>
			<div className="mt-2 space-y-2 rounded-xl border bg-card p-3 text-xs">
				{p.input != null && (
					<div>
						<div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">
							Input
						</div>
						<Capped text={JSON.stringify(p.input, null, 2)} className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed" />
					</div>
				)}
				{typeof p.errorText === "string" ? (
					<div>
						<div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">
							Error
						</div>
						<Capped text={p.errorText} className="whitespace-pre-wrap break-all font-mono text-[11px] text-error" />
					</div>
				) : out != null ? (
					<div>
						<div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">
							Output
						</div>
						<Capped text={out} className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed" />
					</div>
				) : (
					p.state !== "output-available" && (
						<div className="text-muted-foreground italic">running…</div>
					)
				)}
			</div>
		</details>
	);
}

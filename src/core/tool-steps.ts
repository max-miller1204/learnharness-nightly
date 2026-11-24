/**
 * Tool steps: the quiet one-line trace a transcript shows for a call to one of the learner
 * filesystem tools or the prober's graph tools, the tool's name and its headline argument,
 * opening to the call's input and output. The web draws them with ToolCallCard
 * (components/artifacts), the phone with its ToolStep row; both take these rules from here.
 */
import type { ShowImageDetails } from "./contracts/chat.ts";

/** The tools shown as a tool step: ToolCallCard's entries in the web's artifact registry. */
export const TOOL_STEPS: readonly string[] = ["read", "ls", "find", "grep", "list_sessions", "list_propositions"];

/** The input fields each tool step's schema declares (src/agent/tools). A step shows only
 *  these: a call that got past its schema carries no others, and one that didn't (the
 *  model's arguments can hold anything) must never put its extras on the page. */
export const TOOL_STEP_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
	read: ["path", "offset", "limit"],
	ls: ["path", "limit"],
	find: ["pattern", "path", "limit"],
	grep: ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
	list_sessions: [],
	list_propositions: ["session"],
	show_image: ["path", "caption"],
};

/** A step's input as the card shows it: only the tool's declared fields. Other tools' input
 *  passes through. */
export function toolStepInput(tool: string, input: unknown): unknown {
	const fields = TOOL_STEP_INPUT_FIELDS[tool];
	if (!fields || typeof input !== "object" || input === null || Array.isArray(input)) return input;
	return Object.fromEntries(Object.entries(input).filter(([key]) => fields.includes(key)));
}

/** A running call's input as a live card shows it: the declared fields of a tool with a
 *  declared schema (TOOL_STEP_INPUT_FIELDS, an empty object before any has arrived), and
 *  undefined for any other tool. Streaming
 *  arguments have no schema check behind them, so a problem, a conclusion or a plugin
 *  tool's arguments, which can hold the hidden solution and tests, never reach the page. */
export function streamingToolInput(tool: string, input: unknown): unknown {
	return Object.hasOwn(TOOL_STEP_INPUT_FIELDS, tool) ? toolStepInput(tool, input) ?? {} : undefined;
}

/** What a stopped call's result says: pi's own wording, and the Node and fetch wordings that
 *  a tool's own rejection can carry when the run's signal fired mid-call. */
export function isAbortedCall(errorText: unknown): boolean {
	return errorText === "Operation aborted" || errorText === "The operation was aborted" || errorText === "This operation was aborted";
}

/** A failure the agent is told about because its call never ran: pi's schema check (its
 *  text echoes the received arguments), the tool's own refinement check, an unknown tool,
 *  a call cut off by the token limit. The agent retries these, so the transcript shows the
 *  retry line, never the call's arguments. */
export function isRejectedCall(errorText: unknown): boolean {
	return typeof errorText === "string" && /^(Validation failed for tool |Invalid tool input for tool |Tool \S+ not found|Tool call ".*" was not executed)/.test(errorText);
}

/** The tool a failed call is shown for with its own error (the tool step's card, red, with
 *  the Error section): the learner filesystem and graph tools, and a picture the learner
 *  shared, when the call itself ran and failed (a missing file). Every other failed call, and
 *  any call that was rejected before it ran, goes back to the agent, which reads the error and
 *  retries, and its card could hold hidden answers or draw nothing for a call that failed (a
 *  question, a practice problem or its verdict, a plugin problem, a job dispatch), so the
 *  transcript shows a quiet retry line for it. */
export function failedCallShowsItsError(tool: string, errorText?: unknown): boolean {
	return (TOOL_STEPS.includes(tool) || tool === "show_image") && !isRejectedCall(errorText);
}

/** Bidirectional controls, which can make a name read backwards (`txt.exe` under a
 *  right-to-left override shows as `exe.txt`): the embedding, override and isolate controls,
 *  and the Arabic letter mark and left-to-right and right-to-left marks. Letters of any
 *  script are left alone. The one list both platforms escape. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Text from a tool call with its bidirectional controls shown as escapes, so it reads in
 *  the order it was written. */
export function plainToolText(text: string): string {
	return text.replace(BIDI_CONTROLS, (control) => `\\u${control.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
}

/** The headline as the call gave it. */
function rawHeadline(tool: string, input: unknown): string {
	const inp = (input ?? {}) as Record<string, unknown>;
	if (tool === "read" || tool === "ls" || tool === "show_image") {
		return typeof inp.path === "string" && inp.path.length > 0 ? inp.path : "~";
	}
	if (typeof inp.pattern === "string") return inp.pattern;
	// list_propositions: the session id is the call's subject, exactly as list_sessions
	// reported it to the model.
	if (tool === "list_propositions" && typeof inp.session === "string" && inp.session.length > 0) return inp.session;
	return "";
}

/** The first `limit` code points of `text`, or undefined when it has no more than that, so a
 *  cut never splits a surrogate pair. */
function firstCodePoints(text: string, limit: number): string | undefined {
	if (text.length <= limit) return;
	let count = 0;
	let index = 0;
	for (const point of text) {
		if (count === limit) return text.slice(0, index);
		count++;
		index += point.length;
	}
	return;
}

/** A text's length in code points: each surrogate pair counts once. */
const codePoints = (text: string) => text.length - (text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);

/** The collapsed headline argument per tool: path for read/ls/show_image, pattern for
 *  find/grep, the session for list_propositions. Shown as given, never resolved, with any
 *  bidirectional controls shown as escapes. Past `limit` code points it is cut, before the
 *  escapes, so a cut never splits one, and ends in an ellipsis. */
export function toolStepHeadline(tool: string, input: unknown, limit = Infinity): string {
	const raw = rawHeadline(tool, input);
	const cut = Number.isFinite(limit) ? firstCodePoints(raw, limit) : undefined;
	return cut === undefined ? plainToolText(raw) : `${plainToolText(cut)}…`;
}

/** The most of a step's input, output or error text an opened step shows. */
export const TOOL_TEXT_LINES = 200;
export const TOOL_TEXT_CHARACTERS = 8192;

/** A step's text cut to its first TOOL_TEXT_LINES lines and TOOL_TEXT_CHARACTERS
 *  characters (code points), with a note of how much was shown when it was cut: characters
 *  when the length cut it, else lines. A newline that ends the text doesn't start a line.
 *  Bidirectional controls are left as they are: escape what is shown with plainToolText. */
export function capToolText(text: string): { text: string; note?: string } {
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	const lines = body.split("\n");
	const kept = lines.length > TOOL_TEXT_LINES ? lines.slice(0, TOOL_TEXT_LINES).join("\n") : text;
	const cut = firstCodePoints(kept, TOOL_TEXT_CHARACTERS);
	const count = (n: number) => n.toLocaleString("en-US");
	if (cut !== undefined) return { text: cut, note: `Showing the first ${count(TOOL_TEXT_CHARACTERS)} of ${count(codePoints(text))} characters.` };
	if (lines.length > TOOL_TEXT_LINES) return { text: kept, note: `Showing the first ${TOOL_TEXT_LINES} of ${count(lines.length)} lines.` };
	return { text };
}

/** Whether a finished show_image call's details describe a picture that can be shown: a
 *  stored snapshot, a PNG or JPEG, with its path and size (image-card.tsx draws it). */
export function isShowImageDetails(value: unknown): value is ShowImageDetails {
	const v = value as Partial<ShowImageDetails> | null | undefined;
	return (
		typeof v?.snapshotId === "string" &&
		/^[a-f0-9]{64}$/.test(v.snapshotId) &&
		(v.mimeType === "image/png" || v.mimeType === "image/jpeg") &&
		typeof v.path === "string" &&
		typeof v.width === "number" &&
		typeof v.height === "number"
	);
}

/** A tool result's body as text: a string verbatim; a result with text and images, its text
 *  and a note of the images (they are the model's, so the learner sees only that they came);
 *  anything else as JSON. */
export function toolStepOutput(output: unknown): string | null {
	if (output == null) return null;
	if (typeof output === "string") return output;
	if (typeof output === "object" && "text" in (output as Record<string, unknown>)) {
		const o = output as { text?: unknown; images?: unknown[] };
		const text = typeof o.text === "string" ? o.text : null;
		const n = Array.isArray(o.images) ? o.images.length : 0;
		return n > 0 ? `${text ?? ""}\n[${n} image${n > 1 ? "s" : ""} attached to the model]`.trim() : text;
	}
	try {
		return JSON.stringify(output, null, 2);
	} catch {
		return String(output);
	}
}

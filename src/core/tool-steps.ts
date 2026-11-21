/**
 * Tool steps: the quiet one-line trace a transcript shows for a call to one of the learner
 * filesystem tools or the prober's graph tools, the tool's name and its headline argument,
 * opening to the call's input and output. The web draws them with ToolCallCard
 * (components/artifacts), the phone with its ToolStep row; both take these rules from here.
 */

/** The tools shown as a tool step: ToolCallCard's entries in the web's artifact registry. */
export const TOOL_STEPS: readonly string[] = ["read", "ls", "find", "grep", "list_sessions", "list_propositions"];

/** Bidirectional embedding, override and isolate controls, which can make a name read
 *  backwards (`txt.exe` under a right-to-left override shows as `exe.txt`). */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** Text from a tool call with its bidirectional controls shown as escapes, so it reads in
 *  the order it was written. */
export function plainToolText(text: string): string {
	return text.replace(BIDI_CONTROLS, (control) => `\\u${control.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The collapsed headline argument per tool: path for read/ls/show_image, pattern for
 *  find/grep, the session for list_propositions. Shown as given, never resolved, with any
 *  bidirectional controls shown as escapes. */
export function toolStepHeadline(tool: string, input: unknown): string {
	const inp = (input ?? {}) as Record<string, unknown>;
	if (tool === "read" || tool === "ls" || tool === "show_image") {
		return typeof inp.path === "string" && inp.path.length > 0 ? plainToolText(inp.path) : "~";
	}
	if (typeof inp.pattern === "string") return plainToolText(inp.pattern);
	// list_propositions: the session id is the call's subject, exactly as list_sessions
	// reported it to the model.
	if (tool === "list_propositions" && typeof inp.session === "string" && inp.session.length > 0) return plainToolText(inp.session);
	return "";
}

/** The most of a step's input, output or error text an opened step shows. */
export const TOOL_TEXT_LINES = 200;
export const TOOL_TEXT_CHARACTERS = 8192;

/** A step's text cut to its first TOOL_TEXT_LINES lines and TOOL_TEXT_CHARACTERS
 *  characters, with a note of how much was shown when it was cut: lines when the line
 *  count cut it, characters when the length did. */
export function capToolText(text: string): { text: string; note?: string } {
	const lines = text.split("\n");
	const byLines = lines.slice(0, TOOL_TEXT_LINES).join("\n");
	if (byLines.length > TOOL_TEXT_CHARACTERS) {
		const count = (n: number) => n.toLocaleString("en-US");
		return { text: byLines.slice(0, TOOL_TEXT_CHARACTERS), note: `Showing the first ${count(TOOL_TEXT_CHARACTERS)} of ${count(text.length)} characters.` };
	}
	if (byLines.length === text.length) return { text };
	return { text: byLines, note: `Showing the first ${TOOL_TEXT_LINES} of ${lines.length} lines.` };
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

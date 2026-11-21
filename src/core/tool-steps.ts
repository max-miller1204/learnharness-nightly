/**
 * Tool steps: the quiet one-line trace a transcript shows for a call to one of the learner
 * filesystem tools or the prober's graph tools, the tool's name and its headline argument,
 * opening to the call's input and output. The web draws them with ToolCallCard
 * (components/artifacts), the phone with its ToolStep row; both take these rules from here.
 */

/** The tools shown as a tool step: ToolCallCard's entries in the web's artifact registry. */
export const TOOL_STEPS: readonly string[] = ["read", "ls", "find", "grep", "list_sessions", "list_propositions"];

/** The collapsed headline argument per tool: path for read/ls/show_image, pattern for
 *  find/grep, the session for list_propositions. Shown as given, never resolved. */
export function toolStepHeadline(tool: string, input: unknown): string {
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

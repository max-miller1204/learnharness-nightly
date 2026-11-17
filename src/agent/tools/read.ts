import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { resolveSourcePath } from "./fs-shared.ts";
import { detectSupportedImageMimeTypeFromFile, processImage } from "../image-processing/index.ts";
import {
	conversionFailureMessage,
	convertDocument,
	detectDocumentFormat,
	documentFormatFromName,
	DocumentConversionError,
	isOleCompound,
	isPdf,
	isZip,
	looksBinary,
	MAX_DOCUMENT_BYTES,
	type DocumentFormat,
} from "../documents/index.ts";

/**
 * The read tool — sources v0 (2026-09): a Node port of pi's read semantics
 * for the learner's local files. The flow is learner-owned: he pastes file
 * paths into the chat, the agent reads on its own terms (nothing is
 * auto-injected). Broad local reads remain the scope, except the shared
 * sensitive-location/credential denials and optional folder boundary in fs-shared.ts; this is not a sandbox.
 *
 * Ported behaviors (mirroring pi's dist/core/tools/read.js):
 * - text files: utf-8, offset (1-indexed) / limit slicing, and the
 *   2000-line / 50KB truncation ceiling with actionable "use offset=N"
 *   continuation notices — a huge file never silently floods the context.
 * - image files (jpg/png/gif/webp/bmp): returned as native image content
 *   parts so the vision-capable model actually SEES them (teacher's
 *   glm-5.3-flash accepts image input per pi's zai catalog; tool-execute's
 *   toToolResult maps ImageFileResult to pi's ImageContent).
 * - unreadable/missing files throw — pi turns that into an error tool
 *   result the model sees and recovers from.
 * - documents (docx, xlsx, pptx, odt, ods, odp, rtf, epub, ipynb) are
 *   converted to text by src/agent/documents/ and paged like text; PDFs,
 *   old binary Office files and other binaries are refused with a pointer
 *   (docs/specs/document-converters.md).
 *
 * Usage guidance ships in the description (the self-contained-tools
 * principle, user-decided 2026-09: system prompts reference only
 * always-on tools — read IS always-on, but its doctrine still lives here).
 */

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

const readInput = Type.Object({
	path: Type.String({ minLength: 1, description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
});

function formatSize(bytes: number): string {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/** Slice + truncate the text body, pi's continuation-notice style. */
function readTextSlice(text: string, offset: number | undefined, limit: number | undefined): string {
	const allLines = text.split("\n");
	const totalLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (startLine >= totalLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
	}
	// honor an explicit limit first (never beyond EOF)
	let selected = allLines.slice(startLine, limit !== undefined ? startLine + limit : totalLines);
	// then the 2000-line ceiling
	let truncatedBy: "lines" | "bytes" | null = null;
	if (selected.length > MAX_LINES) {
		selected = selected.slice(0, MAX_LINES);
		truncatedBy = "lines";
	}
	// then the 50KB ceiling
	if (Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_BYTES) {
		while (selected.length > 0 && Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_BYTES) {
			selected.pop();
		}
		truncatedBy = "bytes";
	}
	if (truncatedBy === null) {
		const remaining = totalLines - (startLine + selected.length);
		if (remaining > 0) {
			return `${selected.join("\n")}\n\n[${remaining} more lines in file. Use offset=${startLine + selected.length + 1} to continue.]`;
		}
		return selected.join("\n");
	}
	const endLineDisplay = startLine + selected.length;
	const reason =
		truncatedBy === "lines" ? `${MAX_LINES} line limit` : `${formatSize(MAX_BYTES)} limit`;
	return `${selected.join("\n")}\n\n[Showing lines ${startLine + 1}-${endLineDisplay} of ${totalLines} (${reason}). Use offset=${endLineDisplay + 1} to continue.]`;
}

const SHEET_HEADING = "## Sheet: ";
const PDF_MESSAGE = "This is a PDF. read doesn't extract PDFs: dispatch a pdf job with this path and your question.";

/** The first bytes of a file, for signature checks before a full read. */
async function readHead(absolute: string, length: number): Promise<Buffer> {
	const handle = await fs.open(absolute, "r");
	try {
		const head = Buffer.alloc(length);
		const { bytesRead } = await handle.read(head, 0, length, 0);
		return head.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/** The header line `read` puts above converted text; spreadsheets list their sheets. */
function withHeader(text: string, format: DocumentFormat): string {
	if (format !== "xlsx" && format !== "ods") return `[Converted from ${format} to text.]\n\n${text}`;
	const lines = text.split("\n");
	const sheets: Array<{ name: string; line: number; rows: number }> = [];
	for (const [index, line] of lines.entries()) {
		if (line.startsWith(SHEET_HEADING)) sheets.push({ name: line.slice(SHEET_HEADING.length), line: index + 3, rows: 0 });
		else if (sheets.length && line.trim() && !line.startsWith("[Extracted text truncated") && !line.startsWith("[Skipped document part")) sheets.at(-1)!.rows++;
	}
	const count = (n: number) => n.toLocaleString("en-US");
	const index = sheets.map((sheet) => `${sheet.name} (${count(sheet.rows)} ${sheet.rows === 1 ? "row" : "rows"}, line ${count(sheet.line)})`).join(", ");
	return `[Converted from ${format} to text. Sheets: ${index}]\n\n${text}`;
}

/** Convert a document for read, or fall back / refuse per the spec. */
async function readDocument(buffer: Buffer, format: DocumentFormat, name: string, signal?: AbortSignal): Promise<string> {
	try {
		return withHeader((await convertDocument(buffer, format, { signal })).text, format);
	} catch (error) {
		if (!(error instanceof DocumentConversionError)) throw error;
		// The two text-based formats stay useful raw when they don't parse.
		if (error.reason === "invalid" && (format === "rtf" || format === "ipynb") && !looksBinary(buffer)) {
			return `[Could not convert this as ${format}; showing the raw file.]\n${buffer.toString("utf-8")}`;
		}
		throw new Error(conversionFailureMessage(name, format, error.reason));
	}
}

/**
 * The read tool, shared verbatim by the prober and the teacher. Sources v1
 * (2026-09-19): the description is pi-verbatim (user: copy tool usage
 * guidance exactly) — the teaching doctrine moved to the shared prompt
 * fragment (prompts/shared/). Relative paths resolve against the
 * learner's home (fs-shared.ts), the harness's anchor.
 */
export type ReadModel = Pick<Model<Api>, "input" | "inputLimits">;

/** One implementation for every learner-file reader. Bind the active model
 * per agent, rather than sharing mutable model state between conversations.
 * Home-relative paths, text slicing and the app's abort guard stay unchanged;
 * image detection/processing and its notes follow native Pi read behavior. */
export function createReadTool(model?: ReadModel): AgentTool<typeof readInput> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files, images (jpg, png, gif, webp, bmp) and documents (docx, xlsx, pptx, odt, ods, odp, rtf, epub, ipynb). Images are sent as attachments; documents are converted to text. For text files, output is truncated to 2000 lines or 50.0KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete. File access settings and protected-location denials apply; use ls without a path to discover allowed folders when restricted.`,
		parameters: readInput,
		execute: serverExecute("read", readInput, async ({ path: rawPath, offset, limit }, { signal }): Promise<string | ImageFileResult> => {
			const absolute = resolveSourcePath(rawPath);
			const name = nodePath.basename(absolute);
			const mime = await detectSupportedImageMimeTypeFromFile(absolute);
			const named = mime ? undefined : documentFormatFromName(name);
			if (named && (await fs.stat(absolute)).size > MAX_DOCUMENT_BYTES) {
				// The PDF check comes first (spec read flow step 2), even for a large file.
				if (isPdf(await readHead(absolute, 8))) throw new Error(PDF_MESSAGE);
				throw new Error(conversionFailureMessage(name, named, "too-large"));
			}
			const buffer = await fs.readFile(absolute, { signal });
			if (mime) {
				const processed = await processImage(buffer, mime, { resizeOptions: model?.inputLimits?.images?.resize });
				signal?.throwIfAborted();
				const note = processed.ok
					? [`Read image file [${processed.mimeType}]`, ...processed.hints]
					: [`Read image file [${mime}]`, processed.message];
				if (model && !model.input.includes("image")) {
					note.push("[Current model does not support images. The image will be omitted from this request.]");
				}
				return {
					text: note.join("\n"),
					...(processed.ok ? { images: [{ data: processed.data, mimeType: processed.mimeType }] } : {}),
				};
			}
			if (isPdf(buffer)) {
				throw new Error(PDF_MESSAGE);
			}
			const format = detectDocumentFormat(name, buffer);
			if (format) return readTextSlice(await readDocument(buffer, format, name, signal), offset, limit);
			if (isOleCompound(buffer)) {
				throw new Error("This is an old binary Office file (.doc, .xls or .ppt), which read can't convert. Ask the learner to save it as .docx, .xlsx or .pptx.");
			}
			if (looksBinary(buffer)) {
				throw new Error(`${absolute} is ${isZip(buffer) ? "a zip archive" : "a binary file"} and can't be read as text.`);
			}
			return readTextSlice(buffer.toString("utf-8"), offset, limit);
		}),
	};
}

export const readTool = createReadTool();

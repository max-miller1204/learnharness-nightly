/**
 * POST /api/graph/import — the format-agnostic front door's transport
 * (2026-09-13): raw personal-notes files in, one extraction run
 * per file through the SAME pipeline the sessions use. Multipart form data
 * (field "files"); the pipeline mints a deterministic source id per file
 * path, persists the source record (the file's provenance + the run's usage),
 * and runs
 * extractor → auditor → merger over the raw text.
 *
 * Only file names lib/notes-import-limits.ts gives a kind are taken
 * (docs/specs/extract-more-types.md). A PDF (spotted by its %PDF- header)
 * is converted to Markdown; Office, OpenDocument, RTF, EPUB and notebook
 * files go through item 25's converter; an image is described by the
 * Vision slot inside the pipeline; code is extracted with the code prompt.
 * Notes and code are decoded as UTF-8 unless a zero byte in their first
 * 8 KiB causes refusal (a binary-file heuristic, not complete text or
 * encoding validation). These refusals occur before any source record or
 * model call.
 *
 * A request with the form field "group" is one folder's code: every file is
 * a code file under that folder, and they become ONE source named after it.
 *
 * Small concurrency cap: the model calls are the slow part, and a burst of
 * 25 simultaneous runs would trip provider rate limits — a 3-wide worker
 * pool keeps the run registry (the dock's status chips) and the ledgers
 * healthy. The dock's chips + graph refetch track progress live through
 * /api/graph/status, as with session runs.
 */
import {
	convertDocument, conversionFailureMessage, convertPdf, detectDocumentFormat, detectSupportedImageMimeType, DocumentConversionError,
	extraction, isOleCompound, joinPages, looksBinary, ModelUnavailableError, NotesImportError, sourceDirectory,
} from "@/src/server";
import {
	CODE_CAP_MESSAGE, importKind, MAX_CODE_FILE_BYTES, MAX_CODE_FILES, MAX_CODE_TOTAL_BYTES, MAX_IMPORT_BODY_BYTES, MAX_IMPORT_BYTES,
	UNSUPPORTED_TYPE_MESSAGE, validNotesPath,
} from "@/lib/notes-import-limits.ts";
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data.ts";
import {
	emit,
	MODEL_UNAVAILABLE,
	ModelsNotConfiguredError,
	PROVIDER_KEY_MISSING_CODE,
	ProviderKeyMissingError,
	SUBSCRIPTION_UNREACHABLE_CODE,
	SubscriptionUnreachableError,
	type EmissionStats,
} from "@/src/core";

export const dynamic = "force-dynamic";

interface ImportResult {
	requestIndex: number;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	filePath: string;
	ok: boolean;
	stats?: EmissionStats;
	error?: string;
	/** The machine discriminator when ok:false is a config refusal — the
	 * BYOK models refusal (owner, 2026-09-22), a saved model the catalog
	 * dropped (model_unavailable) or the provider-key refusal (2026-09-25); the client can open the setup/keys flow off it. An
	 * unreachable subscription is an outage, not setup: import again later. */
	code?: "models_not_configured" | (typeof MODEL_UNAVAILABLE) | (typeof PROVIDER_KEY_MISSING_CODE) | (typeof SUBSCRIPTION_UNREACHABLE_CODE);
	missing?: string[];
	/** Whose key or connection (provider_key_missing, subscription_unreachable). */
	provider?: string;
	slots?: string[];
	/** Shown beside a completed import (every PDF: scanner text may be wrong). */
	notice?: string;
}

const MAX_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

type NotesInput = Omit<Parameters<typeof extraction.importNotes>[0], "filePath">;
type NotesFile = { kind: "notes"; input: NotesInput; notice?: string } | { kind: "refused"; error: string };
const NOT_TEXT = "This file isn't plain text.";
const OLD_OFFICE = "This is an old binary Office file. Save it as .docx or .pptx first.";

/** Each accepted kind becomes the pipeline's input (spec "Server, per file"). */
async function readNotesFile(file: File, filePath: string): Promise<NotesFile> {
	const kind = importKind(file.name);
	if (!kind) return { kind: "refused", error: UNSUPPORTED_TYPE_MESSAGE };
	const bytes = new Uint8Array(await file.arrayBuffer());
	const text = () => new TextDecoder().decode(bytes);
	if (PDF_MAGIC.every((byte, i) => bytes[i] === byte)) return readPdf(bytes);
	switch (kind) {
		// A .pdf without the PDF header is read as text, as before item 26.
		case "pdf":
		case "notes":
			return looksBinary(bytes) ? { kind: "refused", error: NOT_TEXT } : { kind: "notes", input: { text: text() } };
		case "code":
			return looksBinary(bytes) ? { kind: "refused", error: NOT_TEXT } : { kind: "notes", input: { text: "", codeFiles: [{ path: filePath, text: text() }] } };
		case "image": {
			const mimeType = detectSupportedImageMimeType(bytes);
			if (!mimeType) return { kind: "refused", error: "Could not read this image." };
			return { kind: "notes", input: { text: "", image: { bytes, mimeType } }, notice: "Described by the vision model; details may be wrong." };
		}
		case "document": {
			const format = detectDocumentFormat(file.name, bytes)!;
			if (isOleCompound(bytes) && format !== "docx" && format !== "pptx") return { kind: "refused", error: OLD_OFFICE };
			try {
				const converted = await convertDocument(bytes, format);
				return { kind: "notes", input: { text: converted.text }, ...(converted.truncated ? { notice: "Text was cut at the conversion limits." } : {}) };
			} catch (error) {
				if (!(error instanceof DocumentConversionError)) throw error;
				// The two text-based formats stay useful raw when they don't parse (as `read` does).
				if (error.reason === "invalid" && (format === "rtf" || format === "ipynb") && !looksBinary(bytes)) return { kind: "notes", input: { text: text() } };
				return { kind: "refused", error: conversionFailureMessage(file.name, format, error.reason) };
			}
		}
	}
}

async function readPdf(bytes: Uint8Array): Promise<NotesFile> {
	const pdf = await convertPdf(bytes, MAX_PDF_PAGES);
	switch (pdf.kind) {
		case "unreadable":
			return { kind: "refused", error: "Could not open this PDF." };
		case "too-long":
			return { kind: "refused", error: "Too long. Max 1,000 pages." };
		case "converted": {
			const text = joinPages(pdf.pages);
			if (!text) return { kind: "refused", error: "OCR not supported yet." };
			const skipped = pdf.pages.filter((page) => page.kind === "image-only").length;
			const omission = skipped > 0 ? ` Skipped ${skipped} image-only ${skipped === 1 ? "page" : "pages"}; OCR is not supported.` : "";
			return { kind: "notes", input: { text }, notice: `Scanned pages may have errors.${omission}` };
		}
	}
}

export async function POST(request: Request) {
	let form: FormData;
	try {
		form = await readBoundedFormData(request, MAX_IMPORT_BODY_BYTES);
	} catch (err) {
		const oversized = err instanceof FormBodyLimitError;
		return Response.json({ results: [] as ImportResult[], error: oversized
			? "Import request is too large. Select fewer files."
			: "Could not read the upload. It may be incomplete; please select the files again." }, { status: oversized ? 413 : 400 });
	}
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES) {
		return Response.json({ results: [] as ImportResult[], error: "Too big. Max 25 MB." }, { status: 413 });
	}
	if (files.length === 0) {
		return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	}

	// PR198: folder-relative identity, matched to either browser filename form.
	// Validate every path before conversions, metadata writes, or model calls.
	const suppliedPaths = form.getAll("paths");
	if (suppliedPaths.length > 0 && (suppliedPaths.length !== files.length || suppliedPaths.some((p) => typeof p !== "string"))) {
		return Response.json({ results: [], error: "Invalid import paths" }, { status: 400 });
	}
	const paths = suppliedPaths.length > 0 ? suppliedPaths as string[] : files.map((f) => f.name);
	if (files.some((file, i) => !validNotesPath(paths[i]!, file.name))) {
		return Response.json({ results: [], error: "Import contains an unsafe or mismatched relative path" }, { status: 400 });
	}
	const group = form.get("group");
	if (group !== null) return importCodeGroup(group, files, paths);
	const results: ImportResult[] = [];
	const queue = files.map((file, requestIndex) => ({ file, requestIndex, filePath: paths[requestIndex]! }));
	const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { file, requestIndex, filePath } = next;
			try {
				const notes = await readNotesFile(file, filePath);
				if (notes.kind === "refused") {
					results.push({ filePath, requestIndex, outcome: "failed", ok: false, error: notes.error });
					continue;
				}
				results.push(await runImport(filePath, requestIndex, notes.input, notes.notice));
			} finally { emit("sources-changed", {}); }
		}
	});
	await Promise.all(workers);
	return Response.json({ results });
}

/** One source through the pipeline, with every failure mapped to its result row. */
async function runImport(filePath: string, requestIndex: number, input: NotesInput, notice?: string): Promise<ImportResult> {
	try {
		sourceDirectory.registerImport(filePath);
		const stats = await extraction.importNotes({ filePath, ...input });
		return { filePath, requestIndex, outcome: "completed", ok: true, stats, ...(notice ? { notice } : {}) };
	} catch (err) {
		if (err instanceof ModelsNotConfiguredError) {
			return { filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
				code: "models_not_configured", missing: err.envelope.missing };
		}
		if (err instanceof ModelUnavailableError) {
			return { filePath, ok: false, requestIndex, outcome: "failed", error: err.message, code: MODEL_UNAVAILABLE };
		}
		if (err instanceof ProviderKeyMissingError) {
			return { filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
				code: PROVIDER_KEY_MISSING_CODE, provider: err.envelope.provider, slots: err.envelope.slots };
		}
		if (err instanceof SubscriptionUnreachableError) {
			return { filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
				code: SUBSCRIPTION_UNREACHABLE_CODE, provider: err.envelope.provider };
		}
		return { filePath, requestIndex, ok: false,
			outcome: err instanceof NotesImportError ? err.outcome : "failed",
			...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
			error: err instanceof Error ? err.message : String(err) };
	}
}

/** A folder's code as ONE source named after the folder (spec "Grouped code"). The caps are re-checked here. */
async function importCodeGroup(group: FormDataEntryValue, files: File[], paths: string[]): Promise<Response> {
	if (typeof group !== "string" || !validNotesPath(group, group) || group.includes("/")
		|| files.some((file, i) => importKind(file.name) !== "code" || !paths[i]!.startsWith(`${group}/`))) {
		return Response.json({ results: [], error: "Invalid code folder import" }, { status: 400 });
	}
	const failed = (error: string): Response => Response.json({ results: [{ filePath: group, requestIndex: 0, outcome: "failed", ok: false, error }] });
	if (files.length > MAX_CODE_FILES || files.reduce((total, file) => total + file.size, 0) > MAX_CODE_TOTAL_BYTES) return failed(CODE_CAP_MESSAGE);
	const codeFiles: Array<{ path: string; text: string }> = [];
	for (const [i, file] of files.entries()) {
		if (file.size > MAX_CODE_FILE_BYTES) return failed(`${paths[i]} is over 100 KB, the limit for one code file.`);
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (looksBinary(bytes)) return failed(`${paths[i]} isn't plain text.`);
		codeFiles.push({ path: paths[i]!, text: new TextDecoder().decode(bytes) });
	}
	codeFiles.sort((a, b) => a.path.localeCompare(b.path));
	try {
		const label = `${group} (${files.length} code ${files.length === 1 ? "file" : "files"})`;
		return Response.json({ results: [await runImport(group, 0, { text: "", label, codeFiles })] });
	} finally { emit("sources-changed", {}); }
}
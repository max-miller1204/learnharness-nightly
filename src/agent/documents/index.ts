import { createHash } from "node:crypto";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { MAX_INPUT, TRUNCATED } from "./document-text.mjs";

/**
 * The document converter layer (docs/specs/document-converters.md): one
 * entry point for every caller that needs the text of an Office,
 * OpenDocument, RTF, EPUB or Jupyter file. `read` uses it today; the
 * Extract files import route (roadmap item 26) calls the same two
 * functions with the uploaded bytes:
 *
 *   const format = detectDocumentFormat(file.name, bytes);
 *   if (format) text = (await convertDocument(bytes, format)).text;
 *
 * The extraction itself is T3 Code's converter (./document-text.mjs, MIT)
 * run in a worker thread with T3's limits: two at once, 15 s, 192 MB heap.
 * Results (and rejections) are cached in memory by content hash.
 */

export const DOCUMENT_FORMATS = ["docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "epub", "ipynb"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];
export const MAX_DOCUMENT_BYTES: number = MAX_INPUT;

export type DocumentConversionReason = "too-large" | "invalid" | "encrypted" | "empty" | "timeout" | "failed";

export class DocumentConversionError extends Error {
	readonly reason: DocumentConversionReason;
	constructor(reason: DocumentConversionReason, detail?: string) {
		super(detail ? `Document conversion failed (${reason}): ${detail}` : `Document conversion failed (${reason})`);
		this.name = "DocumentConversionError";
		this.reason = reason;
	}
}

/** The message a caller shows for a failed conversion of `name`. */
export function conversionFailureMessage(name: string, format: DocumentFormat, reason: DocumentConversionReason): string {
	switch (reason) {
		case "too-large":
			return `${name} is larger than 16 MiB, the limit for converting documents.`;
		case "encrypted":
			return `${name} is password-protected or encrypted, so its text can't be read.`;
		case "invalid":
			return `${name} isn't a valid ${format} file.`;
		case "empty":
			return `${name} has no text to read.`;
		case "timeout":
			return `Converting ${name} took longer than 15 s and was stopped.`;
		case "failed":
			return `Could not convert ${name} to text.`;
	}
}

// ─── Signatures ─────────────────────────────────────────────────────────────

const startsWith = (bytes: Uint8Array, signature: readonly number[]) => signature.every((byte, i) => bytes[i] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

export const isPdf = (bytes: Uint8Array): boolean => startsWith(bytes, ascii("%PDF-"));
export const isZip = (bytes: Uint8Array): boolean => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
/** OLE compound file: old .doc/.xls/.ppt, and also password-protected OOXML. */
export const isOleCompound = (bytes: Uint8Array): boolean => startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** The Extract files check: a NUL byte in the first 8 KB. */
export const looksBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, 8192).includes(0);

const MIMETYPES: Record<string, DocumentFormat> = {
	"application/vnd.oasis.opendocument.text": "odt",
	"application/vnd.oasis.opendocument.spreadsheet": "ods",
	"application/vnd.oasis.opendocument.presentation": "odp",
	"application/epub+zip": "epub",
};
const OOXML_PARTS: Array<[string, DocumentFormat]> = [
	["word/document.xml", "docx"],
	["xl/workbook.xml", "xlsx"],
	["ppt/presentation.xml", "pptx"],
];

function zipFormat(bytes: Uint8Array): DocumentFormat | undefined {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (buffer.length >= 30) {
		const nameLength = buffer.readUInt16LE(26);
		const extraLength = buffer.readUInt16LE(28);
		if (buffer.toString("latin1", 30, 30 + nameLength) === "mimetype") {
			const start = 30 + nameLength + extraLength;
			const size = buffer.readUInt32LE(18);
			const mimetype = buffer.toString("latin1", start, Math.min(buffer.length, start + Math.min(size, 128))).trim();
			if (MIMETYPES[mimetype]) return MIMETYPES[mimetype];
		}
	}
	for (const [part, format] of OOXML_PARTS) if (buffer.includes(part, 0, "latin1")) return format;
	return undefined;
}

/** Format by extension first, then by signature; undefined when it is not a convertible document. */
export function detectDocumentFormat(fileName: string, bytes: Uint8Array): DocumentFormat | undefined {
	const extension = path.extname(fileName).slice(1).toLowerCase();
	if ((DOCUMENT_FORMATS as readonly string[]).includes(extension)) return extension as DocumentFormat;
	if (isZip(bytes)) return zipFormat(bytes);
	if (startsWith(bytes, ascii("{\\rtf"))) return "rtf";
	return undefined;
}

/** The format detected by extension alone (lets callers refuse oversized files before reading them). */
export function documentFormatFromName(fileName: string): DocumentFormat | undefined {
	const extension = path.extname(fileName).slice(1).toLowerCase();
	return (DOCUMENT_FORMATS as readonly string[]).includes(extension) ? (extension as DocumentFormat) : undefined;
}

// ─── Conversion ─────────────────────────────────────────────────────────────

/** Test seams (tool-execute.ts's toolTimeoutMs idiom). */
export const documentLimits = { timeoutMs: 15_000, heapMb: 192 };
export const documentStats = { workerRuns: 0 };

type CacheEntry = { text: string } | { reason: DocumentConversionReason };
const CACHE_SIZE = 8;
const cache = new Map<string, CacheEntry>();
export function clearDocumentCache(): void {
	cache.clear();
}
function remember(key: string, entry: CacheEntry) {
	cache.delete(key);
	cache.set(key, entry);
	while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

const SLOTS = 2;
let active = 0;
const waiting: Array<() => void> = [];
function acquire(signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (active < SLOTS) {
		active++;
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			const index = waiting.indexOf(grant);
			if (index >= 0) waiting.splice(index, 1);
			reject(signal!.reason);
		};
		const grant = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		waiting.push(grant);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function release() {
	const next = waiting.shift();
	if (next) next();
	else active--;
}

type WorkerReply = { text: string } | { reason: DocumentConversionReason; error: string };

function runWorker(bytes: Uint8Array, format: DocumentFormat, signal?: AbortSignal): Promise<WorkerReply> {
	documentStats.workerRuns++;
	// Same packaging contract as the image worker: unbundled .mjs files traced
	// at this cwd-relative path (next.config.ts outputFileTracingIncludes).
	const worker = new Worker(path.join(process.cwd(), "src/agent/documents/document-text-worker.mjs"), {
		resourceLimits: { maxOldGenerationSizeMb: documentLimits.heapMb },
	});
	return new Promise<WorkerReply>((resolve, reject) => {
		const timer = setTimeout(() => {
			done();
			resolve({ reason: "timeout", error: "timed out" });
		}, documentLimits.timeoutMs);
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			done();
			reject(signal!.reason);
		};
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		worker.once("message", (reply: WorkerReply) => {
			done();
			resolve(reply);
		});
		worker.once("error", (error) => {
			done();
			resolve({ reason: "failed", error: error.message });
		});
		worker.once("exit", (code) => {
			done();
			resolve({ reason: "failed", error: `worker exited (${code})` });
		});
		// Transfer a worker-owned copy so the caller's bytes stay intact.
		const copy = new Uint8Array(bytes);
		worker.postMessage({ bytes: copy, extension: `.${format}` }, [copy.buffer]);
	}).finally(() => void worker.terminate().catch(() => undefined));
}

/** OOXML containers that arrive as OLE files are password-protected. */
const ZIP_FORMATS: ReadonlySet<DocumentFormat> = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp", "epub"]);

/** Converts with the hash cache and the two-slot queue. Throws DocumentConversionError. */
export async function convertDocument(
	bytes: Uint8Array,
	format: DocumentFormat,
	options: { signal?: AbortSignal } = {},
): Promise<{ text: string; truncated: boolean }> {
	if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentConversionError("too-large");
	if (ZIP_FORMATS.has(format) && isOleCompound(bytes)) throw new DocumentConversionError("encrypted");
	const key = `${format}:${createHash("sha256").update(bytes).digest("hex")}`;
	let entry = cache.get(key);
	if (entry) remember(key, entry);
	else {
		await acquire(options.signal);
		let reply: WorkerReply;
		try {
			reply = await runWorker(bytes, format, options.signal);
		} finally {
			release();
		}
		entry = "text" in reply ? { text: reply.text } : { reason: reply.reason };
		// Rejections are properties of the bytes; timeouts and crashes retry next time.
		if ("text" in entry || entry.reason === "invalid" || entry.reason === "encrypted" || entry.reason === "empty") remember(key, entry);
		if (!("text" in reply)) throw new DocumentConversionError(reply.reason, reply.error);
	}
	if (!("text" in entry)) throw new DocumentConversionError(entry.reason);
	return { text: entry.text, truncated: entry.text.endsWith(TRUNCATED) };
}

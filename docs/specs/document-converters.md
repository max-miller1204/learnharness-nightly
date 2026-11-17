# Document converters (roadmap item 25)

Status: approved by the owner on 2026-11-17.

Goal: the agent's `read` tool reads Office, OpenDocument, RTF, EPUB and Jupyter files as text, the way T3 Code does, through one converter layer that the Extract files import route can reuse later (item 26).

## Decided by the owner

1. Port T3 Code's document text converter (`apps/server/src/provider/documentTextWorker.ts` and the limits and concurrency of `DocumentText.ts`, T3 commit `e5d757f5`, which includes `6ef2c054`), keeping T3's MIT notice. Formats: docx, xlsx, pptx, odt, ods, odp, rtf, epub, ipynb. Libraries as T3 pins them: `saxes` 6.0.0 (ISC), `yauzl` ^3.4.0 (MIT), `character-entities` 2.0.2 (MIT).
2. One converter layer in `src/agent/documents/`. This PR wires it into `read` only; Extract files gets a clean entry point and is wired in item 26.
3. Limits are T3's: 16 MiB input, 32 MiB uncompressed, 1,000,000 output characters, 15 s timeout, two extractions at once.
4. Cache: in memory, keyed by the SHA-256 of the file bytes, holding the last 8 results. Nothing is written to disk (T3's `file.docx.txt` sidecar is dropped because it would write into the learner's folders).
5. Spreadsheets: T3's text output (a `## Sheet: <name>` heading per sheet, one tab-separated line per row) plus a sheet index on the first line, read with `read`'s normal line paging. No new tool.
6. Binary files that no converter handles are refused with a clear error instead of being decoded as UTF-8.

## Adopted from T3 (veto any)

- **Converter code.** `documentTextWorker.ts` ported nearly verbatim to plain JavaScript (`.mjs`, LearnHarness's convention for worker code, with a `.d.mts` type file). All of T3's per-format rules come along unchanged: hidden parts (tracked deletions, field codes, layout values), Word headings as `#` lines, tables and sheet rows as tab-separated cells, xlsx shared strings, booleans and number-format hints (`[Excel numFmtId=...; date system 1900]`), ODF whitespace and repeat counts, pptx `## Slide N` plus `Notes:` from the notes slide, epub `## Chapter N` in spine order, ipynb `## Cell N (code|markdown)` with text outputs and error tracebacks, RTF control words and code pages.
- **Archive and structure limits.** 2,048 zip entries, only XML-like entries are inflated, a 200:1 compression-ratio cap per entry, encrypted archives rejected, 200,000 XML nodes, nesting depth 128, 10,000 rows or notebook cells, 512 columns.
- **Truncation.** When any limit is hit after some text was produced, the text so far is kept and T3's notice is appended: `[Extracted text truncated at document extraction limits.]`.
- **Isolation, two slots, 15 s, 192 MB heap.** As T3: each extraction runs in a separate child process (`process.execPath` with `ELECTRON_RUN_AS_NODE=1` and `--max-old-space-size=192` in `NODE_OPTIONS`) behind a two-slot queue, killed at 15 s. The bytes go in on stdin and one JSON reply comes back on stdout. (Owner, 2026-11-17, after prove round 3: the first build used a `worker_threads` Worker instead, and a 15 MiB notebook that ran the worker out of memory aborted the whole server. Node can't contain that in a thread, so the T3 design is adopted.)
- **Rejection caching.** T3 remembers documents it rejected so it doesn't retry them; here a rejection (invalid, encrypted, no text) is cached in the same 8-entry hash cache. Timeouts and worker crashes are not cached, so the next call retries.

## Design

### Module layout

| File | What it is |
|---|---|
| `src/agent/documents/document-text.mjs` (+ `.d.mts`) | The T3 port. `extractDocumentText(bytes, extension)` returns the text (with the truncation notice when truncated) or throws. Takes bytes instead of a path (`yauzl.fromBuffer`), so Extract files can pass uploaded bytes. T3's MIT notice in the file header. |
| `src/agent/documents/document-text-worker.mjs` | Child-process entry: takes the extension as an argument and the bytes on stdin, writes `{ text }` or `{ reason, error }` as JSON to stdout. |
| `src/agent/documents/index.ts` | The public entry point (below): format detection, the two-slot queue, the timeout, the cache. |
| `src/agent/documents/LICENSE` | T3 Code's MIT license text, the third-party notice (same convention as `src/agent/image-processing/LICENSE`). |

Public API (`src/agent/documents/index.ts`):

```ts
export type DocumentFormat = "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp" | "rtf" | "epub" | "ipynb";
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
/** Format by extension first, then by signature; undefined when it is not a convertible document. */
export function detectDocumentFormat(fileName: string, bytes: Uint8Array): DocumentFormat | undefined;
/** Converts, using the hash cache and the two-slot queue. Throws DocumentConversionError with a reason. */
export function convertDocument(bytes: Uint8Array, format: DocumentFormat, options?: { signal?: AbortSignal }): Promise<{ text: string; truncated: boolean }>;
export class DocumentConversionError extends Error { reason: "too-large" | "invalid" | "encrypted" | "empty" | "timeout" | "failed" }
```

Item 26 calls `detectDocumentFormat(file.name, bytes)` then `convertDocument(bytes, format)` in the import route.

### Detection (extension plus signature)

1. Extension is one of the nine (case-insensitive): that format. If the bytes don't match (for example a `.docx` that isn't a zip), conversion fails as `invalid`. Exception (owner, 2026-11-17, after the prove run): an OLE compound file (`D0 CF 11 E0 A1 B1 1A E1`) named `.docx`, `.xlsx` or `.pptx` fails as `encrypted`, because that is how Office stores a password-protected file.
2. Otherwise, by signature:
   - zip (`PK\x03\x04`) whose first entry is `mimetype`: its content names `odt`, `ods`, `odp` (`application/vnd.oasis.opendocument.text|spreadsheet|presentation`) or `epub` (`application/epub+zip`);
   - zip whose entry names include `word/document.xml`, `xl/workbook.xml` or `ppt/presentation.xml`: docx, xlsx or pptx. This also covers macro-enabled and template variants (`.docm`, `.dotx`, `.xlsm`, `.xltx`, `.pptm`, `.potx`, `.ppsx`) and files with a missing or wrong extension;
   - starts with `{\rtf`: rtf.
   - ipynb has no signature; extension only.

### `read` flow

After the path is resolved (home-relative, sensitive-path guard and folder boundary unchanged):

1. **Images**: unchanged (signature sniff, native image blocks).
2. **PDF** (`%PDF-` signature): error `This is a PDF. read doesn't extract PDFs: dispatch a pdf job with this path and your question.` The prober and teacher always have the `pdf` job, and practice has it whenever jobs are available; the PDF pipeline is unchanged.
3. **Convertible document** (detection above): files over 16 MiB are refused by `stat` before they are read. The converted text is then paged by `read`'s existing `offset`/`limit` and its 2,000-line / 50 KB slices, with the usual continuation notices. Line numbers refer to the converted text. The converted text starts with one header line and a blank line:
   - `[Converted from docx to text.]` for every format but spreadsheets;
   - for xlsx and ods: `[Converted from xlsx to text. Sheets: Sales (1,204 rows, line 3), Notes (12 rows, line 1,209)]`, where the line is the `## Sheet:` heading's line number in what `read` returns, and rows counts the non-empty lines under it.
4. **Old binary Office files** (OLE signature `D0 CF 11 E0 A1 B1 1A E1`): error `This is an old binary Office file (.doc, .xls or .ppt), which read can't convert. Ask the learner to save it as .docx, .xlsx or .pptx.`
5. **Other binary files** (a NUL byte in the first 8 KB, the same check Extract files uses): error `<path> is a binary file and can't be read as text.` (a zip that isn't a document says `is a zip archive` instead of `is a binary file`).
6. **Everything else**: read as UTF-8 text, exactly as today. CSV and TSV files are plain text and stay on this path.

Conversion failures are thrown errors, which pi shows the model as a failed tool result:

| Reason | Message |
|---|---|
| too-large | `<name> is larger than 16 MiB, the limit for converting documents.` |
| encrypted | `<name> is password-protected or encrypted, so its text can't be read.` |
| invalid | `<name> isn't a valid <format> file.` |
| empty | `<name> has no text to read.` |
| timeout | `Converting <name> took longer than 15 s and was stopped.` |
| failed | `Could not convert <name> to text.` |

Exception: for the two text-based formats (rtf, ipynb), an `invalid` failure falls back to the plain-text read with the first line `[Could not convert this as <format>; showing the raw file.]`, since the raw text is still useful. The fallback applies only when the file isn't binary (no NUL byte in the first 8 KB); a binary one fails as `invalid` (owner, 2026-11-17, after the prove run).

### `read` tool description

Current: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ...`

New (only the first two sentences change; the rest stays verbatim):
`Read the contents of a file. Supports text files, images (jpg, png, gif, webp, bmp) and documents (docx, xlsx, pptx, odt, ods, odp, rtf, epub, ipynb). Images are sent as attachments; documents are converted to text. For text files, output is truncated to ...`

The prompt fragments already route PDFs to the `pdf` job and need no change.

### Packaging

- `package.json`: `saxes` 6.0.0, `yauzl` ^3.4.0, `character-entities` 2.0.2; `@types/yauzl` ^3.4.0 as a dev dependency.
- `next.config.ts` `outputFileTracingIncludes`: `src/agent/documents/*.mjs`, `src/agent/documents/LICENSE`, and the worker's runtime packages (`saxes`, `xmlchars`, `yauzl`, `pend`, `character-entities`), because the tracer can't see the child process's imports (same reason the image worker's files are listed).

### Tests

- `tests/document-text.test.ts`: T3's "preserves office structure and EPUB reading order with bounded archives" table (about 40 cases built with its in-test zip writer) ported to `node:test`, plus T3's notebook and RTF cases; signature detection cases; the two-slot queue, 15 s timeout (via a test seam) and cache-hit behavior.
- `tests/fixtures/documents/`: one small real file per format, made with pandoc, LibreOffice or Python libraries, and a test that reads each through `read` and finds its known text.
- `tests/read-tool.test.ts`: docx conversion and the header line, the xlsx sheet index with correct line numbers, `offset` paging over converted text, the PDF message, the OLE message, the binary refusal, the rtf/ipynb raw fallback.

## Out of scope

- Extract files accepting these formats (item 26).
- Images, charts and embedded objects inside documents (not extracted, as in T3); rendered slide images.
- A size cap for plain-text reads (only documents get the 16 MiB cap).
- Old binary `.doc`/`.xls`/`.ppt` conversion.

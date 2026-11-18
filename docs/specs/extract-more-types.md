# More file types in Extract files (roadmap item 26)

Status: approved by the owner on 2026-11-17.

Goal: the graph's **Extract files** takes Office and OpenDocument documents, RTF, EPUB, notebooks, images (including HEIC phone photos) and code, single files or whole folders, reusing item 25's converter layer (`src/agent/documents/`).

## Decided by the owner

1. **Documents in:** docx, pptx, odt, odp, rtf, epub, ipynb. **Spreadsheets out:** xlsx, ods and csv stay refused by Extract files (`read` keeps reading them).
2. **Images in:** jpg, jpeg, png, gif, webp, bmp, heic, heif. Each image gets one call on the **Vision slot** model, which writes its text and diagrams as Markdown; that Markdown then goes through the normal notes extraction. A Vision model that can't take images refuses the file.
3. **Code in**, single files and folders, extracted as concepts, APIs and design decisions, not line by line.
4. **One Folder item** handles every folder (no separate "code folder" mode). Every folder pick honors `.gitignore`, applies the default excludes, and shows an estimate with Extract / Cancel before anything runs. Picking individual files starts right away, as today.
5. **Grouping:** all plain code files of a picked folder form **one source** named after the folder, read together in path order so ideas can span files. Notes, documents, PDFs and images stay one source per file. A single code file picked with Files is its own source.
6. **Code caps** (per folder, after ignores and excludes): 500 code files, 2 MB of code text, and code files over 100 KB are skipped as too large. Over the file or total cap, the folder's code is skipped with `Code skipped: over the 500-file / 2 MB limit. Pick a smaller folder.`; the rest of the folder can still be extracted.
7. **Default excludes**, on top of today's hidden-file rule and `.gitignore`: folders `node_modules`, `vendor`, `dist`, `build`, `out`, `target`, `__pycache__`, `venv`, `coverage`, `bin`, `obj`; files `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `poetry.lock`, `Gemfile.lock`, `composer.lock`, `go.sum`, `*.min.js`, `*.min.css`, `*.map`.
8. **Prompts:** documents and image descriptions use today's notes prompt unchanged. Code gets its own goal and selection paragraphs (wording below); the shared rules are identical.
9. **Estimate** is computed in the browser: text and code measured exactly, images priced per image, PDFs and documents guessed from file size and marked rough. Rates come from the current models through a small server endpoint.

## Adopted from T3 Code (veto any)

- **HEIC conversion in the browser** with `heic-to` (T3 pins `^1.5.2`, LGPL-3.0, compatible with LearnHarness's AGPL-3.0; loaded only when a HEIC file is picked), as T3's `imageCompression.ts`: a file is HEIC by MIME `image/heic|heif`, or by extension when the MIME is empty or `application/octet-stream`; images over 64 megapixels are refused before decoding; decoded to JPEG at quality 0.92 and uploaded as `<name>.jpg`. The source keeps the original path (`photo.heic`).
- **`.gitignore` matching:** port T3's `apps/server/src/workspace/IgnorePatterns.ts` (MIT, notice kept) to `lib/ignore-patterns.ts`. Every `.gitignore` inside the picked folder applies to paths below its own folder; a deeper file's last matching rule wins, as in git. An ignored folder hides everything under it.
- **Two conversions at once** (item 25 carry-over): the converter keeps T3's two slots. Extract files runs three files at a time, so at most two convert while the third waits; memory peaks near 1 GB only when two documents both hit the 192 MB heap limit, which real files don't.
- **Converter failure logging** (item 25 carry-over): T3 logs a warning on failure. Here the converter child's stderr is kept (last 4 KB) and `failed` and `timeout` results log one `console.error` line with the format, reason, detail and stderr tail.

## Design

### Accepted types (`lib/notes-import-limits.ts`)

The one list stays the source of truth for the picker `accept`, the client check and the server check, now split by kind:

| Kind | Extensions | Becomes |
|---|---|---|
| notes | txt, md, markdown, rst, org, adoc, tex | text as today |
| pdf | pdf | page Markdown as today |
| document | docx, pptx, odt, odp, rtf, epub, ipynb | item 25 converter text |
| image | jpg, jpeg, png, gif, webp, bmp, heic, heif | Vision description |
| code | see below | code text, concepts prompt |

Code extensions: c, h, cc, cpp, cxx, hpp, hh, hxx, cs, go, rs, java, kt, kts, scala, swift, m, mm, py, pyi, rb, php, pl, pm, lua, r, jl, dart, ex, exs, erl, hrl, hs, ml, mli, fs, fsx, clj, cljs, cljc, elm, js, jsx, mjs, cjs, ts, tsx, mts, cts, vue, svelte, astro, css, scss, sass, less, html, htm, sql, sh, bash, zsh, fish, ps1, bat, proto, graphql, gql, sol, zig, nim, vhd, vhdl, sv, asm, tf, hcl, nix, groovy, gradle, cmake, json, yaml, yml, toml; and by exact name: `Makefile`, `Dockerfile`, `Containerfile`, `Justfile`, `Rakefile`, `Gemfile`, `CMakeLists.txt`.

`UNSUPPORTED_TYPE_MESSAGE` becomes `This file type isn't supported. Use text, Markdown, PDF, documents, images, or code.` The client's skip summary says `files that aren't a supported type` with the extensions listed, as today.

### Server, per file (`app/api/graph/import/route.ts`)

`readNotesFile` routes by kind (the extension list gates first; signatures confirm):

- **PDF:** unchanged.
- **Document:** `detectDocumentFormat(name, bytes)` then `convertDocument(bytes, format)`. Failures use item 25's `conversionFailureMessage`. An OLE file (old `.doc`/`.ppt`) named anything but docx/pptx says `This is an old binary Office file. Save it as .docx or .pptx first.` For rtf and ipynb an `invalid` result falls back to the raw text, as `read` does. A truncated conversion completes with the notice `Text was cut at the conversion limits.`
- **Image:** `processImage` (resized to the Vision model's limits), then one Vision call (below). Completes with the notice `Described by the vision model; details may be wrong.`
- **Code:** decoded as UTF-8 after the NUL-byte binary check; extracted with the code prompt.
- **Notes:** unchanged.

`NotesImportInput` gains `kind: "notes" | "code"` (default notes) choosing the extractor prompt. Image descriptions and documents are `notes`.

### Image description

- A new model role `imageReader` on the Vision slot (like `pdfReader`: not a per-role override in Settings). Its usage is recorded on the source's import job under role `imageReader`, so it shows in the activity dock and the source's cost.
- Prompt (system), for owner approval:

> You turn one image from a learner's study material into text, so its content can be added to their knowledge graph. Transcribe all legible text exactly, in reading order, as Markdown (headings, lists, tables). Write equations in LaTeX. Describe each diagram, chart or figure: what it shows, its labels, and the relationships or values it conveys. Transcribe handwriting; mark words you can't read as [illegible]. Do not add knowledge the image doesn't contain. If the image has nothing to learn from, reply with one sentence saying what it shows.

- User message: the image plus `File: <path>`. No tools; the reply text is the description. An empty reply fails the file with `The vision model returned no description.`

### Code prompt (for owner approval)

Built with the existing `composeExtractionInstructions(preamble, goal, selection)`; the entailment, knowledge, standalone, continuation and submission sections are shared verbatim.

- **Preamble:** `You are the extraction stage of a learning application. You read one stretch of a source (a codebase's files in path order, each under a "## File:" heading) and report what it teaches as findings for the learner's global knowledge graph, building on everything already extracted from this source.`
- **Goal:** `THE GOAL: bring the knowledge this code teaches into the learner's knowledge graph: the concepts it implements, the APIs and libraries it relies on and how they work, and the design decisions it embodies with the reasons for them. Code is not a lesson: the deliverable is what a reader learns by studying it, not a description of the code.`
- **Selection:** `Keep ideas that hold beyond this codebase: how an algorithm, protocol, data structure or library API works, what a pattern achieves, why a design choice fits its constraints. Do not report line-by-line behavior, inventories of files or functions, identifiers, configuration values, or project trivia. Use chains where the code's structure justifies a conclusion; otherwise record bare ideas.`

### Grouped code (folder picks)

- The client sends one request for the folder's code: every code file with its relative path, plus the form field `group` set to the folder name. The server re-checks the caps, the code extensions and the binary check, then builds one text in path order:

  ````
  ## File: my-app/src/db.ts

  ```ts
  <file text>
  ```
  ````

  (the fence is longer than any backtick run in the file). The source's path is the folder name (`my-app`), so re-extracting the same folder updates the same source.
- Chunking keeps files whole where they fit the chunk budget; a file larger than one chunk is split by lines, and each continuation chunk starts with `## File: <path> (continued)`.
- The response has one result row for the group; the dock and error list show it as `my-app (N code files)`.

### Folder picks in the browser

1. Read every `.gitignore` in the pick (before the hidden-file rule drops them), then drop hidden paths, ignored paths and default excludes.
2. Sort the rest by kind. Unsupported types, files over 25 MB, too-large code files (over 100 KB) and unsafe names are counted.
3. Measure: notes and code by characters (`File.text()`), images by count, PDFs and documents by bytes.
4. `POST /api/graph/import/estimate` with those measures; it returns tokens and dollars (below).
5. Show the dialog, then on Extract queue the per-file sources and the code group into today's three-wide queue. Cancel discards the pick.

Dialog (an existing app dialog component):

```
Extract my-app?
12 notes and documents, 3 images, 48 code files (one source)
Skipped: 2,310 ignored or excluded, 4 too large, 9 unsupported
About 180,000 tokens, about $0.42 (rough)
                                   [Cancel] [Extract]
```

`(rough)` appears when PDFs or documents are in the pick. With a subscription or unpriced model the cost line reads `About 180,000 tokens; cost not estimated for <model>.` A folder with nothing to extract shows only the skipped line and a Close button.

### Estimate endpoint (`POST /api/graph/import/estimate`)

Input: `{ notesChars, codeChars, images, pdfBytes, documentBytes }`. Output: `{ tokens, usd: number | null, rough: boolean }`.

- Source tokens: characters / 4 (the app's convention); PDFs and documents: bytes times a per-kind characters-per-byte ratio, then / 4.
- Extraction cost: source tokens times measured input and output multipliers (covering the prompt, the growing source digest and the auditor), priced with `callCost` at the extractor's and auditor's current models.
- Images: one Vision call each at a fixed token allowance, priced at the Vision model, plus extraction of a description of fixed size.
- The ratios, multipliers and allowances are measured on the real test runs in this PR and recorded here before merge.

### Item 25 carry-overs

- Logging and concurrency: see "Adopted from T3".
- A workbook with no sheets: `read`'s header says `Sheets: none` instead of `Sheets: ]`.
- An OLE file over 16 MiB named `.docx`/`.xlsx`/`.pptx`: `read` and `convertDocument` check the OLE signature before the size, so it gets the password-protected message.

### Tests

- `tests/notes-import.test.tsx`: accepted kinds, folder filtering (`.gitignore` with nesting and negation, default excludes, hidden files), caps and their messages, the grouped request, the estimate dialog (Extract, Cancel, rough, unpriced), HEIC detection.
- `tests/ignore-patterns.test.ts`: T3's ignore-pattern cases.
- Route tests: each document format from item 25's fixtures, OLE and spreadsheet refusals, image description through a stub Vision engine, grouped code text and chunking, server-side cap checks, the estimate endpoint.
- Converter: stderr tail logged for a crashing child; the two carry-over cases.
- Real run: one sample of each new type (including a HEIC photo) and a small real code folder through the running app, checked in the graph.

## Out of scope

- Spreadsheets and CSV in Extract files.
- Images inside documents, slide renders, OCR for scanned PDFs.
- HEIC in the agent's `read` tool.
- A per-role Settings override for the image reader.

# Extract files

The learner adds their own material to the knowledge graph without a session: notes (txt, md, ...), PDFs, Office and OpenDocument documents, RTF, EPUB, notebooks, images (HEIC photos too) and code, as single files or a whole folder. Each file (and a folder's code, grouped) goes through the extractor, the auditor and the merger; images are first described by the Vision slot. A folder pick is reviewed first (counts, skips, a cost estimate, Extract / Cancel).

## Sub-features

- `files`: pick files; each becomes its own source and runs at once, three at a time.
- `folder-review`: pick a folder; the review dialog shows contents, skipped counts, code caps and the estimate; Extract is disabled while the estimate loads; Cancel discards the pick.
- `folder-filter`: hidden paths, every `.gitignore` in the pick, and the default excludes are dropped before anything is counted or sent.
- `code-group`: a folder's code files become one source named after the folder, sent as one request with the form field `group`.
- `image`: an image (HEIC converted to JPEG in the browser) gets one Vision call, then normal notes extraction.
- `documents`: docx, pptx, odt, odp, rtf, epub, ipynb go through the document converter.
- `estimate`: `POST /api/graph/import/estimate`, priced at the current slot models.
- `refusals`: unsupported types (spreadsheets, csv, svg ...) are skipped in the browser; the server refuses unreadable, encrypted, old-binary and non-text files per file.

## How to get to it

- Graph view (`/` with graph rendering on): the `Extract files…` button (`data-testid="import-notes"`), then the menu items `Files` (the `input[type=file][multiple]` picker, `accept` lists the extensions) or `Folder` (the `input[type=file][webkitdirectory]` picker).
- Minimal home (graph rendering off): the same control.
- API: `POST /api/graph/import` (multipart: `files`, `paths`, optional `group`), `POST /api/graph/import/estimate` (JSON measures).
- Progress: the button reads `Extracting…`; runs show in `GET /api/graph/status` (`runs[].label`, `phase`); results land in `GET /api/graph/sources`, `GET /api/graph`, `GET /api/graph/costs` and `data/graph/sources.json`.

## Driving it

Preconditions: the baseline, but start the instances with the extraction scenario: `scripts/start.sh "$RUN" head scenarios/extract-files.json` (and base). Teaching drives need `teach-read.json`, so use a separate run folder for them. `scenarios/extract-files.json` names the extractor's one proposition after the source path it was shown (`zz-prove-it notes <path>`, `zz-prove-it code <path>`, generic otherwise), links nothing in the auditor, and answers the image reader with `PROVE-IMAGE-DESC for File: <path>`. Add a per-path rule there when you want a named node for a new sample.

1. Files: `node scripts/extract-files.mjs "$H" <label> --files <path>...` (about 5 s for a dozen small files). It clicks `import-notes`, then `Files`, and accepts the native chooser with the paths. Afterwards `$SIDE/extract-files/<label>/result.json` has the error lines (`[role=alert]`), notices (`[role=status]`), every `/api/graph/import` response, new sources and nodes, costs, and each model request (rule, model, tools, last message text, images sent as data-URL heads).
2. Folder, extract: `node scripts/extract-files.mjs "$H" <label> --folder <dir>`. The drive waits for `folder-review-dialog`, records `folder-review-contents`, `-skipped`, `-code-skipped`, `-estimate` and the state of `folder-review-confirm`, then clicks Extract. Add `--slow-estimate` to hold the estimate answer 3 s: `reviewFirst` then shows the loading state, and the drive clicks Extract during it (`clickWhileLoading`).
3. Folder, cancel: add `--cancel`; for a folder with nothing to extract add `--close-empty` (the dialog shows Close only). `afterCancel` counts import posts and model requests after the click.
4. The text the extractor saw is in `model-requests.jsonl`: for documents, compare it with `node src/agent/documents/document-text-worker.mjs .<ext> < file` (the converter itself); for code, look for `SOURCE (a codebase): <folder>` and the `## File:` headings.
5. Estimate: POST JSON measures with `origin: $APP_URL`. To price it, `PUT /api/settings/models` with built-in models (for example `anthropic`/`claude-haiku-4-5` in all three slots): pricing needs no key. The custom fake models are always unpriced.
6. Existing flows on base: the same `--files` drive with md, txt and a PDF on both sides, then compare the alerts, notices, responses, sources, nodes, model rules, extractor input and system prompts, and cost runs.

Samples: `tests/fixtures/documents/` (all document types plus xlsx and ods), `tests/fixtures/images/` (png, heic), `tests/fixtures/sample-3page.pdf`. Build folders and edge files yourself in the run folder: a `.gitignore` with a negation, a nested `.gitignore` (with a BOM), default-excluded folders and lock files, hidden files, a code file over 100 KB, a UTF-16 code file, `Makefile` and `CMakeLists.txt`, 501 small code files (file cap), 21 files of 99 KB (2 MB cap), a 79 KB code file (split into chunks), a 16 MiB + 1 OLE file named `.docx`, a 16 MB `{"cells":[{},...]}` notebook (crashes the converter at the 192 MB heap), and a docx with over 1,000,000 characters (truncation notice).

## Gotchas

- Puppeteer's `FileChooser.accept([dir])` on the Folder input gives a real `webkitdirectory` pick, and Chrome sends each file's multipart filename as its full relative path (`folder/sub/name`), not the basename. A server check on `file.name` sees the path.
- The fake model answers in milliseconds: `runLabels` (polled every 150 ms) catches only some dock labels. Multi-chunk sources (a big file or a real repo) show the group label `<folder> (N code files) · i/n`.
- The custom endpoint's models always accept images, so the "can't take images" refusal is not reachable with the fake model.
- `GET /api/graph/costs` is cumulative per instance: compare run entries by title, or use a fresh instance.
- The graph view has a pre-existing axe `button-name` (critical) once nodes exist, the same on base.
- Re-extracting a folder updates the source of the same name (same id, more `extractions` entries).

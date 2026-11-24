// Roadmap item 26 (docs/specs/extract-more-types.md): Extract files takes documents, images and code.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { POST } from "../app/api/graph/import/route.ts";
import { POST as ESTIMATE } from "../app/api/graph/import/estimate/route.ts";
import { extraction, sourceDirectory } from "../src/server/index.ts";
import { chunkCode, CODE_EXTRACTOR_INSTRUCTIONS, createExtractionPipeline, IMAGE_READER_INSTRUCTIONS, NOTES_EXTRACTOR_INSTRUCTIONS, renderCodeFile } from "../src/agent/subagents/extraction.ts";
import { stores } from "../src/server/stores.ts";
import type { GraphStore } from "../src/core/ports.ts";
import type { GraphChain, GraphNode, NotesSource } from "../src/core/contracts.ts";
import { CODE_CAP_MESSAGE, importKind, MAX_CODE_FILES } from "../lib/notes-import-limits.ts";
import { estimateImport } from "../lib/notes-import-estimate.ts";
import { planFolder, planSummaries } from "../components/notes-import-folder.ts";
import { folderReviewLines } from "../components/notes-import.tsx";
import { isHeicImageFile, validateHeicImageDimensions } from "../lib/heic.ts";
import { graphCostSummary } from "../src/core/cost-summary.ts";
import type { PiEngine } from "../src/agent/models.ts";

const original = extraction.importNotes;
const realRegister = sourceDirectory.registerImport;
after(() => { extraction.importNotes = original; sourceDirectory.registerImport = realRegister; });
sourceDirectory.registerImport = () => {};
const fixture = (name: string) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
type Captured = Parameters<typeof extraction.importNotes>[0];
function capture(): Captured[] {
	const seen: Captured[] = [];
	extraction.importNotes = async (input) => { seen.push(input); return { nodes: 1, chains: 0 }; };
	return seen;
}
function upload(files: { name: string; bytes: Uint8Array<ArrayBuffer> | string; path?: string }[], group?: string) {
	const form = new FormData();
	for (const { name, bytes, path } of files) {
		form.append("files", new File([bytes], name));
		form.append("paths", path ?? name);
	}
	if (group !== undefined) form.append("group", group);
	return new Request("http://localhost/api/graph/import", { method: "POST", body: form });
}
const resultsOf = async (request: Request) => (await (await POST(request)).json()).results as Array<{ filePath: string; ok: boolean; outcome: string; error?: string; notice?: string }>;

// ── kinds ──

it("kinds: the seven document formats, images with HEIC, code by extension and by name; spreadsheets stay out", () => {
	for (const name of ["a.docx", "a.PPTX", "a.odt", "a.odp", "a.rtf", "a.epub", "a.ipynb"]) assert.equal(importKind(name), "document", name);
	for (const name of ["a.jpg", "a.JPEG", "a.png", "a.gif", "a.webp", "a.bmp", "a.heic", "a.HEIF"]) assert.equal(importKind(name), "image", name);
	for (const name of ["a.ts", "a.py", "a.rs", "a.json", "a.yml", "Makefile", "Dockerfile", "CMakeLists.txt"]) assert.equal(importKind(name), "code", name);
	for (const name of ["a.xlsx", "a.ods", "a.csv", "a.doc", "a.class", "LICENSE", "makefile.bak"]) assert.equal(importKind(name), undefined, name);
	assert.equal(importKind("notes.txt"), "notes");
	// Chromium sends a folder pick's relative path as the file name (prove run, 2026-11-17).
	assert.equal(importKind("my-app/Makefile"), "code");
	assert.equal(importKind("my.app/CMakeLists.txt"), "code");
	assert.equal(importKind("my.app/README"), undefined);
});

// ── route: documents ──

it("each document fixture reaches the pipeline as converted text", async () => {
	const seen = capture();
	const names = ["sample.docx", "sample.pptx", "sample.odt", "sample.odp", "sample.rtf", "sample.epub", "sample.ipynb"];
	const results = await resultsOf(upload(names.map((name) => ({ name, bytes: fixture(`documents/${name}`) }))));
	assert.ok(results.every((r) => r.ok), JSON.stringify(results));
	for (const name of names) {
		const input = seen.find((s) => s.filePath === name)!;
		assert.ok(input.text.trim().length > 20, name);
		assert.ok(!input.text.includes("PK\u0003\u0004"), `${name} is converted, not raw zip`);
		assert.equal(input.codeFiles, undefined);
	}
	assert.match(seen.find((s) => s.filePath === "sample.pptx")!.text, /## Slide 1/);
});

it("document refusals: old Office, password-protected OOXML, invalid zips; rtf and ipynb fall back to raw text", async () => {
	const seen = capture();
	const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]);
	const results = await resultsOf(upload([
		{ name: "old.odt", bytes: ole }, { name: "locked.docx", bytes: ole }, { name: "broken.pptx", bytes: "not a zip" },
		{ name: "notes.rtf", bytes: "plain words, not rtf" }, { name: "cells.ipynb", bytes: "{ not json" },
	]));
	const error = (name: string) => results.find((r) => r.filePath === name)!.error;
	assert.equal(error("old.odt"), "This is an old binary Office file. Save it as .docx or .pptx first.");
	assert.equal(error("locked.docx"), "locked.docx is password-protected or encrypted, so its text can't be read.");
	assert.equal(error("broken.pptx"), "broken.pptx isn't a valid pptx file.");
	assert.deepEqual(seen.map((s) => [s.filePath, s.text]).sort(), [["cells.ipynb", "{ not json"], ["notes.rtf", "plain words, not rtf"]]);
});

// ── route: images and code ──

it("an image goes to the pipeline as image bytes with the vision notice; an unreadable one is refused", async () => {
	const seen = capture();
	const results = await resultsOf(upload([{ name: "board.png", bytes: fixture("images/sample.png") }, { name: "raw.heic", bytes: fixture("images/sample.heic") }]));
	const board = results.find((r) => r.filePath === "board.png")!;
	assert.equal(board.ok, true);
	assert.equal(board.notice, "Described by the vision model; details may be wrong.");
	assert.equal(seen[0]!.image!.mimeType, "image/png");
	assert.equal(seen[0]!.image!.bytes.byteLength, fixture("images/sample.png").byteLength);
	assert.equal(results.find((r) => r.filePath === "raw.heic")!.error, "Could not read this image.", "unconverted HEIC bytes are not an image the server reads");
	assert.equal(seen.length, 1);
});

it("a single code file is its own source with the code input; a binary one is refused", async () => {
	const seen = capture();
	const results = await resultsOf(upload([{ name: "queue.ts", bytes: "export const x = 1;\n", path: "Course/queue.ts" }, { name: "blob.py", bytes: new Uint8Array([0x61, 0, 0x62]) }]));
	assert.deepEqual(seen.map((s) => [s.filePath, s.codeFiles]), [["Course/queue.ts", [{ path: "Course/queue.ts", text: "export const x = 1;\n" }]]]);
	assert.equal(results.find((r) => r.filePath === "blob.py")!.error, "This file isn't plain text.");
});

it("a folder's code group is one source named after the folder, files in path order, with a file-count label", async () => {
	const seen = capture();
	const results = await resultsOf(upload([
		{ name: "b.ts", bytes: "b", path: "my-app/src/b.ts" }, { name: "a.ts", bytes: "a", path: "my-app/src/a.ts" }, { name: "Makefile", bytes: "all:", path: "my-app/Makefile" },
	], "my-app"));
	assert.deepEqual(results.map((r) => [r.filePath, r.ok]), [["my-app", true]]);
	assert.equal(seen.length, 1);
	assert.equal(seen[0]!.filePath, "my-app");
	assert.equal(seen[0]!.label, "my-app (3 code files)");
	assert.deepEqual(seen[0]!.codeFiles!.map((f) => f.path), ["my-app/Makefile", "my-app/src/a.ts", "my-app/src/b.ts"]);
});

it("a code group whose multipart names are relative paths (Chromium) keeps name-only code files", async () => {
	const seen = capture();
	const form = new FormData();
	for (const [name, path] of [["app/Makefile", "app/Makefile"], ["app/src/CMakeLists.txt", "app/src/CMakeLists.txt"], ["app/a.ts", "app/a.ts"]]) {
		form.append("files", new File(["x"], name!));
		form.append("paths", path!);
	}
	form.append("group", "app");
	const results = await resultsOf(new Request("http://localhost/api/graph/import", { method: "POST", body: form }));
	assert.deepEqual(results.map((r) => [r.filePath, r.ok]), [["app", true]]);
	assert.deepEqual(seen[0]!.codeFiles!.map((f) => f.path), ["app/a.ts", "app/Makefile", "app/src/CMakeLists.txt"]);
});

it("the server re-checks a code group: caps, per-file size, binaries, and malformed groups", async () => {
	const seen = capture();
	const many = Array.from({ length: MAX_CODE_FILES + 1 }, (_, i) => ({ name: `f${i}.ts`, bytes: "x", path: `app/f${i}.ts` }));
	assert.equal((await resultsOf(upload(many, "app")))[0]!.error, CODE_CAP_MESSAGE);
	assert.equal((await resultsOf(upload([{ name: "big.ts", bytes: "x".repeat(100 * 1024 + 1), path: "app/big.ts" }], "app")))[0]!.error, "app/big.ts is over 100 KB, the limit for one code file.");
	assert.equal((await resultsOf(upload([{ name: "bin.ts", bytes: new Uint8Array([0]), path: "app/bin.ts" }], "app")))[0]!.error, "app/bin.ts isn't plain text.");
	for (const [files, group] of [
		[[{ name: "notes.md", bytes: "x", path: "app/notes.md" }], "app"],
		[[{ name: "a.ts", bytes: "x", path: "other/a.ts" }], "app"],
		[[{ name: "a.ts", bytes: "x", path: "app/a.ts" }], "app/sub"],
	] as const) assert.equal((await POST(upload([...files], group))).status, 400);
	assert.equal(seen.length, 0);
});

// ── pipeline ──

function memoryGraph() {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const sources = new Map<string, NotesSource>();
	const graphStore: GraphStore = {
		appendNode: (node) => { nodes.push(node); }, readNodes: () => [...nodes],
		appendChain: (chain) => { chains.push(chain); }, readChains: () => [...chains],
		appendCheckpoint: () => {}, readCheckpoints: () => [],
		appendCoverage: () => {}, readCoverage: () => [],
		upsertSource: (source) => { sources.set(source.id, { ...source, extractions: sources.get(source.id)?.extractions ?? [] }); },
		readSources: () => [...sources.values()],
		deleteSources: () => 0,
		appendSourceUsage: (id, usage) => { sources.get(id)!.extractions!.push(usage); },
		readPositions: () => ({}), writePositions: () => {}, rewriteLedgers: () => {},
	};
	return { nodes, sources, graphStore };
}
function fauxEngine(reply: (context: unknown) => ReturnType<typeof fauxAssistantMessage>, imageInput = true): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(Array.from({ length: 20 }, () => (context: unknown) => reply(context)));
	const model = faux.getModel();
	return { model: { ...model, input: imageInput ? ["text", "image"] : ["text"] }, streamFn: faux.streamSimple, level: "off" } as unknown as PiEngine;
}
const submit = (name: string) => fauxAssistantMessage([fauxToolCall("submit_findings", { propositions: [{ id: "p1", name, statement: `${name} holds.`, aliases: [] }], chains: [] })], { stopReason: "toolUse" });
const review = () => fauxAssistantMessage([fauxToolCall("submit_review", { links: [] })], { stopReason: "toolUse" });

it("an image is described by the Vision engine, extracted with the notes prompt, and its usage is recorded as imageReader", async () => {
	const { nodes, sources, graphStore } = memoryGraph();
	const extractorContexts: string[] = [];
	let visionContext = "";
	const pipeline = createExtractionPipeline({ chatStore: stores.chatStore, graphStore,
		imageReader: fauxEngine((context) => { visionContext = JSON.stringify(context); return fauxAssistantMessage([fauxText("# Photosynthesis\nLight reactions make ATP.")]); }),
		extractor: fauxEngine((context) => { extractorContexts.push(JSON.stringify(context)); return submit("Light reactions"); }),
		auditor: fauxEngine(() => review()),
	});
	const stats = await pipeline.importNotes({ filePath: "Course/board.png", text: "", image: { bytes: fixture("images/sample.png"), mimeType: "image/png" } });
	assert.equal(stats.nodes, 1);
	assert.equal(nodes.length, 1);
	assert.ok(visionContext.includes(JSON.stringify(IMAGE_READER_INSTRUCTIONS).slice(1, 60)), "the image reader prompt");
	assert.match(visionContext, /"type":"image"/);
	assert.match(visionContext, /File: Course\/board.png/);
	assert.match(extractorContexts[0]!, /Light reactions make ATP/);
	assert.ok(extractorContexts[0]!.includes(JSON.stringify(NOTES_EXTRACTOR_INSTRUCTIONS).slice(1, 80)), "documents and images keep the notes prompt");
	const usage = [...sources.values()][0]!.extractions![0]!;
	assert.equal(usage.stages.imageReader!.steps.length, 1);
	assert.equal(usage.stages.extractor.steps.length, 1);
});

it("a Vision model that can't take images fails the file; a missing Vision slot is a config refusal", async () => {
	const { graphStore } = memoryGraph();
	const textOnly = createExtractionPipeline({ chatStore: stores.chatStore, graphStore,
		imageReader: fauxEngine(() => fauxAssistantMessage([fauxText("x")]), false), extractor: fauxEngine(() => submit("x")), auditor: fauxEngine(() => review()) });
	await assert.rejects(textOnly.importNotes({ filePath: "a.png", text: "", image: { bytes: fixture("images/sample.png"), mimeType: "image/png" } }), /can't take images\. Pick one that can in Settings > Models\./);
	const noVision = createExtractionPipeline({ chatStore: stores.chatStore, graphStore,
		engineFor: (role) => role === "imageReader" ? undefined : fauxEngine(() => submit("x")) });
	await assert.rejects(noVision.importNotes({ filePath: "b.png", text: "", image: { bytes: fixture("images/sample.png"), mimeType: "image/png" } }), (err: Error) => err.name === "ModelsNotConfiguredError" || /vision/.test(err.message));
	const empty = createExtractionPipeline({ chatStore: stores.chatStore, graphStore,
		imageReader: fauxEngine(() => fauxAssistantMessage([fauxText("   ")])), extractor: fauxEngine(() => submit("x")), auditor: fauxEngine(() => review()) });
	await assert.rejects(empty.importNotes({ filePath: "c.png", text: "", image: { bytes: fixture("images/sample.png"), mimeType: "image/png" } }), /The vision model returned no description\./);
});

it("code is extracted with the code prompt, files under ## File: headings", async () => {
	const { graphStore } = memoryGraph();
	const contexts: string[] = [];
	const pipeline = createExtractionPipeline({ chatStore: stores.chatStore, graphStore,
		extractor: fauxEngine((context) => { contexts.push(JSON.stringify(context)); return submit("Bounded concurrency"); }), auditor: fauxEngine(() => review()) });
	await pipeline.importNotes({ filePath: "p-limit", label: "p-limit (2 code files)", text: "", codeFiles: [{ path: "p-limit/index.js", text: "export default function pLimit() {}" }, { path: "p-limit/q.js", text: "const q = [];" }] });
	assert.equal(contexts.length, 1);
	assert.ok(contexts[0]!.includes(JSON.stringify(CODE_EXTRACTOR_INSTRUCTIONS).slice(1, 80)));
	assert.match(contexts[0]!, /SOURCE \(a codebase\): p-limit/);
	assert.match(contexts[0]!, /## File: p-limit\/index.js/);
	assert.match(contexts[0]!, /## File: p-limit\/q.js/);
});

it("chunkCode keeps files whole when they fit and splits a large file with continued headings", () => {
	const small = [{ path: "a/x.ts", text: "one\ntwo" }, { path: "a/y.ts", text: "three" }];
	assert.deepEqual(chunkCode(small, 4096), [`${renderCodeFile("a/x.ts", "one\ntwo")}\n\n${renderCodeFile("a/y.ts", "three")}`]);
	const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
	const chunks = chunkCode([{ path: "a/big.ts", text: lines }, { path: "a/z.ts", text: "tail" }], 1000);
	assert.ok(chunks.length >= 4);
	assert.match(chunks[0]!, /^## File: a\/big.ts\n/);
	assert.match(chunks[1]!, /^## File: a\/big.ts \(continued\)\n/);
	for (const chunk of chunks) assert.ok(Math.ceil(chunk.length / 4) <= 1000, `chunk within budget (${chunk.length})`);
	assert.match(chunks.at(-1)!, /## File: a\/z.ts/);
	const joined = chunks.join("\n");
	for (let i = 0; i < 400; i++) assert.ok(joined.includes(`line ${i} `), `line ${i} kept`);
	assert.equal(renderCodeFile("a/f.md", "has ``` inside"), "## File: a/f.md\n\n````md\nhas ``` inside\n````");
});

it("cost summary folds an image's description into the extraction stage and the run", () => {
	const step = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 };
	const summary = graphCostSummary({ chats: [], namings: [], sources: [{ filePath: "a.png", extractions: [{ startedAt: 1, at: "2026-11-17T00:00:00Z", durationMs: 1,
		stages: { extractor: { model: "m:e", steps: [step] }, auditor: { model: "m:a", steps: [step] }, imageReader: { model: "m:v", steps: [step] } } }] }] } as never, () => 1);
	assert.equal(summary.stages.extraction.dollars, 2);
	assert.equal(summary.runs[0]!.dollars, 3);
	const mixed = graphCostSummary({ chats: [], namings: [], sources: [{ filePath: "b.png", extractions: [{ startedAt: 2, at: "2026-11-17T00:00:00Z", durationMs: 1,
		stages: { extractor: { model: "m:e", steps: [step] }, auditor: { model: "m:a", steps: [step] }, imageReader: { model: "m:unpriced", steps: [step] } } }] }] } as never, (_call, model) => model === "m:unpriced" ? null : 1);
	assert.equal(mixed.stages.extraction.unpricedRuns, 1, "the unknown Vision cost marks the stage incomplete");
	assert.equal(mixed.stages.extraction.runs, 1);
	const both = graphCostSummary({ chats: [], namings: [], sources: [{ filePath: "c.png", extractions: [{ startedAt: 3, at: "2026-11-17T00:00:00Z", durationMs: 1,
		stages: { extractor: { model: "m:unpriced", steps: [step] }, auditor: { model: "m:a", steps: [step] }, imageReader: { model: "m:unpriced", steps: [step] } } }] }] } as never, (_call, model) => model === "m:unpriced" ? null : 1);
	assert.equal(both.stages.extraction.unpricedRuns, 1, "one run counts once");
	// A subscription part beside an unpriced part carries both marks, once each (owner, 2026-11-17).
	const sub = "chatgpt:gpt-5";
	for (const [extractor, vision] of [[sub, "m:unpriced"], ["m:unpriced", sub]]) {
		const mixedSub = graphCostSummary({ chats: [], namings: [], sources: [{ filePath: "d.png", extractions: [{ startedAt: 4, at: "2026-11-17T00:00:00Z", durationMs: 1,
			stages: { extractor: { model: extractor, steps: [step] }, auditor: { model: "m:a", steps: [step] }, imageReader: { model: vision, steps: [step] } } }] }] } as never, (_call, model) => model === "m:unpriced" ? null : 1);
		assert.equal(mixedSub.stages.extraction.subscriptionRuns, 1, `${extractor} + ${vision}`);
		assert.equal(mixedSub.stages.extraction.unpricedRuns, 1, `${extractor} + ${vision}`);
		assert.equal(mixedSub.stages.extraction.dollars, 0);
	}
	const subVisionPriced = graphCostSummary({ chats: [], namings: [], sources: [{ filePath: "e.png", extractions: [{ startedAt: 5, at: "2026-11-17T00:00:00Z", durationMs: 1,
		stages: { extractor: { model: "m:e", steps: [step] }, auditor: { model: "m:a", steps: [step] }, imageReader: { model: sub, steps: [step] } } }] }] } as never, () => 1);
	assert.deepEqual([subVisionPriced.stages.extraction.subscriptionRuns, subVisionPriced.stages.extraction.unpricedRuns, subVisionPriced.stages.extraction.dollars], [1, 0, 1]);
});

// ── folder picks ──

function picked(path: string, content: string | Uint8Array<ArrayBuffer> = "x", size?: number): File {
	const file = new File([content], path.split("/").at(-1)!);
	Object.defineProperty(file, "webkitRelativePath", { value: path });
	if (size !== undefined) Object.defineProperty(file, "size", { value: size });
	return file;
}

it("planFolder: .gitignore (nested, negated), default excludes, hidden paths, kinds, measures and summaries", async () => {
	const plan = await planFolder([
		picked("app/.gitignore", "*.log\nsecret/\n"), picked("app/scripts/.gitignore", "*.tmp\n!keep.tmp\n"),
		picked("app/index.ts", "const a = 1;"), picked("app/readme.md", "# Readme"), picked("app/board.png"), picked("app/spec.docx", "docx", 1000),
		picked("app/paper.pdf", "pdf", 4000), picked("app/run.log"), picked("app/secret/key.ts"), picked("app/scripts/x.tmp"), picked("app/scripts/keep.tmp"),
		picked("app/node_modules/pkg/index.js"), picked("app/dist/out.js"), picked("app/.github/ci.yml"), picked("app/yarn.lock"), picked("app/bundle.min.js"),
		picked("app/data.xlsx"), picked("app/a:b.md"), picked("app/huge.ts", "x", 100 * 1024 + 1), picked("app/video.md", "x", 26 * 1024 * 1024),
	]);
	assert.equal(plan.root, "app");
	assert.deepEqual(plan.code.map((f) => f.webkitRelativePath), ["app/index.ts"]);
	assert.deepEqual(plan.files.map((f) => f.webkitRelativePath), ["app/board.png", "app/paper.pdf", "app/readme.md", "app/spec.docx"]);
	// .gitignore x2, run.log, secret/, x.tmp, node_modules, dist, .github, yarn.lock, min.js; keep.tmp is unsupported (.tmp)
	assert.equal(plan.ignored, 10);
	assert.deepEqual(plan.unsupported, [".xlsx", ".tmp"]);
	assert.equal(plan.unsafe, 1);
	assert.equal(plan.codeTooLarge, 1);
	assert.deepEqual(plan.oversized, ["app/video.md"]);
	assert.deepEqual(plan.measures, { sources: 5, notesChars: "# Readme".length, codeChars: "const a = 1;".length, images: 1, pdfBytes: 4000, documentBytes: 1000 });
	assert.deepEqual(planSummaries(plan), [
		"app/video.md: Too big. Max 25 MB.",
		"Skipped 2 files that aren't a supported type (.xlsx, .tmp).",
		"Skipped 1 file with a name the import can't use (e.g. a ':' in the name).",
		"Skipped 1 code file over 100 KB.",
	]);
	const lines = folderReviewLines({ plan, estimate: { tokens: 12345, usd: 0.4249, rough: true } });
	assert.deepEqual(lines, { title: "Extract app?", contents: "3 notes and documents, 1 image, 1 code file (one source)",
		skipped: "Skipped: 10 ignored or excluded, 2 too large, 2 unsupported, 1 with unusable names", estimate: "About 12,345 tokens, about $0.42 (rough)", empty: false });
});

it("planFolder: code over the caps is skipped with the cap message while the other files stay", async () => {
	const files = [picked("big/notes.md", "n"), ...Array.from({ length: MAX_CODE_FILES + 1 }, (_, i) => picked(`big/src/f${i}.ts`))];
	const plan = await planFolder(files);
	assert.equal(plan.code.length, 0);
	assert.equal(plan.codeSkipped, CODE_CAP_MESSAGE);
	assert.equal(plan.files.length, 1);
	assert.equal(plan.measures.codeChars, 0);
	assert.ok(planSummaries(plan).includes(`big: ${CODE_CAP_MESSAGE}`));
	assert.equal(folderReviewLines({ plan, estimate: "loading" }).codeSkipped, CODE_CAP_MESSAGE);
	const total = await planFolder([picked("t/a.ts", "x", 100 * 1024), ...Array.from({ length: 20 }, (_, i) => picked(`t/b${i}.ts`, "x", 100 * 1024))]);
	assert.equal(total.codeSkipped, CODE_CAP_MESSAGE, "over 2 MB in total");
});

it("folder review lines: unpriced models, failed estimates, nothing to extract", async () => {
	const plan = await planFolder([picked("n/a.md", "abc")]);
	assert.equal(folderReviewLines({ plan, estimate: { tokens: 100, usd: null, rough: false, unpriced: "claude-code:opus" } }).estimate, "About 100 tokens; cost not estimated for claude-code:opus.");
	assert.equal(folderReviewLines({ plan, estimate: { tokens: 100, usd: 0.001, rough: false } }).estimate, "About 100 tokens, about less than $0.01");
	assert.equal(folderReviewLines({ plan, estimate: "failed" }).estimate, "Could not estimate the cost.");
	assert.equal(folderReviewLines({ plan, estimate: { tokens: 100, usd: null, rough: false, unavailable: "opencode-go:minimax-m3.1-flash-free" } }).estimate,
		"About 100 tokens. The model minimax-m3.1-flash-free from OpenCode Go isn't available right now. It may be retired, or its provider isn't connected or can't be reached. Check Providers in Settings, or pick another model.");
	const empty = await planFolder([picked("e/data.xlsx")]);
	assert.deepEqual(folderReviewLines({ plan: empty, estimate: "failed" }), { title: "Nothing to extract in e", skipped: "Skipped: 1 unsupported", empty: true });
});

// ── estimate ──

it("estimateImport prices extractor, auditor and vision calls; any unpriced model nulls the dollars", () => {
	const priced = (call: { inputTokens: number; outputTokens: number }) => call.inputTokens * 1e-6 + call.outputTokens * 2e-6;
	const models = { extractor: "p:e", auditor: "p:a", imageReader: "p:v" };
	const text = estimateImport({ sources: 1, notesChars: 40_000, codeChars: 0, images: 0, pdfBytes: 0, documentBytes: 0 }, models, priced, 4096);
	assert.equal(text.rough, false);
	assert.ok(text.tokens > 10_000 && text.usd! > 0);
	const withImages = estimateImport({ sources: 1, notesChars: 40_000, codeChars: 0, images: 2, pdfBytes: 0, documentBytes: 0 }, models, priced, 4096);
	assert.ok(withImages.usd! > text.usd!);
	assert.equal(estimateImport({ sources: 1, notesChars: 0, codeChars: 0, images: 0, pdfBytes: 1000, documentBytes: 0 }, models, priced, 4096).rough, true);
	const unpriced = estimateImport({ sources: 1, notesChars: 0, codeChars: 4000, images: 1, pdfBytes: 0, documentBytes: 0 }, models, (call, model) => model === "p:v" ? null : priced(call), 4096);
	assert.deepEqual([unpriced.usd, unpriced.unpriced], [null, "p:v"]);
	// A configured slot the catalog no longer has is unavailable, even when its history still has a price.
	const gone = estimateImport({ sources: 1, notesChars: 4000, codeChars: 0, images: 1, pdfBytes: 0, documentBytes: 0 }, models, priced, 4096, (model) => model !== "p:a");
	assert.deepEqual([gone.usd, gone.unavailable, gone.unpriced], [null, "p:a", undefined]);
	assert.deepEqual(estimateImport({ sources: 0, notesChars: 0, codeChars: 0, images: 0, pdfBytes: 0, documentBytes: 0 }, models, priced, 4096), { tokens: 0, usd: 0, rough: false });
	// The live calibration folder (p-limit with notes, a docx and an image): 155,419 tokens billed.
	const live = estimateImport({ sources: 5, notesChars: 10_110, codeChars: 36_840, images: 1, pdfBytes: 0, documentBytes: 11_029 }, models, priced, 4096);
	assert.ok(live.tokens > 155_419 * 0.8 && live.tokens < 155_419 * 1.25, String(live.tokens));
});

it("the estimate endpoint validates its body and answers tokens and dollars", async () => {
	const post = (body: unknown) => ESTIMATE(new Request("http://localhost/api/graph/import/estimate", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
	assert.equal((await post("{")).status, 400);
	assert.equal((await post({ sources: 1, notesChars: -1, codeChars: 0, images: 0, pdfBytes: 0, documentBytes: 0 })).status, 400);
	const ok = await post({ sources: 1, notesChars: 4000, codeChars: 0, images: 0, pdfBytes: 0, documentBytes: 0 });
	assert.equal(ok.status, 200);
	const body = await ok.json();
	assert.equal(typeof body.tokens, "number");
	assert.ok(body.usd === null || typeof body.usd === "number");
});

// ── HEIC ──

it("HEIC detection by MIME or by extension, and the 64-megapixel check reads real metadata", async () => {
	assert.equal(isHeicImageFile({ name: "IMG_1.HEIC", type: "" }), true);
	assert.equal(isHeicImageFile({ name: "IMG_1.heic", type: "application/octet-stream" }), true);
	assert.equal(isHeicImageFile({ name: "photo", type: "image/heif" }), true);
	assert.equal(isHeicImageFile({ name: "IMG_1.heic", type: "image/jpeg" }), false);
	assert.equal(isHeicImageFile({ name: "a.png", type: "" }), false);
	assert.equal(await validateHeicImageDimensions(new Blob([fixture("images/sample.heic")])), null);
	assert.equal(await validateHeicImageDimensions(new Blob([fixture("images/sample.png")])), "unreadable");
	const huge = fixture("images/sample.heic");
	// Rewrite every ispe box's width and height to 10,000 x 10,000 (100 MP).
	for (let i = 0; i + 8 < huge.length; i++) {
		if (huge[i] === 0x69 && huge[i + 1] === 0x73 && huge[i + 2] === 0x70 && huge[i + 3] === 0x65) {
			const view = new DataView(huge.buffer, huge.byteOffset);
			view.setUint32(i + 8, 10_000); view.setUint32(i + 12, 10_000);
		}
	}
	assert.equal(await validateHeicImageDimensions(new Blob([huge])), "too-large");
});

it("planFolder skips binary-looking code (UTF-16) in the browser, ignores .gitignore under excluded folders, strips a BOM", async () => {
	const utf16 = new Uint8Array(Buffer.from("select 1;", "utf16le"));
	const plan = await planFolder([
		picked("db/.gitignore", "\uFEFFsecret.ts\n"), picked("db/node_modules/pkg/.gitignore", "*.ts\n"),
		picked("db/setup.sql", utf16), picked("db/query.sql", "select 1;"), picked("db/secret.ts"), picked("db/app.ts", "x"),
	]);
	assert.deepEqual(plan.code.map((f) => f.webkitRelativePath), ["db/app.ts", "db/query.sql"]);
	assert.equal(plan.codeNotText, 1);
	assert.ok(planSummaries(plan).includes("Skipped 1 code file that isn't plain text."));
	assert.match(folderReviewLines({ plan, estimate: "loading" }).skipped!, /1 not text/);
});

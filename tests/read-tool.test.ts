/**
 * The read tool (sources v0) — a Node port of pi's read semantics:
 * truncation with continuation offsets, image mime detection, error paths.
 * Driven through the NATIVE AgentTool execute (Wave A, 2026-09-26): text
 * reads return the raw string as details (the record's tool part output
 * reads it); image reads return native pi content parts (text + image)
 * with null details (the output-less part until the record persists).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { readTool } from "../src/agent/tools/read.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-read-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name: string, content: string): string {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, content, "utf-8");
	return file;
}

/** Native execute → the raw string body (text reads ride details verbatim). */
const run = (args: { path: string; offset?: number; limit?: number }) =>
	readTool.execute!("test", args).then((r) => {
		assert.ok(r.content.length >= 1);
		const first = r.content[0]!;
		assert.equal(first.type, "text");
		return { text: (first as { type: "text"; text: string }).text, details: r.details };
	});

describe("read tool — text semantics", () => {
	it("reads a small file verbatim", async () => {
		const file = write("small.txt", "hello\nworld");
		const { text, details } = await run({ path: file });
		assert.equal(text, "hello\nworld");
		assert.equal(details, "hello\nworld", "the record part output carries the string verbatim");
	});

	it("resolves relative paths against the learner's home (sources v1 anchoring)", async () => {
		// sources v1: the harness has no meaningful cwd — "find my notes" must
		// work from a bare relative path, so the home directory is the anchor
		// (fs-shared resolveSourcePath). Scratch file in home, cleaned up.
		const rel = `lh-read-rel-test-${process.pid}.txt`;
		const homeFile = path.join(os.homedir(), rel);
		fs.writeFileSync(homeFile, "rel", "utf-8");
		try {
			assert.equal((await run({ path: rel })).text, "rel");
		} finally {
			fs.unlinkSync(homeFile);
		}
	});

	it("honors offset (1-indexed) and limit", async () => {
		const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		const file = write("thirty.txt", body);
		const out = (await run({ path: file, offset: 10, limit: 3 })).text;
		// pi parity: the explicit limit stopping short gets a remaining notice
		assert.match(out, /^line 10\nline 11\nline 12\n\n\[18 more lines in file\. Use offset=13 to continue\.\]$/);
	});

	it("offset beyond EOF is an error the model sees", async () => {
		const file = write("tiny.txt", "one");
		await assert.rejects(() => run({ path: file, offset: 99 }), /beyond end of file/);
	});

	it("a missing file throws (pi's error-result semantics)", async () => {
		await assert.rejects(() => run({ path: path.join(tmp, "nope.txt") }), /ENOENT/);
	});

	it("truncates at 2000 lines with a use-offset continuation notice", async () => {
		const body = Array.from({ length: 3000 }, (_, i) => `l${i + 1}`).join("\n");
		const file = write("big.txt", body);
		const out = (await run({ path: file })).text;
		assert.match(out, /Showing lines 1-2000 of 3000 \(2000 line limit\)/);
		assert.match(out, /Use offset=2001 to continue/);
		assert.ok(!out.includes("l2001\n"), "line 2001 must not ride along");
	});

	it("truncates at 50KB with the same continuation notice", async () => {
		// 200 lines of ~400B = ~80KB total, under the line cap — byte cap fires
		const line = "x".repeat(400);
		const body = Array.from({ length: 200 }, () => line).join("\n");
		const file = write("wide.txt", body);
		const out = (await run({ path: file })).text;
		assert.match(out, /50\.0KB limit\)\. Use offset=\d+ to continue\./);
		// and the truncation actually cut content
		assert.ok(out.length < 52_000, "the 50KB ceiling must cut the 80KB body");
	});

	it("an explicit limit that stops short gets a remaining-lines notice", async () => {
		const body = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
		const file = write("ten.txt", body);
		const out = (await run({ path: file, limit: 4 })).text;
		assert.match(out, /\[6 more lines in file\. Use offset=5 to continue\.\]/);
	});
});

describe("read tool — image semantics (native content parts)", () => {
	it("returns native text + image parts for image files, details null (output-less part)", async () => {
		const file = path.join(tmp, "dot.png");
		// Detection now sniffs bytes and the native processor decodes the image.
		const canvas = createCanvas(1, 1);
		canvas.getContext("2d").fillRect(0, 0, 1, 1);
		fs.writeFileSync(file, canvas.toBuffer("image/png"));
		const result = await readTool.execute!("test", { path: file });
		assert.equal(result.content.length, 2);
		const parts = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		const textPart = parts[0]!;
		const imagePart = parts[1]!;
		assert.equal(textPart.type, "text");
		assert.match(textPart.text!, /Read image file \[image\/png\]/);
		assert.equal(imagePart.type, "image");
		assert.equal(imagePart.mimeType, "image/png");
		assert.match(imagePart.data!, /^[A-Za-z0-9+/]+={0,2}$/);
		assert.equal(result.details, null, "image reads keep the record part output-less");
	});

	it("plain string results map to a single text part (parity)", async () => {
		const file = write("plain.txt", "body");
		const result = await readTool.execute!("test", { path: file });
		assert.equal(result.content.length, 1);
		assert.equal(result.content[0]!.type, "text");
		assert.equal((result.content[0] as { type: "text"; text: string }).text, "body");
	});
});

/**
 * Documents (docs/specs/document-converters.md): the fixtures are real files
 * made with pandoc (docx, odt, pptx, epub, rtf), openpyxl (xlsx), odfpy (ods,
 * odp) and nbformat (ipynb).
 */
const FIXTURES = path.join(process.cwd(), "tests/fixtures/documents");

describe("read tool: documents", () => {
	const known: Array<[string, string, string[]]> = [
		["docx", "[Converted from docx to text.]", ["# Photosynthesis", "## The light reactions", "Light reactions\tThylakoid membrane"]],
		["odt", "[Converted from odt to text.]", ["# Photosynthesis", "Water is split, releasing oxygen.", "Calvin cycle\tStroma"]],
		["epub", "[Converted from epub to text.]", ["## Chapter 2", "# Photosynthesis", "Calvin cycle\tStroma"]],
		["rtf", "[Converted from rtf to text.]", ["Plants convert light energy into chemical energy.", "Thylakoid membrane"]],
		["pptx", "[Converted from pptx to text.]", ["## Slide 1", "Photosynthesis notes", "## Slide 2", "Notes:\nRemind the class about the quiz."]],
		["odp", "[Converted from odp to text.]", ["## Slide 1\nCell biology\nThe cell is the basic unit of life.", "## Slide 2\nOrganelles"]],
		["ipynb", "[Converted from ipynb to text.]", ["## Cell 1 (markdown)\n# Arithmetic check", "print(2 + 2)\nOutput:\n4", "ZeroDivisionError: division by zero"]],
		[
			"xlsx",
			"[Converted from xlsx to text. Sheets: Grades (4 rows, line 3), Notes (1 row, line 9)]",
			["## Sheet: Grades\nStudent\tScore\tPassed\tAverage\nAda\t92\ttrue\tAVERAGE(B2:B4)", "## Sheet: Notes\nExam on Friday"],
		],
		[
			"ods",
			"[Converted from ods to text. Sheets: Elements (3 rows, line 3), Sources (1 row, line 8)]",
			["## Sheet: Elements\nSymbol\tName\tNumber\nH\tHydrogen\t1", "## Sheet: Sources\nPeriodic table, 2024 edition"],
		],
	];
	for (const [format, header, expected] of known) {
		it(`converts a real ${format} file to text with its header line`, async () => {
			const { text } = await run({ path: path.join(FIXTURES, `sample.${format}`) });
			assert.equal(text.split("\n")[0], header);
			assert.equal(text.split("\n")[1], "");
			for (const part of expected) assert.ok(text.includes(part), `${format}: ${JSON.stringify(part)} in ${text}`);
		});
	}

	it("the sheet index's line numbers land on the sheet headings", async () => {
		for (const format of ["xlsx", "ods"]) {
			const file = path.join(FIXTURES, `sample.${format}`);
			const header = (await run({ path: file })).text.split("\n")[0]!;
			for (const [, name, line] of header.matchAll(/(\w+) \(\d+ rows?, line (\d+)\)/g)) {
				assert.equal((await run({ path: file, offset: Number(line), limit: 1 })).text.split("\n")[0], `## Sheet: ${name}`);
			}
		}
	});

	it("pages converted text with offset and limit", async () => {
		const out = (await run({ path: path.join(FIXTURES, "sample.odp"), offset: 3, limit: 2 })).text;
		assert.match(out, /^## Slide 1\nCell biology\n\n\[\d+ more lines in file\. Use offset=5 to continue\.\]$/);
	});

	it("detects a document by signature when the extension is missing", async () => {
		const file = path.join(tmp, "report-without-extension");
		fs.copyFileSync(path.join(FIXTURES, "sample.docx"), file);
		const { text } = await run({ path: file });
		assert.equal(text.split("\n")[0], "[Converted from docx to text.]");
		assert.ok(text.includes("# Photosynthesis"));
	});

	it("points PDFs at the pdf job", async () => {
		await assert.rejects(() => run({ path: path.join(process.cwd(), "tests/fixtures/sample-3page.pdf") }), {
			message: "This is a PDF. read doesn't extract PDFs: dispatch a pdf job with this path and your question.",
		});
	});

	it("points a PDF at the pdf job even when it is large and named like a document", async () => {
		const file = path.join(tmp, "bigpdf.docx");
		fs.writeFileSync(file, "%PDF-1.7\n");
		fs.truncateSync(file, 16 * 1024 * 1024 + 1);
		await assert.rejects(() => run({ path: file }), {
			message: "This is a PDF. read doesn't extract PDFs: dispatch a pdf job with this path and your question.",
		});
	});

	it("refuses old binary Office files with a save-as hint", async () => {
		const file = path.join(tmp, "old.doc");
		fs.writeFileSync(file, Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]));
		await assert.rejects(() => run({ path: file }), {
			message: "This is an old binary Office file (.doc, .xls or .ppt), which read can't convert. Ask the learner to save it as .docx, .xlsx or .pptx.",
		});
	});

	it("refuses other binary files and non-document zips", async () => {
		const binary = path.join(tmp, "blob.dat");
		fs.writeFileSync(binary, Buffer.from([1, 2, 0, 3]));
		await assert.rejects(() => run({ path: binary }), { message: `${binary} is a binary file and can't be read as text.` });
		const zip = path.join(tmp, "bundle.zip");
		fs.writeFileSync(zip, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]));
		await assert.rejects(() => run({ path: zip }), { message: `${zip} is a zip archive and can't be read as text.` });
	});

	it("names the file and reason when a document can't be converted", async () => {
		const broken = write("broken.docx", "not really a docx");
		await assert.rejects(() => run({ path: broken }), { message: "broken.docx isn't a valid docx file." });
		const huge = path.join(tmp, "huge.xlsx");
		fs.writeFileSync(huge, "");
		fs.truncateSync(huge, 16 * 1024 * 1024 + 1);
		await assert.rejects(() => run({ path: huge }), { message: "huge.xlsx is larger than 16 MiB, the limit for converting documents." });
	});

	it("shows an rtf or ipynb that doesn't parse as raw text", async () => {
		const notebook = write("draft.ipynb", '{"cells": [unfinished');
		assert.equal((await run({ path: notebook })).text, '[Could not convert this as ipynb; showing the raw file.]\n{"cells": [unfinished');
		const binary = path.join(tmp, "binary.ipynb");
		fs.writeFileSync(binary, Buffer.from([0x7b, 0, 1, 2]));
		await assert.rejects(() => run({ path: binary }), { message: "binary.ipynb isn't a valid ipynb file." });
		const letter = write("letter.rtf", String.raw`{\rtf1\ansi\ansicpg932 \'82\'a0}`);
		assert.equal((await run({ path: letter })).text, `[Could not convert this as rtf; showing the raw file.]\n${String.raw`{\rtf1\ansi\ansicpg932 \'82\'a0}`}`);
	});

	it("still reads csv and other plain text as text", async () => {
		const csv = write("table.csv", "a,b\n1,2");
		assert.equal((await run({ path: csv })).text, "a,b\n1,2");
	});

	it("the description names the document formats", () => {
		assert.ok(
			readTool.description.startsWith(
				"Read the contents of a file. Supports text files, images (jpg, png, gif, webp, bmp) and documents (docx, xlsx, pptx, odt, ods, odp, rtf, epub, ipynb). Images are sent as attachments; documents are converted to text. For text files, output is truncated to 2000 lines or 50.0KB",
			),
		);
	});
});

/**
 * The document converter layer (docs/specs/document-converters.md).
 *
 * The structure table, the RTF cases and the limit cases are ported from
 * T3 Code's apps/server/src/provider/userInputAttachments.test.ts
 * (https://github.com/pingdotgg/t3code, MIT, Copyright (c) 2026 T3 Tools
 * Inc.; full notice in src/agent/documents/LICENSE), adapted from vitest
 * and file paths to node:test and byte arrays.
 */
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { afterEach, describe, it } from "node:test";
import { extractDocumentText } from "../src/agent/documents/document-text.mjs";
import {
	clearDocumentCache,
	convertDocument,
	detectDocumentFormat,
	DocumentConversionError,
	documentLimits,
	documentStats,
} from "../src/agent/documents/index.ts";

/** T3's in-test zip writer: stored entries, deflated for .bmp/.bin names. */
function zipParts(parts: Record<string, string | Buffer>) {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(parts)) {
		const data = Buffer.from(content);
		const compressed = /\.(bmp|bin)$/.test(name) ? zlib.deflateRawSync(data) : data;
		const filename = Buffer.from(name);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(compressed === data ? 0 : 8, 8);
		header.writeUInt32LE(zlib.crc32(data), 14);
		header.writeUInt32LE(compressed.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(filename.length, 26);
		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50);
		directory.writeUInt16LE(20, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt16LE(compressed === data ? 0 : 8, 10);
		directory.writeUInt32LE(zlib.crc32(data), 16);
		directory.writeUInt32LE(compressed.length, 20);
		directory.writeUInt32LE(data.length, 24);
		directory.writeUInt16LE(filename.length, 28);
		directory.writeUInt32LE(offset, 42);
		local.push(header, filename, compressed);
		central.push(directory, filename);
		offset += header.length + filename.length + compressed.length;
	}
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(central.length / 2, 8);
	end.writeUInt16LE(central.length / 2, 10);
	end.writeUInt32LE(Buffer.concat(central).length, 12);
	end.writeUInt32LE(offset, 16);
	return { local, central, end, bytes: () => new Uint8Array(Buffer.concat([...local, ...central, end])) };
}

const rtf = (source: string | Buffer) => extractDocumentText(new Uint8Array(Buffer.from(source)), ".rtf");
const notebook = (value: unknown) => extractDocumentText(new Uint8Array(Buffer.from(JSON.stringify(value))), ".ipynb");

describe("document text (T3 port): office structure and EPUB reading order with bounded archives", () => {
	const cases = [
		// Word stores object layout and field data outside the visible document text.
		{
			ext: "docx",
			bounded: true,
			parts: {
				"word/document.xml":
					'<w:document xmlns:w="urn:w" xmlns:wp="urn:wp" xmlns:wp14="urn:wp14" xmlns:mc="urn:mc"><w:body><w:p><w:r><w:t>Total cost is </w:t><w:drawing><wp:anchor><wp:positionH><wp:posOffset>1905000</wp:posOffset></wp:positionH><wp:positionV><wp:posOffset>-635</wp:posOffset></wp:positionV><wp14:sizeRelH><wp14:pctWidth>0</wp14:pctWidth></wp14:sizeRelH><wp14:sizeRelV><wp14:pctHeight>0</wp14:pctHeight></wp14:sizeRelV></wp:anchor></w:drawing><w:t>42 EUR.</w:t></w:r></w:p></w:body></w:document>',
			},
			expected: ["Total cost is 42 EUR."],
			absent: ["1905000", "-635", "0042"],
		},
		{
			ext: "docx",
			bounded: true,
			parts: {
				"word/document.xml":
					'<w:document xmlns:w="urn:w" xmlns:wp="urn:wp" xmlns:wp14="urn:wp14" xmlns:mc="urn:mc"><w:body><w:p><mc:AlternateContent><mc:Choice Requires="cx"><w:drawing><wp:anchor><wp:positionH><wp:posOffset>1905000</wp:posOffset></wp:positionH><wp:positionV><wp:posOffset>-635</wp:posOffset></wp:positionV><wp14:sizeRelH><wp14:pctWidth>0</wp14:pctWidth></wp14:sizeRelH><wp14:sizeRelV><wp14:pctHeight>0</wp14:pctHeight></wp14:sizeRelV></wp:anchor></w:drawing><cx:chart/></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Chart caption</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:p></w:body></w:document>',
			},
			expected: ["Chart caption"],
			absent: ["1905000", "-635"],
		},
		{
			ext: "docx",
			bounded: true,
			parts: {
				"word/document.xml":
					'<w:document xmlns:w="urn:w" xmlns:wp="urn:wp" xmlns:wp14="urn:wp14" xmlns:mc="urn:mc"><w:body><w:p><w:r><w:t>As shown </w:t><w:fldChar><w:fldData>RU5ETk9URQ==</w:fldData></w:fldChar><w:t>(Smith 2020) earlier.</w:t></w:r></w:p></w:body></w:document>',
			},
			expected: ["As shown (Smith 2020) earlier."],
			absent: ["RU5ETk9URQ=="],
		},
		{
			ext: "docx",
			bounded: true,
			parts: {
				"word/document.xml": "<document><p>Readable despite embedded media</p></document>",
				"word/media/black.bmp": "\0".repeat(64 * 1024),
				"word/embeddings/unused.bin": "\0".repeat(33 * 1024 * 1024),
			},
			expected: ["Readable despite embedded media"],
			absent: ["[Extracted text truncated"],
		},
		...[false, true].map((deep) => ({
			ext: "docx",
			bounded: true,
			parts: {
				"word/document.xml": `<document>${deep ? "<div>".repeat(129) + "Lost" + "</div>".repeat(129) : "<p/>".repeat(200_001)}</document>`,
			},
			expected: ["[Extracted text truncated at document extraction limits.]"],
			absent: ["Lost"],
		})),
		...["ods", "odt", "odp", "docx"].flatMap((ext) =>
			[false, true].map((rows) => ({
				ext,
				bounded: true,
				parts: {
					[ext === "docx" ? "word/document.xml" : "content.xml"]:
						`<document><page><table><table-row${rows ? ' number-rows-repeated="10001"' : ""}><table-cell${rows ? "" : ' number-columns-repeated="513"'}><p>Repeated value</p></table-cell></table-row></table></page></document>`,
				},
				expected: [
					"Repeated value",
					"[Extracted text truncated at document extraction limits.]",
				],
				occurrences: { text: "Repeated value", count: rows ? 10_000 : 512 },
			})),
		),
		...["ods", "odt", "odp", "docx"].map((ext) => ({
			ext,
			bounded: true,
			parts: {
				[ext === "docx" ? "word/document.xml" : "content.xml"]:
					`<document><page><table><table-row><table-cell><p>Kept</p></table-cell><table-cell number-columns-repeated="16383"> \n <p> \t </p> <s c="1048575"/> </table-cell></table-row><table-row number-rows-repeated="1048575"><table-cell> \n <p> \t </p> </table-cell></table-row></table></page></document>`,
			},
			expected: ["Kept"],
			absent: ["[Extracted text truncated", "\t"],
		})),
		...["ods", "odt", "odp"].map((ext) => ({
			ext,
			bounded: true,
			parts: {
				"content.xml": `<document><page><table><table-row>
              <table-cell office:value-type="string" office:string-value="Harbor"/>
              <table-cell office:value-type="boolean" office:boolean-value="false"/>
              <table-cell office:value-type="date" office:date-value="2026-10-20"/>
              <table-cell office:value-type="time" office:time-value="PT2H30M"/>
              <table-cell office:value-type="currency" office:value="125.50" office:currency="USD"/>
              <table-cell office:value-type="percentage" office:value="0.25"/>
              <table-cell office:value-type="float" office:value="0"/>
              <table-cell office:value-type="string" office:string-value="Fallback"><p> \n </p></table-cell>
              <table-cell office:value-type="string" office:string-value="Unshown"><p>Displayed</p></table-cell>
              <table-cell office:value-type="void" office:value="Unshown"/>
              <table-cell office:value-type="currency" office:value=" " office:currency="Unshown"/>
              <table-cell office:value-type="percentage" office:value=" "/>
            </table-row></table></page></document>`,
			},
			expected: [
				"Harbor\tfalse\t2026-10-20\tPT2H30M\t125.50 USD\t0.25 [ODF value-type=percentage]\t0\tFallback\tDisplayed",
			],
			absent: ["Unshown", "[Extracted text truncated"],
		})),
		...[false, true].map((rows) => ({
			ext: "xlsx",
			bounded: true,
			parts: {
				"xl/workbook.xml": '<workbook><sheet name="Limited" r:id="a"/></workbook>',
				"xl/_rels/workbook.xml.rels":
					'<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
				"xl/worksheets/a.xml": `<worksheet>${rows ? "<row><c><v>7</v></c></row>".repeat(10_001) : '<row><c r="A1"><v>7</v></c><c r="SS1"><v>Beyond</v></c></row>'}</worksheet>`,
			},
			expected: ["7", "[Extracted text truncated at document extraction limits.]"],
			absent: ["Beyond"],
		})),
		{
			ext: "xlsx",
			bounded: true,
			parts: {
				"xl/workbook.xml": '<workbook><sheet name="Padding" r:id="a"/></workbook>',
				"xl/_rels/workbook.xml.rels":
					'<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
				"xl/sharedStrings.xml": "<sst><si><t> \n </t></si><si><t>Present</t></si></sst>",
				"xl/worksheets/a.xml": `<worksheet>${'<row><c t="s"><v>0</v></c><c r="XFD1" t="inlineStr"><is><t> \t </t></is></c></row>'.repeat(10_001)}<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c r="XFD2"><v> \n </v></c></row></worksheet>`,
			},
			expected: ["Present"],
			absent: ["[Extracted text truncated"],
		},
		{
			ext: "epub",
			parts: {
				"META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
				"book.opf":
					'<package><item id="bad" href="ch%ZZ.xhtml"/><item id="good" href="good.svg"/><itemref idref="bad"/><itemref idref="good"/></package>',
				"good.svg":
					'<svg xmlns="http://www.w3.org/2000/svg"><text>Readable SVG chapter</text></svg>',
			},
			expected: [
				"Readable SVG chapter",
				"[Skipped document part: chapter 1 (missing or invalid XML).]",
			],
			absent: ["[Extracted text truncated"],
		},
		...[false, true].flatMap((bom) =>
			[false, true].map((bigEndian) => {
				const encode = (source: string) => {
					const data = Buffer.from(`${bom ? "\ufeff" : ""}${source}`, "utf16le");
					return bigEndian ? data.swap16() : data;
				};
				return {
					ext: "epub",
					parts: {
						"META-INF/container.xml": encode(
							'<?xml version="1.0" encoding="UTF-16"?><container><rootfile full-path="book.opf"/></container>',
						),
						"book.opf": encode(
							'<?xml version="1.0" encoding="UTF-16"?><package><item id="a" href="a.xhtml"/><itemref idref="a"/></package>',
						),
						"a.xhtml": encode(
							'<?xml version="1.0" encoding="UTF-16"?><html><p>UTF-16 chapter: café 日本語</p></html>',
						),
					},
					expected: ["UTF-16 chapter: café 日本語"],
					absent: ["[Skipped document part", "[Extracted text truncated"],
				};
			}),
		),
		{
			ext: "epub",
			bounded: true,
			parts: {
				"META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
				"book.opf":
					'<package><item id="bad" href="bad.xhtml"/><item id="good" href="good.xhtml"/><itemref idref="bad"/><itemref idref="good"/></package>',
				"bad.xhtml": "<html><p>Discard this broken chapter</html>",
				"good.xhtml":
					'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><p>North&nbsp;Harbor &NotEqualTilde; &CounterClockwiseContourIntegral; &amp; &lt;tag&gt; &quot;quoted&quot;</p><p><![CDATA[Literal &nbsp;]]></p><table><tr><td>&nbsp; </td></tr><tr><td>Kept&nbsp;cell</td></tr></table></html>',
			},
			expected: [
				"## Chapter 2",
				'North\u00a0Harbor ≂̸ ∳ & <tag> "quoted"',
				"Literal &nbsp;",
				"Kept cell",
				"[Skipped document part: bad.xhtml (missing or invalid XML).]",
			],
			absent: ["Discard this broken chapter", "[Extracted text truncated"],
		},
		...["pptx", "xlsx"].map((ext) => ({
			ext,
			bounded: true,
			parts:
				ext === "pptx"
					? {
							"ppt/presentation.xml":
								'<presentation><sldId r:id="bad"/><sldId r:id="good"/></presentation>',
							"ppt/_rels/presentation.xml.rels":
								'<Relationships><Relationship Id="bad" Target="bad.xml"/><Relationship Id="good" Target="good.xml"/></Relationships>',
							"ppt/bad.xml": "<slide><p>Discard</slide>",
							"ppt/good.xml": "<slide><p>Healthy part</p></slide>",
						}
					: {
							"xl/workbook.xml":
								'<workbook><sheet name="Bad" r:id="bad"/><sheet name="Good" r:id="good"/></workbook>',
							"xl/_rels/workbook.xml.rels":
								'<Relationships><Relationship Id="bad" Target="bad.xml"/><Relationship Id="good" Target="good.xml"/></Relationships>',
							"xl/bad.xml": "<worksheet><row>Discard</worksheet>",
							"xl/good.xml":
								'<worksheet><row><c t="inlineStr"><is><t>Healthy part</t></is></c></row></worksheet>',
						},
			expected: [
				"Healthy part",
				`[Skipped document part: ${ext === "pptx" ? "ppt" : "xl"}/bad.xml (missing or invalid XML).]`,
			],
			absent: ["Discard", "[Extracted text truncated"],
		})),
		{
			ext: "odt",
			bounded: true,
			parts: { "content.xml": '<document><p>Start<s c="1000001"/>Unneeded</p></document>' },
			expected: ["Start", "[Extracted text truncated at document extraction limits.]"],
			absent: ["Unneeded"],
		},
		{
			ext: "docx",
			bounded: true,
			parts: {
				"word/document.xml":
					'<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Callout box</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Callout box</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>',
			},
			expected: ["Body\nCallout box"],
			occurrences: { text: "Callout box", count: 1 },
		},
		{
			ext: "docx",
			bounded: true,
			parts: {
				"word/document.xml":
					'<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body><w:p><w:r><mc:AlternateContent><mc:Choice Requires="cx"><w:drawing><cx:chart/></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Chart caption</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>',
			},
			expected: ["Chart caption"],
		},
		{
			ext: "docx",
			bounded: true,
			parts: {
				"word/document.xml":
					'<w:document xmlns:w="urn:w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Report &amp; totals</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p><w:p><w:r><w:t>34</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Before</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Neighbor</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:noBreakHyphen/></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:noBreakHyphen/></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
			},
			expected: [
				"## Report & totals",
				"North\t12 34",
				"Before Inner After\tNeighbor\t\u2011\n\u2011",
			],
		},
		{
			ext: "docx",
			bounded: true,
			parts: {
				"word/document.xml":
					'<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>First</w:t><w:cr/><w:t>Second</w:t><w:br/><w:t>Third</w:t><w:noBreakHyphen/><w:t>party</w:t><mc:AlternateContent xmlns:mc="urn:mc"><mc:Choice Requires="w"><w:noBreakHyphen/></mc:Choice><mc:Fallback><w:t>‑</w:t></mc:Fallback></mc:AlternateContent><w:t>End</w:t></w:r></w:p></w:body></w:document>',
			},
			expected: ["First\nSecond\nThird\u2011party\u2011End"],
		},
		{
			ext: "docx",
			bounded: true,
			parts: {
				"word/document.xml":
					'<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Intro</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t> 3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9350"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">Fee </w:t></w:r><w:del><w:r><w:delText>$500</w:delText><w:noBreakHyphen/></w:r></w:del><w:ins><w:r><w:t>$700</w:t></w:r></w:ins><w:moveFrom><w:r><w:t>Moved</w:t></w:r></w:moveFrom><w:r><w:tab/><w:t>due</w:t></w:r></w:p></w:body></w:document>',
			},
			expected: ["Intro 3\nFee $700\tdue"],
			absent: ["PAGEREF", "$500", "Moved", "\u2011"],
		},
		{
			ext: "odt",
			bounded: true,
			parts: {
				"content.xml":
					"<document><text><tracked-changes><changed-region><deletion><change-info><creator>Reviewer</creator></change-info><p>$500</p></deletion></changed-region></tracked-changes><p>Fee <change/>$700</p></text></document>",
			},
			expected: ["Fee $700"],
			absent: ["Reviewer", "$500"],
		},
		{
			ext: "docx",
			bounded: true,
			parts: {
				"word/document.xml": `<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>${"A".repeat(1_000_000)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Later cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
			},
			expected: ["A".repeat(32), "[Extracted text truncated at document extraction limits.]"],
		},
		{
			ext: "xlsx",
			bounded: true,
			parts: {
				"xl/workbook.xml": '<workbook><sheet name="Formulas" r:id="a"/></workbook>',
				"xl/_rels/workbook.xml.rels":
					'<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
				"xl/styles.xml": '<styleSheet><cellXfs><xf numFmtId="9"/></cellXfs></styleSheet>',
				"xl/worksheets/a.xml":
					"<worksheet><row><c><f>SUM(11,22)</f><v/></c></row><row><c><f>SUM(33,44)</f><v> \n </v></c></row><row><c><f>SUM(55,66)</f></c></row><row><c><f>SUM(11,22)</f><v>33</v></c><c><f>SUM(0,0)</f><v>0</v></c></row></worksheet>",
			},
			expected: [
				"SUM(11,22)\nSUM(33,44)\nSUM(55,66)",
				"33 [Excel numFmtId=9; date system 1900]\t0 [Excel numFmtId=9; date system 1900]",
			],
			absent: ["SUM(0,0)", "[Extracted text truncated"],
		},
		{
			ext: "xlsx",
			bounded: true,
			parts: {
				"xl/workbook.xml": '<workbook><sheet name="Flags" r:id="a"/></workbook>',
				"xl/_rels/workbook.xml.rels":
					'<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
				"xl/worksheets/a.xml":
					'<worksheet><row><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c><c r="C1" t="n"><v>1</v></c><c r="D1" t="b"><v>2</v></c></row></worksheet>',
			},
			expected: ["true\tfalse\t1\t2"],
		},
		{
			ext: "xlsx",
			parts: {
				"xl/workbook.xml":
					'<workbook><sheets><sheet name="Inventory" r:id="a"/><sheet name="Budget" r:id="b"/></sheets></workbook>',
				"xl/_rels/workbook.xml.rels":
					'<Relationships><Relationship Id="a" Target="worksheets/second.xml"/><Relationship Id="b" Target="worksheets/first.xml"/></Relationships>',
				"xl/sharedStrings.xml": "<sst><si><t>Lantern</t></si></sst>",
				"xl/styles.xml":
					'<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/><xf numFmtId="164"/></cellXfs></styleSheet>',
				"xl/worksheets/second.xml":
					'<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1"><v>37</v></c></row></sheetData></worksheet>',
				"xl/worksheets/first.xml":
					'<worksheet><sheetData><row><c t="inlineStr"><is><t>Ferry</t></is></c><c><v>628</v></c><c s="1"><v>45292</v></c><c s="2"><v>0.25</v></c><c s="3"><v>45293</v></c></row></sheetData></worksheet>',
			},
			expected: [
				"## Sheet: Inventory",
				"Lantern\t\t37",
				"## Sheet: Budget",
				"Ferry\t628",
				"45292 [Excel numFmtId=14; date system 1900]",
				"0.25 [Excel numFmtId=9; date system 1900]",
				"45293 [Excel numFmtId=164; format=yyyy-mm-dd; date system 1900]",
			],
		},
		{
			ext: "xlsx",
			bounded: true,
			parts: {
				"xl/workbook.xml": '<workbook><sheet name="Phonetics" r:id="a"/></workbook>',
				"xl/_rels/workbook.xml.rels":
					'<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
				"xl/sharedStrings.xml":
					'<sst><si><t>東京</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh></si></sst>',
				"xl/worksheets/a.xml":
					'<worksheet><row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>東京</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh></is></c></row></worksheet>',
			},
			expected: ["## Sheet: Phonetics", "東京\t東京"],
			absent: ["とうきょう"],
		},
		{
			ext: "xlsx",
			bounded: true,
			parts: {
				"xl/workbook.xml": '<workbook><sheet name="Escapes" r:id="a"/></workbook>',
				"xl/_rels/workbook.xml.rels":
					'<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
				"xl/sharedStrings.xml":
					"<sst><si><t>first_x000D_\nsecond</t></si><si><t>_x005F_x0041_</t></si><si><t>_x005F_x005F_x0041_</t></si><si><r><t>Bold_x000D_</t></r><r><t>_x005F_x000D_</t></r></si><si><t>&amp;_xnothex_ cap_X0041_ _x000d_ tail</t></si></sst>",
				"xl/worksheets/a.xml":
					'<worksheet><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c t="s"><v>2</v></c><c t="s"><v>3</v></c><c t="s"><v>4</v></c></row><row><c t="inlineStr"><is><t>_x005F_x005F_</t></is></c><c t="inlineStr"><is><t>first_x000D_second</t></is></c><c t="str"><f>A1</f><v>Total_x000D_due</v></c></row></worksheet>',
			},
			expected: [
				"## Sheet: Escapes\nfirst second\t_x0041_\t_x005F_x0041_\tBold _x000D_\t&_xnothex_ cap_X0041_ tail\n_x005F_\tfirst second\tTotal due",
			],
		},
		{
			ext: "xlsx",
			bounded: true,
			parts: {
				"xl/workbook.xml":
					'<workbook><workbookPr date1904="true"/><sheets><sheet name="Dates" r:id="a"/></sheets></workbook>',
				"xl/_rels/workbook.xml.rels":
					'<Relationships><Relationship Id="a" Target="worksheets/dates.xml"/></Relationships>',
				"xl/styles.xml": '<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>',
				"xl/worksheets/dates.xml":
					"<worksheet><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>",
			},
			expected: ["## Sheet: Dates", "1 [Excel numFmtId=14; date system 1904]"],
		},
		{
			ext: "xlsx",
			bounded: true,
			parts: {
				"xl/workbook.xml":
					'<workbook><sheets><sheet name="Repeated" r:id="a"/><sheet name="Unneeded" r:id="missing"/></sheets></workbook>',
				"xl/_rels/workbook.xml.rels":
					'<Relationships><Relationship Id="a" Target="worksheets/repeated.xml"/></Relationships>',
				"xl/sharedStrings.xml": `<sst><si><t>${"A".repeat(1_000_000 - "## Sheet: Repeated\n".length)}</t></si></sst>`,
				"xl/worksheets/repeated.xml": `<worksheet><sheetData>${'<row><c t="s"><v>0</v></c><c t="s"><v>0</v></c></row>'.repeat(1_500)}</sheetData></worksheet>`,
			},
			expected: [
				"## Sheet: Repeated",
				"A".repeat(32),
				"[Extracted text truncated at document extraction limits.]",
			],
		},
		{
			ext: "pptx",
			bounded: true,
			parts: {
				"ppt/presentation.xml":
					'<p:presentation><p:sldIdLst><p:sldId id="1" r:id="b"/><p:sldId id="2" r:id="a"/></p:sldIdLst></p:presentation>',
				"ppt/_rels/presentation.xml.rels":
					'<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>',
				"ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Departure</a:t></a:r></a:p></p:sld>",
				"ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Juniper Pier</a:t></a:r></a:p></p:sld>",
				"ppt/slides/_rels/slide2.xml.rels":
					'<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../notesSlides/ignored.xml"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" TargetMode="External" Target="https://example.com/notes.xml"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notes7.xml"/></Relationships>',
				"ppt/slides/_rels/slide1.xml.rels":
					'<Relationships><Relationship Type="http://purl.oclc.org/ooxml/officeDocument/relationships/notesSlide" Target="/ppt/notesSlides/notes3.xml"/></Relationships>',
				"ppt/notesSlides/notes7.xml":
					"<p:notes><a:p><a:r><a:t>evacuation code ORCHID-81</a:t></a:r></a:p></p:notes>",
				"ppt/notesSlides/notes3.xml":
					"<p:notes><a:p><a:r><a:t>Board at gate 4</a:t></a:r></a:p></p:notes>",
				"ppt/notesSlides/ignored.xml": "<p:notes><a:p>Unrelated notes</a:p></p:notes>",
			},
			expected: [
				"## Slide 1",
				"Juniper Pier\nNotes:\nevacuation code ORCHID-81",
				"## Slide 2",
				"Departure\nNotes:\nBoard at gate 4",
			],
			absent: ["Unrelated notes", "[Skipped document part", "[Extracted text truncated"],
		},
		...[false, true].map((missing) => ({
			ext: "pptx",
			bounded: true,
			parts: {
				"ppt/presentation.xml": '<presentation><sldId r:id="a"/></presentation>',
				"ppt/_rels/presentation.xml.rels":
					'<Relationships><Relationship Id="a" Target="slides/a.xml"/></Relationships>',
				"ppt/slides/a.xml": "<slide><p>Slide text</p></slide>",
				"ppt/slides/_rels/a.xml.rels": `<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/${missing ? "missing" : "bad"}.xml"/></Relationships>`,
				"ppt/notesSlides/bad.xml": "<notes><p>Discard broken notes</notes>",
			},
			expected: [
				"Slide text",
				`[Skipped document part: ppt/notesSlides/${missing ? "missing" : "bad"}.xml (missing or invalid XML).]`,
			],
			absent: ["Discard broken notes", "[Extracted text truncated"],
		})),
		{
			ext: "pptx",
			bounded: true,
			parts: {
				"ppt/presentation.xml":
					'<presentation><sldId r:id="a"/><sldId r:id="b"/></presentation>',
				"ppt/_rels/presentation.xml.rels":
					'<Relationships><Relationship Id="a" Target="slides/a.xml"/><Relationship Id="b" Target="slides/b.xml"/></Relationships>',
				"ppt/slides/a.xml": `<slide><p>${"A".repeat(600_000)}</p></slide>`,
				"ppt/slides/b.xml": "<slide><p>Unneeded slide</p></slide>",
				"ppt/slides/_rels/a.xml.rels":
					'<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/a.xml"/></Relationships>',
				"ppt/notesSlides/a.xml": `<notes><p>evacuation code ORCHID-81 ${"B".repeat(600_000)} Unneeded notes</p></notes>`,
			},
			expected: [
				"## Slide 1",
				"A".repeat(32),
				"Notes:\nevacuation code ORCHID-81",
				"B".repeat(32),
				"[Extracted text truncated at document extraction limits.]",
			],
			absent: ["Unneeded notes", "Unneeded slide", "## Slide 2"],
		},
		{
			ext: "odt",
			parts: {
				"content.xml":
					'<office:document><text:h text:outline-level="2">\n  Orchard\n</text:h><text:p>19<text:s text:c="3"/>violet<text:s/>crates <text:span>\n\t  shipped</text:span>   today<text:tab/>Dock<text:line-break/>Gate\u00a0B </text:p><text:p>Second</text:p><text:p>A<text:span><text:script>console.log(1);\n</text:script></text:span> B</text:p></office:document>',
			},
			expected: [
				"## Orchard\n19   violet crates shipped today\tDock\nGate\u00a0B\nSecond\nA B",
			],
		},
		{
			ext: "ods",
			parts: {
				"content.xml":
					'<office:document><table:table table:name="Cargo"><table:table-row><table:table-cell><text:p>Violet</text:p></table:table-cell><table:table-cell office:value="19"/><table:table-cell office:value="27"><text:p/></table:table-cell></table:table-row></table:table></office:document>',
			},
			expected: ["## Sheet: Cargo", "Violet\t19\t27"],
		},
		{
			ext: "ods",
			bounded: true,
			parts: {
				"content.xml":
					'<office:document><table:table table:name="Padded rows"><table:table-row><table:table-cell><text:p>Left</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/><table:table-cell><text:p>Right</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell/></table:table-row></table:table></office:document>',
			},
			expected: ["## Sheet: Padded rows", "Left\t\t\tRight"],
			absent: ["[Extracted text truncated"],
		},
		{
			ext: "ods",
			bounded: true,
			parts: {
				"content.xml":
					'<office:document><table:table table:name="Padded"><table:table-row><table:table-cell><text:p>Populated</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16383"/></table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="16384"><text:p/></table:table-cell></table:table-row></table:table></office:document>',
			},
			expected: ["## Sheet: Padded", "Populated"],
			absent: ["[Extracted text truncated", "\t"],
		},
		{
			ext: "ods",
			bounded: true,
			parts: {
				"content.xml": `<office:document><table:table table:name="Repeated"><table:table-row><table:table-cell table:number-columns-repeated="512"><text:p>Lead ${"a".repeat(600_000)} Tail</text:p></table:table-cell></table:table-row></table:table></office:document>`,
			},
			expected: [
				"## Sheet: Repeated",
				"Lead ",
				" Tail\tLead ",
				"[Extracted text truncated at document extraction limits.]",
			],
		},
		{
			ext: "odp",
			parts: {
				"content.xml":
					"<office:document><draw:page><draw:frame><draw:text-box><text:p>\n  First\n\t  slide </text:p></draw:text-box></draw:frame></draw:page><draw:page><text:p>Second</text:p></draw:page></office:document>",
			},
			expected: ["## Slide 1\nFirst slide\n\n## Slide 2\nSecond"],
		},
		{
			ext: "ods",
			bounded: true,
			parts: {
				"content.xml": `<office:document>${Array.from(
              { length: 256 },
              (_, index) =>
                `<table:table table:name="${index === 0 ? "Shared" : "Unneeded"}"><table:table-row><table:table-cell table:number-columns-repeated="512"><text:p>${"B".repeat(4096)}</text:p></table:table-cell></table:table-row></table:table>`,
            ).join("")}</office:document>`,
			},
			expected: [
				"## Sheet: Shared",
				"B".repeat(32),
				"[Extracted text truncated at document extraction limits.]",
			],
			absent: ["## Sheet: Unneeded"],
		},
		{
			ext: "odt",
			bounded: true,
			parts: {
				"content.xml": `<office:document><text:p>Before whitespace</text:p><table:table><table:table-row table:number-rows-repeated="10000"><table:table-cell table:number-columns-repeated="512"><text:p>${" ".repeat(10_000)}</text:p></table:table-cell></table:table-row></table:table><text:p>Unneeded</text:p></office:document>`,
			},
			expected: ["Before whitespace", "Unneeded"],
			absent: ["[Extracted text truncated"],
		},
		...["odt", "odp", "ods"].flatMap((ext) =>
			[false, true].map((rows) => ({
				ext,
				bounded: true,
				parts: {
					"content.xml": `<office:document><draw:page>${Array.from(
                { length: 256 },
                () =>
                  `<table:table><table:table-row${rows ? ' table:number-rows-repeated="10000"' : ""}><table:table-cell table:number-columns-repeated="512"><text:p>${"Budget ".repeat(rows ? 160 : 585)}</text:p></table:table-cell></table:table-row></table:table>`,
              ).join(
                "",
              )}</draw:page><draw:page><text:p>Unneeded</text:p></draw:page></office:document>`,
				},
				expected: ["Budget ", "[Extracted text truncated at document extraction limits.]"],
				absent: ["Unneeded"],
			})),
		),
		{
			ext: "docx",
			bounded: true,
			parts: {
				"word/document.xml": `<w:document><w:p><w:t>${"A".repeat(1_000_100)}</w:t></w:p><w:p><w:t>Unneeded</w:t></w:p></w:document>`,
			},
			expected: ["A".repeat(32), "[Extracted text truncated at document extraction limits.]"],
			absent: ["Unneeded"],
		},
		{
			ext: "pptx",
			bounded: true,
			parts: {
				"ppt/presentation.xml":
					'<p:presentation><p:sldId r:id="a"/><p:sldId r:id="missing"/></p:presentation>',
				"ppt/_rels/presentation.xml.rels":
					'<Relationships><Relationship Id="a" Target="slides/slide.xml"/></Relationships>',
				"ppt/slides/slide.xml": `<p:sld><a:p><a:t>${"A".repeat(1_000_100)}</a:t></a:p></p:sld>`,
			},
			expected: [
				"## Slide 1",
				"A".repeat(32),
				"[Extracted text truncated at document extraction limits.]",
			],
			absent: ["## Slide 2"],
		},
		{
			ext: "epub",
			bounded: true,
			parts: {
				"META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
				"book.opf":
					'<package><item id="a" href="a.xhtml"/><itemref idref="a"/><itemref idref="missing"/></package>',
				"a.xhtml": `<html><body><p>${"A".repeat(1_000_100)}</p></body></html>`,
			},
			expected: [
				"## Chapter 1",
				"A".repeat(32),
				"[Extracted text truncated at document extraction limits.]",
			],
			absent: ["## Chapter 2"],
		},
		{
			ext: "epub",
			parts: {
				"META-INF/container.xml":
					'<container><rootfile full-path="OEBPS/book.opf"/></container>',
				"OEBPS/book.opf":
					'<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
				"OEBPS/a.xhtml":
					'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><body><p>Last chapter</p><p>Price <s>10</s> 8 <del>old</del></p></body></html>',
				"OEBPS/b.xhtml":
					'<!DOCTYPE html><html><head><title>My Novel</title><meta name="author" content="Hidden Author"/></head><body><h1>First chapter</h1><p>Larkspur</p><div>Direct div<section>Direct section<li>Direct item <em>emphasis</em> trailing</li></section></div><div>Account: A<br/>Balance: 731<line-break/>Currency: USD</div><table><thead><tr><th>Heading</th><th>Total</th></tr></thead><tbody><tr><td>Important value</td><td>731</td></tr><tr><td>Before<table><tr><td>Inner</td></tr></table>After</td><td>Neighbor</td></tr></tbody></table></body></html>',
			},
			expected: [
				"## Chapter 1",
				"\n# First chapter",
				"Larkspur",
				"Direct div",
				"Direct section",
				"Direct item emphasis trailing",
				"Account: A\nBalance: 731\nCurrency: USD",
				"Heading\tTotal",
				"Important value\t731",
				"Before Inner After\tNeighbor",
				"## Chapter 2",
				"Last chapter",
				"Price 10 8 old",
			],
			absent: ["My Novel", "Hidden Author"],
		},
	];

	for (const [caseIndex, item] of cases.entries()) {
		it(`case ${caseIndex} (${item.ext})`, async () => {
			const zip = zipParts(item.parts as Record<string, string>);
			const extracted = await extractDocumentText(zip.bytes(), `.${item.ext}`);
			let previous = -1;
			for (const expected of item.expected) {
				const index = extracted.indexOf(expected);
				assert.ok(index > previous, `${item.ext}: ${expected} in ${extracted.slice(0, 500)}`);
				previous = index;
			}
			if ("occurrences" in item) assert.equal(extracted.split(item.occurrences.text).length - 1, item.occurrences.count);
			for (const absent of ("absent" in item && item.absent) || []) assert.ok(!extracted.includes(absent), `${item.ext}: ${absent} absent`);
			if (("bounded" in item && item.bounded) || item.ext === "epub") {
				assert.ok(extracted.length < 1_000_100);
				assert.ok((extracted.match(/\[Extracted text truncated/g)?.length ?? 0) <= 1);
			}
			if (item.ext === "docx") {
				zip.end.writeUInt16LE(2049, 8);
				zip.end.writeUInt16LE(2049, 10);
				assert.match(await extractDocumentText(zip.bytes(), ".docx"), /\[Extracted text truncated/);
				zip.end.writeUInt16LE(zip.central.length / 2, 8);
				zip.end.writeUInt16LE(zip.central.length / 2, 10);
				zip.central[0]!.writeUInt16LE(8, 10);
				zip.central[0]!.writeUInt32LE(33 * 1024 * 1024, 24);
				assert.match(await extractDocumentText(zip.bytes(), ".docx"), /\[Extracted text truncated/);
			}
		});
	}
});

describe("document text (T3 port): RTF", () => {
	const symbols: Array<[string, string, string]> = [
		[
			"text symbols",
			String.raw`{\rtf1\ansi Pages 1\endash 5\emdash\lquote left\rquote\ldblquote right\rdblquote\bullet\b End\b0\unknown{\*\secret\bullet hidden}}`,
			"Pages 1\u20135\u2014\u2018left\u2019\u201cright\u201d\u2022End",
		],
		["space and hyphen symbols", String.raw`{\rtf1\ansi A\enspace B\emspace C\qmspace D\~E\_F\-G}`, "A\u2002B\u2003C\u2005D\u00a0E\u2011FG"],
		["joiner and direction marks", String.raw`{\rtf1\ansi A\zwj B\zwnj C\ltrmark D\rtlmark E}`, "A\u200dB\u200cC\u200eD\u200fE"],
		[
			"text symbol fallback",
			String.raw`{\rtf1\ansi\uc10\u945\endash\emdash\enspace\emspace\qmspace\lquote\rquote\ldblquote\rdblquote\bullet Z}`,
			"\u03b1Z",
		],
		["hyphen symbol fallback", String.raw`{\rtf1\ansi\uc3\u945\~\_\-Z}`, "\u03b1Z"],
		["control word", String.raw`{\rtf1\ansi A\u9\tab X}`, "A\tX"],
		["line break paragraphs", "{\\rtf1\\ansi First\\\nSecond\\\r\nThird}", "First\nSecond\nThird"],
		["group close", String.raw`{\rtf1\ansi{\u945}Z}`, "\u03b1Z"],
		["group open", String.raw`{\rtf1\ansi\u945{Z}}`, "\u03b1Z"],
		["hex byte", String.raw`{\rtf1\ansi\u945\'3fZ}`, "\u03b1Z"],
		["escaped symbol", String.raw`{\rtf1\ansi\u945\{Z}`, "\u03b1Z"],
		["destination symbol", String.raw`{\rtf1\ansi\u945\*Z}`, "\u03b1Z"],
		["multiple units", String.raw`{\rtf1\ansi\uc4\u945?\tab\'3f\~Z}`, "\u03b1Z"],
		["binary unit", String.raw`{\rtf1\ansi\u945\bin3 abcZ}`, "\u03b1Z"],
		["large fallback", String.raw`{\rtf1\ansi\uc20\u945????????????????????Z}`, "\u03b1Z"],
		["no fallback", String.raw`{\rtf1\ansi\uc0\u945Z}`, "\u03b1Z"],
		["scoped count", String.raw`{\rtf1\ansi{\uc2\u945??}\u946?Z}`, "\u03b1\u03b2Z"],
	];
	for (const [name, source, expected] of symbols) {
		it(`extracts symbols and Unicode fallbacks: ${name}`, async () => assert.equal(await rtf(source), expected));
	}

	it("skips hidden groups and decodes single-byte code pages", async () => {
		const extracted = await rtf(String.raw`{\rtf1\ansi{\fonttbl hidden}Hello\tab world\par Unicode \u945?{\*\secret hidden}}`);
		assert.ok(extracted.includes("Hello\tworld\nUnicode \u03b1"));
		assert.ok(!extracted.includes("hidden"));
		assert.equal(
			await rtf(String.raw`{\rtf1\ansi\ansicpg1251 \'cf\'f0\'e8\'e2\'e5\'f2 {\ansicpg1252 \'e9} \'cc\'ee\'f1\'ea\'e2\'e0}`),
			"\u041f\u0440\u0438\u0432\u0435\u0442 \u00e9 \u041c\u043e\u0441\u043a\u0432\u0430",
		);
		assert.equal(
			await rtf(Buffer.concat([Buffer.from(String.raw`{\rtf1\ansi\ansicpg1251 `), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), Buffer.from("}")])),
			"\u041f\u0440\u0438\u0432\u0435\u0442",
		);
		await assert.rejects(rtf(String.raw`{\rtf1\ansi\ansicpg932 \'82\'a0}`), /Unsupported RTF code page/);
	});

	it("truncates at depth, output and input limits", async () => {
		assert.equal(await rtf(String.raw`{\rtf1 Kept` + "{".repeat(128) + "Lost" + "}".repeat(129)), "Kept\n\n[Extracted text truncated at document extraction limits.]");
		const unicode = await rtf(String.raw`{\rtf1 ` + "x".repeat(999_999) + String.raw`\u-10179?\u-8576? After}`);
		assert.match(unicode, /\[Extracted text truncated/);
		assert.ok(unicode.isWellFormed());
		assert.ok(unicode.startsWith("x".repeat(999_999)));
		assert.equal(await rtf(String.raw`{\rtf1 First` + " ".repeat(1_000_100) + "Last}"), "First\n\n[Extracted text truncated at document extraction limits.]");
		assert.match(await extractDocumentText(new Uint8Array(17 * 1024 * 1024), ".rtf"), /\[Extracted text truncated/);
	});
});

describe("document text (T3 port): notebooks", () => {
	it("extracts cells, outputs and tracebacks without terminal colors", async () => {
		const extracted = await notebook({
			cells: [
				{ cell_type: "markdown", source: ["# Survey\n", "Vessel: Larkspur"] },
				{
					cell_type: "code",
					source: ["print(43 * 7)"],
					outputs: [
						{ text: ["301\n"] },
						{ data: { "text/plain": ["42"] } },
						{
							output_type: "error",
							ename: "ZeroDivisionError",
							evalue: "division by zero",
							traceback: ["\u001b[32mCell In[1], line 1\u001b[0m", "\u001b[31m----> 1 1 / 0\u001b[0m", "ZeroDivisionError: division by zero"],
						},
					],
				},
			],
		});
		for (const expected of ["Vessel: Larkspur", "301", "42"]) assert.ok(extracted.includes(expected));
		assert.ok(extracted.includes("ZeroDivisionError: division by zero\nCell In[1], line 1\n----> 1 1 / 0\nZeroDivisionError: division by zero"));
		assert.ok(!extracted.includes("\u001b"));
	});

	it("truncates at the cell and output limits", async () => {
		const limited = await notebook({ cells: Array.from({ length: 10_001 }, () => ({ source: "Kept" })) });
		assert.ok(limited.includes("## Cell 10000"));
		assert.ok(!limited.includes("## Cell 10001"));
		assert.equal(limited.match(/\[Extracted text truncated/g)?.length, 1);
		const error = await notebook({
			cells: [
				{
					cell_type: "code",
					source: "1 / 0",
					outputs: [{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: ["\u001b[31m" + "trace".repeat(250_000) + "\u001b[0m", "After limit"] }],
				},
			],
		});
		assert.ok(error.includes("ZeroDivisionError: division by zero\ntrace"));
		assert.ok(error.length < 1_000_100);
		assert.equal(error.match(/\[Extracted text truncated/g)?.length, 1);
		assert.ok(!error.includes("After limit"));
	});

	it("rejects invalid notebooks", async () => {
		await assert.rejects(extractDocumentText(new Uint8Array(Buffer.from("{")), ".ipynb"));
	});
});

describe("detectDocumentFormat: extension plus signature", () => {
	const ooxml = (part: string) => zipParts({ "[Content_Types].xml": "<Types/>", [part]: "<x/>" }).bytes();
	const odf = (mimetype: string) => zipParts({ mimetype, "content.xml": "<x/>" }).bytes();
	it("uses one of the nine extensions first, case-insensitively", () => {
		assert.equal(detectDocumentFormat("Notes.DOCX", new Uint8Array()), "docx");
		assert.equal(detectDocumentFormat("a.ipynb", new Uint8Array()), "ipynb");
		assert.equal(detectDocumentFormat("sheet.xlsx", ooxml("word/document.xml")), "xlsx");
	});
	it("falls back to the signature for other or missing extensions", () => {
		assert.equal(detectDocumentFormat("report", ooxml("word/document.xml")), "docx");
		assert.equal(detectDocumentFormat("book.xlsm", ooxml("xl/workbook.xml")), "xlsx");
		assert.equal(detectDocumentFormat("deck.ppsx", ooxml("ppt/presentation.xml")), "pptx");
		assert.equal(detectDocumentFormat("doc.bin", odf("application/vnd.oasis.opendocument.text")), "odt");
		assert.equal(detectDocumentFormat("x", odf("application/vnd.oasis.opendocument.spreadsheet")), "ods");
		assert.equal(detectDocumentFormat("x", odf("application/vnd.oasis.opendocument.presentation")), "odp");
		assert.equal(detectDocumentFormat("x", odf("application/epub+zip")), "epub");
		assert.equal(detectDocumentFormat("letter.txt", new Uint8Array(Buffer.from("{\\rtf1 Hi}"))), "rtf");
	});
	it("returns undefined for other files", () => {
		assert.equal(detectDocumentFormat("archive.zip", zipParts({ "a.txt": "hello" }).bytes()), undefined);
		assert.equal(detectDocumentFormat("notes.txt", new Uint8Array(Buffer.from("plain"))), undefined);
		assert.equal(detectDocumentFormat("data.json", new Uint8Array(Buffer.from('{"cells":[]}'))), undefined);
	});
});

describe("convertDocument: worker, cache, limits", () => {
	afterEach(() => {
		clearDocumentCache();
		documentLimits.timeoutMs = 15_000;
	});
	const docx = (text: string) => zipParts({ "word/document.xml": `<document><p>${text}</p></document>` }).bytes();
	const reason = async (promise: Promise<unknown>) => {
		try {
			await promise;
		} catch (error) {
			assert.ok(error instanceof DocumentConversionError);
			return error.reason;
		}
		assert.fail("expected a DocumentConversionError");
	};

	it("converts in a worker and caches by content hash", async () => {
		const before = documentStats.workerRuns;
		assert.deepEqual(await convertDocument(docx("Cached text"), "docx"), { text: "Cached text", truncated: false });
		assert.deepEqual(await convertDocument(docx("Cached text"), "docx"), { text: "Cached text", truncated: false });
		assert.equal(documentStats.workerRuns - before, 1, "the second call is a cache hit");
		await convertDocument(docx("Other text"), "docx");
		assert.equal(documentStats.workerRuns - before, 2, "different bytes convert again");
	});

	it("caches rejections, classifies them, and keeps only 8 entries", async () => {
		const before = documentStats.workerRuns;
		const broken = new Uint8Array(Buffer.from("not a zip"));
		assert.equal(await reason(convertDocument(broken, "docx")), "invalid");
		assert.equal(await reason(convertDocument(broken, "docx")), "invalid");
		assert.equal(documentStats.workerRuns - before, 1);
		assert.equal(await reason(convertDocument(zipParts({ "word/document.xml": "<document><p> </p></document>" }).bytes(), "docx")), "empty");
		for (let i = 0; i < 8; i++) await convertDocument(docx(`Filler ${i}`), "docx");
		const runs = documentStats.workerRuns;
		assert.equal(await reason(convertDocument(broken, "docx")), "invalid");
		assert.equal(documentStats.workerRuns - runs, 1, "the oldest entry was evicted");
	});

	it("reports encrypted archives and OLE-wrapped (password-protected) OOXML", async () => {
		// An encrypted stored entry carries a 12-byte encryption header before its data.
		const data = Buffer.concat([Buffer.alloc(12), Buffer.from("<document><p>Secret</p></document>")]);
		const zip = zipParts({ "word/document.xml": data });
		zip.central[0]!.writeUInt16LE(1, 8);
		zip.central[0]!.writeUInt32LE(data.length - 12, 24);
		zip.local[0]!.writeUInt16LE(1, 6);
		zip.local[0]!.writeUInt32LE(data.length - 12, 22);
		assert.equal(await reason(convertDocument(zip.bytes(), "docx")), "encrypted");
		const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
		assert.equal(await reason(convertDocument(ole, "xlsx")), "encrypted");
	});

	it("refuses input over 16 MiB without starting a worker", async () => {
		const before = documentStats.workerRuns;
		assert.equal(await reason(convertDocument(new Uint8Array(16 * 1024 * 1024 + 1), "rtf")), "too-large");
		assert.equal(documentStats.workerRuns, before);
	});

	it("stops a conversion at the timeout and does not cache it", async () => {
		documentLimits.timeoutMs = 1;
		const bytes = docx("Slow");
		assert.equal(await reason(convertDocument(bytes, "docx")), "timeout");
		documentLimits.timeoutMs = 15_000;
		assert.equal((await convertDocument(bytes, "docx")).text, "Slow");
	});

	it("runs at most two conversions at once and serves the rest in order", async () => {
		const results = await Promise.all(Array.from({ length: 5 }, (_, i) => convertDocument(docx(`Queued ${i}`), "docx")));
		assert.deepEqual(results.map((result) => result.text), [0, 1, 2, 3, 4].map((i) => `Queued ${i}`));
	});

	it("stops waiting when the caller aborts", async () => {
		const controller = new AbortController();
		const pending = convertDocument(docx("Aborted"), "docx", { signal: controller.signal });
		controller.abort(new Error("Operation aborted"));
		await assert.rejects(pending, /Operation aborted/);
	});
});

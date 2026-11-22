// Inline math sits on the text's baseline on iOS: the answered card's math and the period
// after message math (#313). React Native's iOS text places an inline view from its line's
// bottom and its character's font, TextKit's default, so inlineLift moves each picture up
// onto the baseline. Android places inline views on the baseline and gets no lift.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { Platform } from "react-native";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { AnswerLine } from "../src/AnswerLine.tsx";
import { ChoiceRow } from "../src/ChoiceRow.tsx";
import { Markdown } from "../src/Markdown.tsx";
import { inlineLift } from "../src/MathLabel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IOS_TEXT = new URL("../node_modules/react-native/ReactCommon/react/renderer/textlayoutmanager/platform/ios/react/renderer/textlayoutmanager/", import.meta.url);
/** TextKit's Helvetica 12 descender, where React Native puts an inline view's bottom above its line's bottom. */
const VIEW_FONT_DESCENT = 2.76;

test("React Native still places iOS inline views the way inlineLift undoes", () => {
	// When React Native places them from the line's real baseline (upstream #59921), the lift
	// must go: it would raise every picture above the text.
	const layout = readFileSync(new URL("RCTTextLayoutManager.mm", IOS_TEXT), "utf8");
	assert.match(layout, /glyphRect\.origin\.y \+ glyphRect\.size\.height - attachmentSize\.height \+ font\.descender/);
	const attributed = readFileSync(new URL("RCTAttributedTextUtils.mm", IOS_TEXT), "utf8");
	// An inline view's character gets no font, so TextKit gives it Helvetica 12.
	assert.match(attributed, /attachment\.bounds = bounds;\s+return \[\[NSMutableAttributedString attributedStringWithAttachment:attachment\] mutableCopy\];/);
	// The baseline offset is worked out once over the whole Text, not per line.
	assert.match(attributed, /CGFloat baseLineOffset = \(maximumLineHeight - maximumFontLineHeight\) \/ 2\.0;/);
	assert.match(attributed, /RCTApplyBaselineOffsetForRange\(attributedText, NSMakeRange\(0, attributedText\.length\)\);/);
});

async function render(element: ReactElement) {
	let tree: ReactTestRenderer | undefined;
	await act(async () => { tree = create(element); });
	return tree as ReactTestRenderer;
}

const flat = (style: unknown) => [style].flat(Infinity).reduce<Record<string, unknown>>((all, part) => ({ ...all, ...(part as object) }), {});

const lifted = (box: ReactTestInstance) =>
	0 - ((flat(box.props.style).transform as { translateY?: number }[] | undefined)?.find((step) => "translateY" in step)?.translateY ?? 0);

/** Each inline picture: how far it is lifted, its size in points, and its Text line's height. */
function inlineBoxes(root: ReactTestInstance) {
	return root.findAll((node) => String(node.type) === "Text").flatMap((line) =>
		line.findAll((node) => typeof node.type === "function" && node.type.name === "MathPicture" && node.parent === line)
			.map((picture) => ({
				lift: lifted(picture.children[0] as ReactTestInstance),
				size: picture.props.size as { width: number; height: number; depth: number },
				lineHeight: flat(line.props.style).lineHeight as number,
				padding: (flat(line.props.style).paddingBottom ?? 0) as number,
			})));
}

async function onPlatform<T>(os: string, run: () => Promise<T>) {
	const was = Platform.OS;
	Object.assign(Platform, { OS: os });
	try { return await run(); } finally { Object.assign(Platform, { OS: was }); }
}

/** Renders on a platform and hands back each inline picture, then unmounts. */
async function boxesOn(os: string, element: ReactElement) {
	return onPlatform(os, async () => {
		const tree = await render(element);
		try { return inlineBoxes(tree.root); } finally { act(() => tree.unmount()); }
	});
}

const card = (labels: string[]) => createElement(AnswerLine, { answer: { kind: "quiz", answers: labels.map((label, index) => ({ index, label, value: String(index) })) } });
const message = (text: string) => createElement(Markdown, { text });
const choice = (label: string) => createElement(ChoiceRow, { label, multi: false, selected: false, disabled: false, onPress: () => {} });

test("ios: the lift matches how far math sat below the text in the iPhone check's shots", async () => {
	// Measured on the iPhone check before any lift (run 44871251269, 3x pictures): the bottom of
	// a digit's ink against the bottom of the letters on the same line. A reading is good to a
	// pixel (1/3 pt) at the ink threshold, and React Native rounds the view's origin to the pixel
	// grid, so the lift must match within half a point. After the lift the same spots measured
	// 0 or -1 px (run 44884978315).
	const measured = [
		// The answered card and message prose: 12, 13, 12, 13, 12 and 13 px low.
		{ name: "answered card", element: card(["Train: $4$; test: $8$"]), px: [12, 13, 12, 13, 12, 13] },
		// A choice row: "4" and "8" 9 px low.
		{ name: "choice row", element: choice("Train: $4$; test: $8$"), px: [9, 9] },
	];
	for (const { name, element, px } of measured) {
		const low = px.reduce((sum, value) => sum + value, 0) / px.length / 3;
		for (const { lift } of await boxesOn("ios", element)) {
			assert.ok(Math.abs(lift - low) <= 0.5, `${name}: lift ${lift.toFixed(2)} pt, measured ${low.toFixed(2)} pt`);
		}
	}
});

for (const os of ["ios", "android"] as const) {
	test(`${os}: the answered card's math and a message's inline math are ${os === "ios" ? "lifted" : "not moved"}, and math alone ${os === "ios" ? "comes down onto its line" : "is not moved"}`, async () => {
		const cases = [
			["answered card", card(["Train: $4$; test: $8$", "$(+0.20, -0.10)$"])],
			["message", message("So the step is $0.1(-1)(-2) = 0.2$.")],
			["math alone", card(["$(+0.20, -0.10)$"])],
			["message math alone", message("$\\rule{1em}{4em}$")],
			// A line of its own after a newline holds no text either.
			["math alone on a line after text", message("Earlier text\n$\\rule{1em}{4em}$")],
		] as const;
		for (const [name, element] of cases) {
			const boxes = await boxesOn(os, element);
			assert.ok(boxes.length > 0, `${name}: inline math found`);
			for (const { lift } of boxes) {
				if (os === "android" || name.endsWith("after text")) assert.equal(lift, 0, `${name}: lifted ${lift}, expected none`);
				else if (name.includes("alone")) assert.ok(lift <= -VIEW_FONT_DESCENT, `${name}: lowered onto the line's bottom: ${lift}`);
				else assert.ok(lift > 3, `${name}: lifted ${lift}`);
			}
		}
	});
}

test("ios: the lift uses the fonts of the line the math is on", async () => {
	// The second line holds only 14 pt code right beside the math: its descent is the code's 4.2 pt,
	// not the prose's 6.4. The offset is the whole Text's: (24 - 1.424 * 16) / 2 = 0.608.
	const [math] = await boxesOn("ios", message("Some words first\n`k`$x$"));
	assert.ok(math);
	assert.equal(math.lineHeight, 24);
	assert.ok(Math.abs(math.lift - (4.2 + 0.608 - VIEW_FONT_DESCENT)) < 1e-6, `lifted ${math.lift}`);
});

test("ios: lines keep the line height they have on Android, and tall or deep math stays inside its line", async () => {
	for (const text of ["Earlier text\nRule: $\\rule{1em}{4em}$.", "Deep: $\\rule[-2em]{1em}{1em}$ here.", "So the step is $0.1(-1)(-2) = 0.2$."]) {
		const ios = await boxesOn("ios", message(text));
		const android = await boxesOn("android", message(text));
		assert.deepEqual(ios.map(({ lineHeight }) => lineHeight), android.map(({ lineHeight }) => lineHeight), `${text}: line heights`);
		for (const { lift, size, lineHeight } of ios) {
			// The box's bottom, up from its line's bottom, once lifted.
			const bottom = VIEW_FONT_DESCENT + lift;
			assert.ok(bottom + size.height - size.depth <= lineHeight + 1e-6, `${text}: top ${bottom + size.height - size.depth} inside ${lineHeight}`);
			assert.ok(bottom - size.depth >= 0, `${text}: bottom ${bottom - size.depth} inside the line`);
		}
	}
	const [prose] = await boxesOn("ios", message("So the step is $0.1(-1)(-2) = 0.2$."));
	assert.equal(prose?.lineHeight, 24, "a message line with ordinary math stays at 24");
	const [row] = await boxesOn("ios", choice("Train: $4$; test: $8$"));
	assert.equal(row?.lineHeight, 21, "a choice row stays at the 21 it had before the lift");
});

test("ios: math in a Text of its own shows whole, at every pixel density", async () => {
	// #315. React Native lays a Text with no text out as one line exactly as tall as its
	// pictures' boxes, each box's size rounded up to the pixel grid after adding 0.01 pt
	// (ParagraphShadowNode's getContentWithMeasuredAttachments), and puts a box's top 2.76 pt
	// above the line's (its bottom at the line's bottom plus TextKit's Helvetica 12 descender),
	// that origin rounded to the nearest pixel (ParagraphShadowNode's layout). The Text cuts
	// off what lies outside it (Text.js: overflow hidden).
	for (const [name, element] of [
		["choice", choice("$(-0.10, +0.20)$")],
		["answered card", card(["$(+0.20, -0.10)$"])],
		["message pair", message("$(+0.20, -0.10)$")],
		["message rule", message("$\\rule{1em}{4em}$")],
	] as const) {
		const boxes = await boxesOn("ios", element);
		assert.equal(boxes.length, 1, name);
		const [{ lift, size, padding }] = boxes as [(typeof boxes)[number]];
		for (const scale of [1, 2, 3]) {
			const line = Math.ceil((size.height - size.depth + 0.01) * scale) / scale;
			const top = Math.round(-VIEW_FONT_DESCENT * scale) / scale - lift;
			assert.ok(top >= 0, `${name} at ${scale}x: ${(-top).toFixed(2)} pt cut off at the top`);
			assert.ok(top + size.height <= line + padding, `${name} at ${scale}x: ${(top + size.height - line - padding).toFixed(2)} pt cut off at the bottom`);
		}
	}
	const [android] = await boxesOn("android", choice("$(-0.10, +0.20)$"));
	assert.equal(android?.padding, 0, "Android keeps its layout");
});

test("ios: math alone on the last line of a Text with text keeps room for its depth", async () => {
	// A last line holding only math in a Text with text is laid out taller than its pictures,
	// so only the bottom can cut: the box's bottom sits 2.76 pt above that line's bottom, give
	// or take half a pixel of rounding, and the depth hangs below it.
	const [after] = await boxesOn("ios", message("Earlier text\n$(+0.20, -0.10)$"));
	assert.ok(after);
	assert.equal(after.lift, 0);
	for (const scale of [1, 2, 3]) {
		const below = after.size.depth - VIEW_FONT_DESCENT + 0.5 / scale;
		assert.ok(below <= after.padding, `after text at ${scale}x: ${(below - after.padding).toFixed(2)} pt cut off at the bottom`);
	}
});

test("ios: a cell holding only math keeps its own padding and adds room for the depth", async () => {
	const [cell] = await boxesOn("ios", message("| Pair | Note |\n| --- | --- |\n| $(x)$ | text |"));
	assert.ok(cell);
	// The cell's own padding is 4 pt (space.xs) above and below.
	assert.ok(cell.padding >= 4 + cell.size.depth, `padding ${cell.padding}, depth ${cell.size.depth}`);
});

test("the lift is iOS only, and none for a line with no text beside text", () => {
	const size = { width: 10, height: 13, depth: 0 };
	assert.equal(inlineLift(24, size, { line: [{ fontSize: 16 }], text: [{ fontSize: 16 }], last: true }, 1, "android"), 0);
	assert.equal(inlineLift(24, size, { line: [], text: [{ fontSize: 16 }], last: true }, 1, "ios"), 0);
	assert.ok(inlineLift(24, size, { line: [], text: [], last: true }, 1, "ios") <= -VIEW_FONT_DESCENT);
	assert.equal(inlineLift(24, size, { line: [], text: [], last: true }, 1, "android"), 0);
	// Helvetica's descender doesn't grow with Dynamic Type, so the lift isn't the 1x lift scaled.
	const once = inlineLift(24, size, { line: [{ fontSize: 16 }], text: [{ fontSize: 16 }], last: true }, 1, "ios");
	const twice = inlineLift(24, size, { line: [{ fontSize: 16 }], text: [{ fontSize: 16 }], last: true }, 2, "ios");
	assert.ok(Math.abs(twice - (2 * (once + VIEW_FONT_DESCENT) - VIEW_FONT_DESCENT)) < 1e-6);
});

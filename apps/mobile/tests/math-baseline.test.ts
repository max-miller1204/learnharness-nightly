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
import { Markdown } from "../src/Markdown.tsx";
import { inlineLift } from "../src/MathLabel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IOS_TEXT = new URL("../node_modules/react-native/ReactCommon/react/renderer/textlayoutmanager/platform/ios/react/renderer/textlayoutmanager/", import.meta.url);

test("React Native still places iOS inline views the way inlineLift undoes", () => {
	// When React Native places them from the line's real baseline (upstream #59921), the lift
	// must go: it would raise every picture above the text.
	const layout = readFileSync(new URL("RCTTextLayoutManager.mm", IOS_TEXT), "utf8");
	assert.match(layout, /glyphRect\.origin\.y \+ glyphRect\.size\.height - attachmentSize\.height \+ font\.descender/);
	const attributed = readFileSync(new URL("RCTAttributedTextUtils.mm", IOS_TEXT), "utf8");
	// An inline view's character gets no font, so TextKit gives it Helvetica 12.
	assert.match(attributed, /attachment\.bounds = bounds;\s+return \[\[NSMutableAttributedString attributedStringWithAttachment:attachment\] mutableCopy\];/);
	assert.match(attributed, /CGFloat baseLineOffset = \(maximumLineHeight - maximumFontLineHeight\) \/ 2\.0;/);
});

test("the lift matches how far math sat below the text in the iPhone check's shots", () => {
	// Measured on the iPhone check before any lift (run 44871251269, 3x pictures): the bottom
	// of a digit's ink against the bottom of the text's letters on the same line.
	const measured = [
		// Answered card and message prose, 16 pt on 24 pt lines: 12, 13, 12, 13, 12 and 13 px low.
		{ fontSize: 16, lineHeight: 24, px: [12, 13, 12, 13, 12, 13] },
		// A choice row, 14 pt on 20 pt lines: "4" and "8" 9 px low.
		{ fontSize: 14, lineHeight: 20, px: [9, 9] },
	];
	for (const { fontSize, lineHeight, px } of measured) {
		const low = px.reduce((sum, value) => sum + value, 0) / px.length / 3;
		const lift = inlineLift(lineHeight, [{ fontSize }], 1, "ios");
		assert.ok(Math.abs(lift - low) <= 1 / 3, `${fontSize}/${lineHeight}: lift ${lift.toFixed(2)} pt, measured ${low.toFixed(2)} pt`);
	}
	assert.equal(inlineLift(24, [{ fontSize: 16 }], 1, "android"), 0);
	assert.equal(inlineLift(24, [], 1, "ios"), 0, "a Text holding only math has only TextKit's font, so its math is on the baseline");
});

async function render(element: ReactElement) {
	let tree: ReactTestRenderer | undefined;
	await act(async () => { tree = create(element); });
	return tree as ReactTestRenderer;
}

const flat = (style: unknown) => [style].flat(Infinity).reduce<Record<string, unknown>>((all, part) => ({ ...all, ...(part as object) }), {});

/** Each inline picture's box, the Text line it sits in, and its size in points. */
function inlineBoxes(root: ReactTestInstance) {
	return root.findAll((node) => String(node.type) === "Text").flatMap((line) =>
		line.findAll((node) => typeof node.type === "function" && node.type.name === "MathPicture" && node.parent === line)
			.map((picture) => ({ box: picture.children[0] as ReactTestInstance, line, size: picture.props.size as { height: number; depth: number } })));
}

const lifted = (box: ReactTestInstance) =>
	0 - ((flat(box.props.style).transform as { translateY?: number }[] | undefined)?.find((step) => "translateY" in step)?.translateY ?? 0);

async function onPlatform<T>(os: string, run: () => Promise<T>) {
	const was = Platform.OS;
	Object.assign(Platform, { OS: os });
	try { return await run(); } finally { Object.assign(Platform, { OS: was }); }
}

const card = (labels: string[]) => createElement(AnswerLine, { answer: { kind: "quiz", answers: labels.map((label, index) => ({ index, label, value: String(index) })) } });

for (const os of ["ios", "android"] as const) {
	test(`${os}: the answered card's math and a message's inline math are ${os === "ios" ? "lifted" : "not moved"}, and math alone is not moved`, async () => {
		await onPlatform(os, async () => {
			const trees = [
				["answered card", await render(card(["Train: $4$; test: $8$", "$(+0.20, -0.10)$"]))],
				["message", await render(createElement(Markdown, { text: "So the step is $0.1(-1)(-2) = 0.2$." }))],
				["math alone", await render(card(["$(+0.20, -0.10)$"]))],
				["message math alone", await render(createElement(Markdown, { text: "$\\rule{1em}{4em}$" }))],
			] as const;
			try {
				for (const [name, tree] of trees) {
					const boxes = inlineBoxes(tree.root);
					assert.ok(boxes.length > 0, `${name}: inline math found`);
					for (const { box } of boxes) {
						if (os === "ios" && !name.endsWith("alone")) assert.ok(lifted(box) > 3, `${name}: lifted ${lifted(box)}`);
						else assert.equal(lifted(box), 0, `${name}: not moved`);
					}
				}
			} finally {
				act(() => { for (const [, tree] of trees) tree.unmount(); });
			}
		});
	});
}

test("ios: tall and deep inline math stays inside its line once lifted", async () => {
	await onPlatform("ios", async () => {
		const tree = await render(createElement(Markdown, { text: "Earlier text\nRule: $\\rule{1em}{4em}$ and $\\rule[-2em]{1em}{1em}$." }));
		try {
			const boxes = inlineBoxes(tree.root);
			assert.equal(boxes.length, 2);
			for (const { box, line, size } of boxes) {
				const { lineHeight } = flat(line.props.style) as { lineHeight: number };
				// React Native puts the box's bottom 2.76 pt (TextKit's Helvetica 12 descender) up
				// from its line's bottom, before the lift.
				const bottom = 2.76 + lifted(box);
				assert.ok(bottom + size.height - size.depth <= lineHeight, `top ${bottom + size.height - size.depth} inside ${lineHeight}`);
				assert.ok(bottom - size.depth >= 0, `bottom ${bottom - size.depth} inside the line`);
			}
		} finally {
			act(() => tree.unmount());
		}
	});
});

// Inline math sits on the text's baseline on iOS (owner bug 1, the answered card, and #313,
// the raised period after message math). React Native's iOS text raises glyphs by half a
// line's extra height but places inline views without that raise, so each inline picture
// is lifted by the same amount. Android places the view on the baseline and gets no lift.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { Platform } from "react-native";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { AnswerLine } from "../src/AnswerLine.tsx";
import { Markdown } from "../src/Markdown.tsx";
import { inlineLift } from "../src/MathLabel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Source Sans 3's line height per point of font size (hhea ascent 1024 + descent 400). */
const FONT_LINE = 1.424;

/** React Native's iOS text layout for one line of `lineHeight`, measured up from the line's
 *  bottom: where the text's baseline lands (RCTApplyBaselineOffsetForRange raises it by half
 *  the extra height) and where an inline view's bottom lands (RCTTextLayoutManager: the line
 *  bottom plus the font's descender), before and after a lift. */
function iosLine(fontSize: number, lineHeight: number, lift: number) {
	const descent = 0.4 * fontSize;
	const raise = lineHeight < FONT_LINE * fontSize ? 0 : (lineHeight - FONT_LINE * fontSize) / 2;
	return { textBaseline: descent + raise, viewBottom: descent + lift };
}

test("on iOS the lift puts an inline picture's bottom on the text's baseline", () => {
	for (const [fontSize, lineHeight] of [[16, 24], [16, 31], [14, 20], [17, 40], [16, 20]] as const) {
		const before = iosLine(fontSize, lineHeight, 0);
		const after = iosLine(fontSize, lineHeight, inlineLift(lineHeight, fontSize, "ios"));
		assert.ok(Math.abs(after.viewBottom - after.textBaseline) < 1e-9, `${fontSize}/${lineHeight}`);
		if (lineHeight > FONT_LINE * fontSize) assert.ok(before.viewBottom < before.textBaseline, "unlifted math sat low");
	}
	assert.equal(inlineLift(31, 16, "android"), 0);
});

async function render(element: ReactElement) {
	let tree: ReactTestRenderer | undefined;
	await act(async () => { tree = create(element); });
	return tree as ReactTestRenderer;
}

/** The inline math boxes (the views that hold an equation's picture) and the Text lines they sit in. */
function inlineBoxes(root: ReactTestInstance) {
	return root.findAll((node) => String(node.type) === "Text").flatMap((line) =>
		line.findAll((node) => typeof node.type === "function" && node.type.name === "MathPicture" && node.parent === line)
			.map((picture) => ({ box: picture.children[0] as ReactTestInstance, line })));
}

const translateY = (box: ReactTestInstance) => {
	const style = [box.props.style].flat().reduce((all, part) => ({ ...all, ...part }), {});
	return style.transform?.find((step: { translateY?: number }) => "translateY" in step)?.translateY ?? 0;
};
const lineStyle = (line: ReactTestInstance) => [line.props.style].flat(Infinity).reduce((all, part) => ({ ...all, ...part }), {});

for (const os of ["ios", "android"] as const) {
	test(`${os}: the answered card's chosen math and a message's inline math ${os === "ios" ? "rise to" : "stay on"} the baseline`, async () => {
		const was = Platform.OS;
		Object.assign(Platform, { OS: os });
		try {
			const card = await render(createElement(AnswerLine, { answer: { kind: "quiz", answers: [{ index: 1, label: "Train: $4$; test: $8$", value: "a" }, { index: 2, label: "$(+0.20, -0.10)$", value: "b" }] } }));
			const message = await render(createElement(Markdown, { text: "So the step is $0.1(-1)(-2) = 0.2$." }));
			for (const [name, tree] of [["answered card", card], ["message", message]] as const) {
				const boxes = inlineBoxes(tree.root);
				assert.ok(boxes.length > 0, `${name}: inline math found`);
				for (const { box, line } of boxes) {
					const { fontSize, lineHeight } = lineStyle(line);
					const expected = os === "ios" ? -inlineLift(lineHeight, fontSize, "ios") : 0;
					assert.ok(Math.abs(translateY(box) - expected) < 1e-9, `${name}: lifted ${translateY(box)}, expected ${expected}`);
					if (os === "ios" && lineHeight > FONT_LINE * fontSize) assert.ok(translateY(box) < 0, `${name}: lifted on iOS`);
				}
			}
			act(() => { card.unmount(); message.unmount(); });
		} finally {
			Object.assign(Platform, { OS: was });
		}
	});
}

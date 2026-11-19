// The choice row and the answered card's response line, rendered into a tree with
// react-test-renderer over the stand-ins in tests/mocks (tests/shared-modules.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { AnswerLine } from "../src/AnswerLine.tsx";
import { ChoiceRow } from "../src/ChoiceRow.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function render(element: ReactElement): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = TestRenderer.create(element); });
  return tree as ReactTestRenderer;
}

/** Whether a node is the stand-in native view `name` (tests/mocks). */
const is = (node: ReactTestInstance, name: string) => String(node.type) === name;
const hosts = (tree: ReactTestRenderer) => tree.root.findAll((node) => typeof node.type === "string");
const hidden = (node: ReactTestInstance) =>
  node.props.accessibilityElementsHidden === true || ["no", "no-hide-descendants"].includes(node.props.importantForAccessibility);

/** Text and drawings a screen reader could reach on their own, outside any hidden subtree. */
function reachable(node: ReactTestInstance, found: ReactTestInstance[] = []): ReactTestInstance[] {
  if (typeof node.type === "string" && hidden(node)) return found;
  if (is(node, "Text") || is(node, "SvgXml")) found.push(node);
  for (const child of node.children) if (typeof child !== "string") reachable(child, found);
  return found;
}

const noop = () => {};
const row = (label: string, extra: Partial<Parameters<typeof ChoiceRow>[0]> = {}) =>
  render(createElement(ChoiceRow, { label, multi: false, selected: false, disabled: false, onPress: noop, ...extra }));

test("a math choice row draws its math with no web view, as one radio stop", () => {
  const tree = row("No, $P\\to Q$ is blocked.");
  const types = hosts(tree).map((node) => String(node.type));
  assert.ok(!types.some((type) => /web/i.test(type)), `no web view: ${types.join(" ")}`);
  assert.equal(types.filter((type) => type === "SvgXml").length, 1);
  const [stop, ...others] = tree.root.findAll((node) => is(node, "Pressable"));
  assert.equal(others.length, 0);
  assert.equal(stop?.props.accessibilityRole, "radio");
  assert.equal(stop?.props.accessibilityLabel, "No, P → Q is blocked.");
  assert.deepEqual(stop?.props.accessibilityState, { disabled: false, checked: false });
  assert.deepEqual(reachable(tree.root), [], "nothing inside the row is reachable on its own");
  act(() => tree.unmount());
});

test("a multi-select row is a checked checkbox; a plain row keeps its text", () => {
  const multi = row("$x^2$", { multi: true, selected: true });
  const stop = multi.root.find((node) => is(node, "Pressable"));
  assert.equal(stop.props.accessibilityRole, "checkbox");
  assert.deepEqual(stop.props.accessibilityState, { disabled: false, checked: true });
  assert.equal(stop.props.accessibilityLabel, "x superscript 2");
  act(() => multi.unmount());
  const plain = row("Other", { math: false });
  assert.equal(plain.root.findAll((node) => is(node, "SvgXml")).length, 0);
  assert.equal(plain.root.find((node) => is(node, "Pressable")).props.accessibilityLabel, "Other");
  assert.deepEqual(reachable(plain.root), []);
  act(() => plain.unmount());
});

test("at font scale 1.3 a tall inline equation's line still holds its depth on Android", () => {
  Object.assign(globalThis, { fontScale: 1.3 });
  try {
    const tree = row("Pick $\\begin{pmatrix}1\\\\2\\\\3\\end{pmatrix}$ now");
    const picture = tree.root.find((node) => is(node, "View") && node.props.style?.position === "absolute");
    const box = picture.parent as ReactTestInstance;
    const paragraph = tree.root.find((node) => is(node, "Text") && Array.isArray(node.props.style));
    const lineHeight = (paragraph.props.style as { lineHeight?: number }[]).at(-1)?.lineHeight ?? 0;
    const [height, above] = [picture.props.style.height as number, box.props.style.height as number];
    // Android's line: ascent is the taller of the box and the text's, descent the text's, then
    // the extra split evenly. Passed as is, it is never scaled down.
    const fontSize = 14 * 1.3;
    const top = Math.max(above, 1.024 * fontSize);
    const below = 0.4 * fontSize + (lineHeight - top - 0.4 * fontSize) / 2;
    assert.ok(height > 80, `the matrix grows with the font scale: ${height}`);
    assert.ok(below >= height - above, `depth ${height - above} fits below the baseline: ${below}`);
    act(() => tree.unmount());
  } finally {
    Object.assign(globalThis, { fontScale: 1 });
  }
});

test("an answered card draws chosen math as one stop with no web view, and copies it", async () => {
  const label = "No, $P\\to Q$ is blocked.";
  const tree = render(createElement(AnswerLine, { answer: { kind: "quiz", answers: [{ label, value: "no", index: 1 }], other: "maybe" } }));
  const types = hosts(tree).map((node) => String(node.type));
  assert.ok(!types.some((type) => /web/i.test(type)), `no web view: ${types.join(" ")}`);
  const stop = tree.root.find((node) => is(node, "Pressable"));
  assert.equal(stop.props.accessibilityLabel, "No, P → Q is blocked., maybe");
  assert.deepEqual(reachable(stop), []);
  const { clipboard } = await import("./mocks/expo-clipboard.cjs" as string) as { clipboard: { text: string } };
  await act(async () => { stop.props.onLongPress(); });
  assert.equal(clipboard.text, `${label}, maybe`, "copies the answer as written, math included");
  assert.ok(tree.root.findAll((node) => is(node, "Text") && node.props.children === "Copied").length);
  act(() => tree.unmount());
});

test("an answered card copies from the keyboard and the screen reader, as the screen shows it", async () => {
  // JSON escaping turned "\to" into a tab and "o"; the card shows, and copies, the repaired label.
  const tree = render(createElement(AnswerLine, { answer: { kind: "quiz", answers: [{ label: "No, $P\to Q$ is blocked.", value: "no", index: 1 }] } }));
  const stop = tree.root.find((node) => is(node, "Pressable"));
  const { clipboard } = await import("./mocks/expo-clipboard.cjs" as string) as { clipboard: { text: string } };
  clipboard.text = "";
  await act(async () => { stop.props.onPress(); });
  assert.equal(clipboard.text, "No, $P\\to Q$ is blocked.", "Enter or Space presses it");
  clipboard.text = "";
  await act(async () => { stop.props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } }); });
  assert.equal(clipboard.text, "No, $P\\to Q$ is blocked.");
  assert.equal(stop.props.focusable, true);
  assert.deepEqual(stop.props.accessibilityActions.map(({ label }: { label: string }) => label), ["Copy", "Copy"]);
  act(() => tree.unmount());
});

test("an answered card without math is selectable text, as before", () => {
  const tree = render(createElement(AnswerLine, { answer: { kind: "ask", answers: [{ label: "Yes", value: "yes", index: 1 }] } }));
  const text = tree.root.find((node) => is(node, "Text"));
  assert.equal(text.props.selectable, true);
  assert.equal(text.props.children, "Yes");
  act(() => tree.unmount());
});

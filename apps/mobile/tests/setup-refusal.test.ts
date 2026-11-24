// Starting a new session with a file: a 422 setup refusal (no model, or its
// provider key missing) shows the refusal and keeps the draft editable, while a
// 503 outage (a subscription that can't be reached) keeps the "Send again" path
// that resends the same start. Rendered with react-test-renderer over tests/mocks.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { ATTACHMENT_UPLOADS, PROTOCOL_ROUTES, type ServerInfo } from "../../../src/client-protocol/index.ts";
import { modelsNotConfigured, providerKeyMissing } from "../../../src/core/settings.ts";
import { NewSession } from "../src/NewSession.tsx";
import { apiClient } from "../src/protocol.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const origin = "https://test.learnharness.example";
const info = { capabilities: [ATTACHMENT_UPLOADS] } as unknown as ServerInfo;
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const texts = (tree: ReactTestRenderer) => tree.root.findAll((node) => String(node.type) === "Text").map((node) => node.children.join(""));
const pressable = (tree: ReactTestRenderer, label: string) =>
  tree.root.find((node: ReactTestInstance) => String(node.type) === "Pressable" && node.props.accessibilityLabel === label);

/** NewSession over a fake server that answers every start with `status` and `body`. */
async function startWithFile(status: number, body: object) {
  const starts: { sendId: string }[] = [];
  const api = apiClient(async (url, init) => {
    const path = url.slice(origin.length);
    if (init.method === "POST" && path === PROTOCOL_ROUTES.attachments) {
      return Response.json({ id: "grant-1", uploadUrl: "/api/attachments/upload?id=grant-1&grant=sig", expiresAt: Date.now() + 600_000 },
        { status: 201, headers: { date: new Date().toUTCString() } });
    }
    if (init.method === "POST" && path === PROTOCOL_ROUTES.startWithAttachments) {
      starts.push(JSON.parse(init.body!));
      return Response.json(body, { status });
    }
    return assert.fail(`unexpected ${init.method} ${path}`);
  }, origin, "example-native-token");
  const opened: string[] = [];
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(createElement(NewSession, {
      api, info, kind: "teach", back: () => {}, open: (id: string) => { opened.push(id); }, connectionFault: () => false,
    }));
  });

  Object.assign(globalThis, { pickedFiles: [{ uri: "file:///cache/notes.txt", name: "notes.txt", type: "text/plain", size: 5 }] });
  await act(async () => pressable(tree, "Attach").props.onPress());
  await act(async () => pressable(tree, "Files").props.onPress());
  await settle();
  const input = () => tree.root.find((node: ReactTestInstance) => String(node.type) === "TextInput");
  await act(async () => input().props.onChangeText("teach me this file"));

  const press = async () => {
    await act(async () => pressable(tree, "Start session").props.onPress());
    await settle();
  };
  return { tree, starts, opened, press, input, shown: () => texts(tree) };
}

for (const envelope of [modelsNotConfigured(["strong"]), providerKeyMissing("openrouter", ["strong"])]) {
  test(`a new session with a file refused with 422 ${envelope.code} shows the refusal and does not ask to send again`, async () => {
    const session = await startWithFile(422, envelope);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await session.press();
      assert.equal(session.starts.length, attempt, "each press sends once");
      assert.ok(session.shown().includes(envelope.error), `the refusal is shown: ${session.shown().join(" | ")}`);
      assert.ok(!session.shown().some((text) => /Send again|didn't confirm/.test(text)), "not treated as a start that may have been saved");
      assert.equal(session.input().props.editable, true, "the draft stays editable");
      assert.equal(pressable(session.tree, "Attach").props.disabled, false, "the files stay changeable");
    }
    assert.deepEqual(session.opened, []);
    act(() => session.tree.unmount());
  });
}

test("a new session with a file answered 503 subscription_unreachable keeps the draft and sends the same start again", async () => {
  const session = await startWithFile(503, { error: "GitHub Copilot could not be reached just now. Try again in a moment.", code: "subscription_unreachable", provider: "github-copilot-subscription" });
  await session.press();
  assert.ok(session.shown().some((text) => /Send again/.test(text)), `the start may have been saved: ${session.shown().join(" | ")}`);
  assert.equal(session.input().props.editable, false, "the draft waits unchanged for the same send");
  assert.equal(pressable(session.tree, "Attach").props.disabled, true, "the files wait too");
  await session.press();
  assert.equal(session.starts.length, 2);
  assert.equal(session.starts[1]!.sendId, session.starts[0]!.sendId, "sending again repeats the same start");
  act(() => session.tree.unmount());
});

test("a deleted opening keeps the text and retries with a fresh draft", async () => {
  const session = await startWithFile(409, { code: "opening-deleted", error: "Deleted" });
  await session.press();
  await settle(); await settle();
  assert.equal(session.input().props.value, "teach me this file");
  assert.equal(session.input().props.editable, true);
  await session.press();
  assert.equal(session.starts.length, 2);
  assert.notEqual((session.starts[0] as { draftId?: string }).draftId, (session.starts[1] as { draftId?: string }).draftId);
  act(() => session.tree.unmount());
});

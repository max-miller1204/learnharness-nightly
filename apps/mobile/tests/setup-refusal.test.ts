// A new session started with a file while no model is set up, or its provider
// key is missing, is refused with 422. The phone shows the refusal and keeps
// the draft editable instead of offering "Send again" for a start that may
// have been saved. Rendered with react-test-renderer over tests/mocks.
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

for (const envelope of [modelsNotConfigured(["strong"]), providerKeyMissing("openrouter", ["strong"])]) {
  test(`a new session with a file refused with 422 ${envelope.code} shows the refusal and does not ask to send again`, async () => {
    const starts: unknown[] = [];
    const api = apiClient(async (url, init) => {
      const path = url.slice(origin.length);
      if (init.method === "POST" && path === PROTOCOL_ROUTES.attachments) {
        return Response.json({ id: "grant-1", uploadUrl: "/api/attachments/upload?id=grant-1&grant=sig", expiresAt: Date.now() + 600_000 },
          { status: 201, headers: { date: new Date().toUTCString() } });
      }
      if (init.method === "POST" && path === PROTOCOL_ROUTES.startWithAttachments) {
        starts.push(JSON.parse(init.body!));
        return Response.json(envelope, { status: 422 });
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

    for (let attempt = 1; attempt <= 2; attempt++) {
      await act(async () => pressable(tree, "Start session").props.onPress());
      await settle();
      assert.equal(starts.length, attempt, "each press sends once");
      assert.ok(texts(tree).includes(envelope.error), `the refusal is shown: ${texts(tree).join(" | ")}`);
      assert.ok(!texts(tree).some((text) => /Send again|didn't confirm/.test(text)), "not treated as a start that may have been saved");
      assert.equal(input().props.editable, true, "the draft stays editable");
      assert.equal(pressable(tree, "Attach").props.disabled, false, "the files stay changeable");
    }
    assert.deepEqual(opened, []);
    act(() => tree.unmount());
  });
}

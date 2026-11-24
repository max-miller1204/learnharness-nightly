// A saved model the server's catalog no longer has is refused with 422
// model_unavailable. The phone shows that message on both send paths instead of
// treating the refusal as a send that may have been delivered.
import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_ROUTES } from "../../../src/client-protocol/index.ts";
import { apiClient } from "../src/protocol.ts";
import { errorText, refusedByServer } from "../src/use-session.ts";

const origin = "https://test.learnharness.example";
const message = "The model minimax-m3.1-flash-free from OpenCode Go isn't available right now. It may be retired, or its provider isn't connected or can't be reached. Check Providers in Settings, or pick another model.";
const api = apiClient(async () => Response.json({ error: message, code: "model_unavailable" }, { status: 422 }), origin, "example-native-token");

for (const [path, route, body] of [
  ["a new session started with files", PROTOCOL_ROUTES.startWithAttachments, { draftId: "draft", title: "teach me", attachmentUploadIds: ["upload"] }],
  ["a send in an existing session", PROTOCOL_ROUTES.send, { chatId: "chat", input: { type: "text", text: "next" } }],
] as const) {
  test(`${path}: 422 model_unavailable shows its message and is not a maybe-delivered send`, async () => {
    const error = await api.post(route, body, new AbortController().signal).then(() => assert.fail("refused"), (thrown: unknown) => thrown);
    assert.equal(refusedByServer(error), true);
    assert.equal(errorText(error), message);
  });
}

test("a 5xx still counts as a send that may have been delivered", async () => {
  const failing = apiClient(async () => Response.json({ error: "busy" }, { status: 503 }), origin, "example-native-token");
  const error = await failing.post(PROTOCOL_ROUTES.send, {}, new AbortController().signal).catch((thrown: unknown) => thrown);
  assert.equal(refusedByServer(error), false);
});

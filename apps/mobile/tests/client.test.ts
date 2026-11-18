import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_HEADER, PROTOCOL_ROUTES, type LhMessage, type TurnStreamEvent } from "../../../src/client-protocol/index.ts";
import { ApiError, apiClient, bearerKey, browserDestination, readPairingLink } from "../src/protocol.ts";
import { consumeSse } from "../src/sse.ts";
import { inputWasSaved, turnReplay } from "../src/live-turn.ts";
import { httpsLink, parseMarkdown, renderMarkdown } from "../src/render-markdown.ts";

const origin = "https://test.learnharness.example:8443";
const other = "https://other.learnharness.example";
const credential = "ABCD-EFGH-JKLM";
const signal = new AbortController().signal;

test("scans the shared pairing URL, normalizes codes, and isolates origin keys", () => {
  assert.deepEqual(readPairingLink(`${origin}/pair#token=${credential}`), { origin, code: "ABCDEFGHJKLM" });
  assert.throws(() => readPairingLink("http://test.learnharness.example/pair#token=ABCDEFGHJKLM"));
  assert.throws(() => readPairingLink(`${origin}/other#token=${credential}`));
  assert.notEqual(bearerKey(origin), bearerKey(other));
  assert.notEqual(bearerKey(origin), bearerKey("https://test.learnharness.example"));
  assert.equal(bearerKey("https://TEST.learnharness.example:8443/"), bearerKey(origin));
});

test("checks the exact protocol before exchanging a one-time code", async () => {
  const urls: string[] = [];
  const api = apiClient(async (url, options) => {
    urls.push(url);
    assert.equal(options.headers[PROTOCOL_HEADER], "1");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, undefined);
    if (url.endsWith(PROTOCOL_ROUTES.token)) {
      assert.equal(new URLSearchParams(options.body).get("subject_token"), "ABCDEFGHJKLM");
      return Response.json({ access_token: "example-native-token", token_type: "Bearer" });
    }
    return Response.json({
      name: "Test server", version: "", protocolVersion: 1, capabilities: [],
      auth: { required: true, bootstrapMethods: ["one-time-token"], sessionMethods: ["bearer-access-token"], tokenEndpoint: "/oauth/token" },
    });
  }, origin);
  assert.equal((await api.descriptor(signal)).protocolVersion, 1);
  assert.equal(await api.exchange(credential, "android", signal), "example-native-token");
  assert.deepEqual(urls, [origin + PROTOCOL_ROUTES.serverInfo, origin + PROTOCOL_ROUTES.token]);
  for (const protocolVersion of [0, 2]) {
    const wrong = apiClient(async () => Response.json({ name: "Test server", protocolVersion }), origin);
    await assert.rejects(wrong.descriptor(signal), {
      status: 426,
      message: protocolVersion === 0 ? /older LearnHarness/ : /app is too old/,
    });
  }
});

test("bearer requests reject cross-origin routes and distinguish a server's 426 refusal", async () => {
  let calls = 0;
  const api = apiClient(async (url, options) => {
    calls++;
    assert.equal(url, origin + PROTOCOL_ROUTES.chats);
    assert.equal(options.headers.Authorization, "Bearer example-native-token");
    return Response.json({ protocolVersion: 2, code: "protocol_incompatible" }, { status: 426 });
  }, origin, "example-native-token");
  await assert.rejects(api.get(other + "/api/chats", signal), /Invalid LearnHarness route/);
  await assert.rejects(api.get("//other.learnharness.example/api/chats", signal), /Invalid LearnHarness route/);
  await assert.rejects(api.get(PROTOCOL_ROUTES.chats, signal), (error) => error instanceof ApiError && error.status === 426);
  assert.equal(calls, 1);
  assert.equal(browserDestination(origin, "chat_123"), `${origin}/chat/chat_123`);
  assert.equal(browserDestination(origin, "chat_123", credential), `${origin}/pair#token=${credential}&chat=chat_123`);
  assert.throws(() => browserDestination(origin, "//evil.example"));
});

test("SSE handles CRLF splits, UTF-8, event fields, comments and termination", async () => {
  const text = ": ping\r\nevent: record-changed\r\ndata: first ☀\r\ndata: second\r\n\r\ndata: [DONE]\n\ndata: ignored\n\n";
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const frames: string[][] = [];
  await consumeSse(stream, (event, data) => { frames.push([event, data]); return data !== "[DONE]"; });
  assert.deepEqual(frames, [["record-changed", "first ☀\nsecond"], ["message", "[DONE]"]]);
});

test("live replay replaces partials and each attachment starts with an empty tail", () => {
  const frame = (type: string, text: string) => ({
    type, message: { role: "assistant", content: [{ type: "text", text }] },
  }) as TurnStreamEvent;
  const consume = turnReplay();
  const start = consume(frame("message_start", "Blue"));
  const end = consume(frame("message_update", "Blue scatters"));
  assert.equal(start?.[0]?.id, end?.[0]?.id);
  assert.equal(consume(frame("message_end", "Blue scatters most"))?.length, 1);
  assert.equal(consume(frame("message_start", "Next"))?.length, 2);
  assert.equal(turnReplay()(frame("message_start", "New attachment"))?.length, 1);
});

test("reconciles the same text or thinking only if a new saved occurrence exists", () => {
  const user: LhMessage = { id: "old", role: "user", content: "work", timestamp: 1 };
  const thinking: LhMessage = {
    id: "new", role: "custom", customType: "practice-thinking", content: "Your thinking:\nwork",
    details: { problemCallId: "p2", text: "work" }, display: true, timestamp: 2,
  };
  assert.equal(inputWasSaved([user], new Set(["old"]), { type: "text", text: "work" }), false);
  assert.equal(inputWasSaved([user, thinking], new Set(["old"]), { type: "thinking", problemCallId: "p1", text: "work" }), false);
  assert.equal(inputWasSaved([user, thinking], new Set(["old"]), { type: "thinking", problemCallId: "p2", text: "work" }), true);
});

test("only parsed math opts a message into the WebView", () => {
  assert.equal(parseMarkdown("## Heading\n\n**Text** followed by [a link](https://example.test).").hasMath, false);
  assert.equal(parseMarkdown("It costs $10. Here is code: `$x^2$`.").hasMath, false);
  assert.equal(parseMarkdown("An inline equation $x^2=4$.").hasMath, true);
  assert.equal(parseMarkdown("> Display math:\n> \\[x=2\\]").hasMath, true);
});

test("only HTTPS links leave the transcript through the confirmation handler", () => {
  const parsed = parseMarkdown("https://example.test/source [HTTP](http://example.test) [local](/chat/one) [email](mailto:me@example.test)");
  const hrefs = parsed.tokens.flatMap(({ children }) => children ?? [])
    .filter(({ type }) => type === "link_open").map((token) => httpsLink(token.attrGet("href")));
  assert.deepEqual(hrefs, ["https://example.test/source", undefined, undefined, undefined]);
  assert.equal(httpsLink("//example.test/source"), undefined);
  assert.equal(httpsLink("HTTPS://EXAMPLE.TEST/source"), "https://example.test/source");
  assert.equal(httpsLink("https://"), undefined);
});

test("math markup renders local math and passes only escaped HTTPS links to the host", () => {
  const html = renderMarkdown(parseMarkdown("**Solve** $x^2=4$\n\n\\[x=2\\]\n\n<img onerror=alert(1)> [external](https://example.test/?a=1&b=2) [plain](http://example.test)"));
  assert.match(html, /<strong>Solve<\/strong>/);
  assert.equal(html.match(/<math\b/g)?.length, 2);
  assert.match(html, /<a href="https:\/\/example.test\/\?a=1&amp;b=2">external<\/a> plain/);
  assert.equal(html.match(/<a\b/g)?.length, 1);
  assert.doesNotMatch(html, /<img\b/);
});

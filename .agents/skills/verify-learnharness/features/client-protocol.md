# Client protocol

## Sub-features

- `GET /.well-known/learnharness/server` is public and uncached; it names the server, the protocol version, the auth methods and the capabilities (docs/specs/client-protocol.md).
- A request naming another protocol version (header `X-LearnHarness-Protocol`, or `?protocol=` on the two streams) gets 426 before the login check; one naming the right version, or none, goes on to it.
- A native client trades a one-time pairing code for a bearer token at `/oauth/token`, lists, creates and opens sessions, sends, watches the turn stream and the notification stream, and stops a running turn at `/api/activity/abort`.

## How to get to it (user POV)

The phone app and the desktop app pointed at a server use it; there is no screen for it in the web UI.

## Driving it with e2e

`tests/e2e/client-protocol.e2e.ts`: raw `fetch` against `app.baseUrl`, no browser. It mints pairing codes with `createPairingLink` (`selfhost/src/auth-store.ts`) in the instance's data folder. Its turns use the fake model's `zz-e2e slow` (a reply held back briefly, so the turn stream is live) and `zz-e2e hang` (a reply held back until the turn is aborted) goals from `tests/e2e/support/scenarios/teach.json`. The image test writes a snapshot into the stored record, since `show_image` belongs to the teacher phase. Streams are opened before the send (the response head means the app has subscribed), and frames keep their `event:` names.

## Proof

The status, headers and body of each answer against the spec: exact server-info keys, 426 with `protocol_incompatible` for every refused request, the turn stream's `agent_start` through `agent_end` and `[DONE]`, the notification stream naming `turn-started` then `turn-settled` for the chat, a settled stream saying `turn-settled`, an image fetched by its snapshot id (and no other id, or session, finding it), and abort answering 200 while it runs and 409 after.

## Gotchas

- The shape of the contract is pinned separately by `tests/client-protocol.test.ts`; this drive is the running server.

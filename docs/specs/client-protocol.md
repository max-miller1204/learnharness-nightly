# Client protocol and server info

Status: approved by the owner on 2026-11-17.

Goal: roadmap item 21. A client released separately from the server (the Expo phone app, item 22; the desktop app pointed at a remote server, item 23) needs an API it can rely on. This adds a public server-info route, one protocol version that client and server must match exactly, the list of routes that form protocol 1, and a typed contract clients import. The model is T3 Code's (`pingdotgg/t3code`, MIT): its `/.well-known/t3/environment` descriptor, `ORCHESTRATION_PROTOCOL_VERSION`, the `426` answer to a mismatched client and the client's two mismatch messages.

## Decided by the owner

1. **Exact protocol version match** between client and server, like T3 (chosen over a version range).
2. **One backend per person.** A client talks to one server at a time.
3. **Clients authenticate with item 6's bearer token** (`/oauth/token`, `Authorization: Bearer`).
4. **The phone app draws native screens over the API**, like T3's mobile app (2026-11-17). So protocol 1 covers the core chat flow, not only server info and login.

## Adopted from T3 Code (veto any)

| Topic | T3's answer, adopted |
|---|---|
| Server-info route | `GET /.well-known/learnharness/server`, public (no credential), `Cache-Control: no-store`. T3: `/.well-known/t3/environment`. A client reads it before pairing and on every connect. |
| Server-info body | `{ name, version, protocolVersion, auth, capabilities }` (shape below). T3's descriptor also has an environment ID, platform and machine kind; they're left out because one backend per person needs none of them. |
| Name | The machine's host name (`os.hostname()`), like T3's label fallback. |
| Version check | Exact: a client connects only when `protocolVersion` equals its own `CLIENT_PROTOCOL_VERSION`. Only breaking changes bump it. |
| Additive changes | A new route or field a client can live without is a new **capability** string, with no bump (T3's optional capability flags; the roadmap's OpenBot-style names). Clients hide a feature whose capability is missing. The base protocol works with an empty list. Item 24 adds the first capabilities, [`attachment-uploads-v1` and `attachment-folders-v1`](remote-safe-attachments.md). See [the mobile beta spec](mobile-beta.md) for `practice-controls-v1` and `browser-handoff-v1`. |
| Client sends its version | Header `X-LearnHarness-Protocol: 1` on every protocol request. Streams may use the query `?protocol=1` instead (T3 does this for its socket), since `EventSource` can't always set headers. |
| Server refuses a mismatch | When a request carries a protocol version that isn't the server's, `proxy.ts` answers `426 { error, code: "protocol_incompatible", protocolVersion }` before the login check, so an old client sees the real reason, not "signed out". Requests without the header (the server's own web UI) are never checked. Server info is never refused. |
| Mismatch messages (client side) | Server newer: "This app is too old for {name}. Update the app to connect." Server older: "{name} runs an older LearnHarness. Update LearnHarness on {name} to connect." (T3's two messages.) The contract exports a helper that returns one of these or nothing. |
| Old versions | A server speaks only its own protocol version (follows from exact match). |
| Contract package | One dependency-free TypeScript file clients import, like T3's `packages/contracts` but without Effect: constants, request and response types, the mismatch helper. Its record types are type-only re-exports of the server's own (`src/core`), so they can't drift apart. |

## Server info body

```ts
{
  name: string;                // "max-desktop"
  version: string;             // server version, e.g. "0.6.1-nightly.20261117"
  protocolVersion: 1;
  auth: {
    required: true;            // item 6: every data route needs a credential
    bootstrapMethods: ("one-time-token" | "desktop-bootstrap")[];   // desktop-bootstrap only in the desktop app's server
    sessionMethods: ["browser-session-cookie", "bearer-access-token"];
    sessionCookieName: string; // "lh_session_<port>"
    tokenEndpoint: "/oauth/token";
  };
  capabilities: string[];      // [] on servers without additive features
}
```

`/api/health` stays exactly as it is: launcher protocol 1 depends on it.

## Protocol 1 routes

The core flow a native client needs: sign in, list and open sessions, send, watch the turn, stop it, stay in sync. Everything else (graph, settings, keys, models, plugins, themes, side chats, rename, delete, devices) stays internal for now and changes freely; a client that needs one adds it to the contract with a capability or a bump.

| Route | Use |
|---|---|
| `GET /.well-known/learnharness/server` | Server info (new). |
| `POST /oauth/token` | Pair: trade a pairing code for a bearer token (item 6, unchanged). |
| `GET /api/auth/session` | Is my token still good? (item 6, unchanged). |
| `GET /api/chats` | Session list (`{ chats: ChatListItem[] }`). |
| `POST /api/chats` | New session. |
| `GET /api/chats/:id` | One session record, messages verbatim. |
| `POST /api/chat` | Send one input event (`{ chatId, input }`: text, answer, continue, ...). |
| `GET /api/chats/:id/stream` | The turn stream (SSE of pi agent events, then `[DONE]`). |
| `POST /api/activity/abort` | Stop a turn (`{ kind: "turn", id: chatId }`). |
| `GET /api/events` | The notification stream (SSE, notify then fetch). |
| `GET /api/chats/:id/images/:snapshotId` | Image bytes a record refers to. |

These routes remain available to protocol 1 clients. The optional attachment fields and routes are documented in the [attachment spec](remote-safe-attachments.md).

## Keeping it honest

- **Shape fingerprint test** (`tests/client-protocol.test.ts`), the roadmap's "frozen-shape fixture" in the style of `selfhost/tests`: it follows the contract through the TypeScript checker to every declaration it reaches in the repo, however many files deep (so `ChatRecord.phase` reaches `src/core/phases.ts`), and hashes those declarations plus the pinned `@earendil-works/pi-*` versions (the turn stream is pi's event shape). When the hash changes, the test fails and says: breaking for an old client, bump `CLIENT_PROTOCOL_VERSION`; additive, add a capability; then update the recorded hash. Function bodies and comments don't count, so ordinary refactors don't trip it.
- **Server-info test**: exact keys and values, public without a credential.
- **Proxy tests**: a mismatched header or query gets 426 before the login check; a matching one and no header pass through; server info is public.

## Files

- `src/client-protocol/index.ts`: the contract (new).
- `app/.well-known/learnharness/server/route.ts` and a `serverInfo()` helper in `src/server/` (new).
- `proxy.ts`: server info joins the public paths; the protocol check.
- The protocol 1 route handlers: `satisfies` only. `app/` routes import the contract types through the `@/src/server` barrel (the import law). `SessionCoverage` moves from `src/server/chats.ts` to `src/core/contracts/chat.ts` so the contract can share it, and the turn stream's `TurnWireEvent` is now derived from the contract's `TurnStreamEvent`.
- `docs/development.md`: a short "Client protocol" section with the bump rule. `docs/fork-roadmap.md` item 21: marked built, linking this spec.

## Not in this item

- The phone app (22), the desktop server list (23), attachment uploads (24).
- CORS: no protocol client is a browser on another origin (the desktop window loads the server's own UI).
- Publishing the contract as an npm package (item 29's question). Item 22 imports the file from this repo.

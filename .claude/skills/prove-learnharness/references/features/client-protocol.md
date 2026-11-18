# Client protocol

A client released separately from the server (the Expo phone app, the desktop app pointed at a remote server) reads the server's info, checks the protocol version, pairs for a bearer token and then uses the protocol 1 routes: sessions, sending, the turn stream, stopping a turn and the events stream. Spec: `docs/specs/client-protocol.md`; contract: `src/client-protocol/index.ts`.

## Sub-features

- `server-info`: `GET /.well-known/learnharness/server`, public.
- `version-check`: a request naming another protocol version (header `X-LearnHarness-Protocol` or the `?protocol=` query) is refused before the login gate.
- `pair`: a pairing code traded at `POST /oauth/token` for a bearer token.
- `session-routes`: list, create and open sessions with that token.
- `turn`: send a text input, read the turn stream to `[DONE]`, see the events stream frames for it.
- `stop`: stop a running turn through `/api/activity/abort`.

## How to get to it

- HTTP only, no UI: any client that sends `X-LearnHarness-Protocol: 1` (no shipped client yet; the phone app is item 22).
- The server's own web UI sends no header and must not be affected (the teaching-session drive covers it).

## Driving it

Preconditions: the Feature README baseline, a head instance `H=$(scripts/start.sh "$RUN" head)`. The base build has no server-info route (a new flow), so there is nothing to diff against base: compare the observations with the spec.

1. `node scripts/protocol-check.mjs "$H"` -> `$(dirname "$H")/protocol/result.json` with:
   - `serverInfo`, `health` (the same instance's `/api/health`, for its version) and `serverInfoVariants` (mismatched header and query, bad bearer, cross-site origin, trailing slash, HEAD, POST).
   - `matrix`: public routes, a public page, signed-in API and pages, each signed out and in, with no header, header `1`, `2`, `0`, `1.0`, `" 1 "`, an empty header, `?protocol=1|2`, and header and query disagreeing.
   - `streams`: `/api/events` and a turn stream with the same variants.
   - `pairing`, `token`, `tokenReuse`: a code minted into `DATA_DIR` with `createPairingLink` (the way `lh pair` does), traded at `/oauth/token`, then reused.
   - `session`, `list0`, `create`, `list1`, `open0`, `send`, `turnStream`, `events`, `open1`, `abortSettled`: the native client run, every request with `X-LearnHarness-Protocol: 1` and only the paired bearer token.
   - `abortRunning`: the fake model set to `hang`, a turn sent, stopped mid-turn, the record read after (the fake model is reset to `none`).
   - `imageMissing`, `mismatchWithToken`, `badToken`.
2. Read each block against the spec's tables (server info body, the 426 body and its ordering before the login check, the protocol 1 route shapes in the contract).

## Gotchas

- `version` in server info must equal `/api/health`'s version on the same instance: `start.sh` runs the server with `env -i`, so a value that only works when `LH_VERSION` is in the live environment shows up here as `""`.
- The events stream never ends: `protocol-check.mjs` reads it for a fixed time; open it before sending the turn.
- Raw `http.request` is used so empty or padded header values are sent exactly as written.
- Sessions created are titled `zz-prove-it protocol ...`, in the instance's throwaway data dir.

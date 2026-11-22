# HTTP API (`app/api`)

Next.js route handlers behind `proxy.ts`, which is a login gate (docs/specs/login-pairing.md): every page and API request needs a session, sent as the `lh_session_<port>` cookie or `Authorization: Bearer <token>`. Signed out, API routes answer 401 and pages render the pairing screen. Public: `/pair`, `/api/health`, `/api/auth/session`, `/api/auth/browser-session`, `/oauth/token` and static files. A cookie on a request from another site is refused with 403: a foreign `Origin`, or Fetch Metadata `Sec-Fetch-Site: cross-site` or `same-site` even with no `Origin` (only a top-level `GET` load of a page, not `/api/`, gets through; on a page a refused cookie shows the pairing screen). With no Fetch Metadata the `Origin` check alone applies. Bearer tokens skip that check. There is no Host allowlist. `start.sh` writes a session into each login-era instance's store and saves it as `APP_TOKEN` in instance.env; `scripts/sign-in.mjs` makes the scripts send it. The desktop app trades its per-launch secret for a bearer session at `/oauth/token` and its window injects `Authorization` itself.

## How a run drives it

`node scripts/api-check.mjs <instance.env>` uses raw `http.request` (so it can forge `Host`) against one instance and writes `api-check/result.json`:

- **Read routes**, with `origin: <app>`: health, settings, models, chats, graph (+status, costs, sources), plugins, themes, activity, updates, keys, custom-provider, settings/prompts, subscriptions (needs `x-learnharness-subscriptions: 1`), claude-code (needs `x-learnharness-claude-code: 1`; 403 "disabled" until opted in). The observation is `GET <route> <status> <shape>`, where shape is keys and value types, so base and head diff cleanly.
- **Refusals:** foreign Host 403, cross-site Origin 403, cross-site fetch metadata 403 (with login: the cookie, `sec-fetch-site: cross-site` and no `Origin`), unknown session 404, turn on unknown session 404, bad JSON 400, delete without `mode` 400, empty text input 400.
- **Round trip:** `POST /api/chats` then list and `data/chats/<id>.json`, then `DELETE /api/chats/<id>?mode=preserve-graph`, then gone from both.
- **Model failure:** fake model switched to `http500`, a turn via `POST /api/chat {chatId, input:{type:"text",text}}` must end with an assistant message whose `stopReason` is `error`.

## Calling routes by hand

```bash
. "$H"   # APP_URL, DATA_DIR, ...
curl -s "$APP_URL/api/chats"
curl -s -X POST "$APP_URL/api/chats" -H 'content-type: application/json' -H "origin: $APP_URL" -d '{"title":"zz-prove-it x"}'
curl -s -X POST "$APP_URL/api/chat" -H 'content-type: application/json' -d '{"chatId":"<id>","input":{"type":"text","text":"zz-prove-it hi"}}'
```

Writes from a non-browser client without `Origin` are allowed by design; some routes (custom-provider, subscriptions, claude-code) still require a same-origin header.

## Adding a check for a new route

Add it to `READS` (with its headers and expected status) or as a step in `api-check.mjs`, keeping observations value-free. A new route is a new flow: its answer key is the spec, and later the client protocol (see planned.md) when it becomes part of `/api/v<N>`.

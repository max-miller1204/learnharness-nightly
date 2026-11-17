# HTTP API (`app/api`)

Next.js route handlers behind `proxy.ts`. In browser-only mode (`next start`, self-hosted, prove instances) the gate is a Host check (localhost names and IP literals pass; others need `LH_ALLOWED_HOSTS`) plus a cross-site check on writes (`Origin` and `Sec-Fetch-Site`). In desktop mode every request needs the per-launch `x-learnharness-desktop` secret, which only the Electron window has.

## How a run drives it

`node scripts/api-check.mjs <instance.env>` uses raw `http.request` (so it can forge `Host`) against one instance and writes `api-check/result.json`:

- **Read routes**, with `origin: <app>`: health, settings, models, chats, graph (+status, costs, sources), plugins, themes, activity, updates, keys, custom-provider, settings/prompts, subscriptions (needs `x-learnharness-subscriptions: 1`), claude-code (needs `x-learnharness-claude-code: 1`; 403 "disabled" until opted in). The observation is `GET <route> <status> <shape>`, where shape is keys and value types, so base and head diff cleanly.
- **Refusals:** foreign Host 403, cross-site Origin 403, cross-site fetch metadata 403, unknown session 404, turn on unknown session 404, bad JSON 400, delete without `mode` 400, empty text input 400.
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

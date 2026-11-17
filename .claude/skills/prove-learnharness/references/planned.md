# Planned surfaces (extension points)

Not built yet. A diff that reaches one of these is BLOCKED for that surface until `/prove-it` adds its section to SKILL.md (Scope map row, Answer keys row, a surface section, scripts, a recipe). Keep these notes current as the specs land in `docs/specs/`.

## Mobile app (Expo, Android emulator)

- Where it will live: `apps/mobile/**` or `mobile/**` (the Scope rule in `scripts/scope.mjs` already maps both to `mobile`; adjust it to the real path).
- How to drive it: an Android emulator on this Linux machine through T3's device tools (`device_list`, `device_open`, then the `agent-device` command it returns for launches, taps, text and screenshots; `device_screenshot` to look). Never `adb` or emulator scripts for interaction; `adb` stays fine for installs, port forwards (`adb reverse tcp:<port> tcp:<port>` so the emulator reaches a prove instance) and logs.
- Server: a prove instance from `start.sh` (the app is a client of a server you choose), with pairing once roadmap item 6 lands.
- Answer key: parity with the web app on the same server (same session through the phone and the browser, same stored record), plus the spec for phone-only flows.
- Script slot: `scripts/mobile.sh <RUN>` (boot or reuse the emulator, install the build, point it at `$APP_URL`), and a drive that writes `result.json` in the same format so `compare.mjs` can diff phone and browser.

## Client protocol (`/api/v<N>`, server info, capabilities)

- Where it will live: `app/api/v<N>/**` plus a server-info route (roadmap item 21). `scope.mjs` maps `app/api/v<N>/**` to `protocol` and `api`.
- Answer keys: frozen-shape fixtures (rung 2 snapshots in `.prove-it/snapshots/protocol/v<N>/`, written from the version the user approves, never by the builder) and parity with the internal route each one wraps (rung 1).
- Script slot: extend `api-check.mjs` (or a sibling `protocol-check.mjs`) to call every v<N> route, diff its full body shape against the frozen fixture, and check that a capability the server does not advertise is hidden by the client.

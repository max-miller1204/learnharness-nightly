# Planned surfaces (extension points)

Not built yet. A diff that reaches one of these is BLOCKED for that surface until `/prove-it` adds its section to SKILL.md (Scope map row, Answer keys row, a surface section, scripts, a recipe). Keep these notes current as the specs land in `docs/specs/`.

## Mobile app (Expo, Android emulator)

- Where it will live: `apps/mobile/**` or `mobile/**` (the Scope rule in `scripts/scope.mjs` already maps both to `mobile`; adjust it to the real path).
- How to drive it: an Android emulator on this Linux machine through T3's device tools (`device_list`, `device_open`, then the `agent-device` command it returns for launches, taps, text and screenshots; `device_screenshot` to look). Never `adb` or emulator scripts for interaction; `adb` stays fine for installs, port forwards (`adb reverse tcp:<port> tcp:<port>` so the emulator reaches a prove instance) and logs.
- Server: a prove instance from `start.sh` (the app is a client of a server you choose), with pairing once roadmap item 6 lands.
- Answer key: parity with the web app on the same server (same session through the phone and the browser, same stored record), plus the spec for phone-only flows.
- Script slot: `scripts/mobile.sh <RUN>` (boot or reuse the emulator, install the build, point it at `$APP_URL`), and a drive that writes `result.json` in the same format so `compare.mjs` can diff phone and browser.

## Client protocol

Built (roadmap item 21, `docs/specs/client-protocol.md`): server info at `/.well-known/learnharness/server`, an exact version match through the `X-LearnHarness-Protocol` header on the existing routes (no `/api/v<N>` paths), and the contract in `src/client-protocol/`. It is driven as part of the API surface: recipe [features/client-protocol.md](features/client-protocol.md), script `scripts/protocol-check.mjs`. The `app/api/v<N>/**` rule in `scope.mjs` stays PLANNED in case a versioned path is ever added.

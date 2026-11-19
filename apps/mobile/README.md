# LearnHarness Nightly mobile

See the [approved beta spec](../../docs/specs/mobile-beta.md). Install and run commands from `apps/mobile`; this npm project uses its own lockfile and Node 22.13 or newer in the Node 22 line.

```sh
npm ci
npm run deps:check
npm run lint
npm run typecheck
npm test
npm start
```

## Release

**Phone builds and updates come only from the [Mobile release workflow](../../.github/workflows/mobile-release.yml) on main, never from a laptop.** It needs `EXPO_TOKEN` (a limited Expo token with the Developer role) in the `mobile-release` environment, which only main may use, and the Apple key secrets `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. iOS only for now. [Spec](../../docs/specs/mobile-auto-updates.md)

- **A merge to main** that changes `apps/mobile/`, `src/client-protocol/`, `src/core/`, `build/icon.png` or `public/fonts/cmunbx.ttf` publishes an OTA update on the `production` channel when the newest TestFlight build is processed by Apple, under 90 days old, and has the same native fingerprint. The phone downloads it on one launch and runs it on the next. Otherwise the run fails and says what to press. A merge never starts a build.
- **A native change** (any other fingerprint) needs a new build: press **Run workflow** on main with mode `build`. It starts one build on Expo's servers and sends it to TestFlight, and refuses while another build is running. Once Apple has processed it, the next merge publishes OTAs for it.
- **Every Monday**, if the newest TestFlight build is 76 or more days old, the run fails as a reminder to press `build`, because **a TestFlight build expires 90 days after upload** and then stops opening. [Apple TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
- **Run workflow** on main offers `check` (read-only: newest build, Apple's state, newest update, fingerprints and the update's launch records), `update` (publish an OTA now) and `build`.

A merge that bumps the client protocol reaches the phone as an OTA and shows the too-old message until the server updates. To undo a bad update, revert the change on main. The next run publishes the old code as a new update.

Google's Play internal testing documentation lists no equivalent build expiration. Its separate **Internal App Sharing** feature expires download links after 60 days. This beta uses the internal testing track. [Play internal testing](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en) · [Play Internal App Sharing](https://support.google.com/googleplay/android-developer/answer/9844679?hl=en)

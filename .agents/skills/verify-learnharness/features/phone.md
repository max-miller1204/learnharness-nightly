# Phone app

The Expo app in `apps/mobile`, driven on an iOS Simulator by the `ios` target. It talks to the same isolated instance as the web target does, so a change that touches a server route, the pairing protocol or a session record can be checked from both sides.

## Sub-features

- The Pair screen takes a server address and a one-time code, or a pasted pairing link, and refuses a wrong code with a message.
- A paired phone lists the server's sessions, and a row opens one: its transcript, its math, its plan.
- A question the tutor asked waits in a dock under the transcript (options, confidence, a thinking field, Submit answer). The answer reaches the server and the tutor replies.
- Saved servers: the app keeps each paired server and opens the default one at launch.

## How to get to it (user POV)

Install the app, open it, tap "Pair a server", and scan the QR code from `lh pair` or Settings → Devices, or type the address and the code.

## Driving it with e2e

Tests are `tests/e2e/phone-pairing.e2e.ts` and `tests/e2e/phone-session.e2e.ts`, written with `test` from `tests/e2e/support/phone.ts`. Read [the e2e mobile guide](../../e2e/SKILL.md) for the engine; what follows is how it applies here.

```bash
npm ci && npm run plugins:setup                      # once per checkout
tests/e2e/support/ios.sh build                       # after any change under apps/mobile
tests/e2e/support/ios.sh e2e run                     # or npm run test:e2e:ios; any e2e command works: e2e run tests/e2e/phone-session.e2e.ts:20 --retries 0
```

**One wrapper owns the run.** `ios.sh e2e <command>` runs `e2e <command> --target ios` and nothing else may start the phone. It creates a simulator named `lh-e2e-<run id>` (an iPhone 17 Pro on iOS 26.5; `E2E_IOS_DEVICE_TYPE` and `E2E_IOS_RUNTIME` choose another), writes a record for it, allocates two free ports, runs e2e pinned to that simulator, and deletes the simulator on exit, failure or interruption: the cleanup is registered before the simulator exists, and a signal is passed to e2e and then the cleanup runs. `e2e.config.ts` and the `ownedSimulator` fixture (`ios-device.ts`) refuse any simulator the wrapper did not create: the record must name it, carry the `lh-e2e-` name, belong to a live wrapper, and match `xcrun simctl list`. With no wrapper the target has no device to fall back on (it never drives "every booted simulator") and its server command stops with a message. `ios.sh devices` lists the simulators the wrapper made, and `ios.sh device-delete <udid>` deletes an orphan (a run that was killed with SIGKILL), only one the wrapper made and whose run is gone. The `e2e` wrapper rejects `--target`: it picks the target.

**Launch.** The `ios` target's `app.command` runs `serve.ts` on the wrapper's ports (`E2E_IOS_PORT` over http, `E2E_IOS_TLS_PORT` over https); a device target has no `url` to take a free port from, so the wrapper allocates them, and nothing in a test or a fixture names a port. The server is a launch of its own (`phoneLaunchId` in `instance.ts`): tests and fixtures find its data folder, TLS address, CA and pairing codes through its launch record, checked against its `state.json`, never through a port. With `LH_E2E_TLS_PORT` serve.ts serves the app over https because the phone accepts only `https://` servers: `scripts/iphone-check/tls-cert.sh` makes a CA and a certificate for 127.0.0.1 in a folder private to the launch, the CA's key is deleted once the certificate is signed, the proxy (`tls-front.mjs`) is supervised (its exit stops the instance), the instance reports ready only after `https://127.0.0.1:<port>/api/health` answers with that CA, the certificate's key is deleted then, and the folder goes when the instance stops or fails to start. serve.ts registers each cleanup before it starts what the cleanup undoes. Before it reports ready serve.ts trusts the CA in the simulator (`xcrun simctl keychain <udid> add-root-cert`) and installs the build (`simctl install`), for a scripted run and a live one alike. `LH_E2E_FIXTURES` seeds the records of `tests/fixtures/mobile-lesson/` and `tests/fixtures/mobile-quiz/` into the data folder, and `LH_E2E_SCENARIO` plays the quiz fixture's scenario on the fake model. The simulator shares the Mac's network, so the phone reaches `127.0.0.1`. Each run has its own agent-device session (`lh-e2e-<run id>`), which the wrapper removes.

**Concurrent runs.** Runs on the same Mac do not share ports, simulators, instance folders or agent-device sessions, and serve.ts refuses to wipe the folder of a live instance. They do share `next dev`: one dev server per checkout holds the build folder `.next/dev`, so a second `next dev` start from the same checkout, for the `web` target or another phone run, is refused with a message naming the first. Serve the production build to run several at once: `npm run build && node scripts/build-server.mjs`, then `LH_E2E_SERVER=standalone tests/e2e/support/ios.sh e2e run`. Keep to one or two booted simulators on a 32 GB Mac.

**The build.** `tests/e2e/support/ios.sh build` makes a Release simulator build of `apps/mobile` and leaves it at `.e2e/ios/LearnHarnessNightly.app` (`E2E_IOS_APP`, relative to the repo root, moves it). It builds a copy of `apps/mobile` (with the `src/`, `public/fonts` and `build/icon.png` it reaches) under `.e2e/ios-build`, so the checkout's native project `apps/mobile/ios`, its `node_modules` and its env files are never read or written, and a later local Release build does not inherit the test settings. A Release build embeds the JavaScript bundle, so no Metro runs, and the script refuses a build with no `main.jsbundle`. Expo's update check is switched off in that built app only (`EXUpdatesEnabled` in its `Expo.plist`), so it never asks `u.expo.dev` for an update; `app.json` is untouched. No architecture is named: the destination is a simulator made for the build and `ONLY_ACTIVE_ARCH=YES` lets Xcode build the slice that simulator runs, so it is the same command on Intel and Apple silicon. It keeps DerivedData (`E2E_IOS_DERIVED_DATA`) and regenerates the native project and pods only when `app.json`, `plugins/`, `package.json` or `package-lock.json` of `apps/mobile` change. Any change under `apps/mobile`, JavaScript included, needs a new `build`: the bundle is inside the app.

Node 22 builds the app (the script finds it with `mise where node@22`) and the repo's Node runs the server and the tests. Ruby and CocoaPods come from `dots pkg add` and mise. Run the commands in a shell on the Mac, or over `ssh`, where the tools come from mise (`PATH=$HOME/.local/share/mise/shims:$PATH`). The first run on a checkout also needs `npm ci` and `npm run plugins:setup` at the root, which `next dev` needs to build the core plugins.

**Tests.** Start each test with `app.open()`, which relaunches the app fresh. A device has no saved sessions, so a test that needs a paired phone calls `pairPhone` (`device.clearKeychain()`, `app.clearState()`, then the Pair screen with `secrets.get("phone-pairing-code")`, a handle the config backs with a fresh code for the phone's server (its own launch record, `phoneLaunchId` in `instance.ts`, so a run that starts both targets keeps them apart), so the code stays out of the report and traces). A code is one-time, and every fill gets its own. The seeded records change when a test answers the quiz, so `phone-session.e2e.ts` copies both fixtures back before it pairs.

**Locators.** Checked on the Release build:

- A React Native `accessibilityRole="header"` is not a `heading`: it reads as `text`. Match the title with `getByText`, or land on `getByRole("textbox", "Server address")`.
- Fields are `textbox` by label: "Server address", "Pairing code" (a secure field), "Your thinking (optional)". Buttons: "Pair a server", "Connect", "Saved servers", "Submit answer", "I don’t know". The list's `New teaching session` and `Servers` are buttons by label.
- A session row is a `button` named by its title and kind, so match it with a RegExp (`/Sets and unions/`).
- Quiz options are `radio` or `checkbox` nodes whose name is the spoken label: math is read out (`open paren negative 0.10 comma positive 0.20 close paren`), plain text is as written. Match them with a RegExp.
- A refused code shows "That pairing code is wrong, expired or already used." as text.
- The question dock is its own scroll view and Submit sits below the fold. Scroll it from a static text node inside it, not from an option (a swipe that starts on an option can tap it): `question.scrollUntilVisible(submit)`, then `question.swipe({ direction: "down", momentum: "slow" })` so the whole button is on screen.

**Save Password sheet.** After a pairing succeeds, iOS offers to save the pairing code as a password, in a system sheet (Safari's remote view) over the app. Tap "Not Now" (`declineSavePassword`). A refused code shows no sheet.

**Saved servers.** After a force-stop, a reinstall or a cleared state the app opens "Saved servers": a paired server is a row with an Open button, and rows from earlier pairings pile up on a simulator that is reused. `app.clearState()` and `device.clearKeychain()` start from none.

**Live look.** `tests/e2e/support/ios.sh e2e mcp` is an MCP server for the phone: it creates the simulator, runs `e2e mcp --target ios` and deletes the simulator when the server exits (the client closes it). An agent that wants it names it as a stdio server, for example `{ "command": "tests/e2e/support/ios.sh", "args": ["e2e", "mcp"] }` in its MCP settings, from the repo root. `.mcp.json` and `.codex/config.toml` stay on the `web` target. `open_session` then opens the phone with the app installed and the CA trusted, because serve.ts provisioned them, and `observe`, `locate` and `screenshot` work. Take a pairing code with the `phone-pairing-code` secret in a test line, and open the app with `app.open()`. For a view in the T3 panel, `device_list` shows the Mac as `This machine` when the session runs on it, and as `intel-mac` from other machines, then `device_open` with the host and device id and `device_screenshot`; `device_close` before the session ends. `app.screenshot("<name>")` writes a point-sized image (402 by 874); `xcrun simctl io <udid> screenshot` writes the pixel size, three times that.

**What to avoid.** Do not tap, type, launch or screenshot through `xcrun simctl`, `idb` or raw scripts: that is e2e's or `device_open`'s job. `xcrun simctl` stays right for boot, create, delete, `keychain`, `install`, `status_bar` and `addmedia`. A Debug build, driven over Metro, is for a JavaScript-only change checked live: it opens with a React Native overlay that `agent-device react-native dismiss-overlay` clears, and a LogBox toast can block typing.

## Proof

After a pairing the session list shows the seeded titles. The lesson fixture opens to its transcript, and the quiz fixture's answer lands in the stored record (`storedChat(state, "chat_zzmobilequiz")`: a `toolResult` whose `details.answers` are the picked options), then the tutor's reply shows. A refused code leaves the Pair screen with the message and no session list. Look at a trace page or a screenshot of each flow: a test that passes on the wrong screen proves nothing.

Report which iOS runtime the run used. Xcode 27 and the iOS 27 simulator runtime need Apple silicon, so a run on an Intel Mac does not cover rendering that exists only on iOS 27.

## Not driven

The camera and QR scan (the simulator has no camera), the photo and file pickers, VoiceOver speech (it is not observable on the simulator), TestFlight builds (EAS builds them in `mobile-release.yml`), and a physical iPhone.

## Charters

```
phone-pair-edge|ios|fuzzer|On the Pair screen, enter an address without https, with a trailing slash, with spaces, and a code that is empty, lowercase, or with the dashes missing; report any input that pairs when it should not, or an error that is missing or misleading
phone-quiz-answers|ios|default|With the phone paired, open "Splits and gradient steps" and answer its open question with one option, with all of them, and with I don't know; report an answer that is lost, shown twice, or a Submit that stays disabled with an option picked
```

## Cleanup

The wrapper deletes its simulator (the CA, the saved server and every setting go with it) and its agent-device session folder, and the runner stops the server, which stops the TLS proxy and deletes the launch's TLS folder. Call `device_close` first if the T3 panel has the device open. After a run killed with SIGKILL, `ios.sh devices` lists what is left and `ios.sh device-delete <udid>` removes it. After a wedged run, `npx agent-device daemon stop`. `~/.agent-device` keeps logs. `.e2e/ios/`, `.e2e/ios-build/` and DerivedData stay, as the build cache. `.e2e/logs/app-ios.log` holds the server's output, with pairing codes redacted, in an ignored folder.

## Gotchas

- `npx e2e run --target ios` without the wrapper stops at once with a message: it has no simulator, ports or build path. Do not set `E2E_IOS_DEVICE` by hand; the config refuses a udid the wrapper did not create.
- A test file under `tests/e2e/` that targets the browser must declare `requires: ["browser"]`, or the `ios` target collects it and fails: the same holds the other way for `requires: ["native-app"]`.
- `device.setNetwork` and `device.setAirplaneMode` are Android-only: an iOS simulator shares the Mac's network.
- A step takes several seconds on a busy Mac. Give the first check after a launch a long timeout (`toBeVisible({ timeout: 60_000 })`).

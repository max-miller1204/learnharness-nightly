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

Tests are `tests/e2e/phone-pairing.e2e.ts` and `tests/e2e/phone-session.e2e.ts`, written with `test` from `tests/e2e/support/phone.ts` and run with `--target ios`. Read [the e2e mobile guide](../../e2e/SKILL.md) for the engine; what follows is how it applies here.

**Launch.** The `ios` target's `app.command` runs `serve.ts` on fixed ports (`E2E_IOS_PORT`, default in `tests/e2e/support/phone-config.ts`, and the next port for https). With `LH_E2E_TLS_PORT` serve.ts also starts a TLS front (`scripts/iphone-check/tls-cert.sh` makes a throwaway CA and a certificate for 127.0.0.1, `tls-front.mjs` ends TLS) because the app accepts only `https://` servers. `LH_E2E_FIXTURES` seeds the records of `tests/fixtures/mobile-lesson/` and `tests/fixtures/mobile-quiz/` into the data folder before the app starts, and `LH_E2E_SCENARIO` plays the quiz fixture's scenario on the fake model. The simulator shares the Mac's network, so the phone reaches `127.0.0.1`. The `phoneBuild` worker fixture trusts the CA in the simulator (`xcrun simctl keychain <udid> add-root-cert`) and installs the build with `device.installApp(undefined, { reinstall: true })`: the engine installs nothing by itself.

**The build.** `tests/e2e/support/ios.sh build` makes a Release simulator build of `apps/mobile` and leaves it at `.e2e/ios/LearnHarnessNightly.app` (`E2E_IOS_APP` moves it). A Release build embeds the JavaScript bundle, so no Metro runs, and the script refuses a build with no `main.jsbundle`. Expo's update check is switched off in that built app only (`EXUpdatesEnabled` in its `Expo.plist`), so it never asks `u.expo.dev` for an update; `app.json` is untouched. The build uses the host's own simulator architecture, so it is the same command on Intel and Apple silicon. It keeps DerivedData (`E2E_IOS_DERIVED_DATA`) and regenerates the native project and pods only when `app.json`, `plugins/`, `package.json` or `package-lock.json` of `apps/mobile` change. Any change under `apps/mobile`, JavaScript included, needs a new `build`: the bundle is inside the app.

Node 22 builds the app (the script finds it with `mise where node@22`) and the repo's Node runs the server and the tests. Ruby and CocoaPods come from `dots pkg add` and mise. The first run on a checkout also needs `npm ci` and `npm run plugins:setup` at the root, which `next dev` needs to build the core plugins.

**A disposable simulator.** The default device pool is every booted simulator, so the target is pinned to one: `E2E_IOS_DEVICE` is a udid or a name. Make one per run so nothing a run leaves behind (a trusted CA, saved servers, the keychain) outlives it, and delete it at the end:

```bash
npm ci && npm run plugins:setup                      # once per checkout
tests/e2e/support/ios.sh build                       # after any change under apps/mobile
export E2E_IOS_DEVICE=$(tests/e2e/support/ios.sh device-create)
npx e2e run --target ios                             # or npm run test:e2e:ios
tests/e2e/support/ios.sh device-delete "$E2E_IOS_DEVICE"
```

`device-create` makes an iPhone 17 Pro on iOS 26.5 and boots it (`E2E_IOS_DEVICE_TYPE` and `E2E_IOS_RUNTIME` choose another). `xcrun simctl list devicetypes` and `runtimes` print the ids. A new simulator's first boot is slow, and the first run on it builds the automation runner. Keep to one booted simulator at a time on a 32 GB Mac, and never touch a shared one: leave a booted simulator you did not create alone. Run the commands in a shell on the Mac, or over `ssh`, where the tools come from mise (`PATH=$HOME/.local/share/mise/shims:$PATH`).

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

**Live look.** `npx e2e mcp --target ios` (on the Mac, with `E2E_IOS_DEVICE` set) opens the phone for `observe`, `locate` and `screenshot`. For a view in the T3 panel, `device_list` shows the Mac as `This machine` when the session runs on it, and as `intel-mac` from other machines, then `device_open` with the host and device id and `device_screenshot`; `device_close` before the simulator is deleted. `app.screenshot("<name>")` writes a point-sized image (402 by 874); `xcrun simctl io <udid> screenshot` writes the pixel size, three times that.

**What to avoid.** Do not tap, type, launch or screenshot through `xcrun simctl`, `idb` or raw scripts: that is e2e's or `device_open`'s job. `xcrun simctl` stays right for boot, create, delete, `keychain`, `install`, `status_bar` and `addmedia`. A Debug build, driven over Metro, is for a JavaScript-only change checked live: it opens with a React Native overlay that `agent-device react-native dismiss-overlay` clears, and a LogBox toast can block typing.

## Proof

After a pairing the session list shows the seeded titles. The lesson fixture opens to its transcript, and the quiz fixture's answer lands in the stored record (`storedChat(state, "chat_zzmobilequiz")`: a `toolResult` whose `details.answers` are the picked options), then the tutor's reply shows. A refused code leaves the Pair screen with the message and no session list. Look at a trace page or a screenshot of each flow: a test that passes on the wrong screen proves nothing.

Report which iOS runtime the run used. Xcode 27 and the iOS 27 simulator runtime need Apple silicon, so a run on an Intel Mac does not cover rendering that exists only on iOS 27.

## Not driven

The camera and QR scan (the simulator has no camera), the photo and file pickers, VoiceOver speech (it is not observable on the simulator), TestFlight builds (EAS builds them in `mobile-release.yml`), and a physical iPhone.

## Charters

```
phone-pair-edge|ios|fuzzer|On the Pair screen, enter an address without https, with a trailing slash, with spaces, and a code that is empty, lowercase, or with the dashes missing; report any input that pairs when it should not, or an error that is missing or misleading
phone-quiz-answers|ios|default|Signed in with a paired phone, open "Splits and gradient steps" and answer its open question with one option, with all of them, and with I don't know; report an answer that is lost, shown twice, or a Submit that stays disabled with an option picked
```

## Cleanup

The runner stops the server and the TLS front. Then:

- `tests/e2e/support/ios.sh device-delete "$E2E_IOS_DEVICE"`, which removes the CA, the saved server and every setting at once. Call `device_close` first if the T3 panel has the device open.
- On a simulator that is not disposable, `app.clearState()` and `device.clearKeychain()` restore the app; `xcrun simctl keychain <udid> reset` also untrusts the CA. `agent-device close` leaves the automation runner (`xcodebuild test-without-building`) running on such a simulator: end it by pid.
- After a wedged run, `npx agent-device daemon stop`, then reboot the simulator.
- `~/.agent-device` keeps logs and session folders: clear what the run added. The build folder `.e2e/ios/` and DerivedData stay, as the build cache.
- `.e2e/logs/app-ios.log` holds the server's raw output; it stays in ignored folders.

## Gotchas

- With no `E2E_IOS_DEVICE`, the run drives every booted simulator it can find, including one you are using.
- A test file under `tests/e2e/` that targets the browser must declare `requires: ["browser"]`, or the `ios` target collects it and fails: the same holds the other way for `requires: ["native-app"]`.
- `device.setNetwork` and `device.setAirplaneMode` are Android-only: an iOS simulator shares the Mac's network.
- A step takes several seconds on a busy Mac. Give the first check after a launch a long timeout (`toBeVisible({ timeout: 60_000 })`).

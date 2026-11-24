# Mobile beta proof

Use the [approved mobile beta spec](../../../../../docs/specs/mobile-beta.md) for phone-only behavior and the browser on the same disposable server for transcript and session parity. CI bundle exports cover packaging. This recipe requires installed binaries and observation on devices.

## Setup

1. Record the source SHA, the Debug simulator build or signed EAS build ID and number, OS and device IDs, and server SHAs. Use a disposable HTTPS endpoint authorized for the test, with no real records or keys. Prepare a second origin and a server pinned to `bfb1e5d` for core protocol proof.
2. Follow [the fake-model setup](../agent.md). For observable teaching streaming, copy `scenarios/teach-read.json` to the proof run folder and set `reply.pauseBeforeDoneMs` to 4000 on `probe-acknowledges-answer`. For practice, start a fresh disposable instance with `scenarios/mobile-practice.json`. Copy `tests/fixtures/mobile-graph/nodes.jsonl` from the repository root into the disposable server’s `DATA_DIR/graph/` before the graph picker run. This seed contains only two synthetic propositions.
3. Boot the iOS Simulator on the Mac as in [iOS Simulator on the Mac](#ios-simulator-on-the-mac).
4. Use T3 `device_list`, `device_open`, the returned `agent-device` command and `device_screenshot`, on the Mac (host label `intel-mac`). If a device is unavailable or cannot scan a QR, record the missing observation. Use the typed or pasted link for the remaining drive. The physical iPhone run still checks both QR generators.

A step the machine or the device tool can't do is BLOCKED for that step, never BROKEN for the change: say which limit stopped it and keep going with the steps that don't need it.

## Drive and compare

- In the installed app, scan each generator's link, check the displayed destination before Connect, and try permission denial and both manual fallbacks. Attempt code reuse. Save two origins, explicitly make one default, switch to the other, then relaunch. Try an unreachable default, revoke the native device, and test descriptor versions below and above 1. Check credentials and the list are isolated by origin.
- On #246, start a teaching lesson with `zz-prove-it`, submit Blue and observe the reply before completion. Start a turn in the browser while watching the same session on the phone. Background during an active turn or interrupt connectivity, restore access, and compare the settled record to the web transcript. Force a model failure and retry, then use the hang switch to Stop an in-flight turn. Test a lost send response and check there is one saved input. Confirm the optional controls are absent.
- On the beta server, pick graph material then start practice with `mobile practice`. Record the graph context and verify the displayed equation. Submit `I am stuck`, wait for the hint and verify no solution, then submit `The positive solution is 2`. Compare the saved conclude and original solution with the web session. Scroll back and check that the full original problem statement is still visible. Leave and reopen the practice session and check the statement again. Tap Next, then Discard. Verify the discard stores a marker without any new model request and the deferred conclusion appears after the following input.
- Check formatted prose and a math message that each contain an HTTPS link and a non-HTTPS link. On the HTTPS link, verify **Open in browser?** appears, Cancel stays in the app, and Open launches the system browser at the confirmed URL. Verify that the non-HTTPS link stays plain text. A Cancel that opened the browser anyway looked fine on screen until the browser came forward (audit 2026-11-21): `scripts/mobile-checks.sh` taps the link in a message rendered through `NativeMarkdown`, then each button of the prompt, before any device run.
- Open the exact session in a paired browser and in an unpaired browser. From the unpaired browser, use assisted pairing, verify it returns to the exact session and adds one browser device. Run assisted pairing with the now-paired browser and verify device count stays the same. Check the fragment is removed and the native bearer never enters browser navigation.
- With the device's real on-screen keyboard, focus the Message field in a long session and type. The field, the draft and Send must stay above the keyboard. Then focus Your thinking on a pending quiz. The question card must sit above the keyboard and scroll so the answers, confidence, field and submit buttons can all be reached without closing the keyboard. Open the session's "…" Session options menu and check that the accessibility tree shows View plan (when the session has a plan), Open in browser and Pair phone browser as visible, labeled nodes with real bounds.
- Compare each main screen with the web UI on the same server and take a phone and browser screenshot of each pair. Do it twice: once with the phone in dark mode against the browser's Default theme, and once with the phone in light mode against Settings → Appearance → Ivory. The pairs are: saved servers and Pair against the browser's pairing screen; the session list against the web sidebar; the teaching and practice sessions against the same sessions in the browser (top bar, the YOU band, cards, the bottom composer and question dock); and New session against the web's new-session screen. Check colors, fonts (JetBrains Mono for chrome, Source Sans 3 for prose, CMU Serif for the session title), spacing, corners and empty states. Any difference that isn't caused by phone layout is a finding.
- Have the owner repeat the approved iPhone acceptance on the exact TestFlight build over Tailscale. Store account or iPhone access is a separate gate.

Record each observation, the device screenshot or recording, and the saved server or browser evidence in the run receipt. Keep codes and bearers out of receipts. Mark missing steps as blocked or unproven.

## iOS Simulator on the Mac

The phone surface is proved on an iOS Simulator on the Mac, not on an emulator on the ThinkPad. Android runs are not part of this recipe: the Android material is kept in [the Android archive](../android-archive.md).

- **Device.** An iPhone 17 Pro on iOS 26.5 (`xcrun simctl list devices` shows its udid; the shared one is `8C1A7F98-6DCD-4EFC-AA99-D249EEE90B44`). `device_list` shows the Mac as host id `local`, label "This machine", when it runs on the Mac itself, and as the host labeled `intel-mac` from other machines. Call `device_list`, then `device_open` with the `hostId` and device `id` it gives (a disposable device is listed by its create name, such as `lh-proof`, not "iPhone 17 Pro"), and `device_close` when done so the T3 panel does not point at a deleted device. Use the command `device_open` returns for launching and input, and `device_screenshot` for screenshots. The bare `agent-device` in the commands below uses its own per-directory session, separate from the one behind that wrapper. Use `xcrun simctl` for what the tool can't do: booting, `keychain`, `status_bar`, `addmedia`, `ui`, `io` and `spawn`.
- **What it does not cover.** Xcode 27, and with it the iOS 27 simulator runtime, runs only on Apple silicon, so this Intel Mac stays on Xcode 26.5 and iOS 26.5. Rendering differences that exist only on iOS 27, Liquid Glass included, are not covered. Every receipt for a phone change says it ran on iOS 26.5.
- **Tools.** Node 22 builds the app (`mise where node@22`) and Node 26 runs the server. Ruby, CocoaPods, `agent-device` and `exiftool` come from `dots pkg add` and mise. `eas` runs through `npx eas`. The Mac has no Homebrew, watchman (Metro works without it), Chrome or AXe, and `gh` is not logged in there.
- **When to rebuild the app.** Rebuild the native app only when `apps/mobile` native inputs change: `app.json`, `plugins/`, native dependencies in `package.json`, or `ios/`. A JavaScript-only diff is served by Metro to the app already installed.

### Run it

Prefer a disposable simulator, so nothing a run leaves behind (a trusted CA, a saved server row, imported photos, a status bar override) outlives it: `U=$(xcrun simctl create lh-proof com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-5)` (`xcrun simctl list devicetypes` and `runtimes` print the ids), then `xcrun simctl delete $U` at the end. On the shared simulator, run the restore list under [Cleanup and restore](#cleanup-and-restore) instead.

Build the server and start it with the quiz fixture's scenario and the lesson and quiz fixtures seeded. The phone app accepts only `https://` servers and the prove server listens on plain HTTP, so `tls-cert.sh` makes a throwaway CA and a certificate for 127.0.0.1 and `tls-front.mjs` ends TLS in front of the server. Keep the TLS files in a directory made for this run.

```bash
cd ~/learnharness-nightly
N22=$(mise where node@22)/bin; export LANG=en_US.UTF-8 EXPO_NO_TELEMETRY=1
npm ci --no-audit --no-fund                       # root, Node 26
(cd apps/mobile && PATH=$N22:$PATH npm ci --no-audit --no-fund)
RUN=$(.claude/skills/prove-learnharness/scripts/new-run.sh iphone-mac)
.claude/skills/prove-learnharness/scripts/build.sh "$RUN" head
mkdir -p $RUN/head/data/{chats,jobs}
cp tests/fixtures/mobile-lesson/chat_*.json tests/fixtures/mobile-quiz/chat_*.json $RUN/head/data/chats/
cp tests/fixtures/mobile-lesson/job_*.json $RUN/head/data/jobs/
INST=$(.claude/skills/prove-learnharness/scripts/start.sh "$RUN" head $PWD/tests/fixtures/mobile-quiz/scenario.json)
. "$INST"
TLS=$(mktemp -d); scripts/iphone-check/tls-cert.sh "$TLS"
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
node scripts/iphone-check/tls-front.mjs $port $APP_PORT "$TLS/cert.pem" "$TLS/key.pem" & echo $! > $RUN/tls.pid
```

Build the native Debug app. The Mac is Intel, so the simulator is x86_64 only: pass `ARCHS=x86_64 ONLY_ACTIVE_ARCH=NO` (an Apple silicon build uses `arm64`).

```bash
cd apps/mobile && export PATH=$N22:$PATH
npx expo prebuild --clean --platform ios --no-install
(cd ios && pod install)
xcrun xcodebuild -workspace ios/LearnHarnessNightly.xcworkspace -scheme LearnHarnessNightly -configuration Debug -destination "generic/platform=iOS Simulator" -derivedDataPath ~/lh-dd ARCHS=x86_64 ONLY_ACTIVE_ARCH=NO build -quiet
APP=~/lh-dd/Build/Products/Debug-iphonesimulator/LearnHarnessNightly.app
[ ! -e "$APP/main.jsbundle" ] || echo "the Debug app embeds a bundle"
```

A Debug build embeds no bundle, so the app can only run what Metro serves it. If `main.jsbundle` is there, the build is not the Debug one and the run proves the wrong thing.

Boot the simulator, trust the CA, install the app and start Metro. The Metro block assumes the working directory is `apps/mobile` and `PATH=$N22:$PATH`, both set by the native-build block above, so set them yourself when that block is skipped because `~/lh-dd` is reused. A new simulator's first boot took 61 s (19 s is the warm case). `xcrun simctl boot` on a booted device exits 149, so wait with `bootstatus -b` alone, which also boots a shut-down device. Port 8081 must be free: another process serving it can warm another checkout's bundle.

```bash
xcrun simctl bootstatus $U -b
xcrun simctl keychain $U add-root-cert "$TLS/ca.pem"
xcrun simctl status_bar $U override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4
xcrun simctl install $U $APP
! lsof -nP -iTCP:8081 -sTCP:LISTEN -t | grep -q . || { echo "port 8081 is in use: stop that process first"; false; }
EXPO_PUBLIC_CI_OPEN_SESSIONS=chat_zzmobilelesson,chat_zzmobilequiz npx expo start --port 8081 > $RUN/metro.log 2>&1 & echo $! > $RUN/metro-npx.pid
curl -fsS --retry 300 --retry-connrefused --retry-delay 2 http://127.0.0.1:8081/status >/dev/null
echo $(lsof -nP -iTCP:8081 -sTCP:LISTEN -t) > $RUN/metro.pid
curl -fsS --max-time 600 -o /dev/null "http://127.0.0.1:8081/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&unstable_transformProfile=hermes-stable"
```

`$!` is the `npm exec` wrapper, so the listener's own pid comes from `lsof`: both pid files are needed to stop Metro. The `/status` poll prints two harmless `curl: (7)` lines while Metro starts. The log never names the requester, so read it by order: the warm-up fetch logs `iOS Bundled ... (2977 modules)`, and the app's own request is the SECOND `iOS Bundled ... index.ts (1 module)` line, followed by the app's `Require cycle` warnings. After the app launches, check that second line is there: it shows the app loaded its bundle from this Metro. Then pair through the Pair screen:

```bash
CODE=$(curl -s -X POST -H "authorization: Bearer $APP_TOKEN" -H "origin: $APP_URL" -H 'content-type: application/json' -d '{"label":"x"}' $APP_URL/api/auth/pairing-token | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).credential')
agent-device open com.maxmiller.learnharness.nightly --platform ios --udid $U --foreground
agent-device react-native dismiss-overlay
agent-device press 'label="Pair a server"' --settle
agent-device fill 'role=text-field' "https://127.0.0.1:$port" --settle
agent-device fill 'role=securetextfield' "$CODE" --settle
agent-device press 'label="Connect"' --settle
agent-device press 'label="Not Now" role=button' --settle     # the system web sign-in sheet (SafariViewService)
agent-device snapshot -i                  # then press the row for https://127.0.0.1:$port by its ref
```

With `EXPO_PUBLIC_CI_OPEN_SESSIONS` set, the first pairing on a fresh simulator opens the lesson immediately, so pressing the saved row by ref applies only after a relaunch. Saved servers rows from earlier pairings pile up, and `press 'label="Open"'` then fails with `AMBIGUOUS_MATCH`. Refs expire after any action, so take a fresh `agent-device snapshot -i` and press the row whose URL text is your `https://127.0.0.1:$port` by its ref. `EXPO_PUBLIC_CI_OPEN_SESSIONS` makes each new connection open the next listed session instead of a tapped row ([`apps/mobile/src/workspace-view.ts`](../../../../../apps/mobile/src/workspace-view.ts)). Only a dev bundle reads it: a release or update bundle never carries it. Before a check that starts from tapping a session row, restart Metro with it unset.

Screenshots: `agent-device screenshot` writes 1x point-sized images (402 by 874), and `xcrun simctl io $U screenshot` writes 1206 by 2622. A check in pixels, such as a 300 px threshold, holds only at 3x: use `agent-device screenshot --pixel-density 3 out.png`.

### Recording frames

`xcrun simctl io $U recordVideo` is variable frame rate: it writes only changed frames, so frame numbers are not times. Record, extract every frame, and read each frame's time:

```bash
mkdir -p $RUN/frames
xcrun simctl io $U recordVideo --codec=h264 --force $RUN/open.mov & REC=$!
# ... the interaction ...
kill -INT $REC; sleep 3
ffmpeg -loglevel fatal -i $RUN/open.mov -fps_mode passthrough $RUN/frames/f%03d.png
ffprobe -v error -select_streams v -show_entries frame=pts_time -of csv=p=0 $RUN/open.mov
magick compare -metric AE $RUN/frames/f001.png $RUN/frames/f002.png null:
```

`ffmpeg -vsync 0` fails on ffmpeg 9.1: use `-fps_mode passthrough`. At `-loglevel error` it prints `non monotonically increasing dts` lines and still exits 0: ignore them or use `-loglevel fatal`. `magick compare -metric AE` prints the number of differing pixels between two frames. Where they work, `agent-device record start` and `record stop` also give frame evidence.

### Rules and gotchas

- **Saved servers.** After a force-stop or a reinstall the app opens Saved servers: open the disposable server's row before selecting a session. A text size change drops a relaunched app there too, but not a running one.
- **Restore what you change.** Restore every setting you change (appearance, text size, rotation, Reduce Motion, the status bar override, the trusted CA, the saved server row, imported photos) and read it back before the receipt. [Cleanup and restore](#cleanup-and-restore) lists the commands.
- **Sessions are bound to the directory.** An `agent-device` session belongs to the working directory it started in: another directory answers `DEVICE_IN_USE`, and its message names the session address, in the form `cwd:<hash>:<suffix>` (the suffix was `ios` for an app opened with `--platform ios`): copy it from the `DEVICE_IN_USE` message. Close it with `agent-device close --session "$SESSION"`, where `SESSION` is that address or the name from `agent-device session list` run in the same directory. From another directory `session list` is empty and `close --session default` answers `SESSION_NOT_FOUND`. Never take over another session's device.
- **First launch and toasts.** A React Native warning overlay can cover the first screen, and a LogBox toast (Metro logged `TypeError: Cannot convert 100 to BigInt` three times) blocks typing with `TEXT_ENTRY_MISMATCH`. Both clear with `agent-device react-native dismiss-overlay`.
- **Text size.** `xcrun simctl ui $U content_size bogus` prints `Invalid argument` and still exits 0, so read the size back with `xcrun simctl ui $U content_size`.
- **`stop.sh` on macOS.** `stop.sh` reads `/proc`, so it cannot stop its own processes on macOS (issue #420). Kill by pid instead, as in the cleanup list. `flock` and `setsid` are not needed on macOS: `lib.sh` supplies stand-ins.
- **Hosts block.** Blocking `u.expo.dev` in `/etc/hosts` needs sudo and is skipped for Debug builds, which load from Metro and never ask for an update. To test the embedded bundle or expo-updates, block `u.expo.dev` first, then build Release (`npx expo run:ios --configuration Release`). The edit is host-wide: restore the file in a `trap ... EXIT` so a failed run restores it too.
- **TestFlight.** TestFlight builds come from EAS on the Linux runner (`mobile-release.yml`). Nothing here builds or uploads one.

### Cleanup and restore

A `trap` cannot span separate shell invocations, so a walk driven one command at a time needs a cleanup script that runs these steps.

- **Processes.** `kill $(cat $RUN/tls.pid $RUN/metro.pid $RUN/metro-npx.pid $RUN/head/app.pid $RUN/head/fake-model.pid)`, and also the footprint sampler and any `recordVideo` job (`kill -INT $REC`). `agent-device close` leaves the XCTest runner (`xcodebuild test-without-building`) running on a SHARED simulator: end it. A disposable simulator's runner dies with `simctl delete`.
- **Booted simulators.** Exactly one stays booted. While a disposable simulator runs, shut the shared one down (`xcrun simctl shutdown "$SHARED"`). Afterwards delete the disposable one and boot the shared one back (`xcrun simctl bootstatus "$SHARED" -b`). The trap runs both.
- **Disposable simulator.** `xcrun simctl delete $U` removes the CA, the saved server, the photos and every setting at once. Call `device_close` for it first, so the T3 panel does not point at a deleted device.
- **Shared simulator.** Restore each of these:
  - `xcrun simctl status_bar $U clear`.
  - Remove the saved server row in the app, then `xcrun simctl keychain $U reset`, which untrusts the CA and also clears saved passwords. Or reuse one CA directory across runs, and say so in the receipt.
  - Photos you imported: `simctl` has no delete-media. A fresh simulator holds 6 stock photos, so record the baseline asset count before importing, and when the library must be pristine, use a disposable simulator and `xcrun simctl erase` it.
  - Reduce Motion: put back its ORIGINAL value, including when it started enabled. Read it with `xcrun simctl spawn $U defaults read com.apple.Accessibility ReduceMotionEnabled` before and after.
  - Appearance, text size and orientation: set them back and read them back.
- **Files.** `rm -rf "$TLS"`, and `rm -rf "$RUN"` once the receipt is written: it holds `auth.json`, a bearer token. `~/.agent-device` keeps logs and session folders, so clear what the run added. `~/lh-dd` and the clone stay.

### What the old driver needs

`scripts/iphone-check/drive.mjs` ([spec](../../../../../docs/specs/ios-simulator-ci.md)) reads the screen and taps through AXe (`--axe`) and shoots the web pages in Chrome (`--chrome`). The Mac has neither, so the full driver does not run there. Use `agent-device` taps and screenshots for the phone half. `paging.mjs`, `tls-cert.sh` and `tls-front.mjs` need neither. A parity pair's web half needs a browser the prover supplies and names in the receipt. Without one, the pair is BLOCKED for its web half.

### Checks

- **Parity.** Shoot the Pair screen, the session list, the lesson fixture and the quiz fixture (waiting, then answered through the dock) on the phone and in the web app on the same server, in light (web: Ivory) and dark (web: Default). Set the phone's appearance with `xcrun simctl ui $U appearance dark` (or `light`). Judge every iPhone screen against its web screen under the visual-parity rule in Drive and compare above. Check math above all: baselines in answered cards and choice rows, sentence-ending math and its period, expressions like `0.1(-1)(-2)`, and the bold first column of the two-column table. A visible difference that phone layout doesn't explain is BROKEN.
- **Choice rows.** A quiz choice row must be one accessibility item speaking its math. An accessibility item check is not a VoiceOver check: never record VoiceOver as checked from it. VoiceOver speech output is not observable on the simulator, so every step that needs it is BLOCKED for that observation and stays the owner's TestFlight check.
- **Camera.** The simulator has no camera. Taking a photo, and the camera permission text, stay the owner's TestFlight check.

### Receipt: first verified run (2026-11-23)

Figures from the first run on the Mac, for planning. They are a dated observation and will drift. The host was an Intel i9 on macOS 26.7.3 with Xcode 26.5, Ruby 4.0.10 and CocoaPods 1.17.0. Typical times: root `npm ci` 57 s, the app's `npm ci` 60 s, the server build 3 min, `pod install` 2.5 min, a cold Debug `xcodebuild` 7 min, simulator boot 19 s, Metro warm 20 s, a warm launch to the session list 5 s. The clone took 5.1 GB, DerivedData 1.7 GB, the CocoaPods cache 1.1 GB and the simulator's data 3 GB.

## Full lesson view (mobile follow-up 1)

Seed the [lesson fixture](../../../../../tests/fixtures/mobile-lesson/) before starting the server: copy `chat_zzmobilelesson.json` into `DATA_DIR/chats/` and `job_zzresearch1.json` into `DATA_DIR/jobs/`. It is one synthetic teaching record with graph picks, a probe, a plan, a research result, a compaction and a pending teach check. Open it on the phone and in the browser on the same server, and compare each item below. Then run the live checks.

- **Reasoning.** Each "Agent's thinking" row starts closed and opens to the same text the browser shows. During a live turn with a thinking model, the newest row reads "Thinking…" with a spinner until text arrives.
- **Phases and markers.** The top bar reads Teaching. The Planning seam sits after the probe, the Teaching seam before the union lesson, and "History compacted · 118k tok" just before the plan message, matching the browser. "Context compacted" sits after the research result. None of them respond to a tap.
- **Plan.** The in-chat plan has the browser's boxes and arrows, all in the plain ink. Tap it, and separately use … → View plan. The live plan opens with "Unions and intersections" glowing as current and the other three nodes, with every arrow, dimmed as upcoming. "What a set is" is upcoming too: a node counts as visited only once a teaching check has been tagged on it, and the fixture tags only the union check. The phone, the browser and the desktop app must all agree. Pinch in and out, drag while zoomed, press −, ⤢ and +, and check that you can't zoom out past the fit. ‹ returns to the same scroll position in the session.
- **Helpers.** The first research call shows "✓ Research agent finished". The result line reads "✓ Research complete · 1 sources · view brief" and opens to the brief, with its formula and one source link. The link asks before opening the browser. The second research call has no job, so it shows a "Dispatched…" card. For live status, use a real-model lesson (`PROVE_MODEL=claude-code`) that dispatches research. Watch the card count seconds and change its activity line, then settle to a ✓ line, with the brief arriving without a manual refresh. If the teacher never dispatches, record it as blocked. Delivery messages never appear as YOU bands.
- **Teach check.** The pending check waits behind "Check your understanding" with a "Thinking while reading" field above it. Type a thought, tap Open, answer and submit. The saved answer has `readingThinking`, and the phone and browser both show it as "YOUR THINKING" above the answered card. On a fresh copy of the fixture, type a thought and tap Skip, then Cancel (nothing saved), then Skip again. The record gains a dismissed answer that carries the thought, no new model request runs, and the composer returns. Your next message wakes the teacher. For a mid-turn Skip, the phone gets `202 {parked:true}`, stops the reply and shows no error. The dismissal is saved only if the question is still pending when that turn settles. If another client's input has already answered or superseded it, the server drops the skip and nothing is saved. That is the server's park rule, the same as in the browser, not a phone failure. Record which case you observed.
- **Old server.** Against the #246 server, which lacks `lesson-view-v1`, Skip is absent and helper dispatches show no card at all: no spinner and no "Dispatched…". The delivered research result and everything else in the fixture still render.
- **Graph picks for teaching.** On New session (teaching), pick both seeded propositions and start. The record's first message is the graph-context marker, and the session shows the folded "Graph context · 2 propositions" card that opens to them.
- **Web and desktop plan unchanged.** The plan diagram's layout math moved into shared code. In the browser and in the desktop app, open the fixture on head and on the base build, and compare screenshots of the in-chat plan and the live plan popup. They must be identical. Then, during a live lesson on head, have the teacher pose a check on the next node. Without reloading, the popup and the plan beside the question dock must move the glow to it, mark the earlier node visited, and keep upcoming nodes dimmed. Wheel and button zoom, drag pan, fit, and Esc close must behave as on base.

## Attach photos and files (mobile follow-up 2)

Use a server with `attachment-uploads-v1` and the fake model's teach scenario. Use only synthetic files, for example `tests/fixtures/sample-3page.pdf`.

- **Paperclip and menu.** New session and an idle session show the paperclip left of the text box. It opens Take photo, Photo library and Files, each a visible, labeled node with real bounds in the accessibility tree. It is dimmed while a reply runs and absent on a practice problem's "Your thinking" dock. Against a server without the capability, it is absent.
- **Library and files.** Pick two photos from the photo picker and the PDF from Files. On iOS the library photos keep their names (a seeded `zz-gps.jpg` shows as that), and a camera photo is named `photo-YYYYMMDD-HHMMSS.jpg`. The PDF keeps `sample-3page.pdf`, not an ID like `document:21`. Remove one photo and check the server released its reservation. Force a failure (stop the server mid-upload, or revoke the pairing), check the error and Retry, then restore and Retry until ready.
- **Limits.** Pick a synthetic image over 10 MiB. The note reads "NAME exceeds the 10 MiB per-image limit." and no reservation is made.
- **Send.** While Send waits for an upload, the text box and Remove are locked. With files and empty text, Send is dimmed and "Add a message to send these files." shows. Type text and send while an upload still runs: the send waits, then one message saves with `attachments` in the record. The phone and the browser both show its chips after reload. Have the fake model call `show_image` and `pdf` with the opaque `attachment:<id>` and check the shown image and the brief.
- **Opening send.** On New session, attach a photo, type an opening message and start. One chat opens with that message and its chip, through `/api/attachments/start`. Drop the response once (kill connectivity right after the tap), send again, and check there is still one chat and one message.
- **Saved and missing.** Delete a claimed file's bytes on the disposable server and reopen: the chip shows "File unavailable. Attach it again to use it."
- **Library photos, GPS and types (iOS).** Make synthetic files in the run folder, then import them:
  ```bash
  magick -size 800x600 gradient:red-blue -gravity center -pointsize 60 -fill white -annotate 0 'GPS TEST' zz-gps.jpg
  exiftool -overwrite_original -GPSLatitude=37.7749 -GPSLatitudeRef=N -GPSLongitude=122.4194 -GPSLongitudeRef=W -Orientation#=6 -XMP-dc:Creator=zz -IPTC:Keywords=zz zz-gps.jpg
  sips -s format heic zz-gps.jpg --out zz-sample.heic
  xcrun simctl addmedia $U zz-gps.jpg zz-sample.heic
  ```
  Import is expensive: `mediaanalysisd` runs near 800% CPU for minutes and starves the XCTest runner, so wait for it to settle before driving (it took 280 s). The paperclip's label is `Attach`, its menu items are `[other]` nodes, and in the Photos picker select photos by a fresh ref, then `press 'label="Done"'`. The picker shows "Location Is Included" for the GPS photo alone and "2 Photos, Locations Included" for both selected, so the check below is not vacuous. The stored chips are `zz-sample.jpg` and `zz-gps.jpg`. Send, then find the stored bytes in `$RUN/head/data-attachments/claimed/<attachment id>` (the id is in the chat record's `attachments`) and read them: `exiftool -a -G1 -s -FileType -MIMEType -Orientation -GPS:all -XMP:all -IPTC:all "$f"`. A JPEG and a HEIC from Photo library are both stored as `image/jpeg` with no GPS, XMP or IPTC tags and Orientation kept, and the chip ends in `.jpg` ([spec](../../../../../docs/specs/mobile-beta.md): "on both platforms"). A fresh simulator already holds 6 stock photos, so the baseline asset count is 6, not 0: record it first, and restore as in [Cleanup and restore](#cleanup-and-restore).
- **WebP (iOS).** `addmedia` refuses a WebP (`File type unsupported`) and Photos cannot hold one, so a WebP from Photo library is not runnable on iOS. Test it through Files: find the app group folder and copy the file into its `File Provider Storage/`, then Attach, Files, Browse, On My iPhone:
  ```bash
  G=$(for d in ~/Library/Developer/CoreSimulator/Devices/$U/data/Containers/Shared/AppGroup/*/; do [ "$(plutil -extract MCMMetadataIdentifier raw "$d/.com.apple.mobile_container_manager.metadata.plist" 2>/dev/null)" = group.com.apple.FileProvider.LocalStorage ] && echo "$d"; done)
  cp zz-sample.webp "${G}File Provider Storage/"
  ```
  It is stored as `image/webp`, unconverted.
- **iOS.** On the TestFlight build, check the two permission texts, that a HEIC library photo uploads as `.jpg` JPEG, and that no microphone prompt or Info.plist string exists.

## Session basics (mobile parity area 4)

Follow [the session basics spec](../../../../../docs/specs/mobile-session-basics.md). Before starting each disposable server, copy the [graph-traces fixture](../../../../../tests/fixtures/mobile-session-basics/) into its data folder: `chats/*.json` into `DATA_DIR/chats/` and `graph/nodes.jsonl` into `DATA_DIR/graph/`. "Square roots to delete" contributed two nodes. "Square of two" is shared with "Squares kept elsewhere"; "Positive square root" is its own. Use a fresh copy for each delete mode. Unchecked, both nodes stay. Checked, "Positive square root" goes and "Square of two" stays with only the other session's provenance. Check `DATA_DIR/graph/nodes.jsonl` and the browser's graph after each.

- On a server without `session-basics-v1` (the pinned `bfb1e5d`), a long press opens no menu. Search and the switch still work.
- The same query in the phone and the web sidebar gives the same rows in the same order. Opening a result with one tap works while the keyboard is up. The query is still there after Back, and gone after Servers and another server.
- Compare the exported file (save it from the share sheet) byte for byte with the browser's download of the same session.

## Session opening (mobile-session-open)

Follow the [spec's Proof section](../../../../../docs/specs/mobile-session-open.md) for what each check must show, with the fixtures in `tests/fixtures/mobile-session-open/chats/` copied into the disposable server's `DATA_DIR/chats/`. These are the iOS driving steps, and the spec's pass criteria are the same on iOS. The Android driving notes, in pixels on the Pixel 6a, are in [the Android archive](../android-archive.md#session-opening-android-driving-notes). The spec's `adb` and TalkBack steps have the iOS equivalents below. Positions are in points: the iPhone 17 Pro is 402 by 874 points.

- **Opening by tap.** Press the session's row with `agent-device press`. A check that starts from the tap runs with Metro restarted without `EXPO_PUBLIC_CI_OPEN_SESSIONS`, which skips the tap. If a row does not respond to the tool's press, that check is BLOCKED for its starting tap.
- **Frames (proofs 1, 2, 8, 9).** Record and extract frames as in [Recording frames](#recording-frames). Step through them and compare consecutive frames pixel by pixel, as the spec says, using each frame's time from `ffprobe` for the 2 s limit.
- **Reaching the top during fill-in (proof 2).** Older messages keep arriving above while the long fixture fills in, so a command that scrolls until the top stops moving never settles there. To reach the FIRST message the finger moves DOWN. Loop, replacing the text with the fixture's first message ("Teach me maximum likelihood and logistic regression."):
  ```bash
  for i in $(seq 1 30); do agent-device swipe 200 150 200 750 --count 3 --pause-ms 50 >/dev/null; agent-device snapshot -i | grep -q 'Teach me maximum likelihood' && break; done
  ```
  It found the first message at round 8, after 175 s, on the long fixture. `agent-device scroll bottom` fails and `scroll top` works once filling in has finished. Run it on a warm open and on a cold open (force-stop first) right after the transcript shows. The cold run is the harder case. Press the app's ‹ to time Back.
- **Status-bar tap (proof 2).** Test it in a separate fresh open, while history is still filling: tap the status bar with `agent-device press 200 10`, which took the long session from near its end to its first message. Then check that the oldest drawn message stays anchored as older ones fill in above it: that part is an observation to make, not one the tap alone shows. If the press does not reach the status bar, the observation is BLOCKED and the owner's TestFlight check stays.
- **The 500 ms commit limit (proof 2).** Back timing and screenshots do not test it. Capture commit times with the React DevTools Profiler connected to the Debug app's Metro, or a Hermes profile. `npx react-native profile-hermes` fails, because the CLI wants `@react-native-community/cli` in `devDependencies`, and the React DevTools Profiler has not been tried. Until one of them runs, exactly this observation is BLOCKED.
- **No WebView (proof 3).** Search the tree: `agent-device snapshot -i | grep -i webview` must print nothing. The snapshot shows element types, so this observation runs.
- **The Scroll to end threshold (proof 5).** The threshold is 100 points on both platforms. `swipe` has no duration option, so drag slowly with `agent-device gesture pan 200 300 0 90 3000` or `agent-device scroll up --pixels 90 --duration-ms 3000` (points, 3 s). From the end, 90 points up leaves "Scroll to end" absent, and 120 to 130 points shows it. Take screenshots with `--pixel-density 3` when the check is in pixels (100 points is 300 px).
- **Text size and the period at the wrap width (proof 8).** Change the text size with `xcrun simctl ui $U content_size <size>` (`increment` and `decrement` step it one size at a time, and `xcrun simctl ui --help` lists the names) until the sentence's equation just fits its line, reopening the math cases session each time. iOS has fixed steps, not the fine steps the Android notes use. Put the size back and read it back with `xcrun simctl ui $U content_size`.
- **Rotation.** Screenshots keep their portrait dimensions in landscape, with the content drawn sideways, so their size proves nothing. Read the root frame from the accessibility tree: `agent-device orientation landscape-left; agent-device snapshot -i --json | grep -A4 '"rect"' | head -5` shows width 874 and height 402 (a `y` key sits between `x` and `width`, so a shorter `-A` stops before the height). Portrait shows 402 by 874. Then `agent-device orientation portrait`. No command reads the orientation back.
- **Reduce Motion (proof 5).** Read the original value first: `xcrun simctl spawn $U defaults read com.apple.Accessibility ReduceMotionEnabled`. Label selectors for the switch tap without toggling it, so use the coordinate:
  ```bash
  agent-device open com.apple.Preferences
  agent-device press 'label="Accessibility" role=cell' --settle
  agent-device press 'label="Motion" role=cell' --settle
  agent-device press 345 160 --settle
  ```
  Read the value back, then open the app and check Scroll to end. With Reduce Motion off, Scroll to end animated over about 20 frames in 0.3 s. With it on, it gave 3 frames, a jump. Switch it back with the same coordinate and restore the ORIGINAL value, including when it started enabled.
- **Keyboard (proof 5).** `agent-device type $'\t'` reports "Typed 1 chars" but is not a Tab, and `keyboard dismiss` answers `UNSUPPORTED_OPERATION`. Activating the focused button from a hardware keyboard has no way to run here, so that observation is BLOCKED.
- **VoiceOver (proofs 4, 5).** VoiceOver speech output is not observable on the simulator. The touch and Reduce Motion parts of proof 5 run here. Proof 4, and the VoiceOver double tap of proof 5, are BLOCKED for that observation and are the owner's TestFlight check.
- **Memory (proof 2).** `xctrace` does not work here: `--attach` by name fails, `--device $U --attach <pid>` ignores `--time-limit` and SIGINT, leaves an unusable trace and a `DTServiceHub`, and hangs the simulator until `xcrun simctl shutdown $U` and `bootstatus -b`. Do not run it. The simulator's app is a Mac process, so sample its footprint (process memory, not heap bytes) about once every 1.5 s (one `footprint` call takes about 1.5 s, and a bare `pgrep` on the app name returns one pid per booted simulator, so the pattern names this device):
  ```bash
  PID=$(pgrep -f "Devices/$U/.*/LearnHarnessNightly.app/LearnHarnessNightly$" | head -1)
  while :; do echo "$(date +%T) $(footprint $PID | sed -n 2p)"; sleep 1; done > $RUN/mem.txt
  ```
  (`ps -o rss= -p $PID` is the coarser alternative.) Open the long session, scroll nowhere, and wait until filling in has finished (20 s after the transcript shows). Then run two rounds, each a fling to the top until the first message shows, then Scroll to end and a 4 s wait. A round's window runs from its first fling to the end of its 4 s wait, and its peak is the largest footprint sample inside it. The spec's limit stays: round 2's peak at most 10% above round 1's. The spec's `dumpsys meminfo` TOTAL PSS is the Android measure. Memory on the simulator is the Mac process's, not a phone's: say so in the receipt. Rounds started while filling in is still going compare a partly loaded session with a fully loaded one, so they don't measure this.
- **Blank math in a recording.** In the long fixture every line of prose holds inline math, so a missing picture leaves a gap wider than any word space inside a line of text. Scan each frame's transcript area (below the bar, above the dock, left of the button column) for ink gaps over 140 px inside a text line no taller than a few lines. Then look at each flagged frame by eye: matrices and display math with wide spacing are false positives. Check a known blank frame (the receipt's `blank-math-frame-116.png` from the run at a4881269) is flagged before trusting a clean scan.

# Android archive

Android proof knowledge kept in case Android testing returns. Nothing here is run by default: phone proof runs on the iOS Simulator (see [the mobile beta recipe](features/mobile-beta.md#ios-simulator-on-the-mac)). The text is moved from the mobile beta and remote attachments recipes as written, with only its relative links adjusted, so it still names the ThinkPad, the Pixel 6a emulator and its AVDs.

## Setup steps as written for the Android emulator

Steps 1, 3 and 4 of the mobile beta recipe's Setup.

1. Record the source SHA, APK or signed EAS build ID and number, OS and device IDs, and server SHAs. Schedule the ThinkPad slot before building the server or Android APK. Use a disposable HTTPS endpoint authorized for the test, with no real records or keys. Prepare a second origin and a server pinned to `bfb1e5d` for core protocol proof.
3. Follow the emulator health gate below, in its order: the emulator is free, then memory and the APK build, then the boot and its checks.
4. Use T3 `device_list`, `device_open`, the returned `agent-device` command and `device_screenshot`. If a device is unavailable or the emulator cannot scan a virtual QR, record the missing observation. Use the typed or pasted link for the remaining drive. The physical iPhone run still checks both QR generators.

## Emulator health gate and machine limits

The ThinkPad runs one Android emulator at a time, and other jobs share it. A step the machine or the device tool can't do is BLOCKED for that step, never BROKEN for the change: say which limit stopped it and keep going with the steps that don't need it.

Steps in this order. `adb` is not on PATH: set `ADB=${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb` and use `"$ADB"` wherever a command below says `adb`.

1. **Is it free?** Run `"$ADB" devices` and `pgrep -a qemu-system`. If an emulator is listed or a `qemu-system` process exists, another job owns it: wait, or stop as BLOCKED. Never boot the second AVD beside it (`LearnHarness_Pixel_6a_API_36-2` next to a running one): two emulators leave Android's System UI not responding before the first tap. A `DEVICE_IN_USE` answer from the device tool means the same thing: don't take over or close another session's device.
   If `"$ADB" devices` hangs, no adb server is listening: `"$ADB" start-server`, then list again once.
2. **Memory and the APK, before the boot.** Check `free -m` and keep 6 GiB available, before the server build, before Gradle and again before the boot (an emulator takes about 2.5 GiB). Build only the emulator's ABI with two workers: `./gradlew assembleRelease -PreactNativeArchitectures=x86_64 --max-workers=2`. Gradle exiting with 143 was killed for memory: run the same command again, it resumes from the finished tasks.
3. **Boot through the device tool.** Call `device_list` and open the AVD with `device_open`, passing the `hostId` and device `id` that `device_list` gives for it. Once the AVD is booted, `device_list` lists it under its adb serial instead: open it with that id (the AVD name then answers "No device"), and set `SERIAL` to it. Every adb command for this device from here on is `"$ADB" -s "$SERIAL"`, since a physical device may be attached too. If an emulator you start from the shell exits on a missing `libpulse.so.0` or `libsndfile.so.1`, get the packages with `apt-get download` and unpack them with `dpkg -x` into the run folder, then point `LD_LIBRARY_PATH` at their `usr/lib/x86_64-linux-gnu`. Install nothing system-wide.
4. **Health gate after boot.** `device_open` can return before Android finishes booting, so poll, with each adb call and the whole wait bounded:
   ```bash
   deadline=$((SECONDS + 300)); booted=
   while [ $SECONDS -lt $deadline ]; do
     [ "$(timeout 10 "$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && { booted=1; break; }
     sleep 5
   done
   echo "booted=${booted:-no}"
   ```
   If it ends `booted=no`, shut the emulator down (`device_close` with shutdown), boot it once from the shell with `-wipe-data` (`"${ANDROID_HOME:-$HOME/Android/Sdk}/emulator/emulator" -avd <AVD> -wipe-data -no-window -no-audio`), and run this step again; if that also ends `booted=no`, stop as BLOCKED. Once booted, wait 60 s, then:
   - `timeout 30 "$ADB" -s "$SERIAL" shell dumpsys window >"$RUN/dumpsys-window.txt"` must exit 0. A failed or timed-out command is BLOCKED with its error, never a pass. Then `grep -i 'not responding' "$RUN/dumpsys-window.txt"` must print nothing.
   - `timeout 30 "$ADB" -s "$SERIAL" shell dumpsys activity lastanr` must say no ANR has occurred since boot.

   A System UI "isn't responding" dialog blocks every tap and Back: it is the environment, so shut the emulator down and cold boot once more (`-no-snapshot-load`). If it hangs again, stop as BLOCKED.

Machine limits, at any step:

- **Test HTTPS.** A test CA in the generated Android network security config needs `includeSubdomains="false"` on its domain entry, or Android lint stops the release build. Reach the disposable server through a local TLS proxy and `adb reverse`. A Cloudflare quick tunnel passed health but never delivered `/api/events` payloads, so the app showed its reconnect banner.
- **After a force-stop, a reinstall or a font change** the app opens Saved servers: open the disposable server's row before selecting a session.
- **Device tool answers.** A stale ref (`belongs to an expired ref frame`, `Android fill verification failed`): take a fresh snapshot and retry once. `pinch` is `gesture pinch`. The font presets land on 1.12 and 0.94: set exact values with `adb shell settings put system font_scale 1.3`, and put back `1.0`. A release APK refuses `run-as`, so read cache use from Settings → Apps → Storage & cache. Android 16 has no clipboard write command: copy with Chrome's selection and Copy. This image has no Developer options touch indicator, so record with `--hide-touches` instead.
- **Keyboard checks** need the real on-screen keyboard. Automation can leave its own test IME selected: pick Gboard in Settings → System → Keyboard, then check `"$ADB" -s "$SERIAL" shell settings get secure default_input_method` names Gboard (`com.google.android.inputmethod.latin/...`) before the check.
- **QR.** The device tool starts the emulator with its own camera flags, so the AVD's virtual scene setting does nothing. Feed the QR to the scanner as a PNG through the tool's image-file camera feed, and keep the code clear of the preview's left edge.
- **Shutting down.** `device_close` with shutdown can answer `Could not communicate with device support`. Run `device_list` once, check `adb devices` and `pgrep -a qemu-system` show it off, then close the stale panel entry. That is not a failed step.
- Restore every setting you change (TalkBack, font scale, rotation, dark mode, IME, animations) and read it back before the receipt.

## Android variants of shared steps

These steps are in the mobile beta recipe without their Android parts. Each is the original bullet, under the section it came from.

### Drive and compare

- Check formatted prose and a math message that each contain an HTTPS link and a non-HTTPS link. On the HTTPS link, verify **Open in browser?** appears, Cancel stays in the app, and Open launches the system browser at the confirmed URL. Verify that the non-HTTPS link stays plain text. A Cancel that opened the browser anyway looked fine on screen until Chrome came forward (audit 2026-11-21): after Cancel, `"$ADB" logcat -d | grep 'act=android.intent.action.VIEW'` must show no new line, and `scripts/mobile-checks.sh` taps the link in a message rendered through `NativeMarkdown`, then each button of the prompt, before any device run.

- With the device's real on-screen keyboard (Gboard on Android), focus the Message field in a long session and type. The field, the draft and Send must stay above the keyboard. Then focus Your thinking on a pending quiz. The question card must sit above the keyboard and scroll so the answers, confidence, field and submit buttons can all be reached without closing the keyboard. Open the session's "…" Session options menu and check that the accessibility tree shows View plan (when the session has a plan), Open in browser and Pair phone browser as visible, labeled nodes with real bounds.

- Have the owner repeat the approved iPhone acceptance on the exact TestFlight build over Tailscale and confirm the Android test-track install. Store account or iPhone access is a separate gate.

### Full lesson view

- **Plan.** The in-chat plan has the browser's boxes and arrows, all in the plain ink. Tap it, and separately use … → View plan. The live plan opens with "Unions and intersections" glowing as current and the other three nodes, with every arrow, dimmed as upcoming. "What a set is" is upcoming too: a node counts as visited only once a teaching check has been tagged on it, and the fixture tags only the union check. The phone, the browser and the desktop app must all agree. Pinch in and out, drag while zoomed, press −, ⤢ and +, and check that you can't zoom out past the fit. The Android back button and ‹ return to the same scroll position in the session.

### Attach photos and files

Use a server with `attachment-uploads-v1` and the fake model's teach scenario. Give the emulator a virtual camera scene (Extended controls → Camera → Virtual scene, or a webcam image) and push one synthetic photo and one synthetic PDF (for example `tests/fixtures/sample-3page.pdf`) into the emulator's Pictures and Download folders. Use only synthetic files.

- **Camera.** Deny the camera permission once: the note reads "Camera access is off. Allow it for LearnHarness Nightly in Settings to take photos." and the draft text stays. Allow it, take a photo of the virtual scene, and check the chip's progress, then ready. The server's pending upload is a JPEG whose bytes match the chip's size.

- **Location and types.** Turn on location tagging for the emulator camera (or push a synthetic JPEG with GPS EXIF into Pictures), attach it, and check the server's stored bytes with `exiftool` or `exif`: no GPS, XMP or IPTC tags, orientation kept. Push a synthetic WebP or GIF into Pictures and pick it from Photo library: its chip ends in `.jpg` and the server stores `image/jpeg` bytes.

- **Undecodable photos.** Push a synthetic 12-bit HEIC (HEVC Range Extensions, `yuv420p12le`) and an 8-bit HEIC into Pictures, and pick both from Photo library with a GIF. The 8-bit HEIC and the GIF attach as `.jpg`. The 12-bit one is skipped with "NAME couldn't be converted on this phone. Attach it from Files instead." No reservation is made for it.

- **Copies.** After sending, removing and refusing Files picks, and after leaving the screen, `adb shell run-as <package> ls cache/attachments` shows no leftover copies. A Files pick over 50 MiB is refused with "A picked file exceeds the 50 MiB per-file limit." without a copy appearing.

### Session basics

- On a server without `session-basics-v1` (the pinned `bfb1e5d`), a long press opens no menu and TalkBack lists no row actions. Search and the switch still work.

- Compare the exported file (`adb shell run-as <package> ls cache/session-exports`, or save it from the share sheet) byte for byte with the browser's download of the same session.

## Math in quiz choices with TalkBack

Rerun this whenever a change touches quiz or ask choice rows. Use a pending quiz whose choices include `No, $P\to Q$ is blocked.` and a plain label, and a pending multi-select ask question ([spec](../../../../docs/specs/mobile-quiz-choice-math.md), proof 3).

- **Driver.** Drive TalkBack only with real input and its own spoken output, never accessibility-tree dumps. A UiAutomator snapshot (`agent-device` snapshot, `uiautomator dump`) unbinds TalkBack, so take screenshots with `adb exec-out screencap -p` and read logcat instead. Turn TalkBack back on with `adb shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService` and `adb shell settings put secure accessibility_enabled 1`. In TalkBack settings → Advanced settings → Developer settings, set the log output level to Verbose, and read what it speaks from `adb logcat | grep -i talkback`. `adb shell input` and `agent-device` presses arrive as plain clicks, not TalkBack gestures. Send gestures as hardware input through the emulator console instead: a one-finger right swipe is `adb emu event mouse X Y 0 1` at a start point, the same at a few points further right, then `adb emu event mouse X2 Y 0 0`. TalkBack logs `GESTURE_SWIPE_RIGHT detected` and moves to the next item (proven at `07433c3`). A double tap is two quick taps the same way, `0 1` then `0 0` twice at one point within about 300 ms. Record that TalkBack logs it as a double tap, not a click.
- **One stop per row.** From the question, swipe next-item through every row. Focus lands once on each row, in order, with nothing between rows. Each row's utterance has its label with the math spoken (`No, P right arrow Q is blocked.`), no `$` or `\`, "radio button" or "checkbox", and its checked state. Android's usage hint ("Double-tap to toggle") may follow a row as its own utterance.
- **Double tap.** Double-tap a focused row. It is selected, and TalkBack reads it as checked. Repeat on the multi-select ask question.

Record each observation, the device screenshot or recording, and the saved server or browser evidence in the run receipt. Keep codes and bearers out of receipts. Mark missing steps as blocked or unproven.

## Session opening: Android driving notes

Driving notes for the steps that are hard to reach on the emulator, from the Session opening section of the mobile beta recipe. Follow the [spec's Proof section](../../../../docs/specs/mobile-session-open.md) with the fixtures in `tests/fixtures/mobile-session-open/chats/`.

- **Reaching the top during fill-in.** Older messages keep arriving above while the long fixture fills in, so a command that scrolls until the top stops moving never settles there and times out. Fling instead. On the Pixel 6a (1080 by 2400 px), `adb shell input swipe 540 700 540 2200 60` is one fast fling toward the top. Repeat it, taking an `adb exec-out screencap -p` after each, until the fixture's first message ("Teach me maximum likelihood and logistic regression.") is at the top. A scroll-to-top command is usable once fill-in has finished, when no new content arrives above.
- **The Scroll to end threshold.** The threshold is 100 points, 263 px on the Pixel 6a. A slow drag moves the content by the drag distance without a fling: `adb shell input swipe 540 1000 540 1250 1500` moves about 250 px, and `540 1000 540 1300 1500` about 300 px.
- **The period at the wrap width.** Change the text size until the sentence's equation just fits its line, with `adb shell settings put system font_scale 1.05` (then 1.1, 1.15 and so on), reopening the math cases session each time. Put it back with `adb shell settings put system font_scale 1.0`.
- **Rotation.** `agent-device orientation landscape-left`, then `orientation portrait`. Plain `landscape` is rejected. The command turns auto-rotate off: put it back afterwards with `adb shell settings put system accelerometer_rotation 1`, and check the screenshots' size (2400 by 1080 in landscape), since the tool may warn that the rotation is unconfirmed.
- **Keyboard.** `agent-device` sends no Tab on a phone: `tv-remote` refuses with `UNSUPPORTED_OPERATION`, and `keyboard` has only Enter and dismiss. On a headless emulator (`-no-window`), console keys (`adb emu event send EV_KEY:...`) never reach the phone either. Send Tab with `adb shell input keyboard keyevent KEYCODE_TAB`, and Shift+Tab with `adb shell input keyboard keycombination KEYCODE_SHIFT_LEFT KEYCODE_TAB`. Read which control has focus from `agent-device snapshot -i` (the `[focused]` row), and activate it with `agent-device keyboard enter`. For Scroll to end, scroll up more than 100 points, press the "Whatever comes to mind as you read." field, run `agent-device keyboard dismiss`, then press Shift+Tab once: "Scroll to end" is `[focused]`. `keyboard enter` then lands at the end. Tab forward walks through the transcript, which scrolls the end into view and hides the button before focus reaches it.
- **TalkBack.** Turn it on with the two `settings put secure` commands in the quiz-choice section above. Its gestures go through the emulator console, which works on a headless emulator too. Write `E="adb -s emulator-5554 emu event mouse"`. Next item is a one-finger right swipe: `$E 300 1200 0 1`, then `$E X 1200 0 1` for X = 400, 500, 600, 700 and 800, then `$E 800 1200 0 0`. To put TalkBack's focus on a control, explore-tap it once: `$E X Y 0 1` then `$E X Y 0 0`. The Scroll to end button is at about (980, 1745) px. To activate the focused control, double tap anywhere: `$E 540 1200 0 1; $E 540 1200 0 0; $E 540 1200 0 1; $E 540 1200 0 0`. Take evidence with `agent-device screenshot`, which shows TalkBack's green focus box and leaves TalkBack bound; check with `adb shell dumpsys accessibility | grep "Bound services"`. With agent-device 0.21.36, `record`, coordinate `press` and `swipe`, and `snapshot` also left it bound and still taking gestures. Even so, keep snapshots out of TalkBack runs, since an earlier helper restart unbound it.
- **What TalkBack speaks.** Set its log level to Verbose while TalkBack is off. `agent-device open com.google.android.marvin.talkback` fails, so open the settings with `adb shell am start -n com.google.android.marvin.talkback/com.android.talkback.TalkBackPreferencesActivity`. Then use agent-device: `scroll down --until 'label="Advanced settings"'`, press it, do the same for "Developer settings", press "Log output level", press `text="VERBOSE"`, then "Yes, enable verbose logging". Each utterance is then in `adb logcat | grep 'action=SPEAK'` as `text="..."`, and each gesture as `GESTURE_SWIPE_RIGHT` and the like. A math paragraph reads as one utterance with the math spoken ("Write the loss as log p Each step multiplies by X ... the fraction with numerator 32 cubed and denominator 3."). Set the level back to ERROR the same way, and turn TalkBack off.
- **Flings that test the picture window.** Fling toward the top with `agent-device swipe 540 700 540 2200 --count 12 --pause-ms 150`. Run it on a warm open, and on a cold open (force-stop first) right after the transcript shows, while older messages are still filling in above. The cold run is the harder case.
- **Proof 2's memory check (owner decision, 2026-11-20).** Measure it once the long session has fully loaded. Open it, scroll nowhere, and wait until filling in has finished: wait 20 s after the transcript shows. On the ThinkPad emulator, filling in takes about 8 s from a cold open and less warm. Then run the two rounds. A round is: fling to the top with `agent-device swipe 540 700 540 2200 --count 8 --pause-ms 200` until that first message shows, then press Scroll to end and wait 4 s. Sample `adb shell dumpsys meminfo <package>` TOTAL PSS about once a second through both rounds, and compare each round's peak. The spec's limit stays: round 2's peak at most 10% above round 1's. Rounds started while filling in is still going compare a partly loaded session with a fully loaded one, so they don't measure this.

## Remote attachments: Android Chrome

Step 5 of the drive in [remote attachments](features/remote-attachments.md), as written.

5. Android Chrome, if an emulator with Chrome 132+ is available: open the device with the device tools, `adb reverse` the head port, pair the phone browser, open `/chat/new`, choose Folder and pick a subfolder of Download holding the fixture (Android 11+ refuses the Download folder itself, internal storage root and SD card roots). Expect the same chip and manifest. Record the Chrome version.

# Demos and figures on mobile

The owner approved this spec on 2026-11-19: they confirmed the playback and all 11 defaults, with no vetoes. In the Expo phone app (`apps/mobile`), a lesson message that delivers an interactive demo or a figure shows only a card saying to open the session in the browser. This spec makes the phone show both in place, at parity with the web and desktop app.

T3 references are to github.com/pingdotgg/t3code at `3ce2145864f1e8b822cc8dff9c8cfdf39d9e450b` (2026-11-18), under `apps/mobile/`. LearnHarness references are to `origin/main` at `88981ee`, checked 2026-11-19.

## 1. Starting point

**Why.** The phone already receives everything it needs. The transcript projection puts each demo's HTML and each figure's SVG in the `data-subagent-artifact` part, together with the saved invert state `ui.inverted` (`src/core/view.ts:431-449`, `src/core/contracts/jobs.ts:312-318`). But `SteerCard` never draws them: for `demo` and `visual` it returns a card that says "Open this session in the browser to see it" (`apps/mobile/src/LessonParts.tsx:228`, `:272-279`). The phone has no demo or figure renderer.

**Current state.**

- **The web's demo card** (the desktop app runs the same code): `components/artifacts/demo-card.tsx`.
  - The demo runs in an iframe with `sandbox="allow-scripts"` and no `allow-same-origin` (`:211-217`). A bridge script added to every demo reports its height and its errors (`:31-53`). The frame grows to fit, from 80 to 2400 px, starting at 360 px (`:62-63`, `:229`).
  - The header has the "interactive demo" label and title, an invert switch, and Download as `<slug>.html` (`:177-202`).
  - The invert switch is saved through `POST /api/chats/:id/artifact-ui`, and a failed save is ignored (`:149-158`).
  - An error chip offers "Send to teacher", which sends `The demo "<title>" threw an error: <message>` (`:204-210`).
  - A failed demo shows "Interactive demo · failed" with its notes (`:111-121`).
- **The web's figure card:** `components/artifacts/visual-card.tsx`.
  - The SVG is shown as an image on a white backing, at its own width (`:374-406`). The display-only repairs never change the stored file or the download (`lib/svg-image-source.ts:1-3`).
  - Below the picture is a caption row: the "Figure" label, an invert switch, Download as `figure.svg`, and full screen (`:407-448`).
  - A figure that annotates a learner photo loads the photo from `/api/chats/:id/images/:snapshotId` and has no invert switch (`:324-325`, `:352-355`, `:367`).
- **What the AI writes.**
  - Plain figures may use style blocks (`src/agent/subagents/visual-maker.ts:104`).
  - Annotated photos are told to give their labels white halos with `paint-order="stroke"` (`:125`).
  - Demos may import libraries from a CDN (`src/agent/subagents/demo-builder.ts:54`), and the sandbox makes their storage calls throw (`:56`).
  - Of the jobs in the owner's local data on 2026-11-19, 4 are demos (none loads from a CDN) and 1 is a figure. The figure uses `text-anchor` and `font-family`.
- **react-native-svg 15.16.0** (packed from npm on 2026-11-19). It draws text, markers, gradients, filters, `foreignObject` and `image`, and its `react-native-svg/css` entry handles style blocks. It has no `dominant-baseline` or `paint-order` (a grep of `src/` and `android/` finds only `alignmentBaseline`). On the phone, a centered label would sit off center, and a halo would be painted over its text.
- **T3.**
  - **HTML.** T3 draws an inline HTML page as a web view at a fixed height (`src/features/threads/HtmlRenderWebView.tsx:247-255`). The frame scrolls inside only when the page overflows (`:111`, `:135`, `:139`), and the view is labeled with the page title (`:128`). A crashed page reloads once, then shows "Page unavailable" with tap to reload (`:100-110`, `:156-157`, `:256-270`). A button opens the page full screen (`:221-244`), and the full-screen screen has "Save or share" (`src/features/files/AttachmentFileScreen.tsx:155-159`, `expo-sharing` at `package.json:117`).
  - **Heights.** T3's frame heights come from measurements taken when the page is published (`packages/shared/src/htmlRender.ts:99-119`). LearnHarness has no such measurement.
  - **Diagrams.** T3 draws them with native `SvgXml` inside one `imagebutton` stop with the hint "Opens the diagram full screen" (`src/native/MermaidCodeBlock.tsx:236-254`).
  - **Off-screen pages.** T3's feed is a virtualized `LegendList` (`ThreadFeed.tsx:56`), so pages far off screen unload. Its own comment says fixed row heights are what stop the feed jumping (`ThreadFeed.tsx:4109-4111`).
- **The phone.**
  - The transcript is a plain `ScrollView` (`apps/mobile/src/Session.tsx:205`), so everything in it stays mounted.
  - Math blocks already use one web view each (`Markdown.tsx:72-79`), with storage, file access and extra windows off (`:73`).
  - The phone already loads learner photos through `PROTOCOL_ROUTES.image` (`Transcript.tsx:25`).
  - The paired bearer works on every `/api/` route (`proxy.ts:28-45`).
  - `updates.enabled` is false today (`apps/mobile/app.json:10`). The mobile auto-updates spec (`docs/specs/mobile-auto-updates.md` on `docs/ota-build-spec`) is being built. Under it, a native change triggers a new store build.
- **Old servers.** The older protocol server the mobile recipe pins, `bfb1e5d`, already has both routes the phone needs: `artifact-ui` and `images/[snapshotId]` (`git ls-tree`, 2026-11-19). No new capability flag is needed.
- **Related owner decisions.**
  - Phone math is drawn as SVG through MathJax, with one screen-reader stop per equation (`docs/specs/mobile-quiz-choice-math.md` on `feat/mobile-quiz-choice-math-build`).
  - Per-element web views leaked TalkBack focus and made the session jump on open (closed PR #263).
  - The phone's look follows the web: Default when the phone is dark, Ivory when it is light (`apps/mobile/src/theme.ts:1-5`).
- **I could not verify these.**
  - *Inside a nested web view in the `ScrollView`, can TalkBack reach a demo's controls, and does focus leave the frame to the next message?* If not, Goal 6 fails. The first task proves it.
  - *On Android, does a demo frame scroll inside when the demo overflows, while the transcript still scrolls when it doesn't?* The first task proves it.
  - *Do the web view settings really block navigation, new windows, storage, and camera, mic and location on a device?* Only the props were read. The first task proves it.

**First task, before any feature code.**

1. Re-probe the load-bearing facts:
   - `LessonParts.tsx:272-279` is still the placeholder.
   - The transcript still carries `result.html`, `result.svg` and `ui.inverted`.
   - react-native-svg still lacks `dominant-baseline` and `paint-order`.
   - The phone's bearer is accepted by `POST artifact-ui`.
2. Get the real TalkBack driver, the one proven by the math spec's first task (keyboard next-item navigation plus TalkBack's logged spoken output, never node dumps). If it doesn't exist yet, prove one now.
3. Spike on the ThinkPad Android emulator with a debug build. Put one 360 px demo frame in a session between two messages, with a slider, a button and a taller-than-frame variant. Show all of these:
   - TalkBack, driven for real, announces the frame by its title, reaches the slider and the button, then moves on to the next message.
   - A drag moves the slider.
   - A vertical swipe on the demo that fits its frame scrolls the transcript, and the taller variant scrolls inside its frame.
   - The escape demo's navigation, `window.open`, storage, and camera, mic and location requests all fail.
4. If any item in step 3 fails, **stop and report to the owner** with the evidence. Don't try another approach.

## 2. Goals and non-goals

**Goals.**

1. A delivered demo runs in place in its message, in a frame that is 360 px tall and never changes height. A shorter demo leaves white space below it inside the frame. A taller one scrolls inside the frame. This follows T3's fixed frame (`HtmlRenderWebView.tsx:111-139`).
2. A delivered figure is drawn in place by react-native-svg, with display-only fixups for what it can't draw: `dominant-baseline`, `paint-order` halos and style blocks. Every test figure looks the same as on the web.
3. The demo sandbox matches the web's exactly:
   - The demo's code runs, and it can load files from the internet.
   - It can't reach the app.
   - It can't navigate, open windows, store data, or use the camera, mic or location.
   - Its only messages to the app are its size and its errors, and the app ignores anything else.
4. Every demo in a session stays loaded and keeps its state while you scroll, as on the web.
5. Both demos and figures have a full-screen button, and figures can be pinched to zoom there. Full screen loads a fresh copy of the demo. Back returns to the same place in the session.
6. Screen readers:
   - A figure is one stop, read as "Figure", with the hint "Opens full screen".
   - A demo frame is announced as "Interactive demo, <title>", and its own controls can be reached inside it, as in T3.
7. An invert switch on demos and plain figures (none on annotated photos) is saved through `POST /api/chats/:id/artifact-ui`, as on the web. The phone and the web show the same saved state.
8. A demo error shows the web's error chip, whose "Send to teacher" sends the web's exact text. The button is disabled while a reply runs, like Send.
9. In full screen, "Save or share" opens the phone's share sheet, as in T3 (`AttachmentFileScreen.tsx:155-159`). It shares the original file with the web's names: `<slug>.html` for a demo, `figure.svg` for a figure.
10. The card text and the failed, unreadable and loading states, including "Loading image…" for annotated photos, use the web's words. Card chrome follows the phone's theme, and the demo and figure backing stays white, as on the web.
11. A crashed demo reloads once, then shows "Demo unavailable" with tap to retry (T3 `HtmlRenderWebView.tsx:100-110`).
12. Demos, figures and invert also work against the older protocol server at `bfb1e5d`.

**Non-goals.**

- No server change, new route or new capability flag. Every route needed exists on `bfb1e5d`.
- No growing demos to fit their content, as the web does. Rejected: it makes the page jump.
- No unloading of demos that scroll off screen, as T3 does. Rejected: the owner wants demo state kept, as on the web.
- No PNG made on the server for figures. Rejected in favor of native SVG.
- No measuring demo heights at build time to size the frame. That would be a server change the owner did not ask for.
- The knowledge graph on mobile: a separate, later spec.
- Math in messages and quiz choices: covered by the math specs.
- Opening a session at its latest message: a separate spec.
- Inline download buttons on the card. Saving happens only from full screen, as in T3.

## 3. Constraints

**Invariants.**

| Invariant | Where it is enforced or detected | Kind |
| --- | --- | --- |
| A demo frame's height never changes after its first layout, including while the session opens and while demos load. | Proof 3 (screen recording measured frame by frame) | machine |
| The demo web view never receives the bearer, a cookie or any other credential. A fetch from the demo to the server gets 401. | Proof 4, and a unit test that the demo document and web view props carry no credential | machine |
| The app accepts only size and error messages from a demo, in the bridge's shapes. It ignores everything else, including link URLs, so a demo can never make the app navigate, open a link or send anything. | Unit test on the message filter, and proof 4 | machine |
| A demo can't navigate its frame or the app, open a window, use storage, or use the camera, mic or location. It can load files from the internet. | Proof 4 | machine |
| The figure fixups change only how a figure is drawn. Save or share carries the original SVG or HTML byte for byte, as on the web (`lib/svg-image-source.ts:1-3`). | Unit test comparing the shared file to the stored result | machine |
| Every test figure looks the same on the phone as on the web: every mark, label and halo in the same place and readable. | Proof 2 (a fresh agent that sees only the screenshot pairs and this goal) | machine |
| The phone sends exactly the web's "Send to teacher" text, and only on the learner's tap. | Proof 8 and a unit test | machine |
| On the owner's iPhone with VoiceOver, demos run, a figure is one stop, and a demo's controls can be reached. | The owner, by hand, on the first TestFlight build after merge. Not a merge check. A failure becomes a follow-up. Replacement verifier when one exists: an iOS Simulator run of proofs 5 and 9. | human (confirmed by the owner) |

**Entrypoints.** No new routes. Two existing actions get a phone trigger:

- `POST /api/chats/:id/artifact-ui` (the invert switch). It is reversible, owned by that route, and the last write wins. A failed save is ignored, as on the web.
- The phone's existing send path ("Send to teacher"). It adds a lesson message and wakes the teacher, which can't be undone. The learner's tap is its only trigger.

Both use the paired bearer, and a revoked bearer gets 401. Bearer API calls carry no CSRF risk, there is no new secret to guess, and nothing new is exposed outside production.

**Permissions.** No person or agent gains or loses access. The one new process that handles untrusted input is the demo web view, and it holds no credential.

**Removed or changed readers.**

- The placeholder card and its comment (`apps/mobile/src/LessonParts.tsx:228`, `:272-279`).
- The mobile beta spec's line "Demo and figure results point to the browser until follow-up 5" (`docs/specs/mobile-beta.md:43`) goes stale. Update or delete it in the same PR.

**Stop and ask.**

- Any failure in the first task: stop and report. Don't switch approaches.
- A fidelity gap that a display-only fixup can't close.
- The memory check (proof 10) shows a crash, a web view render-process restart, or the app reloading.
- Meeting a goal would need the sandbox to differ from the web's.
- The full Android proof gets one fix round and one fresh re-verify (task-lifecycle's verify rule). If it still fails, stop and report.

**Left to the agent.**

- Component and file layout.
- How the fixups are written.
- How invert is drawn natively.
- The full-screen screens (they may reuse the plan screen's pinch zoom).
- How the bridge script is injected.
- Test names.
- Whether to add a prove-learnharness feature recipe under `references/features` for reaching and driving demos and figures on the phone. Add it only after it has run. This spec's proof is the answer key, and later changes re-check these flows only when their diff touches them.

## 4. Proof

**Verifies on.** The ThinkPad's Pixel 6a API 36 Android emulator, with a debug or `android-proof` APK built from the head. It is paired to a disposable LearnHarness server with the fake model, following `.claude/skills/prove-learnharness/references/features/mobile-beta.md`. The web on the same server, in Chrome, is the answer key. A second disposable server at `bfb1e5d` is used for proof 12.

**Set up first.**

- Extend `tests/fixtures/mobile-lesson` with one synthetic session and its jobs. It holds:
  - Five working demos: one with a slider and a button, one taller than 360 px, one that throws an error, one that loads a library from a CDN, and one that tries to escape. The escape demo navigates, calls `window.open`, uses `localStorage`, asks for the camera, fetches the server's `/api/chats`, and posts junk messages.
  - A failed demo.
  - A plain figure.
  - A figure that uses `dominant-baseline` and a style block.
  - An annotated learner photo with halo labels.
  - A failed figure.
  - One demo and one figure with `ui.inverted` set.
- The real TalkBack driver (first task, step 2).

| # | Proves | Surface | Check | Where it runs | Pass signal |
| --- | --- | --- | --- | --- | --- |
| 1 | Goals 1, 2, 10 | Session on the phone | Screenshot every fixture card in dark mode (web Default) and light mode (web Ivory), next to the same card on the web | Emulator and Chrome, same server | Each card, label, state and wording matches the web. The backing is white and the chrome follows the theme. No placeholder text remains. |
| 2 | Goal 2, fidelity invariant | Figures on the phone | A fresh agent gets only each figure's phone and web screenshot pair and the goal "the same picture: every mark, label and halo in the same place and readable" | Emulator and Chrome | The agent passes every pair. |
| 3 | Goal 1, height invariant | Session opening | Record the screen from opening the fixture session until 5 s after the last demo loads. Measure each demo frame's bounds per frame. | Emulator | No frame's height changes after its first frame. |
| 4 | Goal 3, credential, message and sandbox invariants | Escape demo and CDN demo | Run the escape demo and read its on-page results. Watch the app and the server log. | Emulator and server | The app stays on the session, and no browser or window opens. Storage throws, the camera is denied, and the server fetch gets 401. Junk messages change nothing. The CDN demo draws. |
| 5 | Goals 1, 3 | Interactive demo | Drag the slider and tap the button. Swipe vertically on the 360 px demo and on the taller one. | Emulator | The demo responds. A swipe on the demo that fits scrolls the transcript, and the taller demo scrolls inside its frame. |
| 6 | Goal 5 | Full screen | Open a demo and a figure full screen. Pinch to zoom the figure. Press Back. | Emulator | Both open, the figure zooms, and Back returns to the same scroll position. |
| 7 | Goal 7 | Invert | Toggle invert on the phone and reload the browser. Toggle on the web and reopen the session on the phone. Check the annotated photo. | Emulator, Chrome and the saved record | Both sides show the saved state, and the record's `ui.inverted` matches. The annotated photo has no switch. |
| 8 | Goal 8 | Error chip | Open the throwing demo and tap Send to teacher. Try again while a reply runs. | Emulator and the saved record | The saved learner message equals the web's text exactly. The button is disabled during a reply. |
| 9 | Goal 6 | TalkBack | Move next-item through a figure and the slider demo with the real driver, and capture what it speaks | Emulator | The figure is one utterance, "Figure", with the full-screen hint. The demo frame is announced with its title, the slider and button are reached, and focus then moves to the next message. |
| 10 | Goal 4 | Memory | Open the session with all five demos, scroll to the end and back, then use a demo. Record `dumpsys meminfo` for the app. | Emulator | No crash, no render-process restart and no reload. The demo keeps its slider state after scrolling. Memory figures are recorded in the receipt. |
| 11 | Goal 9, original-file invariant | Save or share | Save or share a demo and a figure from full screen to Files | Emulator | The files are named `<slug>.html` and `figure.svg`, and match the stored result byte for byte. |
| 12 | Goal 12 | Old server | Repeat proofs 1 and 7 against the `bfb1e5d` server | Emulator | Same pass signals. |
| 13 | Goal 11 | Crash recovery | Force the demo web view's render process to end twice (for example with `adb shell am kill` on the sandboxed renderer) | Emulator | It reloads once, then shows "Demo unavailable", and a tap retries. |
| 14 | Unit-tested invariants, build health | CI | `npm test` in `apps/mobile`, plus the Mobile job (deps:check, lint, typecheck, test, both exports) | CI | All green. |

Every check must pass to merge. Pass means every step shows its stated result, and anything else fails the step. A step that can't run counts as a failure, not a skip.

**After deploy.** The owner runs the iPhone check from Constraints on the first TestFlight build that contains this change. The check ends after that one build. A failure opens a follow-up.

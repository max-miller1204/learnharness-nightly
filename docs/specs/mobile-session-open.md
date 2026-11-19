# Opening a mobile session at the latest message, fully drawn

Approved by the owner on 2026-11-19 (playback confirmed with all 12 defaults, no vetoes). In the Expo phone app (`apps/mobile`), opening a session shows a half-drawn transcript for a couple of seconds and then jumps into its real layout. This spec draws message math natively with the MathJax drawing that quiz choices already use, opens the session at the latest message with nothing half-drawn, and adds T3's status-bar tap and "Scroll to end" button. It is the second half of closed PR #263. The first half shipped as PR #277 (`docs/specs/mobile-quiz-choice-math.md`).

T3 references are to github.com/pingdotgg/t3code at `3ce2145864f1e8b822cc8dff9c8cfdf39d9e450b` (2026-11-18), under `apps/mobile/src/features/threads/`. LearnHarness references are to `origin/main` at `4a66ecd7`, checked 2026-11-19.

## 1. Starting point

**Why.** Every markdown block that contains math is drawn as its own web page (`apps/mobile/src/Markdown.tsx:19-23`, `:26-80`). Each page starts 26 px tall and blank (`:29`), loads, measures itself and reports its height, and only then does the block grow (`:64-65`, `:76-77`). A message with math is blank until its page loads, and the transcript lays out with wrong heights until every page has reported. The owner's two screenshots from 2026-11-19 show this. In `…5bf7ff25-c694-49d8-adee-bf3fbaa5a3c7.png` (the half-drawn frame), the answered quiz cards are tall and empty, the space after each "Agent's thinking" is blank, and the collapsed "Check your understanding" preview has no text. The screen sits at the bottom of a transcript whose last messages are still short blank pages, so older content shows where the latest should be. In `…73833125-3ad2-4e47-869d-0dabdd13c541.png` (the settled frame), the pages have loaded and grown, and the view is pinned to the real end. The brief labeled the two files the other way round. The scroll itself already follows the bottom: `nearBottom` starts true and every content size change scrolls to the end (`apps/mobile/src/Session.tsx:56`, `:205-210`). The jump comes from late-growing web pages, not from a wrong starting position.

**Current state.**

- **Where markdown is drawn.** `Markdown` is used for message text, posed plugin questions, problem statements, conclude verdicts and solutions, practice thinking, and answered-card question text, explanations and committed text (`Transcript.tsx:67-121`). It is also used for the dock's question text and context (`BuiltinQuestion.tsx:156-157`), the collapsed "Check your understanding" preview (`BuiltinQuestion.tsx:95`), the agent's reasoning when opened (`LessonParts.tsx:43`), and helper briefs and results (`LessonParts.tsx:177`, `:200`, `:267`). Blocks without math already use the native renderer (`NativeMarkdown.tsx`), which prints inline math as `$...$` source (`:55-56`) and block math as plain text (`:109-110`). Math is detected by markdown-it with `@mdit/plugin-katex`, all delimiters (`render-markdown.ts:4-9`, `:40-48`).
- **The native math drawing from #277.** `drawTex` turns TeX into an SVG string, size and depth, MathML and symbol text, and refuses broken or untrusted math (`apps/mobile/src/choice-math.ts:207-244`). Labels are cached, 200 at most (`:295-310`). `MathLabel` sizes every picture before drawing it, so a row never grows later (`MathLabel.tsx:68-105`). Spoken math comes from the bundled speech engine (`math-speech.ts`).
- **The list.** The transcript is a plain `ScrollView` with everything mounted (`Session.tsx:205-232`). The question dock has a second `ScrollView` (`:236`). Neither sets `scrollsToTop`. The phone has no "Scroll to end" button and no status-bar handling (grep for `Scroll to end` and `scrollsToTop` in `apps/mobile/src`, 2026-11-19: no matches).
- **Other content that sizes late.** Shown images load, then take their aspect ratio (`Transcript.tsx:18-39`). The in-chat plan re-sizes after its first layout (`Transcript.tsx:43-55`). Demos get fixed 360 px frames under the visuals spec.
- **How big real sessions are** (probe on 2026-11-19: the owner's local data in `~/.learnharness/userdata/data/chats/`, read only, run through `projectView` and the phone's `parseMarkdown`, then `drawTex` under Node 26 on the desktop). "cs4824 test2" (the screenshot session) has 226 records and 20 view messages. It has 1,291 equations in content shown at open, and 479 of them are different. By view message from the end, the counts are 234, 0, 226, 0, 100, 0, 263, and so on. Drawing the 479 different equations took 1,245 ms (2.6 ms each), or 1,707 ms with `--jitless` (3.6 ms each). "cs4804 Test 2" has 124 equations (74 different), and its last message has 67. Collapsed reasoning is not counted, because it mounts only when opened.
- **T3.**
  - Its feed opens at the end (`initialScrollAtEnd`, `alignItemsAtEnd`, `ThreadFeed.tsx:4348-4349`) and keeps to the end on data, item and layout changes (`:3107-3110`, `:4310`).
  - It hides the feed (`opacity: 0`) until it has landed within 2 points of the end, and shows it anyway 1 s after the list is ready (`:3775-3792`, `:4298`, `:4350-4355`).
  - Its virtualized list gives rows fixed sizes because rows measured late make the feed jump (`:4109-4112`).
  - "Scroll to end" shows whenever the feed is not at the end (`ThreadDetailScreen.tsx:1410`). It is a round chevron button labeled "Scroll to end" and hidden from screen readers while not shown (`floating-working-control.tsx:343-356`). It scrolls with animation unless Reduce Motion is on, with a haptic tick (`ThreadDetailScreen.tsx:1403-1408`).
  - Inner scroll views opt out of the iOS status-bar tap (`thread-work-log.tsx:721`).
- **Ship path.** The phone has OTA updates (`docs/specs/mobile-auto-updates.md`, PR #275). A change that keeps the native fingerprint ships as an update with no store build. `react-native-webview` is also needed by the visuals spec (`docs/specs/mobile-visuals-demos.md` on `docs/mobile-visuals-demos-spec`).
- **Proof environment.** The ThinkPad (env `56422c83…`) was reachable on 2026-11-19. It has the Pixel 6a API 36 emulators. The real TalkBack driver and the mobile proof steps are in `.claude/skills/prove-learnharness/references/features/mobile-beta.md:59-67`. The Mac has no iOS Simulator, so the owner checks the iPhone by hand.
- **I could not verify these.**
  - *How fast are drawing and mounting on the phone under Hermes?* Only Node was measured. If the latest message can't be shown within 2 s on the emulator, Goal 1 fails. The first task measures it.
  - *Does the transcript keep what is on screen still when older content is added above it, on Android and iOS?* If not, Goal 1's fill-in fails. The first task proves it on Android, and the owner's after-deploy check covers iOS.
  - *What does TalkBack do with a link inside a paragraph read as one stop?* The proof checks it.

**First task, before any feature code.**

1. Re-probe the load-bearing facts: `Markdown.tsx` still sends math blocks to a web page, and `Session.tsx` still follows the bottom with a plain `ScrollView`.
2. Build the made-up fixture (see Proof). Spike on the ThinkPad emulator with a debug build. Show both of these:
   - The latest message's math is drawn and shown at the bottom within 2 s of tapping the session.
   - Content added above the visible messages leaves them still on screen.
3. If either fails, **stop and report to the owner** with the evidence.

**Owner decision after the first spike (2026-11-19).** The first spike (`cb1eee8`, release build on the ThinkPad emulator) mounted every equation's picture with its message. It showed the latest message fully drawn after only "Loading session…", but took 2,233 ms from the tap (the limit is 2 s), shifted the content down by one pixel about 2.1 s after showing, held the JS thread for one 1,799 ms commit while older messages filled in, and crashed about 22 s after the tap with an `OutOfMemoryError`. Each react-native-svg `SvgView` draws into its own bitmap on Android (`SvgView.java`, around line 280), and all of about 1,291 stayed mounted. The owner chose a second spike with this approach:

- Every equation's box is sized up front from MathJax's measured width, height and depth, which come with drawing it and need no view. A picture appearing or going away never moves anything.
- Only blocks on or near the screen mount their pictures. Blocks that scroll far away unmount theirs and free the views. Memory stays bounded however long the session is.
- Messages themselves stay mounted, so this is not the virtualized message list ruled out below. Only the math pictures are lazy.
- The 2 s open stays. No commit while older messages fill in may hold the JS thread over 500 ms, and the one-pixel shift is fixed.

## 2. Goals and non-goals

**Goals.**

1. Opening a session shows only "Loading session…" until the latest message is fully drawn at the bottom. Then it shows the transcript, and no frame is ever half-drawn and nothing jumps. Older messages fill in above without moving what is on screen.
2. Math is drawn natively with the quiz choices' MathJax drawing in every place `Markdown` is used: messages, question text and context, explanations, briefs, problems and the collapsed preview. No web page draws math anywhere in the phone app.
3. With VoiceOver or TalkBack, a paragraph with math is one stop. It reads as one sentence with each equation spoken inside it, never as LaTeX source and never in pieces. Links in such a paragraph stay reachable. **This replaces the earlier "each equation is one stop" decision for messages.** The owner chose this knowingly on 2026-11-19.
4. A tap on the iPhone status bar goes to the top of the session, as in T3.
5. A round "Scroll to end" button appears whenever the session is scrolled away from the end, and takes you to the end. It copies T3 (`floating-working-control.tsx:343-356`, `ThreadDetailScreen.tsx:1403-1410`) and works by touch, by screen reader and from a hardware keyboard.

**Non-goals.**

- A virtualized list like T3's. Rejected: T3's own comment says rows measured late make it jump (`ThreadFeed.tsx:4109-4111`), and the visuals spec keeps demos loaded.
- Math drawn on the server and sent as pictures. Rejected: the owner chose drawing on the phone, newest first.
- An inverted list (newest at the top of the data). Tried in #263: screen readers read it backwards.
- Math in text that is still streaming. The live tail stays plain text, as on main.
- Changing which text counts as math. The phone's reader stays as it is. Matching the web's repair of question and explanation text (`ToolContentResponse`, `components/ai-elements/message.tsx:416-422`) is a follow-up.
- Copying drawn math out of selected message text.
- A haptic tick on the button. It would need a new native module.
- Demos and figures, which belong to the visuals spec.
- Saving drawn math to disk.

## 3. Constraints

**Invariants.**

| Invariant | Where it is enforced or detected | Kind |
| --- | --- | --- |
| No frame after "Loading session…" shows blank math, a placeholder height or a half-drawn message, and once shown the visible content never moves by itself. | Proof 1 (frame-by-frame recording) | machine |
| No web page draws math in the phone app. | Proof 3 (view tree), and a unit test that rendering math markdown makes no WebView | machine |
| The quiz spec's math rules still hold for message math: AI-written math is untrusted, the same packages stay off, broken math shows its source text, nothing loads from the network, and faint colors switch to the theme's text color. Must still satisfy `docs/specs/mobile-quiz-choice-math.md` Constraints. | Unit tests, proof 3 | machine |
| Math follows the theme: Default when the phone is dark, Ivory when it is light. | Proof 3 | machine |
| Each distinct equation is drawn at most once per app run. The cache lives in memory only and has a size cap. | Unit test | machine |
| The app stays responsive while older math draws: Back responds within 500 ms, and no commit holds the JS thread over 500 ms. | Proof 2 | machine |
| Memory stays bounded however long the session is: only blocks on or near the screen hold picture views. | Proof 2 (peak memory from `adb shell dumpsys meminfo` across the long session, including scrolling to the top and back) | machine |
| A paragraph with math is one screen-reader stop with the math spoken. | Proof 4 (real TalkBack driver) | machine |
| Everything works from the keyboard (AGENTS.md), including the "Scroll to end" button. | Proof 5 | machine |
| The change is JavaScript only: the native fingerprint is unchanged, so it ships as an OTA update. | Proof 7 | machine |
| On the owner's iPhone, cs4824 test2 opens with no half-drawn frame at the latest message, the status-bar tap goes to the top, and VoiceOver reads a math paragraph as one stop. | The owner, by hand, on the first OTA update after merge. Not a merge check. A failure becomes a follow-up. Replacement verifier when one exists: an iOS Simulator run of proofs 1, 4 and 5. | human (confirmed by the owner) |

**Behavior details (owner-confirmed defaults).**

1. Short sessions and sessions without math open with no extra wait. A session shorter than the screen shows from its top.
2. Once the latest message is drawn, if landing at the end stalls, the session shows anyway after 1 s (T3's fallback, `ThreadFeed.tsx:4353-4354`).
3. "At the end" means within 100 px of the bottom, the phone's existing follow rule (`Session.tsx:208`). The button shows beyond that.
4. The button scrolls with animation, unless the phone's Reduce Motion is on (T3 `ThreadDetailScreen.tsx:1405`). There is no haptic tick.
5. A status-bar tap while older messages are still filling in lands on the oldest drawn message. The older ones then fill in above it without moving it.
6. When a reply finishes, its streamed text is replaced by drawn math in place. If the learner was at the end, the view stays at the end.
7. The equation cache lives in memory only, with a size cap. Nothing is saved to disk.
8. Wide block math scales down to fit the column, as in quiz rows, instead of scrolling sideways as on the web. This is a deliberate difference from the web, alongside the MathJax-vs-KaTeX size and spacing differences already accepted.
9. Proofs use a made-up fixture, never the owner's real session.
10. `react-native-webview` stays installed, because the visuals spec needs it.
11. Back responds within 500 ms while older math draws.
12. This build and the visuals spec's build touch the same screens. Whichever lands second rebases onto the other. Demo frames' fixed 360 px height counts as a known height.

**Removed or changed readers.**

- The web-page math path, `MathMarkdown` (`apps/mobile/src/Markdown.tsx:26-80`). Its only caller is `Markdown` (`:23`).
- `renderMarkdown` (`render-markdown.ts:50-52`), whose readers are `Markdown.tsx:51` and the HTML test at `apps/mobile/tests/client.test.ts:7` and `:123`. Remove it or keep it, with its test updated to match.
- The `react-native-webview` test mock (`tests/mocks/react-native-webview.cjs`, `tests/shared-modules-hooks.mjs:13`) stays while the package is installed.

**Stop and ask.**

- Any failure in the first task. Don't switch approaches.
- The 2 s open or the 500 ms Back response can't be met.
- Meeting a goal would need a web page for math, or a native change (a new native module or anything that changes the fingerprint).
- The full Android proof gets one fix round and one fresh re-verify (task-lifecycle's verify rule). If it still fails, stop and report.

**Left to the agent.**

- How drawing is split into batches and scheduled, newest first.
- How the transcript hides until landed and keeps the view still as content fills in above.
- The cache's shape and cap.
- How text and math lay out in a paragraph (reusing `MathLabel`'s sizing).
- Component and file layout.
- How the made-up fixture is generated.
- Test names.
- Whether to add a prove-learnharness feature recipe under `references/features` for opening and recording a session on the phone. Add it only after it has run. This spec's Proof is the answer key, and later changes re-check these flows only when their diff touches them.

## 4. Proof

**Verifies on.** The ThinkPad's Pixel 6a API 36 Android emulator, with a debug or `android-proof` APK built from the head. It is paired to a disposable LearnHarness server with the fake model, following `.claude/skills/prove-learnharness/references/features/mobile-beta.md`. The web app on the same server, in Chrome, is the visual answer key. Set up first, committed under `tests/fixtures/`:

- A made-up long session shaped like cs4824 test2: about 1,300 equations in content shown at open, about 480 different, and 234 in the last view message. It has answered quiz cards, a pending check behind "Check your understanding", and a paragraph that holds both math and a link.
- A short session.
- A session without math.
- Messages covering inline math, `$$` and `\[...\]` block math, a wide matrix, broken math, a colored command and an excluded command.

| # | Proves | Surface | Check | Where it runs | Pass signal |
| --- | --- | --- | --- | --- | --- |
| 1 | Goal 1; no-half-drawn invariant; defaults 1, 2 | Opening a session on the phone | Record the screen from the tap until 3 s after the transcript shows, for the long, short and no-math fixtures, and step through it frame by frame | Emulator | Only "Loading session…" shows until the latest message appears fully drawn at the bottom, within 2 s for the long fixture. No later frame shows blank math or moves the visible content. Short and no-math sessions show with no extra wait. |
| 2 | Goal 1 fill-in; responsiveness invariant; defaults 5, 11 | The long session just after it shows | Scroll up while older messages fill in and compare frames. Press Back during the fill and time it. On a fresh open, scroll to the top during the fill. | Emulator | The visible content stays still as content fills in above. Back responds within 500 ms. The top lands on the oldest drawn message, and older ones then fill in above it without moving it. |
| 3 | Goal 2; no-web-page, math-rules and theme invariants; default 8 | Messages, dock and collapsed preview on the phone | Screenshot each math fixture in dark (Default) and light (Ivory), next to the web's same session, and check the view tree for web views | Emulator and Chrome, same server | Every equation is drawn, with no `$` or `\` visible except broken math, which shows its source. It matches the web under the quiz spec's visual-parity rule. The wide matrix scales to fit. No WebView is in the tree. |
| 4 | Goal 3 | The long session with TalkBack on | With the real TalkBack driver from the recipe, move next-item through math paragraphs and the paragraph with a link, and capture what TalkBack speaks | Emulator | Each math paragraph is one stop, read with the math spoken and no `$` or `\`. The link in the math paragraph can be reached and opened (the external-link prompt appears). |
| 5 | Goal 5; keyboard invariant; defaults 3, 4 | "Scroll to end" button | Scroll more than 100 px up, then use the button by touch, by a TalkBack double tap and from a hardware keyboard (focus it, press Enter). Repeat with Reduce Motion (Remove animations) on. | Emulator | The button shows only when scrolled up past 100 px, and each way lands at the end. With Remove animations on, it jumps with no animation. |
| 6 | Cache, broken-math and math-rules invariants; default 6 | Unit tests | `npm test` in `apps/mobile` | CI Mobile job | All pass, including: each distinct equation is drawn once; the cache stays under its cap; a finished reply swaps streamed text for drawn math in place; no WebView is rendered for math. |
| 7 | JavaScript-only invariant; build health | CI and the PR | The Mobile job (deps:check, lint, typecheck, test, both exports), plus the native fingerprint of head compared with base, written in the PR | CI | All green, and the fingerprint is unchanged. |

Every check must pass to merge. Pass means every step shows its stated result. Anything else fails the step, and a step that can't run is a failure, not a skip.

**After deploy.** On the first OTA update that contains this change, the owner opens cs4824 test2 on the iPhone. They check three things: no half-drawn frame and it lands at the latest message, the status-bar tap goes to the top, and VoiceOver reads a math paragraph as one stop. This runs once only. A failure opens a follow-up.

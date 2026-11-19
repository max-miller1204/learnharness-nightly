# Math in mobile quiz choices

Approved by the owner on 2026-11-19 (playback confirmed, no vetoes). In the Expo phone app (`apps/mobile`), quiz and ask answer choices, and the chosen answers on an answered card, show raw LaTeX such as `No, $P\to Q$ is blocked.` The question text above them renders math. This spec makes choices draw math with MathJax as a picture, with one screen-reader stop per row. It restarts the choice-math half of closed PR #263; opening a session at the latest message is a separate spec.

T3 references are to github.com/pingdotgg/t3code at `082bc2cb7acdb12ce6d015f9709f648afaedbe01` (2026-11-18), under `apps/mobile/`. LearnHarness references are to `origin/main` at `ac63833`, checked 2026-11-19.

## 1. Starting point

**Why.** Choice labels never go through a math renderer. The row draws its label as a plain `Text` (`apps/mobile/src/BuiltinQuestion.tsx:76`), and the answered card joins the typed text, chosen labels and "other" into one plain `Text` (`apps/mobile/src/Transcript.tsx:108-117`). The app's only math renderer is a `react-native-webview` page per markdown block (`apps/mobile/src/Markdown.tsx:19-23`, KaTeX MathML output in `render-markdown.ts:5-10`). The native markdown fallback prints inline math as `$...$` source (`NativeMarkdown.tsx:55-56`). PR #263 put that web view inside each choice row. On Android, every round still exposed a focusable inner WebView inside the row, even after it was hidden on the wrapper, on the web view itself and with `aria-hidden` on its body. The deciding proof is [comment 7000122277](https://github.com/max-miller1204/learnharness-nightly/pull/263#issuecomment-7000122277) at `804acb0`. The owner closed the PR on 2026-11-19.

**Current state.**

- **Choice row.** It is a `Pressable` with `accessibilityRole="button"` and state `{disabled, selected}`, with no `accessibilityLabel` (`BuiltinQuestion.tsx:63`). The radio dot is already hidden from screen readers (`:69`). The same `Option` draws the constant "Other" row for ask questions (`:192`). Options are shuffled by `seededRandom(toolCallId)` (`:86`).
- **Web answer key.** Each option is a `<button role="radio|checkbox" aria-checked>`. Its label goes through `ToolContentResponse` (markdown and math) at `text-sm` (`components/question-dock.tsx:649-676`). `ToolContentResponse` first runs `repairMathForDisplay` (`components/ai-elements/message.tsx:419`, `src/core/math-delims.ts:119`). That recovers TeX mangled by JSON escaping, such as a `\t` swallowed from `\to`. The web answered card lists every option with marks (`components/answered-card.tsx:104-138`).
- **T3.** T3 draws its choice labels as plain text with no math (`src/features/threads/PendingUserInputCard.tsx:335`). The row is a `Pressable` with role `radio` or `checkbox` and state `{checked, disabled}` (`:312-313`). T3's math elsewhere uses the native library react-native-enriched-markdown (`package.json:130`, `:163-166`). That library makes its own math nodes focusable for screen readers (upstream 1.2.0 `MathContainerView.kt:86-88`, `TextViewSetup.kt:151`), so it carries the same risk inside a row. T3 does not settle this design.
- **MathJax probe** (Node 22, `mathjax-full` 3.2.2, 2026-11-19, in a scratch folder). TeX to SVG works in plain JS with no DOM, through the lite adaptor. A minified bundle with every TeX package is 1,819,103 bytes. The speech rule engine (`speech-rule-engine`, ClearSpeak, English) read `P\to Q` as "P right arrow Q", `\frac{1}{2}` as "one half", `\int_0^1 x^2\,dx` as "the integral from 0 to 1 of x squared d x" and `\sqrt{a^2+b^2}` as "the square root of a squared plus b squared". Its code and English rules are about 0.9 MB. `bussproofs` throws without an output that measures boxes ("requires an output jax with a getBBox() method"). Unclosed `\frac{a}{b` produced an error node.
- **Phone stack.** RN 0.88.1, Expo 58, `react-native-svg` 15.16.0 (already used by `PlanDiagram.tsx`), `katex` 0.18.2 (`apps/mobile/package.json`). `updates.enabled` is false (`app.json`), so each change ships as a new store build. The CI Mobile job runs `npm ci`, `deps:check`, lint, typecheck, test, `export:ios` and `export:android` (`.github/workflows/ci.yml:197-220`).
- **Proof environment.** The ThinkPad (env `56422c83…`) was reachable on 2026-11-19. PR #263's proofs ran there on the Pixel 6a API 36 emulator (Android 16) the same day. This machine has no Android SDK. The Mac has no simulator, so the owner checks the iPhone by hand on TestFlight. The prove skill's mobile recipe is `.claude/skills/prove-learnharness/references/features/mobile-beta.md`.
- **I could not verify these.**
  - *Does MathJax and its speech engine run under Hermes in the app?* Only Node was probed. If either does not run, the first task fails (MathJax) or speech falls back (Goal 3).
  - *Does a `react-native-svg` drawing inside an accessible `Pressable` stay out of TalkBack's navigation?* That is the premise of this design. The first task proves it.
  - *Did real TalkBack swipe navigation ever stop on PR #263's inner WebView?* Those proofs used node dumps and focus actions that may count nodes TalkBack skips, and they never drove a real swipe or read spoken output (PR #263 comments, receipts at `c3a041b` and `804acb0`). So node dumps are not a valid verifier here.
  - *Does TalkBack obey keyboard navigation sent with `adb shell input keyevent`, and log what it speaks?* Unverified. The first task proves a driver.

**First task, before any feature code.**

1. Re-probe the load-bearing facts: `BuiltinQuestion.tsx:76` and `Transcript.tsx:108-117` still draw labels as plain text, and the web option path is unchanged.
2. Spike on the ThinkPad Android emulator with a debug build. Render one choice row whose label is `No, $P\to Q$ is blocked.`, with the math drawn by MathJax as SVG through `react-native-svg`. Show all of these:
   - TalkBack, driven for real (keyboard next-item navigation plus its logged spoken output, never node dumps), stops once on the row.
   - The row reads the label with the math spoken, and no `$` or `\`.
   - A tap on the drawn math selects the row.
   - MathJax runs under Hermes.
   - Report whether the speech engine runs under Hermes. If it doesn't, that alone is not a failure (see Goal 3).
3. If any item in step 2 fails, or no real TalkBack driver works, **stop and report to the owner** with the evidence. Don't try another approach.

## 2. Goals and non-goals

**Goals.**

1. A choice label with math (`$...$`, `\(...\)`, and `$$...$$` or `\[...\]`) in a quiz or ask question shows the math drawn, not as source. Coverage is full STEM: every TeX package MathJax ships for TeX input except those excluded under Constraints.
2. On an answered card, math in the chosen answers is drawn.
3. With TalkBack or VoiceOver on, each choice row is exactly one stop. It reads the label with the math spoken by MathJax's speech engine ("No, P right arrow Q is blocked"), plus its role and checked state. If the speech engine cannot run on the phone, the math is read as symbol text ("P → Q") instead, and the PR says so. Spoken text never contains LaTeX source, except for math that failed to render.
4. A tap anywhere on a row, including on the drawn math, picks it. A screen-reader double tap picks it too.
5. On the answered card, math is never split into pieces for a screen reader. Each equation is at most one stop and is read by its spoken label.
6. Choices without math look and behave as they do on main, apart from the role change in Constraints.

**Non-goals.**

- Opening a session at the latest message and transcript scrolling: a separate spec.
- Math in question text, context, explanations and messages stays on the WebView renderer. **Deferred, owner's note (2026-11-19):** the owner wants this MathJax picture approach reused later for math in messages. That would likely also fix the session-open jumping that per-equation web views cause.
- The collapsed "Check your understanding" bar's preview, which can be its own TalkBack stop (`BuiltinQuestion.tsx:118`). It predates this work and concerns question text, not choices. Deferred.
- Markdown other than math in choices (bold, italics, code, links). These show as they do today.
- The web's answered-card layout that lists all options with marks. The phone keeps its one-line layout.
- Ask-option descriptions, which the phone doesn't show today.
- Plugin questions, which the phone hands to the browser (`apps/mobile/src/Session.tsx:201`).
- Locales other than English for spoken math.
- react-native-enriched-markdown, or anything else that adds a web view or a native math view inside a row. Rejected: it carries the same inner-focus risk (see Current state).

## 3. Constraints

**Invariants.**

| Invariant | Where it is enforced or detected | Kind |
| --- | --- | --- |
| A choice row is one screen-reader stop. Nothing inside it (math drawing, text) is reachable on its own. | Proof 3 (real TalkBack next-item navigation on the emulator) | machine |
| No WebView inside a choice row or an answered-card answer. | Unit test on the rendered choice tree, and proof 3 | machine |
| AI-written math is untrusted. These are off: `\href`, `\style`, `\class`, `\cssId`, `\require` and any other command that makes a link, sets styles or ids, or loads code. They render as plain text and do nothing. `bussproofs` is off too, because it can't run without a measuring output. The MathJax packages the web (KaTeX) doesn't support, `physics`, `setoptions` and `action`, stay off, matching the web. Every other MathJax TeX package is on. | Unit test that feeds each excluded command and checks the output has no link, no style or id hook, and loads nothing | machine |
| Math rendering loads nothing from the network at run time. | Unit test with the network stubbed to fail, and a code check that only bundled assets are used | machine |
| Broken math shows its original text, and the rest of the label still renders. | Unit test (`\frac{a}{b`) | machine |
| Labels go through the web's `repairMathForDisplay` before math is detected, the same as `ToolContentResponse`. | Unit test with a tab-mangled `\to` label, compared with the web's output for the same label | machine |
| The answer sent to the server is unchanged: same values, labels and "other" text as main. | Unit test on the submit payload for a math label | machine |
| Choice rows never change height after their first layout. Math is measured before it is drawn, so there is no late growth like PR #263's 31 px shift. | Proof 6 (recording of the dock as a quiz arrives) | machine |
| Math in choices is 14 px on a 20 px line (the web's `text-sm`), scales with the phone's text size, and uses the row's text color in dark and light themes. | Proofs 1 and 7 | machine |
| Block math (`$$...$$`) in a label sits on its own line inside the row with no scroll box. The row is still one stop. | Proofs 1 and 3, fixture choice with block math | machine |
| The row is announced as a radio button (single-select) or checkbox (multi-select), with checked and disabled state. This follows T3 (`PendingUserInputCard.tsx:312-313`) and the web (`question-dock.tsx:652-653`). It replaces today's `button` with `selected`. | Proof 3 spoken output | machine |
| Typed answers and the "Other" text stay plain text and never go through the math parser. | Unit test | machine |
| The math addition grows the app's JS bundle by at most 5 MB (`export:android` bundle size, head minus base). | Size diff in the PR | machine |
| On the owner's iPhone with VoiceOver, each choice row is one stop that reads spoken math, and a double tap or a tap on the math picks it. | The owner, by hand, on the next TestFlight build after merge. Not a merge check. A failure becomes a follow-up. Replacement verifier when one exists: an iOS Simulator run of proof 3 with VoiceOver. | human (confirmed by the owner) |

**Stop and ask.**

- Any failure in the first task: stop and report to the owner. Don't switch approaches.
- The full Android proof gets one fix round and one fresh re-verify (task-lifecycle's verify rule). If it still fails, stop and report. No extra rounds.
- The bundle would grow by more than 5 MB, or full coverage needs a package these rules exclude: stop and ask.
- Meeting a goal would mean a web view or native math view inside a row: stop and ask.

**Left to the agent.** The MathJax version (3 or 4), how the speech engine and its English rules are bundled and loaded, how text and math lay out in a row, component and file layout, and test file names.

**Promote on merge.** Add the TalkBack choice-row check (proof 3, with its real-TalkBack driver from the first task) to `.claude/skills/prove-learnharness/references/features/mobile-beta.md` in the same PR, so later phone changes rerun it. The repo has no numbered invariants list or ADR folder to add to.

## 4. Proof

**Verifies on:** the ThinkPad's Pixel 6a API 36 Android emulator, with a debug or `android-proof` APK built from the head. It is paired to a disposable LearnHarness server with a fake model, following the mobile recipe. The web app on the same server, in Chrome, is the visual answer key. Set up first: a seeded fixture session with a pending quiz and a pending multi-select ask question, plus answered cards. Its labels cover plain text, `No, $P\to Q$ is blocked.`, a fraction, `\ce{H2O}`, a matrix, `\[...\]` or `$$` block math, `\(...\)`, broken math and an excluded command. Base and head use the same `toolCallId`s, so the shuffle matches. Also set up first: the real TalkBack driver proven in the first task.

| # | Proves | Surface | Check | Where it runs | Pass signal |
| --- | --- | --- | --- | --- | --- |
| 1 | Goals 1, 6; size, color and block-math invariants | Quiz dock on the phone | Screenshot each fixture question in dark mode (web Default) and light mode (web Ivory), next to the web's same question | Emulator and Chrome, same server | Every math label is drawn with no `$` or `\` visible. Size, color and line placement match the web. Block math sits on its own line. Broken math shows its source text. |
| 2 | Goal 4 | Quiz dock | Tap the center of the drawn math in each math choice, then submit | Emulator | Each tap selects that row. The saved answer on the server equals the chosen option. |
| 3 | Goals 3, 4; one-stop, role and state invariants | Quiz dock with TalkBack on | From the question, move next-item through every row with the real driver and capture TalkBack's spoken output. Double tap one row. Repeat on the multi-select ask question. | Emulator | Exactly one TalkBack focus stop per row, in order, with no stop between rows. Android's standard usage hint ("Double-tap to toggle") may follow a row as its own utterance. Each row's utterance has the label with math spoken, no `$` or `\`, "radio button" or "checkbox", and checked state. The double tap selects the row. |
| 4 | Goals 2, 5 | Answered card | Screenshot it, then move through it with TalkBack and capture spoken output | Emulator and Chrome | The chosen answers' math is drawn. Each equation is read once, spoken, never in pieces or as source. |
| 5 | Goal 6 | Plain-label quiz | Screenshot the plain-label fixture on base (`ac63833`) and on head | Emulator | Pixel-identical. |
| 6 | No height change | Quiz dock arriving | Record the screen from before the quiz appears until 2 s after, and measure each row's bounds per frame | Emulator | No row's height changes after its first frame. |
| 7 | Font-scale invariant | Quiz dock | Set the system font scale to 1.3 and screenshot | Emulator | Math and text grow together. Nothing is clipped or overlaps. |
| 8 | Untrusted-input, network, broken-math, repair, payload and plain-"Other" invariants | Unit tests | `npm test` in `apps/mobile` | CI Mobile job | All pass. |
| 9 | Build health and bundle cap | CI | The Mobile job (deps:check, lint, typecheck, test, both exports), plus the bundle size diff in the PR | CI | All green. The bundle grows by 5 MB or less. |

Every check must pass to merge. Pass means every step shows its stated result; anything else fails the step. A step that can't run is a failure, not a skip.

**After deploy.** The owner runs the iPhone VoiceOver check from Constraints on the first TestFlight build that contains this change. It stops after that one build. A failure opens a follow-up.

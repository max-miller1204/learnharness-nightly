# iPhone check in CI

Approved by the owner on 2026-11-19 (playback confirmed, no vetoes). A new required CI job runs the phone app (`apps/mobile`) on an iOS Simulator on GitHub's Macs for every phone PR. It drives a few key screens against a throwaway server, takes iPhone and web screenshots side by side, and fails on mechanical problems. The prove-it checker judges how the screens look.

## 1. Starting point

**Why.** iPhone-only rendering bugs reach the owner untested because no automated check ever runs the app on iOS. The CI `Mobile` job only runs `npm ci`, `deps:check`, the update-config and fingerprint checks, lint, typecheck, unit tests and the two `expo export` bundles (`.github/workflows/ci.yml:196-229`, read 2026-11-19). Device proofs run by hand on the ThinkPad's Android emulator, and the iPhone is checked only by the owner on TestFlight (`docs/specs/mobile-quiz-choice-math.md:18,78`). The owner's Mac has 8 GB and can't run a simulator. Example: PR #277 (`4a66ecd7`) drew choice math natively, its iOS line-height path was never run before merge, and on the iPhone the drawn digits in an answered card sit on the wrong baseline. The owner has since reported two more iPhone bugs, listed under Goal 3.

**Current state** (all checked 2026-11-19):

- **T3 Code** (clone at `3ce21458`, 2026-11-18) has no iPhone check on pull requests. Its simulator work runs on paid Blacksmith `macos-27` runners:
  - `mobile-dev-client.yml:220-315` builds a Debug simulator app on pushes to main, on demand, and on PRs that touch that workflow. `scripts/mobile-native-client.ts:722-766` runs `expo prebuild --clean`, `pod install` and `xcodebuild ... -configuration Debug -destination "generic/platform=iOS Simulator" ARCHS=arm64`, with no signing.
  - `mobile-showcase-screenshots.yml:45-106` is a manual button that takes App Store screenshots. It installs AXe (`:79-88`) and `agent-device` (`:90-91`) and starts seeded fixture servers. `scripts/mobile-showcase.ts` runs Metro (`:741`), launches with `simctl launch` (`:1173-1191`) and captures with `simctl io ... screenshot` (`:1226-1232`). Nothing compares its pictures to an answer key.
  - T3 reaches each scene through launch arguments and a scene file the app reads (`mobile-showcase.ts:1162-1191`). This spec does not copy that (see Non-goals).
  - The owner chose a blocking PR check knowing it goes further than T3.
- **GitHub runner images** (`actions/runner-images`, image readmes 20261102 and 20261104):
  - `macos-26` / `macos-latest` has Xcode 26.0.1 to 26.6 (default 26.6) and iOS 26.2 to 26.5 simulators.
  - `xcode-27` (macOS 27.0.1) has Xcode 27.0, 27.1 (default) and 27.2. Its iOS 27.0 and 27.2 runtimes include an iPhone 17. Issue #14404, "Xcode 27 is now available as a public preview", is still open and warns of "queueing issues". The `-xlarge` labels are larger, paid runners.
  - The repo is public (`gh repo view`), so standard GitHub-hosted runners cost nothing.
- **Expo SDK 58** builds iOS on EAS with Xcode 27.1 (`docs/specs/mobile-auto-updates.md:23`; Expo's SDK 58 upgrade guide, https://expo.dev/blog/how-to-upgrade-to-sdk-58). **I could not verify** whether SDK 58 also builds with Xcode 26.x. That doesn't matter, because this job uses Xcode 27.1.
- **Runner capacity.** macOS arm64 jobs sometimes are never given a runner. `ci-runner-retry.yml` re-runs such a CI run up to 3 times when the "was not acquired by Runner of type hosted" annotation is present (`.github/scripts/ci-runner-retry.cjs:23`, `docs/specs/ci-runner-retry.md`). Capacity ran out on 2026-11-17 and 18. **I could not verify** that the `xcode-27` queue's cancels carry the same annotation. If they don't, a no-runner cancel fails `Check` with no automatic re-run.
- **Time.** `Standalone (mac-arm64)` builds the production server on `macos-15` in 4 to 5 minutes (CI runs on main, 2026-11-19). **I could not verify** how long a cold iOS Debug build takes on a standard `xcode-27` runner.
- **The app accepts only `https://` servers** (`apps/mobile/src/protocol.ts:6-15`). A committed throwaway certificate exists at `tests/fixtures/security-tls/`.
- **The prove scripts are Linux-only** in places: `flock` and `setsid` in `.claude/skills/prove-learnharness/scripts/start.sh:28,43,58` and `env -C` at `:58`. They won't run as is on a macOS runner.
- **Fixtures.** `scripts/fake-model.mjs` plays scenario files (`.claude/skills/prove-learnharness/references/agent.md`). `tests/fixtures/mobile-lesson/` is a synthetic teaching record. PR #277 committed no quiz-math fixture.
- **Updates.** `app.json` turns expo-updates on, with `checkAutomatically: ON_LOAD` against the production update URL. A release-style simulator build could load main's published update instead of the PR's code. A Debug build loads its code from Metro.
- **Screen reader.** AXe's `describe-ui` lists the simulator's accessibility items (label, frame, state). **I could not verify** that real VoiceOver speech runs in the simulator, so it is not used.

**First task, before any code.** Re-probe the load-bearing facts above. On a scratch branch, run one `xcode-27` job that does a cold Debug simulator build of `apps/mobile` with Xcode 27.1, boots an iPhone 17 on the newest iOS 27 runtime, and opens the app against Metro. Record the build time and total time. If the build fails on that image, or a cold run cannot fit the 60-minute limit, stop and report.

## 2. Goals and non-goals

**Goals**

1. A CI job named `iPhone` runs whenever the existing `Mobile` job's gate is on (`changes.outputs.mobile`), and also whenever its own fixtures or scripts change. It is in `Check`'s `needs`, so a phone PR can't merge unless it passes. On a push to main, where every other job runs, it runs only when the merge touches the same paths (owner, 2026-11-20), so unrelated merges and the nightly don't wait on it; `Check` passes with it skipped through its gate. Manual runs run it.
2. The job builds the app for the iOS Simulator with no signing and no secrets, and starts a throwaway LearnHarness server on the same runner. The server uses the fake model, made-up fixtures only, and HTTPS with a throwaway certificate trusted only inside that simulator. The job pairs the app through the Pair screen with real input, the way a user does.
3. It screenshots these screens on the iPhone, in light and dark mode, and the same screens in the web app on the same server:
   - the Pair screen;
   - the session list;
   - the lesson fixture session (`tests/fixtures/mobile-lesson/`);
   - a new made-up quiz session, both waiting and answered.

   The quiz fixture must show the owner's three reported iPhone bugs:
   - math in an answered card's chosen answers, such as `Train: $4$; test: $8$` and `$(+0.20, -0.10)$`;
   - message or explanation math where a sentence ends in inline math followed by a period, and expressions like `0.1(-1)(-2)`;
   - a two-column markdown table with a short bold first column and a long second column.
4. The job fails when any of these happens: the app doesn't open; a listed screen isn't reached; an error or crash screen shows; a quiz choice row is not exactly one accessibility item; or a row's label shows `$` or `\` instead of spoken math.
5. The job uploads the iPhone and web screenshots side by side as a run artifact, and lists them in the job summary.
6. The prove-it mobile recipe has an iPhone step. For any phone PR, the fresh checker downloads that artifact and judges each iPhone screen against the web screen, under the recipe's existing visual-parity rule. A visible difference that phone layout doesn't explain is BROKEN.

**Non-goals**

- Fixing the three iPhone bugs. This spec only makes them visible; each fix is its own change.
- Saved answer-key pictures with pixel diffs. They only show "same as before", and today's baseline bug would have become the answer key.
- An AI judge or any model key inside CI. CI jobs run PR code, and the owner's rule keeps secrets out of them.
- Real VoiceOver speech. The owner's TestFlight VoiceOver hand check (`docs/specs/mobile-quiz-choice-math.md:78,111`) stays.
- Android, iPad, landscape, larger text sizes or more screens in this job. These are deferred, and the owner can extend the job.
- Hidden test switches or launch arguments in the app, which T3 uses to jump to scenes. The job drives the real UI, with one exception the owner chose on 2026-11-20: tapping a session row to open it. AXe's touches never reach rows inside `@react-native-menu`'s long-press MenuView on the iOS Simulator (every touch from 0.01 s to 0.3 s, at the title, centre and edge, also with the app's tap guard bypassed), while a real iPhone opens them with a tap, and AXe can neither press an element through accessibility nor run its custom actions. So only the job's Metro bundles with `EXPO_PUBLIC_CI_OPEN_SESSIONS`, and each new connection opens the next listed session (`apps/mobile/src/workspace-view.ts`). Expo inlines the variable at bundle time, so release and update bundles, which never set it, carry an empty list, and the native fingerprint is unchanged. A test checks the option is inert when unset. The job reaches the session list with the Sessions back button and the second session by reopening the server.
- Building on Expo (EAS), or a release-style build with its embedded bundle and live updates.
- Running on paid or larger runners.

## 3. Constraints

**Invariants**

| Invariant | Where enforced or detected | Kind |
|---|---|---|
| The job holds no secrets: no Expo, Apple, model or deploy keys, and `permissions: contents: read`. | The workflow file, and a CI script test that fails if the job references `secrets.` | machine |
| The screenshots show this PR's code, never a published update. | Debug build with code served from the job's own Metro. The job fails if Metro did not serve the bundle the simulator launched. | machine |
| Only made-up data reaches the server: the repo's fixtures, the fake model and a throwaway HOME and data folder. | The job's server setup; fixtures live in the repo and are reviewed in the PR. | machine |
| The throwaway certificate is trusted only inside the job's simulator, which is discarded with the runner. | The job's setup step | machine |
| The job fails and never silently skips. A missing screen, tool or fixture fails the step. Skipping is allowed only through the `changes` gate. | `Check`'s existing skip rule (`ci.yml:248-252`) and the job's own steps | machine |
| A change to the job's fixtures or scripts runs the job. | `.github/scripts/ci-changes.cjs` and its test | machine |
| The PR never shows the owner as checked by CI on iPhone VoiceOver. The hand check stays. | The prove-it recipe text | human (confirmed by the owner) |

**Stop and ask**

- The first task shows the app can't build on the `xcode-27` image, or a cold run can't fit 60 minutes.
- Reaching a listed screen would need a change to app code.
- The `xcode-27` image loses Xcode 27.1, or the runner-retry script doesn't recognise its no-runner cancels.

**Left to the agent:** file and script names, script language, caching (Pods, derived data, npm), how the job reaches each screen, how it starts the server and web screenshots on macOS (the prove scripts need portable equivalents for `flock`, `setsid` and `env -C`), where the new fixtures live (within the gate rule above), and the artifact layout.

**Defaults the owner accepted**

1. Build like T3: a Debug simulator build with `xcodebuild` (`mobile-native-client.ts:742-760`), with code served by Metro.
2. Runner `xcode-27`, with Xcode 27.1 chosen explicitly (the version EAS uses for SDK 58), and an iPhone 17 on the newest iOS 27 runtime that Xcode runs.
3. A 60-minute job time limit, as on T3's iOS dev-client job (`mobile-dev-client.yml:222-223`).
4. Artifacts are kept 14 days, as T3 keeps its screenshots (`mobile-showcase-screenshots.yml:106`).
5. Taps, typing and the accessibility item list use AXe (T3 installs it at `mobile-showcase-screenshots.yml:79-88`).
6. The iPhone step goes into the prove-it mobile recipe in the same PR.

**Stopping rules.** The job has a 60-minute timeout and makes no retries of its own. No-runner cancels go through `ci-runner-retry.yml`, which allows at most 3 automatic re-runs per CI run (`docs/specs/ci-runner-retry.md`). After that, the PR waits for a manual re-run. Rebooting the simulator at most twice before the first screen read is setup, not a retry (owner, 2026-11-20): AXe cannot read a simulator whose screens never settle until it reboots. The job logs each reboot and never reboots once the drive has started.

**Promote on merge.** In the same PR, add the iPhone step to `.claude/skills/prove-learnharness/references/features/mobile-beta.md`. Update the "Planned surfaces" line in `.claude/skills/prove-learnharness/SKILL.md:192` so it names the iPhone CI job as the iOS surface. The repo has no numbered invariants list or ADR folder to add to.

## 4. Proof

**Verifies on:** GitHub Actions `xcode-27` standard runners, on a scratch branch and on the PR itself. The answer key for how the screens look is the web app on the same throwaway server. To set up first: the new quiz fixture, and the first task's timing run.

| # | Proves | Surface | Check | Where it runs | Pass signal |
|---|---|---|---|---|---|
| 1 | Goals 1, 2, 3, 5 | The `iPhone` job and its artifact | Open the PR's own run. | CI on the PR | The job passes inside `Check`. The artifact has an iPhone and a web picture of every listed screen in light and dark mode. The summary lists them. |
| 2 | Goals 3, 6 (the check catches real bugs) | The artifact's screenshots | Run the job on a scratch branch at `133ebf2c` plus only the new job, scripts and fixtures. Give a fresh agent only those pictures and the visual-parity rule. | CI, then a fresh agent | The agent reports all three reported bugs: the answered-card baseline, the sentence-ending math and `0.1(-1)(-2)`, and the bold table. |
| 3 | Goal 4 (crash) | The `iPhone` job | On a scratch branch, make one listed screen throw on render. | CI | The job fails and names that screen. |
| 4 | Goal 4 (choice row) | The `iPhone` job | On a scratch branch, split one quiz choice row into two accessibility items, and separately show a row's raw `$` label. | CI | The job fails on each, naming the row. |
| 5 | No-secrets invariant | The workflow file | The CI script test | CI `Lint` job | Passes as is, and fails when a `secrets.` reference is added to the job. |
| 6 | Gate invariant | `ci-changes.cjs` | Its unit test, with a fixture-only and a script-only change. | CI `Lint` job | Both turn the gate on. A docs-only change leaves it off, and `Check` passes with the job skipped. |

Every check must pass to merge. Pass means every step shows its stated result; anything else fails the step.

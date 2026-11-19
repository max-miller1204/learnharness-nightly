# Mobile auto updates

Approved by the owner on 2026-11-19. The phone app gets over-the-air (OTA) updates from `expo-updates`, and a GitHub workflow publishes them when main changes phone or shared client code. A new TestFlight build is made only when the app's native fingerprint changes, or when the newest build gets close to TestFlight's 90-day expiry. Reference: T3 Code at [pingdotgg/t3code `c4dc9ed`](https://github.com/pingdotgg/t3code/tree/c4dc9ed55b35267a40857aa27525c520bf913342) (2026-11-18), the "whatever T3 does" rule.

## 1. Starting point

**Why.** Every phone change, even a one-line text fix, needs a hand-run `eas build --profile beta --platform ios --auto-submit` from the owner's Mac. The app ships with updates switched off, and the runbook says every beta update is a fresh store build. The Mac's Apple ID login now fails with a Keychain error, so even the manual path is broken. The root cause is that no OTA path exists and nothing but a person starts a build.

**Current state** (all checked 2026-11-19):

- `apps/mobile/app.json:10` has `"updates": { "enabled": false }` and no `runtimeVersion`. The Expo project ID is `5e837ebd-6337-4a8b-9cfa-3d181424fe40` under `max-miller1204s-team`. `ITSAppUsesNonExemptEncryption` is already false.
- `apps/mobile/eas.json`: `appVersionSource: remote`, so build numbers come from Expo. The `beta` profile has `autoIncrement` and no `channel`. The `beta` submit profile has only an Android track: no iOS `ascAppId` and no API key.
- `apps/mobile/package.json`: Expo 58.0.26, React Native 0.88.1, npm with its own lockfile, no `expo-updates`.
- The phone bundle reads `apps/mobile/**`, `src/client-protocol/`, `src/core/`, `build/icon.png` and `public/fonts/cmunbx.ttf`. Metro resolves shared source from the mobile `node_modules` (`apps/mobile/metro.config.js`), so the root `package.json` doesn't change the bundle. CI's `MOBILE_SHARED` (`.github/scripts/ci-changes.cjs`) is wider on purpose: it also re-runs mobile checks on `.github/` and root dependency changes.
- Phone and server must match `CLIENT_PROTOCOL_VERSION` exactly (`src/client-protocol/index.ts:39`, `:93`). The phone shows a too-old message on mismatch.
- The repo is public (`gh repo view`). Main requires only the `Check` status, with no reviews required.
- Repo secrets: `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` (added 2026-11-18). There is no Expo token yet. That key is a Team key with the **Developer** role (`docs/electron-nightly-signing.md:15`). Apple's [upload builds help](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds) says: "Required role: Account Holder, Admin, App Manager, or Developer."
- [Expo's role docs](https://docs.expo.dev/app-signing/apple-developer-program-roles-and-permissions/) say that when signing credentials are already stored on Expo, a build uses them with no Apple login. Creating new ones needs Account Holder or Admin.
- [Expo Submit for iOS](https://docs.expo.dev/submit/ios/): non-interactive submit needs an App Store Connect API key, either assigned in `eas credentials` or given as `ascApiKeyPath`, `ascApiKeyIssuerId` and `ascApiKeyId` in eas.json, plus `ascAppId` in the submit profile.
- Expo Free plan ([pricing](https://expo.dev/pricing), [billing FAQ](https://docs.expo.dev/billing/faq/)): "Up to 15 Android and 15 iOS builds", with one macOS build at a time, a low-priority queue and a 45-minute timeout. Once the quota is used, builds stop until the first day of the next calendar month, with no overage charge. Update covers 1,000 MAU, 100 GiB bandwidth and 20 GiB storage, with "no update overage pricing". Submit is included.
- [Expo's build images](https://docs.expo.dev/build-reference/infrastructure/) map `sdk-58` to `macos-tahoe-26.6-xcode-27.1`. GitHub-hosted runners offer Xcode 27 only as a preview image (actions/runner-images `xcode-27-arm64-Readme.md`). This is why builds run on Expo, not on GitHub's Macs.
- A TestFlight build expires 90 days after upload (`apps/mobile/README.md`, "TestFlight expiration").
- eas-cli 27.10.0 has `fingerprint:generate`, `fingerprint:compare`, `update:insights` (launches, crashes and unique users per update group) and `update:republish`.
- T3's design (`.github/workflows/mobile-eas-production.yml`): it runs on pushes to main with a path filter (`:58-70`). Runs are serialized (`:77-82`), and it refuses OTAs from a fingerprint that hashes no Expo native modules (`:292-313`). Per target it computes the fingerprint and publishes `eas update --channel production` when a finished build with that fingerprint exists, and otherwise builds and submits (`:338-439`). An errored build fails the run and is retried by hand (`:401-406`). A manual `workflow_dispatch` covers build and update (`:23-57`). Builds and OTAs come only from CI, never a laptop (`:3-7`). In the app it uses the `fingerprint` runtime policy (`apps/mobile/app.config.ts:15-17`, `:241-244`) and `updates` with `checkAutomatically: "ON_LOAD"` and `fallbackToCacheTimeout: 0` (`:248-253`), on one `production` channel (`apps/mobile/eas.json:73`). This spec differs on purpose in two places: builds run on Expo's servers, not T3's paid Blacksmith Macs (`:554`), and there is a 75-day refresh, because T3's iOS production ships through the App Store.
- **I could not verify** (no Expo login on this machine) that Expo still stores the iPhone distribution certificate and profile, that the existing key works for Expo's submit, or that the fingerprint Expo's macOS builder embeds equals the one the Linux runner computes. T3 notes that a laptop's fingerprint differed (`:4-6`), and this repo uses npm, not T3's pinned pnpm. If any of these is false, builds fail or OTAs never reach the phone. Until they are probed, nothing may be published.

**First task, before any code:**

1. The owner creates a limited Expo access token (Limit access, team `max-miller1204s-team`, role Developer) and adds it as the `EXPO_TOKEN` repository secret. Secrets never go in chat or git.
2. Find the app's App Store Connect Apple ID (`ascAppId`). It is not secret.
3. Re-probe, from CI using the button's `check` mode or a one-off run, and stop and report if any fails: Expo holds valid iOS distribution credentials for `com.maxmiller.learnharness.nightly`, the limited token can list builds and updates for the project, and the last finished iOS builds and their fingerprints are readable.
4. The first real build is itself the probe for the fingerprint and the submit key (After deploy A1). If its embedded fingerprint differs from the CI-computed one, or the upload is refused, stop and report.

## 2. Goals and non-goals

**Goals**

1. A merge to main that changes phone or shared client code publishes an OTA on channel `production` for iOS, when a finished TestFlight build with the same fingerprint exists. Without one, nothing is published.
2. The owner's iPhone, on that build, runs the update after opening the app twice. The first launch downloads it and the next launch uses it.
3. A merge that changes the iOS fingerprint automatically starts one build on Expo's servers with the `beta` profile and sends it to TestFlight. No one presses anything.
4. Every Monday, if the newest finished `beta` iOS build is more than 75 days old and none is in progress, the workflow builds and sends a fresh one from main.
5. A GitHub **Run workflow** button offers `build` (retry or force a build), `update` (publish an OTA now) and `check` (read-only: print the newest build, the newest update, their fingerprints and the update's launch records).
6. The mobile README's release section describes this flow and no longer says every update needs a fresh store build.

**Non-goals**

- Android and Google Play: iOS only for now.
- A nightly, preview or PR channel, and PR preview updates: the owner decided on one production channel.
- App Store release: TestFlight only.
- Holding back an OTA that bumps the protocol until the server updates: the existing protocol check and its too-old message cover it (owner decision).
- Builds on GitHub's Macs with `eas build --local`, as T3 does: owner decision, because Xcode 27 is a GitHub preview and recording local builds needs extra machinery.
- A paid Expo plan or overage of any kind.
- A version or update line in the app's Settings, an in-app "update now" prompt, push notifications, source-map upload, and T3's native-change PR label.
- Builds started from a laptop, including the owner's Mac.
- Changing the Apple key or creating a new one: the owner chose to reuse it.

## 3. Constraints

**Invariants**

| Invariant | Enforced or detected | Kind |
| --- | --- | --- |
| Only this workflow, running on main, starts phone builds or publishes phone updates. | The workflow never runs on `pull_request`. The button refuses refs other than main. The README rule. | Machine (trigger and ref check); README rule human |
| An OTA is published only for a fingerprint that has a finished TestFlight build. | The workflow's build-or-update decision | Machine |
| No OTA is published when the fingerprint hashes no Expo native modules (T3 `:292-313`). | Workflow step before publishing | Machine |
| At most one automatic build attempt per fingerprint. An errored build fails the run and is not retried automatically. | Decision logic, from Expo's build records | Machine |
| A finished build whose recorded fingerprint differs from the CI-computed fingerprint for its own commit fails the run, and nothing is built. | Decision logic | Machine |
| Runs are serialized in merge order and never cancel each other (T3 `:77-82`). | Workflow concurrency group | Machine |
| A missing `EXPO_TOKEN` fails the run (unlike T3, which skips quietly). | First workflow step | Machine |
| The updates URL, the `fingerprint` runtime policy and the `production` channel on the `beta` profile stay set. | Pre-merge config check (Proof P2) | Machine |

**Credentials and permissions**

| Actor | Holds | Can |
| --- | --- | --- |
| The mobile release workflow (push to main, Monday schedule, button) | `EXPO_TOKEN` (limited: Developer on the team) and the Apple key trio | Build iOS on Expo, submit to TestFlight, publish and republish updates on `production`, read build and update records. It also runs `npm ci` and dependency scripts with these secrets present, like T3. The owner accepted this on 2026-11-19. Packages install only from the committed lockfile. |
| Expo's servers | A copy of the Apple key during submission | Upload builds to App Store Connect. The owner accepted this. |
| The owner | Creates and rotates both credentials and adds the GitHub secrets | Press the button in any mode, and install from TestFlight |
| Agents | No Expo or Apple secret | Press the button in `check` mode only, unless the owner asks for `build` or `update` |
| Pull request workflows | Nothing from this workflow | Run the pre-merge checks only |

If either credential leaks, the owner deletes and remakes it. Renewing the yearly distribution certificate stays a manual owner task with an Admin-level login. A build that fails on it stops (see Stop and ask).

**Entrypoints**

- **Push to main** that touches `apps/mobile/**`, `src/client-protocol/**`, `src/core/**`, `build/icon.png`, `public/fonts/cmunbx.ttf` or the workflow file. The decision for a run:
  - JS-only merge, finished build with fingerprint F: publish an OTA for F.
  - New fingerprint G with no build: start one build for G and don't wait for it. OTAs for G resume on the first merge after it finishes, so changes merged during the build arrive with that next merge (T3 `:412-416`).
  - A build for G is in progress: publish nothing and start no build.
  - A build for G errored: fail the run, start no build, and retry with the button.
  - The build quota is used up: the build request fails, so the run fails. A later merge or the button tries again, and Expo refuses at no charge until the 1st of the month.
- **Monday schedule.** It reads the newest finished `beta` iOS build. If that build is 76 or more days old and none is in progress, it builds and submits from main HEAD. At exactly 75 days it does nothing. The weekly step keeps every build under 83 days old. GitHub pauses schedules on a public repo after 60 days with no repo activity. This is a known gap the owner accepted.
- **Button (`workflow_dispatch`).** Modes `build`, `update` and `check`. It refuses any ref but main. `build` always builds, even for a fingerprint that already has a build or errored. `update` publishes only under the same fingerprint rule. `check` changes nothing.
- **Single owners of irreversible effects.** The decision step owns starting a build: a TestFlight upload, a burned build number and a quota build. The publish step owns writing to the `production` channel. Expo's remote auto-increment owns build numbers.

**Ordering and cutover**

1. The owner adds `EXPO_TOKEN`. The Apple secrets already exist.
2. The PR merges with `expo-updates`, the runtime policy, the channel, the iOS submit profile, the workflow and the doc changes. If it merges without the token, the first run fails loudly and nothing is published.
3. Adding `expo-updates` changes the fingerprint, so the first run starts a build and sends it to TestFlight. The current TestFlight build has updates off and never receives an OTA.
4. The owner installs the new build from TestFlight once.
5. The next phone change arrives as an OTA.

Rollback: revert the PR. With the workflow gone nothing more is published, and the installed build keeps working with its last update. A bad update is fixed by reverting the change on main, which publishes the old code as a new update. Expo's `update:republish` remains available to the owner.

**Stop and ask**

Halt and report when: a first-task probe fails; Expo has no valid iOS credentials, or they need creating or renewing; the submit key is refused; the fingerprint embedded in a build differs from the CI-computed one; a change would need a paid Expo feature, a second channel, Android publishing, or a new credential; or `expo-updates` needs a native change beyond its own module and config.

**Left to the agent:** file and workflow names, script layout and language (a tested `.cjs` decision script like `ci-changes.cjs` fits the repo), how build and update records are queried, the eas-cli version pin, how the Apple key file is written for submit, run summary and update message text, and the Monday hour.

**Docs to change** (each reader of the old rule):

- `apps/mobile/README.md:26`: "Every beta update uses fresh store builds." and the hand-run release commands. Replace them with the CI flow, the button, and "never build from a laptop".
- `apps/mobile/README.md:32`: the day-75 proposal "pending approval" is now decided as the Monday refresh.
- `docs/specs/mobile-beta.md:11`: "Push notifications and OTA updates are outside beta 1." Point OTA to this spec.
- `docs/specs/mobile-beta.md:27`: "Beta updates are fresh signed binaries." Replace it with OTA plus fingerprint builds.

**Promote on merge:** add to the mobile README's release section, as a lasting rule: phone builds and updates come only from the mobile release workflow on main, never a laptop. The project has no invariant IDs or ADR folder, so the README holds it.

## 4. Proof

**Verifies on:** GitHub Actions (PR CI for P1 to P3; the live workflow on main for the After deploy list), Expo's build and update records read by the button's `check` mode, and the owner's iPhone on TestFlight. There is no iOS Simulator: the Mac has 8 GB. The owner's part is only opening the app. Expo's launch records give the pass or fail.

| # | Proves | Surface | Check | Runs | Pass signal |
| --- | --- | --- | --- | --- | --- |
| P1 | Goals 1, 3, 4 and the build invariants | The workflow's build-or-update decision | Unit tests over fixture build lists: JS-only gives update; new fingerprint gives one build; in progress gives nothing; errored fails with no build; a mismatched finished build fails with no build; 76 days gives a refresh build; 75 days gives nothing; `build` mode forces; a non-main ref is refused; a missing token fails. | PR CI (`node --test .github/scripts/*.test.cjs` in Lint) | Every case gives its stated result |
| P2 | Config invariant | `npx expo config --type public --json` and `eas.json` | `updates.enabled` is true, the URL is `u.expo.dev/5e837ebd-…`, `runtimeVersion.policy` is `fingerprint`, the `beta` build has `channel: production`, and the `beta` submit has iOS `ascAppId` and the key fields. | PR CI, Mobile job | All present |
| P3 | Fingerprint guard | An offline fingerprint of `apps/mobile` | It hashes at least one Expo native module source for iOS. | PR CI, Mobile job | Count is above 0 |
| P4 | Nothing else broke | The existing Mobile job | Install, deps check, lint, typecheck, tests, iOS and Android exports | PR CI | Required `Check` green |

**After deploy** (owner decision; it stops after A2 passes once):

- **A1. Bootstrap build.** The first main run starts one iOS build for the new fingerprint F. It finishes and its submission to TestFlight succeeds. `check` shows the build's recorded fingerprint equals F (`fingerprint:compare`). The build appears in the owner's TestFlight app. If it doesn't appear on its own, stop and report: TestFlight group distribution is a setup step outside this spec.
- **A2. First OTA reaches the iPhone.** After the owner installs that build, the next merged phone change produces a run whose summary says it published an OTA for F. `check` shows that update group's runtime version equals the newest build's. After the owner opens the app twice, `update:insights` for that group shows at least one iOS launch and zero crashes. Anything else fails.

Every check in the table must pass to merge. Pass means every step shows its stated result. Anything else fails the step, and no check may skip silently.

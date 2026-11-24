---
name: verify-learnharness
description: Prove a change to LearnHarness works in the running app, the way a learner would see it, with e2e (e2e.config.ts, tests/e2e/). Boots an isolated instance with a scripted fake model, checks it is worth driving, drives the flows the change touches (scripted tests or live over `npx e2e mcp`), keeps the evidence and bug bashes it. Use on your own after any change to app/, components/, lib/, public/, src/, plugins/, next.config.ts, proxy.ts or package.json, before saying it is done or merging a PR; also when asked to verify, test in the real app, check a UI change, reproduce a bug, or QA a branch.
---

# Verify LearnHarness

Proof means you watched the running app do the thing. Tests passing, code
reading well or a build succeeding is not proof.

## Read first

The `e2e` skill (`.agents/skills/e2e/`, or `npx e2e guide <topic>`) is the
reference for everything e2e does; this skill only says how it applies here.
It drives `e2e.config.ts` and the tests under `tests/e2e/**/*.e2e.ts`. The
node unit tests (`npm test`, `tests/*.test.ts`) are a separate suite.

## Launch

You never start the app by hand. The config's `app.command` runs
`node tests/e2e/support/serve.ts {port}` on a free port (`127.0.0.1:0`), so
every run, and every worktree, gets its own app. It:

- wipes and creates `$TMPDIR/learnharness-e2e/<port>/` with a throwaway HOME,
  data folder and key store. Your real `data/` and `auth.json` are never read.
  It lives outside the checkout because `next dev` reloads the page when a
  file under the checkout changes.
- runs no provider key (`LH_IGNORE_ENV_KEYS=1`), and sets every variable that
  could point it at real data or a real install (`LH_SELFHOST`, `LH_HOME`,
  the update feed and so on) to an isolated value, because `next dev` loads
  the checkout's `.env*` files and a variable passed to it wins over them. It starts a scripted fake
  model (`tests/e2e/support/fake-model.ts`) that fills the Strong, Cheap and
  Vision slots as `e2e-strong`, `e2e-cheap`, `e2e-vision`. It plays
  `tests/e2e/support/scenarios/teach.json` (read two files, ask one question,
  acknowledge the answer). `LH_E2E_SCENARIO=<file>` picks another scenario.
- serves `next dev` by default. `LH_E2E_SERVER=standalone`
  serves the production build instead: build it first with
  `npm run build && node scripts/build-server.mjs`. In a checkout with a
  `data/` folder, move it aside for the build and back after: the build
  sweeps it into `.next/standalone/` and build-server.mjs refuses that. Use standalone for a
  change to launch config (`next.config.ts`, `proxy.ts`, `package.json`,
  `instrumentation.ts`) and for a bug bash.
- writes `state.json` (data folder, model log, fixtures) once seeded. Tests
  read it with `instance(app.baseUrl)` from `tests/e2e/support/instance.ts`.

Ready when `/api/health` answers (the runner waits for it). The app's output
goes to `.e2e/logs/app.log`.

`next dev` runs one copy per checkout. Your own `npm run dev`, an open MCP
session or a running explorer in the same checkout makes a second dev-mode
run fail: stop the other one, or run with `LH_E2E_SERVER=standalone`, which
any number of instances can share.

## Doctor

Run these first, and again whenever anything looks off:

```bash
npx e2e list                                   # config loads, every test listed; starts nothing
npx e2e run tests/e2e/pairing.e2e.ts --retries 0   # the app boots, pairing works, a signed-in landmark renders
```

Exit `0` on both means the app starts, the engine runs, and sign-in works.
`auth.setup.e2e.ts` is not the doctor: a setup file alone selects no test.

## Drive

**Sign-in.** The config's `pairing-code` secret mints a one-time pairing code
in the instance's data folder (what `npm run pair` does) each time it is
filled. `tests/e2e/auth.setup.e2e.ts` fills it into the "Pairing code" field on
`/pair` and saves the session `learner`. A test that declares
`{ session: "learner" }` starts signed in. A signed-out page shows "Pair this
device". Always fill the code as `secrets.get("pairing-code")`: a code typed as
a string, or opened as `/pair#token=<code>`, lands in `report.json` and the
traces.

**Scripted.** Write or extend a test under `tests/e2e/` for each flow the
change touches (topic `writing-tests`), run only it
(`npx e2e run tests/e2e/<feature>.e2e.ts:<line> --retries 0`), then the whole
suite (`npx e2e run --exclude-tag agent`; add the agent tests
when the change reaches what they drive). Stable handles here are
`data-testid` (`composer`, `question-dock`, `session-row`, `settings-entry`,
`stats-model`), roles and accessible names. Question options are radios
named with their letter badge ("A Blue"), so match them with a RegExp.

**Live.** `npx e2e mcp` is registered in `.mcp.json` and `.codex/config.toml`.
`open_session` starts the same isolated instance; `observe`, `locate` before
you write a locator, then copy each action's `Test line:` into the test
(topic `mcp`). For a signed-in page, `open_session {test: "tests/e2e/pairing.e2e.ts:<line>"}`
with the line of the `test(` call "a code typed on the pairing screen signs the
browser in" runs that test and hands you the session on the screen it ended on,
signed in. Or open a plain session, go to `/pair`, and call `type_secret` with
the secret name `pairing-code` into the "Pairing code" field, then tap Pair. A
setup file alone cannot be opened this way (`NO_TESTS`).

**Agent steps.** `agent.act` and `agent.assert` run on your signed-in coding
agent over ACP: Claude Code (`sonnet`) by default, Codex with
`--agent codex`. They need that CLI signed in (`claude`, `codex login`).
`agent.waitFor`, `agent.extract` and `e2e explore` run e2e's own agent on the
owner's ChatGPT plan (`chatgpt("gpt-6-luna")`), which needs
`npx e2e login openai` once per machine (`--device` prints a code to enter
in a browser; only the user can do it). Prefer a locator wait over
`agent.waitFor` in tests: CI has neither login. Tests with agent steps carry
the tag `agent`. Pair every `agent.act`
with a `screen` check so its recording can replay from `.e2e/cache/`, which
stays on this machine.

**The fake model.** It never judges content. A change to prompts, tool
schemas or provider code needs a real-model look: start a live session and
set a real model in Settings, or add a scenario rule that calls the changed
tool with the new input (and one that fails, `POST <fakeControl>/__fake/fail?mode=http500|broken-stream|hang`).
Read what one session sent the model with `sessionRequests(state, goal)` (all
of them: `modelRequests(state)`; tests share the instance, so filter by your
goal); each line names the rule it matched, and a rule that never fired means
the scenario fell through to its fallback.

**What e2e does not drive.** The web target reaches the web UI and the HTTP API
only. Not driven: the Electron desktop window, the phone app (`apps/mobile`)
unless the config has a mobile target, and the self-hosted `lh` launcher
(`selfhost/`) with its update and rollback flow
([#447](https://github.com/max-miller1204/learnharness-nightly/issues/447)).
For those, run their own tests (`node --test selfhost/tests/*.test.ts`,
`cd apps/mobile && npm test`) and say in the handover that the surface was not
driven.

## Evidence

Every run writes `.e2e/report.json`; a failed test gets
`.e2e/results/<test>/trace.md` (steps, app log, screen at failure,
screenshots). `--trace on` keeps a trace for passing tests too, `--video`
records each attempt, `app.screenshot("<name>")` saves a named frame. The next
run clears `.e2e/results/`, so a proof that must outlive it runs with
`--output .e2e/proof/<slug>`. The instance's data folder and model log stay
in `$TMPDIR/learnharness-e2e/<port>/` until the next run on that port.

Proof standards:

- Drive the real user path: the composer, the question dock, the sidebar.
  Not internal setters, not test-only endpoints. Seeding through the API
  routes Settings uses is fine.
- Check the action and the resulting state, not only the final screen: the
  stored record (`storedChat(state, id)`, `data/chats/<id>.json`, read with
  `expect.poll`: it is written after the screen updates) and what the model
  received (`sessionRequests(state, goal)`).
- Assert exactly: a tool result equals its file byte for byte, not "contains".
- Compare with the answer key, not your idea of right: the `Spec:` issue the
  PR links, a shipped spec in `docs/specs/`, or the base commit's behavior.
  An existing flow the change touched must behave as on `main`; run the same
  test on a `main` worktree when in doubt. Never edit a spec or a test's
  expectation to make it pass.
- Try to break it: the empty input, a reload mid-turn, a failing model.

**Screenshots.** Tests tagged `visual` compare pixels with `toHaveScreenshot`
(`math-rendering.e2e.ts`: arrows with labels and `\text` inside colour
boxes). Baselines sit beside the test in `<file>-snapshots/`, named per OS
(`-linux.png`), and CI's Linux runner is the reference: fonts and
antialiasing differ between machines. A change that alters a drawing on
purpose updates its baseline in the same commit: run the test with `-u`, look
at the new image, and if CI then fails on it, take the image CI drew from the
`e2e-report` artifact (`results/<test>/`) and commit that. Never update a
baseline to make an unexplained diff pass. A `-darwin.png` baseline does not
exist: on a Mac, run with `--exclude-tag visual` or leave the missing-baseline
failure out of the verdict.

CI runs `npx e2e run --exclude-tag agent` on the Linux standalone build
(`.github/workflows/ci.yml`, job Standalone (linux-x64)). It writes the results
to the job summary (`@e2e-dev/github`, with no token), uploads
`.e2e/report.json`, `junit.xml` and `results/` as the `e2e-report` artifact and
`summary.md` as `e2e-summary`. The separate `e2e comment` job, the only one
with `pull-requests: write`, posts that summary as one PR comment; it runs no
PR code and skips fork and Dependabot PRs.
CI is a backstop, not the proof: it never runs agent steps.

In the handover, name every flow you drove, its test, PASS or FAIL, the
evidence path, and every surface you did not drive.

## Bug bash

Follow topic `bug-bash`. Explorers run on ChatGPT: pass `--agent chatgpt`
(the config's agent with `maxSteps: 40, maxModelCalls: 40`), or give each
posture in the bug-bash config the same `chatgpt("gpt-6-luna")` model. It uses
the owner's plan, so ask before a large fan-out. Here: explore a standalone build
(`LH_E2E_SERVER=standalone`); port `0` already gives each explorer its own
app, so no `reuseExisting`. Write an untracked `e2e.bugbash.config.ts` that
spreads `e2e.config.ts` and gives its agents this context: "The local app has no provider key and its model is a
scripted fake that only follows tests/e2e/support/scenarios/teach.json: a
goal containing zz-e2e gets two file reads, one question and an
acknowledgement; anything else gets 'zz-e2e fallback reply.' Not bugs: that
fallback reply, the 503 from /api/stt/token (no dictation key), and
'Updates unavailable' in the sidebar footer." Charters come from the feature
map (`features/`); every charter there starts signed in, so pass
`--session learner` and raise `--max-steps` and `--timeout` (defaults 8 steps,
10 minutes). Output goes to `.e2e/bugbash/<slug>` (gitignored). A finding is a
bug only once a repro test, `tests/e2e/bugbash/<slug>.e2e.ts` tagged
`bugbash`, fails on the reported defect. Commit only repros of confirmed bugs;
once the bug is fixed, drop the tag and keep the test as a regression.

## Cleanup

The runner stops the app it started, and `close_session` stops the one an
MCP session started; serve.ts takes the fake model down with it. Never kill
by process name. Cleanup never removes `.e2e/proof/` or `.e2e/report.json`.

## Helpers

- `tests/e2e/support/serve.ts`: the launcher above (run by the config, not by hand).
- `tests/e2e/support/instance.ts`: `instance(app.baseUrl)`, `modelRequests`, `storedChat`.
- `tests/e2e/support/fake-model.ts`: the scripted model; its header documents the scenario format.

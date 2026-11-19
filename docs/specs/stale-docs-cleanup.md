# Delete stale docs and say where specs live

Status: approved by the owner on 2026-11-19 (idea-to-spec playback confirmed, no vetoes).

The owner's rule, in their words: "any doc that will easily go stale, please delete it because stale docs is the worst thing for agents." This change applies that rule once to the docs, removes the pointers it breaks, and writes it down so it holds from now on. Specs stay where they are: flat files at `docs/specs/<topic>.md`, read by agents, not by the owner.

## 1. Starting point

**Why.** Agents trust what docs say. The docs mix lasting facts with text that is only true for a while (status tables, done and later lists, counts, "currently" and "not built yet" claims), and nothing updates that text when the work moves on. The roadmap's Index is the clearest case: it still lists items 21 to 26 as "Later" although all six are built. Nothing in the repo says where specs live, so each idea-to-spec run asks again.

**Current state** (checked 2026-11-19 on `main` at `73705d1`, re-checked at `19205e7`):

- `docs/fork-roadmap.md:20-53` is an Index table with an Order column ("Done", "Later", numbers). Rows 21 to 26 say "Later" (lines 43-48), but their specs shipped in PRs #246, #251, #252, #248, #9 and #233.
- The roadmap has 26 entries. 12 are built or parked and each has its own spec: items 1, 3, 6, 7, 12, 20 (parked) and 21 to 26. 14 are not built: 2, 4, 5, 8, 10, 11, 14, 15, 17, 18, 19, 27, 28, 29. Some built entries still carry "Proposed design (not approved)" text (for example item 3 at line 159). Removing built entries already has precedent: `docs/specs/github-app.md:78` and `docs/specs/upstream-issue-mirror.md:82` each removed a built item's row and section.
- Three spec lines link to roadmap entries that this change deletes: `docs/specs/chatgpt-account-models.md:3` and `docs/specs/codex-cli-provider.md:5` (item 20), `docs/specs/pr-previews.md:3` (item 12). No other file links a roadmap anchor (`git grep -nE 'fork-roadmap\.md#'`).
- `docs/archive/` holds 7 docs from 2026-08 to 2026-10 and a README saying they "may contradict each other and the current implementation". 36 lines in 27 files outside it name `docs/archive/...`: code comments in `src/`, `components/` and `tests/`, plus `docs/README.md:29`, `docs/architecture.md` and `docs/plugin-api/contracts-plan.md:52`.
- `docs/plugin-api/` is generated from source comments by `scripts/build-plugin-api-reference.mjs` (each page says "Generated ... Edit canonical contracts/guides, not this page"), and `tests/plugin-api-reference.test.ts:82` compares it with the committed copy. Removing a pointer from a comment in `src/core/contracts/*.ts` therefore changes generated pages.
- Docs that code reads or ships: the 9 files in `AUTHORING_DOCS` (`scripts/build-plugin-authoring.mjs:9-13`) go into the plugin authoring bundle, checked by `tests/desktop-payload.test.ts` and `tests/plugin-authoring-bundle.test.ts`. `tests/plugin-setup.test.ts:169` reads `docs/development.md` for `npm run plugins:setup`. `tests/plugin-authoring-bundle.test.ts:67` writes its own fixture named `docs/archive/plugin-implementation-history.md`; it doesn't read the real file.
- About 170 code comments point at specs (for example `tests/auth-routes.test.ts:1`). No program reads a spec file. The prove-learnharness skill finds specs at `docs/specs/<item>.md` (`.claude/skills/prove-learnharness/SKILL.md:75`), so it keeps working with no change as long as specs don't move.
- No link checker exists (`npm run lint` is `eslint .`). CI's lint job runs on every PR, docs-only PRs included (`.github/workflows/ci.yml:66-92`).
- `AGENTS.md` holds only the Next.js block between `<!-- BEGIN:nextjs-agent-rules -->` and `<!-- END:nextjs-agent-rules -->` (lines 1-9). `next dev` rewrites that block.
- Open work on 2026-11-19: PR #270 (jobs-payload) merged as `19205e7`; the archive pointer count is unchanged after it (36 lines, 27 files). PR #271 (phone session basics) is open. It edits `apps/mobile/src/`, `components/delete-session-dialog.tsx`, specs and a prove-learnharness recipe, but none of the files this change edits. Quiz-choice math has no PR yet (it adds `docs/specs/mobile-quiz-choice-math.md`).

**First task, before any edit:** re-probe the facts above on the current `main`: the roadmap's built and unbuilt items, the archive pointer count, the generated-docs test, and the open PRs (`gh pr list --state open` with their files). If a fact changed in a way that changes a goal, stop and report it. Then check the ordering rule under Constraints.

## 2. Goals and non-goals

**Goals**

1. `docs/fork-roadmap.md` has no Index table and no entry for the built or parked items (1, 3, 6, 7, 12, 20, 21 to 26). The 14 unbuilt entries remain, each with its number in its heading (so "item 27" still names something) and with its "Decided" notes.
2. `docs/archive/` no longer exists: the 7 docs and its README are deleted, and so is the line linking it in `docs/README.md`.
3. Every `.md` under `docs/` except `docs/specs/`, plus the root `README.md` and `apps/mobile/README.md`, has no text that goes stale. That means status tables, done or later lists, counts, and "currently", "today", "for now", "not built yet" and "will be replaced when built" claims. When a sentence stays true without the time word, only the word goes. The owner's decisions, the owner's theory (`docs/teaching-methodology.md`) and how-to or contract text stay. Nothing new is written in its place.
4. No code comment names a deleted doc. Each of those comments loses only the pointer and keeps its explanation. Comments that point at a spec are unchanged.
5. `AGENTS.md` has two new lines outside the Next.js block. (a) Specs are files at `docs/specs/<topic>.md`; idea-to-spec publishes there. (b) Docs and code comments hold only what stays true: no status tables, done or later lists, counts, or currently, not yet or today claims. Specs are exempt.
6. CI's lint job runs a small link check. It fails when a Markdown link in a tracked `.md` file, or a `docs/...` path named in a tracked non-Markdown file, points at a file that does not exist.
7. The PR description lists every deleted file and section, each with a one-line reason naming the rule it falls under.

**Non-goals**

- Moving, renaming or rewording specs. The owner chose to keep them flat with topic names, because only agents read them. The only spec edits are the three links to deleted roadmap entries, which become plain text, and the three decision lines listed under Owner decisions during the build.
- A list or index of planned specs. Nothing could check it, so it would go stale.
- Removing spec pointers from code comments. Specs don't move, so those pointers stay true, and they help agents.
- Dated or status notes in code comments ("Wave A", "INTERIM", "NOTE (2026-09-11 pivot)") and "roadmap item N" mentions in comments. **Deferred** to their own cleanup PR, planned to follow right after this one.
- Editing the prove-learnharness skill, including `references/planned.md`. It's left to `/maintain-prove-it`.
- T3 Code's approach (no specs in the repo; work tracked in GitHub issues, `AGENTS.md:174-177` at T3 `3ce21458`). The owner chose files because issues would mix with mirrored upstream issues.
- Fixing links in past PR descriptions or bot comments that point at deleted docs. They are already published, and git history keeps the text.
- Checking `#anchor` targets in the link check. That keeps the script small.

## 3. Constraints

**Invariants**

| Invariant | Where it is enforced or detected | Kind |
|---|---|---|
| Spec files keep their content; only the three listed link lines change, plus the three added decision lines under Owner decisions during the build | the end-state script (Proof 3) on the PR diff | machine |
| No Markdown link or `docs/` path in code points at a missing file | the link check in CI lint, from now on | machine |
| Generated `docs/plugin-api/` matches its source | `tests/plugin-api-reference.test.ts` in CI | machine |
| Nothing deleted was an owner decision or a spec's answer key that isn't kept elsewhere | fresh agent with the deletion list (Proof 6) | fresh agent |
| Docs hold only what stays true | fresh agent with only the rule (Proof 5) once; afterwards the `AGENTS.md` line guides writers | fresh agent |

**Ordering.** Start only when every PR open at that moment that touches the files this change edits has merged or closed (on 2026-11-19, #270 was the only one, and it has merged). Re-check the open PRs right before starting. Branches that only add a new spec file don't block. If this PR conflicts later, rebase it; a new spec arriving needs nothing from this change. Rollback is a revert of the merge commit.

**Stop and ask**

- A built or parked roadmap entry has a "Decided" note or owner choice that its spec doesn't contain.
- The rule would delete a whole file in `AUTHORING_DOCS`, or a file a test reads (`docs/development.md`).
- A passage is both an owner decision and stale-prone, and the time word can't simply be dropped.
- The link check finds a dead link inside `.claude/skills/prove-learnharness/` that this change didn't cause.
- A probe in the First task contradicts this spec.

**Left to the agent:** the link check's language and location (next to `.github/scripts/ci-changes.cjs` and its test is a fit), how it marks a test fixture to skip (needed for `tests/plugin-authoring-bundle.test.ts:67`), the exact wording of the two `AGENTS.md` lines, how a sentence reads once its time word goes, the commit split, and this spec's own file name.

**Defaults the owner accepted**

1. The link check checks that files exist, not `#anchors`. It skips URLs, fenced code blocks and lines marked as test fixtures.
2. The `AGENTS.md` lines go outside the Next.js block, which `next dev` rewrites.
3. The parked specs (`codex-cli-provider.md`, `gemini-cli-provider.md`) stay as they are.
4. "roadmap item N" mentions in comments wait for the follow-up PR. In specs they stay, because specs are exempt.
5. The docs index lines that describe the roadmap stay ("work considered and deliberately deferred" stays true).

**Owner decisions during the build (2026-11-19).** The owner approved these changes beyond the goals above:

1. Three built or parked roadmap entries held an owner decision their spec lacked. Each moved into its spec as one line (added, or appended to an existing line): item 20's "Rejected for now" CLI list into `docs/specs/gemini-cli-provider.md`, item 1's "Mac checks run over the linked MacBook" into `docs/specs/electron-nightlies.md`, and item 26's 192 MB converter heap limit into `docs/specs/extract-more-types.md` (decision 10).
2. `docs/flashcards-implementation-plan.md` is deleted: a plan for work that is already built. The two `docs/flashcards-vision.md` sentences that deferred details to an implementation plan go with it.
3. `apps/mobile/README.md` loses its "Proposal for owner approval" paragraph (the unapproved TestFlight cadence), which the mobile auto-updates spec will decide. One line keeps the lasting fact that a TestFlight build stops opening 90 days after upload, with its source links.
4. Item 27's "**Decided.** Nothing yet." is deleted: not a decision, a point-in-time placeholder. Every other Decided note stays word for word.

**Generated docs.** `docs/plugin-api/` is never hand-edited. After editing source comments, regenerate it with its script and commit the result.

**Merge.** The owner's standing rule applies: auto-merge when CI is green, review findings are resolved and the proof says PROVED.

**Promote on merge.** The two `AGENTS.md` lines (Goal 5) are this change's lasting rules, and they land in the same PR.

## 4. Proof

**Verifies on:** the PR's GitHub Actions CI (lint, typecheck, test), and a local checkout of the PR head for the scripts and fresh agents. Nothing needs setting up first, except the link check, which this PR adds.

| # | Proves | Surface | Check | Where it runs | Pass signal |
|---|---|---|---|---|---|
| 1 | Goals 2, 4, 6: no dead links remain | CI lint job on the PR | the new link check over the PR head | GitHub Actions | the lint job passes, with the link check in its log |
| 2 | Goal 6: the check really catches a dead link | the link check's own test | a fixture with a link to a missing file, and one with a missing `docs/` path in a comment | CI lint job (the same step that runs `ci-changes.test.cjs`) | both cases fail, and a clean fixture passes |
| 3 | Goals 1, 2, 5 and the spec invariant | the repo tree and the PR diff | a script asserting: no Index table in `docs/fork-roadmap.md`, no heading for items 1, 3, 6, 7, 12, 20, 21 to 26, headings present for the 14 unbuilt items, `docs/archive/` absent, both `AGENTS.md` lines present after `END:nextjs-agent-rules`, `docs/flashcards-implementation-plan.md` absent, no "Proposal for owner approval" in `apps/mobile/README.md`, no "Nothing yet" Decided line in the roadmap, and `git diff origin/main -- docs/specs` (this spec aside) changing only the three listed link lines and the three decision lines under Owner decisions during the build | local, on the PR head, output pasted in the PR | every assertion prints ok |
| 4 | Generated docs and bundled docs still match | existing CI tests | `tests/plugin-api-reference.test.ts`, `tests/plugin-authoring-bundle.test.ts`, `tests/desktop-payload.test.ts`, `tests/plugin-setup.test.ts`, and the rest of the suite | GitHub Actions | the `Check` job is green |
| 5 | Goal 3 | the docs as an agent reads them | a fresh agent that never saw this work gets only the rule from Goal 3 and the list of covered files, and reports any stale text left | local | zero findings, or each finding fixed and the agent re-run with zero |
| 6 | Goals 1, 3, 7: nothing decided was lost | the PR description's deletion list and the diff | a fresh agent gets the deletion list, the diff and the rule "keep owner decisions and spec answer keys", and checks each deletion; for each removed roadmap entry it confirms the decisions exist in that item's spec | local | zero violations |

Every check must pass to merge. Pass means every step shows its stated result; anything else fails the step.

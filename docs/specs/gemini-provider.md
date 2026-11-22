# Gemini provider

Status: approved by the owner on 2026-11-21 (decision-only spec; no app code, Settings UI, or user-doc changes).

LearnHarness keeps Google Gemini on its existing Pi `google` API-key provider (`GEMINI_API_KEY`). It does not add a Google subscription sign-in, a Gemini CLI provider, an Antigravity (`agy`) provider, or a Vertex AI key row in Settings. This is a lasting rule for this fork: revisit only if Google launches an official third-party sign-in program (or restores personal Google login to Gemini CLI).

## 1. Starting point

### Why

The owner likes Google's Gemini models and asked whether LearnHarness should add Gemini as a subscription sign-in (like ChatGPT, GitHub Copilot, and Grok) or as a CLI-backed provider (like Claude Code, using Gemini CLI or Antigravity). Every non-API-key path either violates Google's Terms of Service (with reported account suspensions), lost personal Google login, or breaks earlier rules the owner set in roadmap item 20.

### Current state (checked 2026-11-21 on `docs/gemini-provider-spec` at `00b42e26`)

- **Existing API-key support.** LearnHarness exposes `{ id: "google", envVar: "GEMINI_API_KEY", label: "Google" }` in `AUTH_PROVIDER_KEYS` (`src/core/auth-keys.ts:112`), under **Settings → Providers → Model API keys → + Add a provider**. The table is test-pinned to Pi's built-in plain-key providers (`tests/auth-provider-keys.test.ts:62-71`), and the Google API-key transport (`google-generative-ai`, `https://generativelanguage.googleapis.com/v1beta`, `x-goog-api-key`) is covered by `tests/provider-neutral-agents.test.ts:45`.
- **Pi `1.5.2` catalog and live refresh.** `package.json:32` and `package-lock.json:544` pin `@earendil-works/pi-ai` to `1.5.2`. Its bundled `dist/providers/data/google.json` ships 23 chat models including `gemini-3.8-flash` and `gemini-4-argon`, and `dist/auth/oauth/` has no Google OAuth provider. Clicking **Refresh model catalog** fetches `https://pi.dev/api/models/providers/google?types=chat` (`src/server/remote-model-catalog.ts:21-28,205`). A live probe of that shard on 2026-11-21 returned 26 chat models including `gemini-4-neon` (1M context / 65,536 max output, $3/$15 per 1M, thinking `low/medium/high/xhigh`), `gemini-4-hydrogen` ($1.50/$7.50, `low/medium/high/xhigh`), `gemini-4-carbon` ($2/$10, `low/medium/high`), `gemini-4-argon` ($2/$10, `low/medium/high`), and `gemini-3.8-flash` ($0.75/$3.75, `low/medium/high`), with zero rows failing `checkedModels()` rules (`src/server/remote-model-catalog.ts:141-174`).
- **Google AI plan credits and API terms.** Google documents monthly Google Cloud credits for AI Pro ($10/month) and AI Ultra ($40 or $100/month) usable with a paid Gemini API key in external applications (`https://ai.google.dev/gemini-api/docs/google-ai-plans`). Google Cloud billing charges overages to the card on file by default, and heavy `gemini-4-neon` lessons can cost a few dollars each. The Gemini API Additional Terms (`https://ai.google.dev/gemini-api/terms`) set age (18+), professional/business-use, EEA/Switzerland/UK paid-tier, and free-tier training rules.
- **Google subscription sign-in.** Unlike OpenAI's sanctioned "Sign in with ChatGPT" program used by `electron/chatgpt.cjs` (`docs/specs/chatgpt-remote-signin.md:11`), Google offers no third-party consumer sign-in program. Google's Gemini CLI terms (`https://geminicli.com/docs/resources/tos-privacy`) and Antigravity FAQ (`https://antigravity.google/docs/faq`) name third-party access via Gemini CLI or Antigravity OAuth as a Terms of Service breach, with users reporting 403 account suspensions.
- **Gemini CLI.** Personal Google login stopped working on 2026-06-18 for Free, AI Pro, and AI Ultra tiers (`https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals`). LearnHarness's 2026-11-17 spike on Gemini CLI `0.68.0` hit this and parked the provider (https://github.com/max-miller1204/learnharness-nightly/issues/391 (lines 9-15)).
- **Antigravity (`agy`).**
  - Headless mode (`agy -p`): Google's FAQ states wrapping `agy -p` inside third-party apps is not supported under consumer plans (`https://antigravity.google/docs/faq`). Its `--input-format stream-json` accepts text only (no images), and its CLI reference documents no flag to disable built-in tools or replace the system prompt.
  - ACP mode (`agy acp`): T3 Code (`pingdotgg/t3code`, `docs/user/providers-antigravity.md`, commit `5d42431e`) drives `agy acp` (~9,600 lines, ~1.25 GiB managed runtime, requires 1.5+, recommends 1.5.12+) as a full coding agent with its own tools and an append-only system prompt. Unofficial forum replies (2026-11-02 and 2026-10-28) describe unmodified `agy acp` as permitted only for single-user interactive development (Gemini models only) and warn that unattended background requests (such as LearnHarness jobs, graph extraction, and subagents) can trigger lockouts. It also crashes on 39-bit ARM64 Linux kernels and conflicts with three owner rules in https://github.com/max-miller1204/learnharness-nightly/issues/391 (lines 11-13): Antigravity rejected, no ACP layer, and each CLI must act as a model (its own tools off), not an agent.
- **Vertex AI (`google-vertex`).** Excluded from Settings by earlier owner spec (`src/core/auth-keys.ts:96-98`, `tests/auth-provider-keys.test.ts:34`), even though Pi `1.5.2`'s `google-vertex.js` accepts `GOOGLE_CLOUD_API_KEY` as well as ADC. `catalogProviders()` (`src/server/model-catalog.ts:156-172`) omits `google-vertex`, so it does not appear in Settings or the model picker (`src/server/keys.ts:206` returns `true` for excluded providers; left untouched).
- **Settings UI and existing indirect routes.** Model-provider rows in `components/settings/keys-section.tsx:3-5,16-17` are intentionally uniform and minimal with no description hints or per-provider `docsUrl`. Existing GitHub Copilot and Grok sign-ins (`electron/subscriptions.cjs`) use Pi's built-in editor/CLI device-code IDs, and Pi `1.5.2`'s `github-copilot.json` includes `gemini-3.8-flash` and `gemini-4-argon` when enabled on a Copilot account. Aggregators (`openrouter`, `opencode-go`, `vercel-ai-gateway`) also remain available through their existing API-key rows.
- **Unverified items:**
  - **I could not verify this:** live inference with a real `GEMINI_API_KEY` against Gemini 3.8 or Gemini 4 models (no test key configured). Consequence: a live-only Gemini 4 API quirk (such as thinking-level or tool-call behavior in a real lesson) would only appear when the owner runs their own key. Safe behavior: rely on the existing offline transport and key-table tests.
  - **I could not verify this:** the full JavaScript-rendered text of `https://antigravity.google/terms/`, whether Google forum responders speak officially for Google, or undocumented `agy` behaviors (tool hiding under deny rules, ACP `mcpServers`, headless Linux keyring storage). Consequence: none while Antigravity remains rejected. Safe behavior: do not rely on Antigravity.
  - **I could not verify this:** exact Google Cloud credit redemption mechanics (such as regional eligibility or billing enrollment steps), and running `npm test` inside this worktree (`node_modules/` is not installed here). Consequence: automated tests run in CI or after `npm ci`. Safe behavior: re-run the test suite after `npm ci` if this area is ever touched.

### First task, before any future code

If this decision is ever reopened, first re-verify whether Google has launched an official third-party sign-in program (or restored personal Google login to Gemini CLI), then run `npm ci` and verify the existing Google tests (`tests/auth-provider-keys.test.ts`, `tests/provider-neutral-agents.test.ts`, `tests/remote-model-catalog.test.ts`) on the current Pi version before writing any code.

## 2. Goals and non-goals

### Goals

1. **API-key-only Gemini path (owner decision).** Keep Gemini on LearnHarness's existing Pi `google` provider (`GEMINI_API_KEY`), with no Google subscription sign-in and no Gemini CLI or Antigravity provider.
2. **Vertex AI stays excluded (owner decision).** Keep `google-vertex` hidden from Settings so the provider table stays small and carries no fork diff in `src/core/auth-keys.ts`.
3. **Decision-only spec (owner decision).** Make no app code, Settings UI, or user-doc changes, keeping the wave-5 minimal provider table intact and avoiding upstream Sync PR conflicts.
4. **Lasting Gemini policy, existing subscriptions unchanged (owner decision).** Record as a lasting fork rule that LearnHarness will not add borrowed Google OAuth or unsupported CLI/ACP wrappers for Gemini unless Google launches an official third-party sign-in program, while leaving existing GitHub Copilot and Grok sign-ins untouched.

### Non-goals

- **No Google subscription sign-in:** borrowing Gemini CLI or Antigravity OAuth breaches Google's terms and risks 403 account suspension.
- **No Gemini CLI provider:** remains parked in https://github.com/max-miller1204/learnharness-nightly/issues/391 unless Google restores personal Google login.
- **No Antigravity (`agy -p` or `agy acp`) provider and no ACP layer:** conflicts with Google's consumer-plan FAQ/background-use limits and with item 20's rules (https://github.com/max-miller1204/learnharness-nightly/issues/391 (lines 11-13)).
- **No `google-vertex` key row in Settings (deferred):** `GEMINI_API_KEY` already exposes the same Gemini 3.8 and Gemini 4 models.
- **No Settings UI links or hints, and no edits to `docs/getting-started.md`, `docs/architecture.md`, or `docs/fork-roadmap.md`:** decision-only spec; avoids Sync PR conflicts and volatile vendor-pricing docs.
- **No Gemini API web search (`google_search` grounding) backend (deferred):** out of scope for this provider decision.
- **No changes or terms audit for GitHub Copilot or Grok sign-ins:** existing subscription connections stay untouched.
- **No change to `src/server/keys.ts:206` or documentation of indirect Gemini routes** (GitHub Copilot, OpenRouter, OpenCode Go, Vercel AI Gateway).

## 3. Constraints

### Invariants

| Invariant | Where it is checked | Machine or human |
|---|---|---|
| `AUTH_PROVIDER_KEYS` stays exact-pinned to Pi's plain-key providers, with `google` (`GEMINI_API_KEY`) present and `google-vertex` excluded. | `tests/auth-provider-keys.test.ts` (P1) | Machine |
| Existing `google` API-key transport (`google-generative-ai`, `x-goog-api-key`) and manual `pi.dev` catalog refresh stay unchanged and passing. | `tests/provider-neutral-agents.test.ts` and `tests/remote-model-catalog.test.ts` (P2) | Machine |
| No app code, Settings UI, user docs, or existing subscription providers (ChatGPT, Copilot, Grok) are modified by this spec PR. | `git diff --name-only origin/main...HEAD` (P3) | Machine |
| Item 20's rules (https://github.com/max-miller1204/learnharness-nightly/issues/391 (lines 11-13): Antigravity rejected, no ACP layer, CLI as model not agent) and the lasting rule against borrowed Google sign-ins or unsupported CLI/ACP wrappers hold on future PRs. | PR review on any future Gemini proposal | Human (lasting rule; confirmed by owner) |

### Stop and ask

Reopen this spec and ask the owner only if:

- Google launches an official third-party sign-in program for consumer Google AI plans;
- Google restores personal Google account login to Gemini CLI; or
- a Pi upgrade breaks `google` (`GEMINI_API_KEY`) or causes `src/server/remote-model-catalog.ts` to reject the live `pi.dev` `google` shard.

### Left to the agent

- Exact wording and formatting of this spec file and its draft PR description. No implementation work follows this spec.

### Promote on merge

This repository has no numbered invariants list or ADR folder (`docs/specs/jobs-payload.md:109`), and the owner chose not to edit `docs/architecture.md` or other docs. This file (`docs/specs/gemini-provider.md`) is the permanent record of the lasting Gemini rule.

## 4. Proof

### Verifies on

- Existing automated test runner (`npm test` after `npm ci`, local and CI) for the unchanged Google API-key path.
- No live `GEMINI_API_KEY` environment is set up (owner decision). This spec PR itself is docs-only (`Verified: none`).

### Checks

| # | Proves | Surface | Check | Where it runs | Pass signal |
|---|---|---|---|---|---|
| P1 | Goals 1 and 2, invariant 1 | `AUTH_PROVIDER_KEYS` (`google` present, `google-vertex` excluded) | `tests/auth-provider-keys.test.ts` | CI / local after `npm ci` | All assertions pass with `google` (`GEMINI_API_KEY`) present and `google-vertex` absent |
| P2 | Goal 1, invariant 2 | Pi `google-generative-ai` transport and `pi.dev` catalog refresh | `tests/provider-neutral-agents.test.ts` and `tests/remote-model-catalog.test.ts` | CI / local after `npm ci` | All assertions pass |
| P3 | Goals 3 and 4, invariant 3 | Repo diff of this spec PR | `git diff --name-only origin/main...HEAD` | Spec PR | Only `docs/specs/gemini-provider.md` is added; no app, UI, or other doc files changed |

Every check must pass to merge (for P1 and P2, on any CI run covering `main`; P3 on this PR).

Checks that did not apply:

- **Entrypoints and irreversible effects:** no new or changed routes, commands, settings fields, webhooks, jobs, credentials, or background processes are added. API-key spending stays on the user's existing Google AI Studio / Google Cloud billing account.
- **Permissions, removals/renames, and cutover/rollback:** no permission changes, nothing removed or renamed, and no data migration.
- **Live Gemini API inference:** skipped by owner decision (no test `GEMINI_API_KEY` configured).

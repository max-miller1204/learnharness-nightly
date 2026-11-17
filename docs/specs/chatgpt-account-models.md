# ChatGPT account models missing from Pi's catalog

Replaces the Codex CLI part of roadmap item 20 ([fork roadmap](../fork-roadmap.md#20-gemini-cli-and-codex-cli-providers)). The Codex CLI spike (see [codex-cli-provider.md](codex-cli-provider.md), parked) showed that the models the owner was missing are already offered to the ChatGPT sign-in. LearnHarness just drops them.

## Problem

`refreshChatGPTModels` in `src/agent/chatgpt-bridge.ts` keeps an account model **only if** Pi's `openai` catalog has a Responses model with the same ID. Any other model the account offers is dropped without notice.

Checked on 2026-11-17 with a real ChatGPT sign-in:

- `GET https://api.openai.com/v1/models` (the call `electron/chatgpt.cjs` makes) lists 10 models with `visibility: "list"`: gpt-6.2-sol, gpt-6.2-astra, gpt-6.1-terra, gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra and gpt-5.6-luna. This is the same list the Codex CLI shows.
- The LearnHarness picker shows 7 of them. **gpt-6.2-sol, gpt-6.2-astra and gpt-6.1-terra are dropped**, because Pi 1.4.0 doesn't know them.
- A Responses request to `gpt-6.2-sol` with the ChatGPT access token streams a normal answer, so the transport already works.
- Pi's catalog trails the account's model list, so building from the account's own metadata keeps new models visible without waiting for a catalog update.

## Decisions

1. **Keep every listed account model.** A model Pi knows keeps today's behavior exactly: the Pi entry with `provider: "chatgpt"`, the account's display name and zero cost.
2. **Build models Pi doesn't know from the account's metadata plus a template.**
   - The template is the first model in the account's own list order that Pi's `openai` catalog knows as a Responses model. For today's account that is gpt-6.1-sol.
   - From the template: `api`, `baseUrl`, `compat`, `inputLimits`, `maxTokens` and the zero ChatGPT cost.
   - From the account:
     - `id` and `name`: the slug and `display_name`.
     - `contextWindow`: `context_window`. If it is missing or invalid, the model is dropped (owner decision: limits are never borrowed from another model, which also keeps the existing "without inventing model limits" test passing).
     - `input`: `input_modalities` narrowed to `text` and `image`. A model with no input list, or none including `text`, is dropped.
     - `reasoning` and `thinkingLevelMap`: from `supported_reasoning_levels`. `low`, `medium`, `high`, `xhigh` and `max` map to themselves when listed. `off` and `minimal` are unsupported, and Codex-only levels such as `ultra` are ignored. With no usable level, `reasoning` is false.
   - If the account lists no model Pi knows, there is no template, and unknown models are still dropped, as today.
3. **Metadata transport.** `electron/chatgpt.cjs` `models()` passes `contextWindow`, `input` and `reasoningLevels` with each `{ id, name }` entry. That file serves both packaged desktop and web/dev. The bridge validates these fields and ignores bad ones per entry. Known models keep using Pi's values, so their context windows don't change in this PR.
4. **No UI change.** Built models look like any other ChatGPT model in the picker and the context meter. Subscription billing labels are unchanged.
5. **Codex CLI provider: parked, not built.** `docs/specs/codex-cli-provider.md` is committed with a "Parked" status line as the record of the spike. Roadmap item 20 is updated: the Codex CLI is parked with the reasons (maintenance cost, no live typing, the catalog-rewrite dependency), this fix replaces it, and the Gemini CLI stays as planned.
6. **Out of scope:** showing which models were dropped (none are, with a template), changing known models' metadata, and the Gemini CLI.

## Files

- `electron/chatgpt.cjs`: the extra fields in `models()`.
- `src/agent/chatgpt-bridge.ts`: `ModelsValue` entry type and `refreshChatGPTModels` (template and build).
- `tests/chatgpt-catalog.test.ts` (or a new `tests/chatgpt-account-models.test.ts`), covering:
  - a known model is unchanged
  - an unknown model is built with the template and account fields
  - missing or invalid window or input metadata drops the model
  - with no template, unknown models are dropped
  - account order is preserved
- A `chatgpt.cjs` test for the extra fields, if the existing suites cover `models()`.
- `docs/fork-roadmap.md` (item 20) and `docs/specs/codex-cli-provider.md` (Parked line).

## Acceptance (prove answer key)

1. With ChatGPT connected, the model picker lists all 10 account models, including `chatgpt:gpt-6.2-sol`, `chatgpt:gpt-6.2-astra` and `chatgpt:gpt-6.1-terra`, in account order.
2. A lesson turn on `chatgpt:gpt-6.2-sol` streams a normal answer, with live typing and tool calls working as for other ChatGPT models.
3. The context meter shows gpt-6.2-sol's window as 500,000 (the account's `context_window`). The effort menu offers low through max.
4. The 7 models Pi already knows look exactly as before (same names, context windows and effort levels).
5. Existing ChatGPT tests pass unchanged.

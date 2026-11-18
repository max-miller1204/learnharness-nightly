# Codex CLI provider

**Status: Parked, not built (owner decision, 2026-11-17).** The spike below showed the Codex CLI can qualify, but it costs much more to maintain than the Claude Code provider: about 25 flags plus a rewrite of Codex's internal model catalog to keep its tools off, a debug command for model discovery, and no live typing. The models the owner wanted are already offered to the ChatGPT sign-in, so [chatgpt-account-models.md](chatgpt-account-models.md) replaces this provider. This file is the spike record and the starting point if the Codex CLI is revisited.

Roadmap item 20, Codex CLI part only ([fork roadmap](../fork-roadmap.md#20-gemini-cli-and-codex-cli-providers)). The Gemini CLI gets its own later spec.

LearnHarness drives an externally installed **Codex CLI** as a model, the way it already drives Claude Code (`src/agent/claude-code/`). Codex's own tools are off. LearnHarness keeps the agent loop, its tools, and the transcript.

## Spike findings (Codex CLI 0.169.0, Linux, ChatGPT sign-in)

Codex was installed with `dots pkg add codex` and signed in with `codex login --device-auth`. Tool exposure was checked by pointing Codex at a fake local Responses endpoint that recorded each request body, then confirmed against the real service.

- **Built-in tools.** By default the model gets `exec_command`, `write_stdin`, `apply_patch`, `view_image`, `request_user_input`, the goals tools, `tool_search` and `web_search`. Newer catalog models also get code mode (`exec`, `wait`), `send_message_to_user_async` and a clock. Every one of them goes away with the flags under [Launch](#launch). `apply_patch`, code mode and the async/clock tools are driven by Codex's **model catalog**, so LearnHarness passes a rewritten copy of Codex's own catalog through the official `model_catalog_json` setting.
- **Remaining tools.** The model sees LearnHarness's MCP tools plus three read-only helpers Codex always adds when any MCP server exists: `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`. With user config ignored, they can only reach the LearnHarness bridge, and the bridge offers no resources. **Owner decision: this qualifies.** A resource request to the bridge fails the turn.
- **Headless stream.** `codex exec --json` writes JSONL: `thread.started`, `turn.started`, `item.started` and `item.completed` (types `agent_message`, `reasoning`, `mcp_tool_call`, `error`, and others), then `turn.completed` with usage, or `turn.failed`. Text is **not** streamed word by word: each message arrives whole.
- **MCP bridge.** Set with `-c mcp_servers.learnharness.url=...` plus `bearer_token_env_var`. Every `tools/call` carries `_meta.callId`, the model's call ID. A call held for 75 s waited correctly.
- **Instructions.** `model_instructions_file` replaces Codex's base prompt; it is sent as a developer message. Project `AGENTS.md`, user `config.toml`, skills, permissions, environment and collaboration-mode blocks can all be switched off. **`$CODEX_HOME/AGENTS.override.md` and `AGENTS.md` always load**, and no setting stops them.
- **Models.** `codex debug models` prints the account's full live catalog as JSON: slug, display name, visibility, context window, reasoning levels, and so on. Listed (`visibility: "list"`) for this account: gpt-6.2-sol, gpt-6.2-astra, gpt-6.1-terra, gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna.
- **Usage.** `turn.completed.usage` gives `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` and `reasoning_output_tokens`, summed over the whole run. There is no dollar cost.
- **Fail-closed config.** With `--strict-config`, an unknown `-c` key is a hard error ("unknown configuration field"), so a switch renamed in a future Codex stops the run instead of being silently ignored.
- **app-server.** T3 Code drives `codex app-server`, which streams deltas, but it cannot ignore the user's `config.toml` in release builds. User-defined MCP servers and hooks would then reach the model, which breaks the tools-off rule. `codex exec` has `--ignore-user-config`.

## Decisions

Tags: **(T3)** adopts T3 Code's answer, **(owner)** was decided by the owner, **(spec)** is proposed here for the owner to veto.

1. **Driver: `codex exec --json`, one child process per model turn**, just as Claude Code runs `claude -p`. Not app-server, for the reason in the findings. **Consequence: replies appear one whole message at a time, with no live typing.** (spec, deliberately differs from T3)
2. **Authentication: the user's normal Codex home** (`$CODEX_HOME`, default `~/.codex`) and its existing login, created outside LearnHarness with `codex login`. LearnHarness never reads or copies `auth.json`. The global `AGENTS.md` / `AGENTS.override.md` in that home still reaches the tutor, and the docs and the Settings row say so. (owner, T3 default "direct" home)
3. **Qualification.** The three bridge-only MCP resource helpers are accepted (owner).
4. **Settings: Settings → Providers → External CLI → Codex CLI**, an app-wide opt-in, **off by default**, stored as `codexCli: { enabled }`. It works like the Claude Code row, with a version line and **Check again**. (roadmap)
5. **Minimum version 0.169.0**, the version spiked. Several required keys (`include_collaboration_mode_instructions`, `tools.experimental_request_user_input`, `skills.include_instructions`) are recent, and `--strict-config` rejects them on older versions anyway. There is no maximum: newer versions run, and the checks below fail closed. The version check parses `codex-cli X.Y.Z` from `codex --version`. (spec; T3 pins 0.166.0 for its own managed install)
6. **Model discovery: `codex debug models`**, run with the launch environment and a 15 s timeout. Its result is cached in memory and refreshed on server start (lazily, at first catalog or model use while enabled) and on **Check again**. Models with `visibility: "list"` appear in the picker. A failed discovery leaves no Codex models and shows "Models could not be listed" in Settings. The same cached catalog is the input for the per-turn rewritten catalog (decision 9). (spec; T3 discovers dynamically through app-server `model/list`)
7. **Model IDs:** provider `codex-cli`, model ID = the Codex slug, display name = Codex's `display_name`. A full reference such as `codex-cli:gpt-6.2-sol` never collides with `openai:` (API key) or `chatgpt:` (ChatGPT sign-in) models of the same slug, because the provider part differs. (T3 uses slugs as IDs)
8. **Model fields:** `input: ["text","image"]`, `reasoning: true`, and `contextWindow` = Codex's `context_window` (exposed in the catalog and the context meter, unlike Claude's aliases). `maxTokens` is a 128,000 placeholder that the client DTO hides as `null`, as for Claude. `thinkingLevelMap` is built from each model's `supported_reasoning_levels`: `low`, `medium`, `high`, `xhigh` and `max` map to themselves, while `off`, `minimal` and Codex-only levels such as `ultra` are unsupported. With no reasoning level selected, the model's `default_reasoning_level` applies. (spec)
9. **Tools off.** See [Launch](#launch). Per turn, LearnHarness writes the cached catalog to a private file with these fields cleared on every model: `apply_patch_tool_type: null`, `tool_mode: null`, `experimental_supported_tools: []`, `multi_agent_version: null`, `supports_search_tool: false`. (spec)
10. **Runtime fail-closed checks.** The turn fails and the child is killed when any of these happen (spec):
    - an item type other than `agent_message`, `reasoning`, `mcp_tool_call` or `error`
    - an `mcp_tool_call` whose `server` is not `learnharness`, or whose tool LearnHarness did not declare
    - any `error` item, or a `turn.failed`
    - an MCP request to the bridge other than `initialize`, notifications, `tools/list` or `tools/call` (for example `resources/list`)
11. **Tool admission (Claude parity).** A tool runs only when an authenticated MCP `tools/call` arrives whose `_meta.callId` is unique and non-empty and whose name and arguments deep-equal a streamed `mcp_tool_call` `item.started` that has not yet been admitted. Pi gets `callId` as the tool call ID. Codex sends `parallel_tool_calls: false`, so a batch is exactly one call. There is no stdout-only fallback. (spec)
12. **Held calls, reuse and replay: Claude parity.** The child stays alive while a tool call waits, up to 10 minutes idle, and continues only for the same owner, session and compatible history, configuration and environment. The MCP `tool_timeout_sec` is 1800 (30 min). After expiry or restart, the next call starts a fresh child and replays history as labelled text, the same replay format as Claude Code. Images in the replay are written to private files and passed with `-i`. (spec)
13. **Usage.** Codex reports usage once, when the run ends. The final assistant message of a run carries the whole run's totals; assistant messages that end in a held tool call carry zero. Mapping: `input` = `input_tokens - cached_input_tokens`, `cacheRead` = `cached_input_tokens`, `cacheWrite` = `cache_write_input_tokens`, and `output` = `output_tokens` (which includes reasoning tokens). A run killed early (abort, failure, idle expiry) reports no usage. (spec; T3's app-server gets per-request usage instead)
14. **Cost meter: unpriced, "CLI billing"**, exactly like Claude Code: zero placeholder rates, a `null` cost in the client DTO, "CLI billing" in the model menu, and "CLI" in the stats bar. (spec, Claude parity)
15. **Reasoning text.** `reasoning` items become thinking blocks with their summary text. (spec)
16. **Shared helpers.** No new shared module. Codex imports the Claude provider's already provider-neutral pieces unchanged: `reuse-context.ts`, `live-processes.ts` (one registry, separated by owner symbol) and `transcript.ts`'s replay text. `tool-bridge.ts` gains one optional parameter for which `_meta` key carries the call identity and how errors are worded, defaulting to today's Claude behavior. The Claude tests pass unchanged. Everything else (binary lookup, version check, launch, stream, events) is written as Codex files in `src/agent/codex-cli/`. (spec, follows the roadmap's "share only if identical")
17. **Not in scope:** the Gemini CLI, a LearnHarness-managed Codex install or login (T3 has one), an account/login status check (Claude parity: version only), and Windows-specific discovery beyond `codex.exe` on PATH.
18. **Known nearby issue, out of scope:** `refreshChatGPTModels` in `src/agent/chatgpt-bridge.ts` (around lines 125-127) silently drops ChatGPT account models that are missing from Pi's `openai` catalog. The Codex provider is the supported way to reach the full Codex model list. The ChatGPT filter stays as is.

## Launch

The child environment is `externalCliEnv()` plus `LH_CODEX_MCP_TOKEN=<random bearer token>`. The working directory is a fresh empty temporary directory. There is no shell. Arguments (`<...>` are per-turn private files):

```
exec --json --strict-config --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules
-s read-only -m <slug> -c model_reasoning_effort="<effort>"
--disable shell_tool --disable unified_exec --disable view_image --disable goals --disable multi_agent
--disable apps --disable plugins --disable memories --disable image_generation --disable browser_use
--disable computer_use --disable tool_suggest --disable hooks
-c web_search="disabled" -c tools.experimental_request_user_input.enabled=false
-c model_catalog_json="<catalog.json>" -c model_instructions_file="<system-prompt.md>"
-c include_permissions_instructions=false -c include_environment_context=false
-c include_apps_instructions=false -c include_collaboration_mode_instructions=false
-c project_doc_max_bytes=0 -c skills.include_instructions=false
-c mcp_servers.learnharness.url="http://127.0.0.1:<port>/mcp"
-c mcp_servers.learnharness.bearer_token_env_var="LH_CODEX_MCP_TOKEN"
-c mcp_servers.learnharness.default_tools_approval_mode="approve"
-c mcp_servers.learnharness.required=true -c mcp_servers.learnharness.tool_timeout_sec=1800
[-i <image file>]... -
```

The prompt (labelled replay or the single user message) goes to stdin, and stdin is then closed. The private directory and the cwd are removed on exit, failure, abort or idle expiry, as for Claude.

## Files

- `src/core/contracts/codex-cli.ts`: `CODEX_CLI_PROVIDER = "codex-cli"`, `CODEX_CLI_MINIMUM_VERSION = "0.169.0"`, `CodexCliStatus` (Claude's states plus `modelCount: number | null`). Exported from `src/core/index.ts`.
- `src/agent/codex-cli/`: `constants.ts`, `binary.ts` (`codex` / `codex.exe` on PATH plus Claude's known user and system directories, minus `~/.claude/local`), `installation.ts`, `models.ts` (discovery, cache, catalog rewrite, Pi model mapping), `launch.ts`, `cli-events.ts`, `stream.ts`, `provider.ts`.
- `src/agent/claude-code/tool-bridge.ts`: the optional identity parameter (decision 16).
- `src/agent/models.ts`: register the provider. Its models come from the discovery cache.
- `src/server/codex-cli-config.ts`, `src/server/codex-cli.ts`, `app/api/codex-cli/route.ts`: opt-in, availability and the same-origin status route (header `x-learnharness-codex-cli: 1`), mirroring Claude's.
- Settings: the `codexCli` section in `src/core/settings.ts` and `src/server/settings-body.ts`, `SettingsSection` `"codexCli"`, `components/settings/codex-cli-status.tsx`, a row in `keys-section.tsx`, and a catalog refresh on save in `components/model-catalog.ts`.
- Provider gates that today special-case `claude-code`, which gain `codex-cli` where the meaning is "external CLI": `src/server/keys.ts` (availability), `src/server/model-catalog.ts` (provider row, model lookup, null cost and maxTokens), `src/server/pricing.ts` (unpriced), `src/core/settings.ts` (an "unavailable" refusal message for Codex CLI), `src/server/chat-handler.ts` (background admission), `components/settings/model-menu.tsx` ("CLI billing") and `components/stats-bar.tsx` ("CLI" cost cell). The Claude-only context-window report paths (`cliContextWindow`, side-context budget) stay Claude-only, because Codex uses its catalog window.
- `docs/codex-cli.md`, written like `docs/claude-code.md`. `THIRD_PARTY_NOTICES.md` is added only if T3 code is ported verbatim (none is planned).
- Tests (`tests/codex-cli-*.test.ts`, synthetic processes and MCP requests, no live CLI): binary lookup, the version check, model discovery and the catalog rewrite, argument construction, event parsing, admission (match, mismatch, duplicate, foreign server, resource request), the held-call continue path, usage mapping, opt-in and availability gates, the status route, the Settings row, and the catalog DTO (unpriced, context window shown).

## Acceptance (prove answer key)

1. With the opt-in off (the default), no `codex-cli` models are listed and selecting one is refused with the Codex CLI unavailable message.
2. Turning on **Settings → Providers → External CLI → Codex CLI** shows `Version 0.169.0 · meets minimum` and lists the account's Codex models (`codex-cli:<slug>`) in the model picker, priced as "CLI billing".
3. A lesson turn on a Codex CLI model answers, and its text appears whole.
4. A turn in which the tutor calls a LearnHarness tool (for example a learner question) runs the tool through the bridge, waits for the learner, and continues in the same child after the answer.
5. The spawned command line contains every flag under [Launch](#launch). A recorded request (fake endpoint) shows no tools other than LearnHarness's tools and the three MCP resource helpers.
6. A synthetic `command_execution` item, a foreign MCP server, a mismatched MCP call, or a `resources/list` request fails the turn and kills the child.
7. Usage after a turn shows token counts, and cost shows "CLI", not a dollar amount.
8. All existing Claude Code tests pass unchanged.

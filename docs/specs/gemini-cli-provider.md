# Gemini CLI provider (roadmap item 20, Gemini part): spike, parked

**Status: parked, nothing built.** The spike ran on 2026-11-17 against Gemini CLI **0.68.0** (installed with `dots pkg add npm:@google/gemini-cli@latest`) on WSL Ubuntu.

## Why it's parked

Item 20 wants the Gemini CLI for one reason: Google/Gemini **subscriptions** can't reach LearnHarness any other way. The spike shows the CLI can no longer give us that:

- Signing in with a personal Google account (`gemini`, then "Sign in with Google") fails with: *"This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products."*
- What still works is a Gemini API key, Vertex AI, or a gateway URL. LearnHarness already supports API-key Gemini directly, so a CLI provider on those terms adds nothing.
- Antigravity is already on item 20's "Rejected for now" list: Grok CLI and GitHub Copilot CLI (they duplicate the existing Grok and Copilot sign-ins), Cursor CLI, OpenCode, Kiro, Antigravity, and letting a CLI run as a full agent (owner).

The owner decided to drop the Gemini CLI provider. Look at it again only if Google brings back personal-subscription sign-in for the CLI.

## What the spike found

All checks except sign-in used a local fake Gemini API (`GOOGLE_GEMINI_BASE_URL` plus a dummy `GEMINI_API_KEY`). The fake records every request the CLI sends to the model, so the list of declared tools can be read off directly. A fake MCP server stood in for LearnHarness's tool bridge. Unlike Codex, the CLI itself would have qualified:

| Question | Finding |
| --- | --- |
| Can every built-in tool be turned off, simply? | **Yes, in two independent ways.** (1) `--admin-policy <file>` with a deny rule for `toolName = "*"` (priority 100) and an allow rule for `toolName = "*"`, `mcpName = "learnharness"` (priority 999). The model then sees no built-in tool at all (by default headless runs offer `update_topic`, `list_directory`, `read_file`, `grep_search`, `glob`, `google_web_search`, `enter_plan_mode`, `invoke_agent`). (2) `tools.core` in the working folder's `.gemini/settings.json` set to the exact MCP names (`["mcp_learnharness_<tool>"]`). An empty `tools.core: []` hides the MCP tools as well. |
| Policy file pitfalls | An invalid policy file is skipped with only a stderr warning, and the run carries on with all tools on. Supplemental admin policies are also ignored when the machine has `.toml` files in `/etc/gemini-cli/policies`. A build would have needed its own fail-closed check. |
| MCP from an inline config? | Yes. `mcpServers.learnharness` (`httpUrl`, `headers`, `timeout`) in a per-child `.gemini/settings.json`, loaded only with `GEMINI_CLI_TRUST_WORKSPACE=true` (`--skip-trust` alone did not load project settings). `--allowed-mcp-server-names learnharness` and `-e none` keep out the user's own MCP servers and extensions. |
| Tool-call admission | `tool_use` events (with `tool_id` and arguments) reach stdout before the MCP request. Parallel calls all reach MCP together, after every `tool_use` in the batch. The CLI holds the turn while an MCP call is pending (tested 20 s). Unlike Claude, the MCP request has **no call ID** in `_meta` (only `progressToken`), so admission would have had to match on name and arguments. |
| Headless structured stream? Live typing? | `-p ... -o stream-json` gives JSONL: `init`, `message` (assistant `delta: true` chunks that arrive as the API streams them), `tool_use`, `tool_result`, `error`, `result`. Live typing works. Thinking parts are not emitted. Non-JSON lines can appear on stdout (see slash commands). |
| Usage and cost | The `result` event reports `input_tokens`, `output_tokens`, `cached`, `total_tokens` and a per-model breakdown. No dollar cost, so the Claude-style "CLI billing" label would have applied. |
| Model listing | `gemini models -o json` (also `--list-models`) works without sign-in and lists `auto`, `gemini-2.5-pro`, `gemini-3.5-flash`, `gemini-3.1-flash-lite`, each with `contextLimits` (1,048,576 input / 8,192 output). The CLI may map an alias to another API model: `-m gemini-3.5-flash` was sent to `gemini-3.8-flash`. |
| System prompt | `GEMINI_SYSTEM_MD=<file>` replaces the 30 KB built-in coding-agent prompt completely. |
| Instruction files (`GEMINI.md`) | **Only partly controllable.** An empty working folder plus `context.memoryBoundaryMarkers: []` keeps project and parent `GEMINI.md` out. The user's global `~/.gemini/GEMINI.md` always loads: `context.fileName` adds names but never removes `GEMINI.md` (in 0.68.0 `setGeminiMdFilename` merges with the current list). Only a separate `GEMINI_CLI_HOME` avoids it, and that also hides the user's sign-in. |
| Prompt preprocessing | `@path` and `!command` in `-p` were passed through unchanged. A prompt **starting with `/`** runs slash commands, including the user's custom `~/.gemini/commands/*.toml`. `/memory show` printed non-JSON text into the stream. A build would have had to make sure the prompt never starts with `/`. |
| Session saving | Can't be turned off. Every run writes `~/.gemini/tmp/<folder>/chats/session-*.jsonl` and adds to `~/.gemini/projects.json` and `~/.gemini/history/`. |
| Cancellation | SIGTERM ends the CLI within about 10 ms (exit 143), even during a held MCP call. |
| Version check | `gemini --version` prints `0.68.0` in under a second. |

Compared with the Codex spike (about 25 flags plus a model-catalog rewrite, no live typing), the Gemini CLI's tool lockdown was light: about six flags, two environment variables and one settings file. The blockers are sign-in and, to a lesser degree, the global `GEMINI.md` and forced session saving.

## Not decided (moot while parked)

Minimum version, model naming in the picker, whether models are discovered live or kept as a fixed list, handling of the global `GEMINI.md` and session files, and which helpers to share with `src/agent/claude-code/`. T3 Code (`pingdotgg/t3code`) has no Gemini CLI driver to borrow from.

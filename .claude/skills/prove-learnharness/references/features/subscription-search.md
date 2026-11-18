# Subscription search

Settings → Agent → Tools → Search engine offers subscription accounts next to the keyed engines. A selected subscription runs every LearnHarness web search through that account only. Spec: `docs/specs/subscription-search.md`; server: `src/server/subscription-search.ts`.

## Sub-features

- `picker`: each subscription row shows its account label (never blank), the plan usage disclosure, or the reason it is unavailable.
- `chatgpt`: native Responses web search through the Sign in with ChatGPT lease.
- `claude-code`: one headless `claude -p` run with only `WebSearch` (haiku, low effort). The account comes from `claude auth status --json`.
- `grok-probe`: Grok is selectable only when the server starts with `LH_GROK_SEARCH_PROBE=1`, and then uses the Grok OAuth lease with the hosted `web_search` tool.
- `research-sources`: a research job keeps the native links as sources and drops a source whose fetch returned a non-2xx status.
- `no-fallback`: a failed search reports its reason and never uses another account, engine or key.

## How to get to it

- Web: Settings → Agent → Tools → Search engine. Start a lesson and ask for research to run a job.
- The live parts need the owner's own sign-in, through the provider's own flow, on an isolated instance. Fixture tests (`tests/subscription-search.test.ts`, `tests/claude-grok-search.test.ts`) cover app behavior. Live runs prove provider eligibility and usage.

## Driving it

Preconditions: the Feature README baseline, plus a saved Tavily key so a silent fallback would be visible. Run in this order. Each step needs the step before it to pass.

1. ChatGPT: sign in with ChatGPT in Providers, enable background use, choose ChatGPT in the picker, run a research job. Check that the sources are clickable provider citations, and that usage appears on the ChatGPT account.
2. Claude Code: start with `PROVE_MODEL=claude-code` so the instance keeps the real HOME and the CLI's login. Enable Providers → External CLI → Claude Code.
   - The picker row shows `email · Claude <plan>` and "Search can use your Claude plan usage limits (Claude Code)."
   - Choose it and run a research job. Sources are the WebSearch result titles and URLs.
   - Record the effective tool list: the CLI's `system/init` line must list only `WebSearch`, plus `EndConversation` if the CLI adds it.
   - Failure without fallback: run `claude auth logout` in that HOME, or pick the row and then sign in as another account. The next search reports the reason ("claude auth login" or "Reselect Claude Code") and sends no Tavily request.
3. Grok probe, only after 1 and 2 pass: start the head instance with `LH_GROK_SEARCH_PROBE=1 scripts/start.sh "$RUN" head`. Sign in to Grok in Providers through xAI's own flow and enable background use. Choose Grok in the picker and run one research job. Record:
   - whether native search completed (sources appear) or the error text, including the `Provider response:` part from xAI,
   - whether citations came back,
   - what xAI shows for subscription usage or any extra charge on the account.

   Then stop the instance. Grok stays unavailable on every instance without the switch.

## Gotchas

- `start.sh` uses `env -i`, so `LH_GROK_SEARCH_PROBE` reaches the app only through its passthrough line.
- The Claude Code row reads the sign-in fresh when Settings loads and before every search. A sign-in change made while Settings is open shows up after reopening it.
- Claude Code search links carry no snippet. The researcher fetches the pages it needs.

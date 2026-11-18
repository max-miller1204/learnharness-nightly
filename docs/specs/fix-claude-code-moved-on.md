# Spec: Claude Code bridge waits for the retry after the CLI rejects unparseable tool input

Status: bug fix. Behaviour chosen by the user, 2026-11-17: wait for the model's retry, only for the CLI's InputValidationError rejections; every other CLI refusal still fails loudly.
Base: main at d9faaa2 (the Claude Code bridge, worker admission and submit agent are identical to the 5b1afb2 build where the failure was seen).

## What main does today (measured)

A background Extract files run with Claude Code `haiku` in all slots intermittently fails a job with `claude CLI moved on without admitting its harness tool calls` (seen on `p-limit/readme.md`, extractor step 2, after a schema retry).

- Background (worker) requests never continue a held CLI process: `WorkerRequestStream` aborts each request's signal when the request ends, and that kills the held process. So every extractor step, including a schema retry, is a fresh `claude` process with a replayed transcript.
- Haiku sometimes streams a large `submit_findings` call whose input is not valid JSON. The `claude` CLI (2.1.327) answers that call itself, with an error tool_result starting `<tool_use_error>InputValidationError: ... could not be parsed as JSON`, never calls MCP, and lets the model retry. It prints that tool_result between `content_block_stop` and `message_delta`, so before `message_stop` (recorded against a scripted API, see `tests/fixtures/claude-code/invalid-input.jsonl`).
- The bridge only matched CLI tool_results against intents recorded at `message_stop`, so it ignored this one. At `message_stop` it then recorded the rejected call as waiting for MCP admission, and the model's retry (`message_start`) tripped the "moved on without admitting" guard, failing the turn and the job. The rejected call never ran anywhere.
- When the unparseable call sits behind a valid call in the same message, the CLI runs them one at a time and rejects the second only after the first's result. In a held (chat) process that rejection arrived after `message_stop` and failed the continuation with `refused a harness tool call before MCP admission`.

## Change

- `cli-events.ts`: a `toolResults` event also lists `invalidInputIds`, the results that are errors whose text (string or text blocks) starts with `<tool_use_error>InputValidationError:`.
- `stream.ts` (`ClaudeProcess`):
  - A CLI tool_result is matched against unadmitted intents both before `message_stop` (the current message's intents) and after (`sourceCalls`). Cancelled MCP requests are excluded, as before.
  - An InputValidationError result for such an intent drops that call for good (`invalidInputIds`): it is removed from `sourceCalls` and never shown to Pi.
  - Any other CLI result for an unadmitted intent fails the turn with `refused a harness tool call before MCP admission`, now also when the CLI prints it before `message_stop`.
  - At `message_stop`, if every intent of that message was a bare-name call or an InputValidationError rejection, the turn stays open for the model's next message, exactly like the existing bare-name tolerance. Otherwise the usable intents wait for MCP admission as before.
  - An MCP request for a call the CLI already rejected fails at once with `MCP call does not match its streamed tool intent`, instead of being held, whether it arrives before or after the rejection.
  - Each new CLI message starts with no batch waiting (the "moved on" guard has just checked that), so the retry's MCP request is matched against the retry even when it reaches the bridge before the retry's `message_stop`.

## Done looks like

- A message whose only harness call the CLI rejects as unparseable, followed by a valid retry, ends the turn as `toolUse` with only the retry (in either line order, and also when the retry's MCP request arrives before its `message_stop`); its result continues the held process.
- An unparseable call beside a valid one: only the valid call is admitted, and the later rejection does not fail the continuation.
- An unparseable call followed by a text answer ends the turn normally (`stop`), with no tool call.
- A live Extract files run with Claude Code `haiku` over a small folder including a copy of `p-limit/readme.md` completes every job, several runs in a row; no `moved on` error in the app log.

## Must keep working (existing flows, answer key is the base commit)

- The CLI's built-in tools never run: `--tools ""` and the MCP admission path are unchanged; only calls that reach the authenticated MCP bridge with matching id, name and arguments are admitted.
- A rejected call can never become executable: it is never in the turn's content, and an MCP request for its id fails the turn.
- Other CLI refusals (policy denial, "No such tool" for a prefixed call) still fail the turn with `refused a harness tool call before MCP admission`.
- The bare-name tolerance, sequential split batches, held-process continuation and its reuse checks, MCP identity checks, abort, idle timeout and the "moved on" guard for a call the CLI silently drops: all existing `tests/claude-code-stream.test.ts` cases pass unchanged.
- Extraction with other providers and Claude Code chat (tutor) turns with tools behave as on base.

## Not changed

- The CLI's own coercion of a JSON-string argument into an array before the MCP call still fails the turn with `MCP call does not match its streamed tool intent`. Deterministic with the real CLI (`items: "[1,2,3]"` reaches MCP as `[1,2,3]`). Out of scope by the user's choice; a separate fix.
- Background requests still start a fresh CLI process per step (worker admission aborts the request's signal at its end).
- A turn that spans a rejected message and the retry reports the retry message's token usage, not both (same as the bare-name tolerance).

# Agent tools (`src/agent`)

The teaching agents (prober, teacher, practice, side chats, background workers) run in the server with Pi's agent loop. Tools live in `src/agent/tools/` (read, ls, find, grep, probe, plan, graph, web, pdf-read, show-image, ...).

## The fake model

`scripts/fake-model.mjs` is an OpenAI-compatible server that `start.sh` connects as the keyless custom endpoint (`custom/prove-strong`, `prove-cheap`, `prove-vision` in the three slots). It plays a scenario file:

```json
{ "rules": [ { "id": "...", "match": { "lastRole": "user|tool", "lastIncludes": "...", "anyIncludes": "...",
  "systemIncludes": "...", "hasTool": "read", "noTool": "...", "model": "prove-strong" },
  "times": 1, "reply": { "text": "... {{lastText}} ..." } | { "toolCalls": [{ "name": "read", "arguments": { "path": "{{env:PROVE_FIXTURE}}" } }] } } ],
  "fallback": { "text": "..." } }
```

- First matching rule wins; `times` caps it. `POST $FAKE_CONTROL/__prove/reset` forgets fired rules (drives call it first).
- `{{lastText}}` echoes the last message (a tool result or the learner's answer); `{{env:NAME}}` fills per-run paths. `start.sh` exports `PROVE_FIXTURE` (a file in the throwaway HOME whose first line is `PROVE-FIXTURE-SKY: ...`).
- Matching looks at message `content` only: a tool call's arguments are not content (the probe question is not "in" the conversation text).
- Every request and reply is appended to `$RUN/<side>/model-requests.jsonl` with the rule that fired: this is where a checker reads exactly which tools were offered, which tool results the app sent back, and the system prompt.
- Fail switch: `POST $FAKE_CONTROL/__prove/fail?mode=http500|broken-stream|hang|none`.
- To use a different scenario: `scripts/start.sh "$RUN" head scenarios/<name>.json`.

`scenarios/teach-read.json`: on the goal, the prober calls `read` on the fixture; on the read result, it calls `probe` (Blue/Red); on the answer (`{"kind":"quiz",...}` tool result), it replies `zz-prove-it acknowledged your answer: ...`.

## Proving a tool change

1. Write a scenario that makes the agent call the tool with the input the change is about (and one sibling input the change must not alter).
2. Run it on base and head (`start.sh ... <scenario>` for each side) with a drive (`web-teach.mjs` if the flow is the same, or a copy for a different UI).
3. Compare the tool result each side sent back to the model (in `model-requests.jsonl`) and what the UI and the stored record show. An existing tool's result must match base unless the spec says otherwise.
4. Flip the fail switch mid-turn for at least one probe.

## Real model (opt-in)

`PROVE_MODEL=claude-code scripts/start.sh "$RUN" head` turns on the Claude Code opt-in and puts `claude-code/$PROVE_REAL_MODEL_ID` (default `haiku`) in every slot; the server keeps your real HOME so the CLI finds its login. `node scripts/web-real-turn.mjs "$H"` drives one teaching turn and checks it ends without an error and leaves something to act on; judge the content from `web-real-turn/turn.png` and `record.json` against the spec. Ran 2026-11-17: 8 s, `list_sessions` then `ask_user_question`. Real output varies: never diff it against base.

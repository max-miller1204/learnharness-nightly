# Teaching session

## Sub-features

- A goal typed in the composer on `/chat/new` creates a session and moves to `/chat/<id>`.
- The tutor's tool calls (`read`, `probe`, ...) show as tool cards in the transcript.
- A question shows in the question dock: options (radios with letter badges), confidence slider, "Your thinking", Submit answer.
- The answer goes back to the tutor and its reply streams in; the dock closes.
- The record is stored in `data/chats/<id>.json` and the transcript survives a reload.

## How to get to it (user POV)

Signed in, the Teaching button in the sidebar or `/chat/new`; type a goal and press Enter.

## Driving it with e2e

`tests/e2e/teaching-session.e2e.ts` (deterministic, fake model), `tests/e2e/math-rendering.e2e.ts` (tag `visual`: a screenshot of a reply's math) and `tests/e2e/agent-teaching.e2e.ts` (tag `agent`: Claude Code starts the session from a plain-language goal). The fake model plays `tests/e2e/support/scenarios/teach.json` for any goal containing `zz-e2e`. Locators: `getByTestId("composer").getByRole("textbox")`, `getByTestId("question-dock")`, `getByRole("radio", /Blue/)`, the button "Submit answer". Wait for `/chat/chat_` in the URL before acting on the dock: the page moves there after the first turn.

## Proof

- On screen: both read cards, the question with exactly the options Blue and Red, then "zz-e2e acknowledged your answer", and the dock gone.
- To the model (`sessionRequests(state, goal)`): each `read` result equals its fixture file byte for byte (one has no final newline), and the final `probe` tool result the tutor receives names exactly the Blue option the learner picked.
- On disk (`storedChat(state, id)`): the goal, the fixture text, the question and the acknowledgement.

## Charters

```
teach-state|web|default|Signed in (--session learner), starting at /chat/new, start a session with a goal containing zz-e2e, answer the question, then reload, go back and forward; report a transcript, question or answer that is lost, duplicated or stale
teach-edge|web|fuzzer|Signed in (--session learner), starting at /chat/new, submit goals that are empty, whitespace, 300 characters, unicode and markdown, then answer a question with no option picked; report input that is accepted when it should not be, or an error that is missing
```

## Gotchas

- A goal without `zz-e2e` gets "zz-e2e fallback reply." from the fake model: not a bug.
- `GET /api/stt/token 503` on every page: dictation has no key in the isolated instance.
- The fake model never judges content; prompt or provider changes need a real model.

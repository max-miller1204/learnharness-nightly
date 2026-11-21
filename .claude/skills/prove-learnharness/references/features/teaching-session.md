# Teaching session

A learner types what they want to understand; the prober opens by finding where their understanding ends, using tools (reading files, asking graded questions) and the learner answers in the question card. The session, its tool calls and answers are stored and survive a reload; the learner can delete the session.

## Sub-features

- `create`: typing a goal in a new session creates the session and starts the first turn.
- `tool-read`: the agent reads a file and the result goes back to the model.
- `probe`: a graded multiple-choice question card with confidence and a thinking field.
- `answer`: picking an option and submitting sends the answer to the model; the card closes.
- `persist`: the transcript is in `data/chats/<id>.json` and shows after a reload.
- `delete`: right-click the session row, Delete, confirm: gone from sidebar, API and disk.

## How to get to it

- `/chat/new` (the `+ TEACHING` button, `data-testid="new-session"`), or `/` then the composer.
- API: `POST /api/chats {title}` then `POST /api/chat {chatId, input:{type:"text",text}}`.
- Desktop: the same pages inside the Electron window.
- Delete: sidebar row context menu (`ctx-delete`); API `DELETE /api/chats/<id>?mode=preserve-graph|delete-nodes`.

## Driving it

Preconditions: the baseline, `scripts/ensure-axe.sh` run once.

1. `node scripts/web-teach.mjs "$B"` then `node scripts/web-teach.mjs "$H"` (about 15 s each). Each prints a line per step:
   - goal typed, Enter -> URL becomes `/chat/<id>`, sessions +1.
   - fake prober calls `read` twice in one turn, on the no-final-newline fixture and then on the fixture -> `model-requests.jsonl` request 2 carries both `tool` messages, each equal to its file byte for byte.
   - fake prober calls `probe` -> `[data-testid="question-dock"]` shows "zz-prove-it: which colour of sunlight scatters most in air?" with options Blue and Red (shuffled).
   - click Blue, Submit answer -> request 3 carries `{"kind":"quiz","answers":[{"index":..,"label":"Blue"}],"correct":true,...}`; the page shows "zz-prove-it acknowledged your answer"; the card closes.
   - stored shape: `user, assistant[read,read], toolResult(read), toolResult(read), assistant[probe], toolResult(probe), assistant[]`.
   - reload `/chat/<id>` -> the reply is still there.
   - from `/chat/new`, right-click the row, `ctx-delete`, `delete-confirm` -> row, list entry and file gone.
   - three more sessions and a turn on the first -> the sidebar lists them first, third, second (`observations.sidebarOrder`), then they are deleted.
2. `node scripts/compare.mjs "$RUN/base/web-teach/result.json" "$RUN/head/web-teach/result.json" --out "$RUN/compare-web.md"`.
3. API side: `node scripts/api-check.mjs "$B"`, `"$H"`, compare.
4. Evidence: `$RUN/<side>/web-teach/0*.png`, `result.json`, `model-requests.jsonl`, `app.log`.

## Gotchas

- The option order is random on purpose; observations sort it.
- The fake prober's first rule needs the goal to contain `zz-prove-it`; the drive's goal does.
- Deleting the session you are viewing can log a 404 for `/api/chats/<id>/side-chats` on main; the drive deletes from `/chat/new` and that case is a break-it probe.
- A second drive on the same instance works (the drive resets the fake model's rules and only reads its own requests).

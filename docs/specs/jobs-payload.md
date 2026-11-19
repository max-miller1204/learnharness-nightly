# Trim the helper list (GET /api/jobs)

Status: approved by the owner on 2026-11-19.

`GET /api/jobs?chatId=` stops sending each helper's result, inputs, cost details and delivery bookkeeping. The cards that read this list only show status, so the web, desktop and phone apps look and behave as they do today, and every request gets much smaller. The data format does not change, so no protocol version change and no new capability is needed.

## 1. Starting point

### Why

The route returns each job's stored file as it is. There is no list projection, so the storage record, which was built for delivery and crash recovery, doubles as the wire shape. Every job write (each activity-line update included) announces `jobs-changed`, and every open web tab and phone on that lesson then refetches the whole list. Each refetch carries every finished helper's full result, even though no client reads it from this route.

### Current state (checked 2026-11-18 on origin/main `ac63833`)

- **Route.** It returns `{ jobs: listJobs(chatId), turnInFlight }` (`app/api/jobs/route.ts:14-23`). `listJobs` runs the throttled crash-recovery sweep and then returns the parsed `data/jobs/*.json` records verbatim (`src/server/jobs.ts:796-800`, `src/store/jobs.ts:69-75,93-105`).
- **Size.** Probe: the real route handler, run on a copy of the owner's desktop data (8 finished jobs in one lesson: 4 demo, 3 PDF, 1 visual), returned 200 with 104,005 characters. Gzipped, that is about 33 KB, which assumes Next's default compression. Inside that, `result` is about 82 KB, `input` about 11.5 KB, `usage` about 7.7 KB and `delivery` 0.3 KB. With those left out, the same list is about 2.4 KB (about 0.75 KB gzipped). The sample had no running, failed or plugin jobs, so their sizes were not measured.
- **Fetch triggers.** The store emits `jobs-changed` on create, update and delete (`src/store/jobs.ts:65,88,129`).
  - The web refetches on mount, per announcement (250 ms trailing debounce) and on resync (`components/chat.tsx:1424-1489`). The phone does the same (`apps/mobile/src/use-jobs.ts:9-46`, `apps/mobile/src/Workspace.tsx:62-63`).
  - The web also polls the route every 500 ms for up to 30 s while a send gets 409, only to read `turnInFlight` (`components/session-core.ts:76-78,109-117,576-583`).
- **Web readers.** The desktop app shows the same web pages from its server. Nothing in `electron/` reads this route (`electron/server-list.cjs:263`). All web readers:
  - `components/chat.tsx:1428-1460` reads `id`, `status` and `turnInFlight`.
  - `components/artifacts/dispatch-card.tsx:31-119` reads `toolCallId`, `status`, `error`, `plugin.label`, `plugin.toolName`, `createdAt` and `activity`. The refusal cards test the start of `error` with `isModelsRefusal` and `isProviderKeyRefusal`.
  - `components/plugin-renderers.tsx:71,90` reads `kind` and `toolCallId`.
  - `components/session-core.ts:109-117` reads only `turnInFlight`.
- **Phone readers** (`apps/mobile`):
  - `use-jobs.ts` reads `id` and `status`.
  - `lesson.ts:57-108` reads `kind`, `toolCallId`, `plugin.label`, `plugin.toolName`, `createdAt` and `status`.
  - `LessonParts.tsx:143-167` reads `status`, `activity` and `error`.
- **Where results come from.** Neither app reads `result`, `input`, `usage`, `delivery` or `plugin.input` from this route. Finished results reach both apps through the saved transcript's steer marker (`src/core/contracts/jobs.ts:167-185`, phone `LessonParts.tsx` `SteerCard`).
- **Other callers.** These keep needing full records from `listJobs`: the dock feed, which spreads `...job` and reads `usage` (`src/server/observability.ts:76-96`, `components/activity-dock.tsx:214`). Also `src/server/chats.ts:86`, `src/server/jobs.ts:694,765` and `src/store/jobs.ts:109,118`.
- **Which fields are optional.** In `JobRecord`, `input`, `delivery`, `result`, `usage`, `error` and `plugin` are optional, and so is `plugin.input`. `pluginId`, `toolName`, `workerId` and `requestId` are required inside `plugin` (`src/core/contracts/jobs.ts:21-60`). Leaving out only optional fields keeps every response a valid `JobsResponse`.
- **Client protocol.** `/api/jobs` is the `lesson-view-v1` extension. Its response type is `JobsResponse { jobs: JobRecord[]; turnInFlight }` (`src/client-protocol/index.ts:317-335`), and the published description is in `docs/specs/mobile-beta.md:21`. `tests/client-protocol.test.ts` fingerprints every declaration the contract reaches. Comments don't count, so the fingerprint changes only when a type does.
- **T3 Code** (`pingdotgg/t3code` at `3a51807`, 2026-11-18):
  - The server strips heavy optional parts before sending items to clients, in one wire projection that keeps the same item type (`apps/server/src/orchestration-v2/WireProjection.ts:158-205`): command output is removed, dynamic-tool input and output are compacted, and subagent text is truncated at 32 KB.
  - It marks removed output with `outputOmitted: true` (`WireProjection.ts:179`) because its client can fetch the item separately ("fetch it with getTurnItem", `packages/contracts/src/orchestrationV2.ts:1794`).
  - The sidebar list uses slim summaries (`orchestrationV2.ts:1060-1099,2206-2260`).
- **Shipped phone build.** **I could not verify this:** which commit the installed TestFlight build was made from. The consequence is none either way. A build from before #260 never calls this route, and a later one reads only the kept fields.
- **Existing tests.** `NODE_ENV=test npx tsx --test tests/jobs-route.test.ts tests/client-protocol.test.ts tests/chat-plugin-action-refresh.test.tsx` passes 20/20. `tests/jobs-route.test.ts` asserts only `id`, `status`, `activity` and `toolCallId`.

### First task, before any code

Re-probe the reader lists above with a fresh search of `components/`, `app/`, `lib/`, `src/`, `apps/mobile/src`, `electron/` and `plugins/`. If any client reads `result`, `input`, `usage`, `delivery` or `plugin.input` from `/api/jobs`, stop and report. Then confirm that one of the ThinkPad's Android emulators is free for P4.

## 2. Goals and non-goals

### Goals

1. **Smaller list.** Each job in a `GET /api/jobs` response has no `result`, `input`, `usage`, `delivery` or `plugin.input`. On the owner's 8-job data, the response is about 2.5 KB instead of about 104 KB.
2. **Kept fields.** Each job still carries `id`, `kind`, `chatId`, `toolCallId`, `status`, `activity`, `createdAt` and `updatedAt`. It also carries `error` and `plugin` (minus its `input`) when the stored record has them. `turnInFlight` is unchanged.
3. **Same behavior.** Helper cards on the web, the desktop app and the phone look and behave exactly as before: running (status line and timer), finished, failed, "needs model setup", "needs a provider key", "Dispatched…" for a call with no job yet, and plugin names. A helper that settles still triggers the transcript re-sync.
4. **Same format.** The protocol format is unchanged. `CLIENT_PROTOCOL_VERSION` stays the same, no capability is added, and every phone build and server version keep working together.

### Non-goals

- **No "left out" marker** (owner decision). T3 adds `outputOmitted` because its client can fetch the item separately. Ours never needs to, and a marker would be a new field needing a capability.
- **No route to fetch one job's result.** Results already arrive in the transcript.
- **No change to `GET /api/activity`** (deferred). It is a different consumer, it lists running jobs only, and the dock reads `usage` from it.
- **No change to how `listJobs` scans `data/jobs/`**, and no change to the recovery sweep's cost.
- **No caching, ETags, deltas,** or job data pushed over the events stream.
- **No shortening of `error`.** It is sent whole, because the refusal checks read its start.
- **No new or narrower contract type for the list.** A slimmer type would change the format.
- **No compression changes.**

## 3. Constraints

### Invariants

| Invariant | Where it is checked | Machine or human |
|---|---|---|
| `/api/jobs` never sends `result`, `input`, `usage`, `delivery` or `plugin.input`. | Route test in `tests/jobs-route.test.ts` (P1). | Machine |
| Only `/api/jobs` is trimmed. Every other `listJobs` caller still gets full records, and the recovery sweep still runs when `/api/jobs` is read. | `tests/activity-feed.test.ts` and `tests/job-delivery-recovery.test.ts` keep passing. P1 also reads the store after a request and proves a route read still reaches the recovery sweep. | Machine |
| The client protocol format is unchanged. | `tests/client-protocol.test.ts` passes with its recorded fingerprint untouched (P2). | Machine |
| Helper cards render the same on web and phone. | P3 and P4. | Machine (scripted user flows) |

### Stop and ask

Stop and report if:

- an app turns out to read a dropped field;
- the protocol fingerprint test trips;
- a dropped field turns out to be required in the type;
- no ThinkPad emulator is free. Wait for one; never swap in a weaker check.

### Left to the agent

- Where the trimming lives, as long as the invariants hold.
- Names, comment wording and test layout.
- The wording of the doc notes below.

### Compatibility

The posture: the format is unchanged and only optional fields are left out. This follows T3's wire projection (`apps/server/src/orchestration-v2/WireProjection.ts:158-205`), without its marker.

| Surface | Before | After |
|---|---|---|
| `GET /api/jobs` response | Full stored `JobRecord` per job | The same type without `result`, `input`, `usage`, `delivery` and `plugin.input` |
| `JobsResponse` type and fingerprint | `{ jobs: JobRecord[]; turnInFlight }` | Unchanged. A doc comment says this route never sends those fields. |
| Shipped phone builds | Read the kept fields only | Unaffected |
| New phone against an older server | n/a | Gets the extra fields and ignores them |
| `GET /api/activity` and other `listJobs` callers | Full records | Unchanged |

### Docs to update in the same PR

- `docs/specs/mobile-beta.md:21`: say that the listed jobs leave out those fields.
- Comments in `app/api/jobs/route.ts`, on `LESSON_VIEW_V1` and `JobsResponse` in `src/client-protocol/index.ts`, and the `/api/jobs` notes in `src/server/observability.ts:11` and `src/core/contracts/jobs.ts:167-170`.

### Promote on merge

Add one sentence to `docs/architecture.md` under "Background work" (owner decision): the chat's job list (`/api/jobs`) carries status only, never results, inputs, cost details or delivery bookkeeping; results reach clients through the saved transcript. The project has no invariant IDs or ADR folder, so nothing else is promoted.

## 4. Proof

### Verifies on

- The local test runner, for P1 and P2.
- The prove-learnharness web harness against a seeded local server, run beside the base commit, for P3.
- One of the ThinkPad's Android emulators (`LearnHarness_Pixel_6a_API_36` or `LearnHarness_Pixel_6a_API_36-2`, whichever is free), for P4. It uses the [mobile beta recipe](../../.claude/skills/prove-learnharness/references/features/mobile-beta.md) against the new server and the base server.

**Seed data** for P3 and P4:

- The existing lesson fixture (`tests/fixtures/mobile-lesson/`). It has a finished research job and a research call with no job.
- Three added job records in the same lesson:
  - a running job with an activity line;
  - an error job whose `error` is a models refusal;
  - a plugin job with `plugin.label`.

Each added record also carries a large `result` or `input`, so the trimming is visible.

### Checks

| # | Proves | Surface | Check | Where it runs | Pass signal |
|---|---|---|---|---|---|
| P1 | Goals 1 and 2, invariants 1 and 2 | `GET /api/jobs` response | Route test. Store a finished job with a large `result`, `input`, `usage` and `delivery`, and a plugin job with `plugin.input`, then call the handler. | `tests/jobs-route.test.ts`, local and CI | The kept fields are present with stored values, and the dropped fields are absent. The response is under a few KB. The store still holds the full record afterwards, and the route read reached the recovery sweep. `tests/activity-feed.test.ts` and `tests/job-delivery-recovery.test.ts` pass. |
| P2 | Goal 4, invariant 3 | Client protocol contract | `tests/client-protocol.test.ts` with no fingerprint edit | Local and CI | Passes, and the diff touches no recorded hash. |
| P3 | Goal 3 on web and desktop | The lesson page in a real browser | prove-learnharness web flow on the seeded server, beside the base commit. Open the lesson and compare every helper card, then read `/api/jobs` from the page. | Local prove run, receipt saved | Each card matches the base: finished line, "Dispatched…", running card with status line and timer, "needs model setup" with its button, plugin label. The page's `/api/jobs` body has none of the dropped fields. |
| P4 | Goal 3 on the phone | The phone app's lesson screen | Mobile beta recipe on a ThinkPad emulator, against the new server and the base server, with the same seed | ThinkPad emulator, receipt saved | Helper cards match the browser and the base server, and the running helper shows its status line and counting timer. |

Every check must pass to merge. Pass means every step shows its stated result. Anything else fails the step, and no check skips silently.

These checks did not apply:

- A separate Electron check: the desktop app shows the same web pages, and no `electron/` code changes.
- A live AI-model run (owner decision for the phone proof).
- Permission and entrypoint checklists: the route is read-only, and its auth and refusals are unchanged.

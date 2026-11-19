# Mobile session basics (mobile parity area 4)

Approved by the owner on 2026-11-18 (playback confirmed in four parts, no vetoes). The phone's session list gets the web sidebar's search, kind switch, Rename, Export as Markdown and Delete. This is area 4 in the owner's plan to bring every web and desktop feature to the phone. It builds on the [mobile beta spec](mobile-beta.md) and the [client protocol](client-protocol.md).

T3 references are to github.com/pingdotgg/t3code at `158394194c6ba4a3e2b0cd1c2bab28ceacdca7e1` (2026-11-18), under `apps/mobile/src/`.

## 1. Starting point

**Why.** The phone's session list is read-only (`apps/mobile/src/Workspace.tsx`). Protocol 1 kept rename and delete internal, and the Markdown export route was never added to the contract. The protocol's rule is that a client needing an internal route adds it with a capability (client-protocol.md, "Protocol 1 routes", approved 2026-11-17), so the phone never wired any of these up.

**Current state** (checked 2026-11-18 on `origin/main` 48e57b1 unless noted):

- **Web rename.** The sidebar's right-click menu swaps the row to an inline field, and the chat header has click-to-rename (`components/sidebar.tsx:366-417`, `:616-631`; `components/chat.tsx:369-437`). The server needs a non-empty trimmed title (400 otherwise, 404 for an unknown session). It does not bump `updatedAt`, so a rename never reorders the list (`app/api/chats/[id]/route.ts:47-66`). It emits `chats-changed` (`src/store/chats.ts:209-216`).
- **Web delete.** The menu's last item, "Delete…", opens the delete box (`components/delete-session-dialog.tsx`). It has a red "Delete session?" title, the session name, the body text, and one unchecked checkbox, "Also remove its graph traces" (`:12-17`). Unchecked sends `mode=preserve-graph`; checked sends `mode=delete-nodes`. On failure it shows the server's message with "Try again" and stays open (`:66-97`).
- **Server delete.** `DELETE /api/chats/:id?mode=…` requires the mode (400 `bad_mode`). It answers 404 for a missing session, 409 `turn_in_flight` or `jobs_running` while work runs, and 503 `extraction_winding_down` after a wait of up to 10 s (`app/api/chats/[id]/route.ts:68-115`, `src/server/chats.ts:30-34`, `:73-125`). The record file is the only copy and is removed for good (`src/server/chats.ts:144-170`).
- **Web export.** "Export as Markdown…" downloads `GET /api/chats/:id/markdown` (`components/sidebar.tsx:874-897`). The file is `text/markdown`, and its name is the slugified title plus `.md`, or `session.md` when the slug is empty (`app/api/chats/[id]/markdown/route.ts`).
- **Web search.** A field in the Sessions header filters the loaded list by title with `src/core/fuzzy.ts` `fuzzyScore`, ranked by score. An empty query keeps list order. The empty states are "No sessions match." with a query and "No sessions yet." without (`components/sidebar.tsx:449-467`, `:853-857`). Under it sits a Teaching / Practice / All switch, default All, remembered by the browser (`:419-438`, `:838-852`).
- **Phone.** The API client sends only GET and POST, and every success is parsed as JSON (`apps/mobile/src/protocol.ts:77-107`). Open PR #262 (photos and files, unmerged) widens the same function to DELETE and adds `expo-file-system`. Open PR #263 (unmerged) rewrites `Session.tsx` and `Transcript.tsx`, not the list. When the open session's read gets 404, the screen shows the server text with a Reconnect button that can never succeed (`apps/mobile/src/use-session.ts:146-147`).
- **T3.**
  - Rows open the system menu on a long press (`features/threads/thread-list-v2-items.tsx:1787-1788`, `@react-native-menu/menu`). The menu has Rename (`:1066-1068`) and a red Delete (`:187-194`), and rows also expose screen reader actions (`:1645`).
  - Rename is a prefilled prompt (`features/home/useThreadListActions.ts:623-652`): the iOS system prompt (`components/ui/Dialog.tsx:24-35`) and an in-app box on Android (`components/ui/Dialog.android.tsx:91`).
  - Rename and delete exist only on the list, not on the open thread.
  - Files are shared by writing them to the cache and calling `expo-sharing` `shareAsync`, with a one-day cache retention (`lib/attachmentDownload.ts:11`, `:66-100`).
- **Dark mode.** `app.json` sets `userInterfaceStyle: "automatic"`. `apps/mobile/src/theme.ts` picks Default or Ivory from the phone's setting. A grep found no hard-coded colors in `apps/mobile/src/*.tsx`. **I could not verify the cold-launch screen**: the app has no launch-screen setting and no `expo-splash-screen`, so it may flash white in dark mode. Until it is checked, assume it can.
- **Bearer access.** Every non-public path accepts a bearer token (`proxy.ts:21-46`). Bearer requests skip the cookie Origin rule (`src/server/auth.ts:45-66`), and tokens carry no roles. Only the web route and the graph's source deletion call rename or delete (`src/server/source-organization.ts:38`, `src/server/chats.ts:128`). **I could not verify live** that a phone bearer can rename, delete and export, because no server ran during homework. The first task checks it.
- **Invariants.** The project has no numbered invariants list and no ADRs.

**First task, before any code:**

1. Confirm #262 has merged. Build on top of it.
2. On a disposable server, check that a paired phone's bearer can `PUT /api/chats/:id`, `DELETE /api/chats/:id?mode=…` and `GET /api/chats/:id/markdown`.
3. Build a synthetic fixture: a session whose record contributed graph nodes, one shared with another source and one only its own. It must support proving both delete modes.

If any step fails, stop and report.

## 2. Goals and non-goals

**Goals**

1. A search field above the phone's session list filters by title with `fuzzyScore`, and gives the same order as the web sidebar for the same query and sessions.
2. A Teaching / Practice / All switch under the search (default All) filters the list and is remembered on the phone.
3. A long press on a session row opens the system menu (T3, `thread-list-v2-items.tsx:1787-1788`) with Rename, Export as Markdown and Delete, in the web's order with Delete red and last. It appears only when the server lists `session-basics-v1`.
4. Rename saves the new title. The browser's sidebar shows it, and neither list reorders.
5. Delete opens an in-app box in the web's look, with the web's text and the graph-traces checkbox (unchecked by default). The checkbox picks the mode sent. A refusal shows the server's message with Try again.
6. Export puts a `.md` file in the system share sheet, with the same bytes as the web's download for that session.
7. The new menu, boxes, search field and switch follow the phone's light or dark setting with the app's palette. A cold launch in dark mode shows no white flash. If one shows, the launch screen gets a background that follows the setting (Default dark, Ivory light).

**Non-goals**

- Rename, export or delete inside an open session (header or … menu). The owner chose the list only, like T3. It also stays clear of #263.
- Searching message text. The web searches titles only, and T3's content search would need a new server route.
- The web menu's extraction coverage block and manual Extract. **Deferred** to the Graph area.
- Swipe actions, undo, bulk delete and archive. The web has none of them.
- Any change to the server routes or delete rules. Delete stays offered while a reply runs, and the server refuses it.
- Live updates of an open web session header or graph view after a phone rename or delete. They update on reload, the same as between two browsers today (`components/graph-view.tsx:1193`, `:1225`).
- The theme picker on the phone. **Deferred** to the Settings screens area.
- Changes to the list row's text (time ago, waiting states).

## 3. Constraints

**Invariants**

| Invariant | Where enforced or detected | Kind |
| --- | --- | --- |
| Only the server deletes (`deleteChatSession`, `src/server/chats.ts:100`), and the phone sends DELETE only after Delete in the box | Phone unit test on the delete flow; emulator drive | machine |
| The mode sent always matches the checkbox at the moment Delete is pressed, Try again included | Phone unit test; emulator drive on the fixture | machine |
| The server owns titles: the phone sends the trimmed text and shows the server's title, never one of its own | Phone unit test on the rename rules | machine |
| A server without `session-basics-v1` shows no long-press menu, while search and the switch still work | Phone unit test; emulator drive on the pinned server `bfb1e5d` | machine |
| No server route changes, and the server lists the capability | `tests/client-protocol.test.ts` (server info and fingerprint) | machine |
| Every new surface uses `theme.ts` tokens | Emulator dark and light screenshots compared with the browser | machine |

**Rename (like T3, `useThreadListActions.ts:623-652`).** The rename prompt is titled "Rename session", is prefilled with the current title, and its button is "Rename". It is the iOS system prompt on iOS and an in-app box on Android.

- A blank title shows "Could not rename session" with "Session title cannot be empty." and saves nothing.
- An unchanged title does nothing.
- A failure shows "Could not rename session" with the server's message.

**Delete.**

- The box text is the web's, word for word (`components/delete-session-dialog.tsx:12-17`, `:152-166`).
- A network failure keeps the box open with Try again.
- If Try again gets 404, the session counts as deleted: the box closes and the row goes, because an earlier answer may have been lost after the server deleted it.

**Session deleted elsewhere.** A session open on the phone whose next read returns 404 shows "This session was deleted." with a Back to sessions button in place of Reconnect.

**Export.**

- The file name is the server's `Content-Disposition` name, cut to 100 characters before `.md`.
- Each export is written to its own cache folder.
- Exports older than one day are removed at the next export (T3, `attachmentDownload.ts:11`).
- A failure shows the server's message.

**Search and switch.**

- The query survives opening a session and coming back, and clears on a server switch.
- The empty states follow the web: "No sessions match." with a query, "No sessions yet." without.
- One tap on a result opens it while the keyboard is up.
- The switch's choice is stored once per phone, for all servers.

**Screen readers.** Each row exposes Rename, Export as Markdown and Delete as accessibility actions (T3, `thread-list-v2-items.tsx:1645`).

**Stop and ask:**

- #262 is not merged.
- A first-task check fails.
- The graph fixture cannot be seeded.
- `@react-native-menu/menu` does not build with this Expo and React Native.
- Any server change turns out to be needed.

**Left to the agent:** file and component names, how the delete box and the Android rename box are drawn, the contract's type and constant names, cache folder names, test layout, and how the launch screen is fixed.

**Compatibility**

| Surface | Before | After |
| --- | --- | --- |
| Server info `capabilities` | five capabilities | adds `session-basics-v1` |
| Contract (`src/client-protocol/index.ts`) | rename, delete, export not listed | listed under `session-basics-v1`, fingerprint updated on purpose |
| Phone on an older server | read-only list | search and switch; no long-press menu |
| Native app | current build | adds `@react-native-menu/menu` and `expo-sharing` (with #262's `expo-file-system`), so a new store build |

**Entrypoints.** The phone becomes a new caller of three existing routes: rename, delete and export. They are unchanged, and the owner confirmed the safety checklist line by line:

- Sign-in and revocation work as today.
- Bearer tokens skip the cookie Origin rule.
- No new public route is added.
- No test-only route is added.
- Any signed-in device may rename and delete.
- The teacher, plugins and jobs cannot.

Irreversible effect: deleting a session's record (and with the checkbox, its graph traces). Its single owner is `deleteChatSession`.

**Promote on merge.** Add `session-basics-v1` to the capability list in [client-protocol.md](client-protocol.md) in the same PR.

## 4. Proof

**Verifies on:**

- `apps/mobile` tests (`npm test`).
- The root test suite.
- The ThinkPad's Android emulator, through T3 device tools, against a disposable HTTPS server with the browser on the same server, following the [mobile proof recipe](../../.claude/skills/prove-learnharness/references/features/mobile-beta.md).
- The pinned `bfb1e5d` server for the old-server check.

Set up first: the graph-traces fixture (first task) and a fresh APK with the new native packages.

| # | Proves | Surface | Check | Where | Pass signal |
| --- | --- | --- | --- | --- | --- |
| 1 | Goals 1, 2; search and switch rules | Phone list logic | Unit tests: ranking equals `fuzzyScore` order, switch filtering and stored choice, both empty states, query kept across opening a session and cleared on server switch | `apps/mobile` `npm test` | All pass |
| 2 | Goal 4; rename rules | Phone rename logic | Unit tests: trim, blank refused with the message, unchanged sends nothing, failure shows the server's message | `apps/mobile` `npm test` | All pass |
| 3 | Goal 5; delete invariants | Phone delete logic | Unit tests: no request before Delete, mode follows the checkbox, 409 and 503 show the message with Try again, network failure keeps the box, 404 on Try again counts as deleted | `apps/mobile` `npm test` | All pass |
| 4 | Capability listed, contract changed on purpose | Server info | `tests/client-protocol.test.ts` with the new capability and fingerprint | Root test suite | Passes |
| 5 | Goals 1 to 6 end to end | The installed app beside the browser | Emulator drive covering: the same query in both apps; the switch; the long-press menu; renaming, then reading the browser sidebar; exporting and comparing the saved file with the web download; both delete modes on fixture copies, then checking the graph in the browser (shared node kept, own node gone only with the checkbox); delete during a held reply (409 shown); deleting in the browser a session open on the phone | ThinkPad emulator, disposable server | Every step shows its stated result. Export bytes are identical |
| 6 | Old-server invariant | Installed app | Connect to `bfb1e5d` | ThinkPad emulator | No long-press menu; search and switch work |
| 7 | Screen reader actions | Installed app | With TalkBack on, reach Rename, Export and Delete on a row | ThinkPad emulator | All three are listed and work |
| 8 | Goal 7 | Installed app beside the browser | Dark and light screenshots of the menu, both boxes, search and switch against the browser's Default and Ivory; a cold launch in dark mode | ThinkPad emulator | No palette difference not caused by phone layout; no white flash |

Every check must pass to merge. Pass means every step shows its stated result. Anything else fails the step.

**Human check (recorded, not proof).** The owner repeats the iOS-only parts on the TestFlight build: the iOS rename prompt, the system menu, the share sheet and Files save, and the cold launch in dark mode. The Mac cannot run a simulator, so no machine check covers these.

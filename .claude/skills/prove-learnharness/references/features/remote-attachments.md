# Remote attachments: files and folders

A paired browser, or the desktop app connected to a remote server, uploads files and whole folders from the composer to the server. A folder keeps its layout, shows as one chip with its file count, and the agent browses it through its opaque reference with `ls`, `find`, `grep` and `read`. Spec: `docs/specs/remote-safe-attachments.md` (PR 1 individual files, PR 2 remote folders); contract: `src/client-protocol/index.ts`; storage: `src/store/attachments.ts`.

## Sub-features

- `files`: Files from the paperclip menu uploads each file with progress, Retry and Remove (PR 1).
- `folder-button`: Folder from the paperclip menu (`input[type=file][webkitdirectory]`, `data-testid="attach-folder-input"`), offered on every device, desktop and phone alike.
- `folder-drop`: dropping files or folders anywhere in the content area of a page with an uploading composer. The overlay reads "Drop to upload files or a folder". The desktop app on its own local server keeps path chips instead.
- `skip`: hidden entries (any name starting with `.`), `Thumbs.db`, `desktop.ini` and `__MACOSX/` are skipped before counting, with a `role=status` line such as "Skipped 3 hidden or system files in Notes: .git/, .DS_Store, sub/Thumbs.db".
- `limits`: 100 files and 256 MiB per folder after skipping, plus PR 1's per-file, per-image, per-message, staging and per-chat limits. The `role=alert` line names the limit and nothing uploads.
- `unsafe`: an unsafe path (`..`, absolute, backslash, device name such as `CON.txt`, `CONIN$` or `CON .txt`, C0 or C1 control characters, `<>:"|?*`, trailing dot or space, duplicates ignoring case, file and folder at one path) rejects the whole folder before any request, naming the entry.
- `no-relative-paths`: a browser that returns plain files from the folder input (iOS before 18.4, Android Chrome before 132) gets "This browser can't attach folders. Attach individual files instead." and nothing uploads.
- `renew`: Retry, or an upload that outlives its 10-minute grants, calls `POST /api/attachments/:id` and re-sends only the files that have not arrived.
- `send`: the folder id rides in `attachmentUploadIds`; the saved message carries `{ id, name, fileCount }` and the chip reads "Notes · 3 files" after reload.
- `agent-browse`: `ls attachment:<id>`, `find`, `grep` and `read attachment:<id>/<path>` work in restricted File access mode with no allowed folders, and no output or error contains the storage path.
- `draft-back`: an unsent upload comes back after leaving the session and pressing Back or reloading (`lib/attachment-drafts.ts`, stored per session under `lh:composer-attachments:v1:<chatId>`). A restored chip is checked with `GET /api/attachments/:id?chatId=` (capability `attachment-status-v1`) and drops quietly on 404. An upload still running when the learner leaves is cancelled and released.
- `cleanup`: deleting the chat removes `claimed/<id>/` on the next sweep; an unsent folder expires with its files.

## How to get to it

- Web: `/chat/new` or `/`, the paperclip (`data-testid="attach-files"`), then the menu items `Files` or `Folder`. In a chat, the composer at the bottom.
- Drop: drag onto the content area (`data-testid="file-path-drop-zone"`); the receiving element is `[data-attachment-upload]` inside the composer.
- API: `POST /api/attachments` with `{ draftId | chatId, name, files: [{ path, mimeType, size }] }`, PUT each `uploadUrl`, `POST /api/attachments/:id` to renew, `DELETE /api/attachments/:id`, then `POST /api/attachments/start` or `POST /api/chat` with `attachmentUploadIds`. Server info lists `attachment-folders-v1`.
- Disk: `<DATA_DIR>-attachments/pending/<id>.folder.json` and one `<file id>.json|.body` per file; after send, `<DATA_DIR>-attachments/claimed/<id>/<layout>`.

## Driving it

Preconditions: the Feature README baseline, but start head with the folder scenario: `H=$(scripts/start.sh "$RUN" head scenarios/attachment-folder.json)`. The production server must run behind the production proxy (start.sh does) so the PUT route's own pairing checks are what is exercised. Set File access to restricted with no folders (Settings, Agent, Tools, File access, or `PUT /api/settings/agent` with `fileAccess: { restricted: true, folders: [] }`). The base build has no folder support (a new flow): compare against the spec, and run PR 1's file flow on base and head for the existing-flow check.

Build the fixture folder in the run folder, never in the repo:

```
$RUN/fixtures/Notes/week1/intro.md      (one line: PROVE-FOLDER-SKY scatters blue light)
$RUN/fixtures/Notes/week1/data/table.csv
$RUN/fixtures/Notes/README.txt
$RUN/fixtures/Notes/.git/HEAD           (skipped)
$RUN/fixtures/Notes/.DS_Store           (skipped)
$RUN/fixtures/Notes/sub/Thumbs.db       (skipped)
```

1. Button, desktop browser (Puppeteer or Playwright, signed in as the paired browser): open `/chat/new`, click `attach-files`, then the `Folder` menu item, and accept the file chooser with the `Notes` directory (`FileChooser.accept([dir])` gives a real `webkitdirectory` pick). Expect one chip "Notes · 3 files", the skipped line naming `.git/, .DS_Store, sub/Thumbs.db`, one `POST /api/attachments` whose `files` lists exactly `README.txt`, `week1/data/table.csv`, `week1/intro.md`, then three PUTs answered 204.
2. Send "zz-prove-it folder: what does my week 1 note say?". The fake prober calls `ls`, `find`, `grep` then `read` with `{{attachmentRef}}`. In `model-requests.jsonl` check: the user message carries `attachment:<id> "Notes" (folder, 3 files. Browse it with ls, find or grep, and open files as attachment:<id>/<path>)`; the tool results are `README.txt\nweek1/`, `week1/intro.md`, `week1/intro.md:1: PROVE-FOLDER-SKY ...` and the file text; no request or transcript contains `-attachments/claimed`. Reload: the saved chip still reads "Notes · 3 files" and the answer is there.
3. Drag and drop: in a desktop browser drive, dispatch a real drop of the `Notes` directory (Playwright `page.dispatchEvent` cannot carry directories: use CDP `Input.dispatchDragEvent` with the directory path, or the Electron app connected to the remote head instance and a manual drop). Expect the overlay text and the same chip, manifest and PUTs as step 1. On the Electron app with its local server, the same drop still inserts a quoted folder path chip.
4. No relative paths: on the Folder input, set plain files with `elementHandle.uploadFile(file1, file2)` (no `webkitRelativePath`). Expect the alert "This browser can't attach folders. Attach individual files instead." and no `POST /api/attachments`.
5. Android Chrome, if an emulator with Chrome 132+ is available: open the device with the device tools, `adb reverse` the head port, pair the phone browser, open `/chat/new`, choose Folder and pick a subfolder of Download holding the fixture (Android 11+ refuses the Download folder itself, internal storage root and SD card roots). Expect the same chip and manifest. Record the Chrome version.
6. Break it:
   - A folder with `sub/CON.txt`, one with `A.md` and `a.md`, and one with 101 files: each shows its alert and sends no request. Then POST the same manifests directly: 400 or 413, and `pending/` gains no entry.
   - Throttle the network (CDP `Network.emulateNetworkConditions`) so uploads outlast the grant, or abort one PUT: Retry calls `POST /api/attachments/:id` and only the missing files are PUT again.
   - Remove the chip mid-upload: no further PUTs start, then one `DELETE /api/attachments/:id`, and `pending/` loses the folder and its files.
   - From a second chat, `read attachment:<id>/week1/intro.md` is refused as not part of the current chat; `read attachment:<id>/../x` is "Path not found"; `ls` of the claimed directory path is a protected location.
   - Delete the chat: after the sweep `claimed/<id>/` is gone.

7. Unsent attachment and Back (`draft-back`): `node scripts/web-attachment-draft.mjs "$H"` attaches in session A, goes to session B and presses Back (chip restored, status check 204, sends with the attachment), reloads with a finished upload, leaves and reloads during a throttled upload (CDP `Network.emulateNetworkConditions`: nothing stored, transfer aborted, reservation released, no second grant), deletes the server's pending files while away (the chip drops with no alert and the text still sends) and loads corrupt stored state. It requires the `attachment-status-v1` capability; a build without it fails the Back step. It also presses Send while server info is slow, and the saved chip must still go with the message.

Evidence: screenshots of the chip, skipped line and alerts, the network log of attachment requests, `model-requests.jsonl`, the saved `data/chats/<id>.json` attachments entry and a listing of `claimed/<id>/`.

## Gotchas

- `scenarios/attachment-folder.json` needs the message to contain `zz-prove-it folder` and the folder to hold `week1/intro.md` with `PROVE-FOLDER`; `{{attachmentRef}}` is the first `attachment:<id>` the app sent the model.
- Chromium sends folder picks as File objects whose `webkitRelativePath` starts with the folder name; the composer strips it, so manifest paths never include `Notes/`.
- Uploads are refused while a turn runs, for the button and for drops alike: during a turn the drop overlay does not appear at all.
- Grant timing follows the server's `Date` header: set the browser's clock an hour ahead or behind (for example with a `Date.now` override injected before load) and uploads and Retry still behave.
- Names that only start with two dots (`..notes.txt`, `..config/`) are hidden names: the composer skips them and lists them in the skipped line. A manifest sent straight to `POST /api/attachments` with them is accepted, claimed into `claimed/<id>/` and readable by the agent.
- The composer stops starting new files 30 seconds before a grant's deadline, lets running PUTs finish, then renews: expect `POST /api/attachments/:id` between batches on a slow link, and no PUT that starts after its grant expired.

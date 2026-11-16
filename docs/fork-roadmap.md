# Fork roadmap

Future work for `max-miller1204/learnharness-nightly` that was considered while planning the self-hosted nightly server and deliberately **not built yet**. Each entry is a starting spec, not a commitment.

How to read an entry:

- **Decided** lists choices already made with the owner. Treat them as settled unless you reopen them on purpose.
- **Proposed design** is a starting point only. **Nothing in it is approved.** Settle the open questions with the owner before building.
- **Touches core** says whether the work edits app code. That's allowed: this fork is expected to change the core heavily, and upstream arrives only through a reviewed Sync PR. The note is there so you can judge how much each item adds to future Sync PR conflicts.

Baseline the entries build on (the self-hosting plan):
- Update logic lives in the server (`src/server/self-update.ts`, `/api/updates`, `/api/health`), and the desktop update banner and Settings row are reused through a web transport.
- The separate `lh` launcher in `selfhost/` swaps versions, health-checks, rolls back and keeps snapshots.
- Versioned installs under `~/.learnharness/runtime/versions/`, and the `learnharness.service` systemd user unit.
- The server binds 127.0.0.1:3774, with optional Tailscale Serve on 8443.
- Upstream is mirrored hourly to `upstream-main` with a standing Sync PR. Upstream PRs come in through the "Import upstream PR" workflow, authenticated with `FORK_BOT_TOKEN`.

One structural rule carries over to every entry: **the launcher stays a separate process from the server.** It's what recovers from a broken version, so recovery logic must never depend on the server working.

## Index

Rows are in build order. **Order** is the planned sequence, after the self-hosting plan is built. **#** is a stable ID from the planning conversation (not a priority), so references to an item never change when the order does.

| Order | # | Item | Group | Depends on | Touches core |
|---|---|---|---|---|---|
| 1 | 20 | Gemini CLI and Codex CLI providers | Providers | none | Moderate (new provider folders, Settings rows) |
| 2 | 12 | Preview builds of PRs | Review workflow | none | Small |
| 3 | 13 | Upstream issue intake | Review workflow | none | No |
| 4 | 6 | Login and pairing | Access + security | none | Yes |
| 5 | 1 | Electron desktop nightlies | Desktop + distribution | none | Small (`electron/main.cjs`) |
| Later | 2 | Removing Electron | Desktop + distribution | none | Yes (deletions) |
| Later | 3 | macOS self-hosting | Desktop + distribution | none | No |
| Later | 4 | Docker image | Desktop + distribution | none | No |
| Later | 5 | LAN mode | Access + security | 6 | Small |
| Later | 7 | Update deadline | Ops + polish | none | Small (`self-update.ts`) |
| Later | 8 | Chromium on demand | Ops + polish | none | No |
| Later | 9 | GitHub App instead of a personal token | Access + security | none | No |
| Later | 10 | Side-by-side installs | Desktop + distribution | 11 | No |
| Later | 11 | Stable channel | Desktop + distribution | none | Small (update UI channel picker) |
| Later | 14 | Keep the machine awake during agent work | Ops + polish | none | Small |
| Later | 15 | Resource limits for agent processes | Ops + polish | none | Yes |
| Later | 17 | Failure and conflict notifications | Ops + polish | none | Small |
| Later | 18 | Signed releases | Access + security | none | Small (`release.ts`) |
| Later | 19 | Scheduled and off-machine backups | Ops + polish | none | No |
| Later | 21 | Client protocol and server info | Clients + remote access | 6 | Yes |
| Later | 22 | Mobile web app (PWA) | Clients + remote access | 6, 21 | Small |
| Later | 23 | Desktop server list (choose a backend) | Clients + remote access | 6, 21 | Moderate (`electron/`) |
| Later | 24 | Remote-safe attachments | Clients + remote access | 6 | Yes |
| Later | 25 | Office and data formats | Files + ingestion | none | Yes |
| Later | 26 | More file types in Extract files | Files + ingestion | 25 | Yes |
| Later | 27 | @-mentions for files and folders | Files + ingestion | none (remote use: 24) | Yes |

"Later" items have no order yet; they're listed by ID. Item 16 (in-app update status) moved into the self-hosting plan itself.

Why this order: 20 was agreed as next. 12 and 13 help with reviewing upstream work, the main job of this fork. 6 unlocks 5 and any remote access beyond Tailscale. 1 is the largest single project.

Items 21 to 24 come from comparing LearnHarness with T3 Code and OpenBot (`nightly-labs/openbot`): in both, the server is the product and every app (desktop, web, phone) is a client that connects to a server you choose. All four need login and pairing (6) first. If they're built, the suggested order among them is 21, 22, 24, 23.

Items 25 to 27 cover the owner's ingestion workflow (PDFs, code, spreadsheets and more) and file mentions in the composer. They don't depend on remote access, except that @-mentions from a phone only reach files the server can see.

---

## Providers

### 20. Gemini CLI and Codex CLI providers

**Why.** Reach models that LearnHarness can't use today, the same way Claude Code is used now: as an external CLI that LearnHarness drives as a model.
- **Gemini CLI:** Google/Gemini subscriptions aren't reachable any other way. Today Gemini is API-key only.
- **Codex CLI:** the ChatGPT sign-in only shows part of OpenAI's lineup. Per the owner it offers the models from the ChatGPT chat product, not the newer Codex models (the owner sees only one new model there). The Codex CLI uses Codex's own login and routing and exposes its full model list.

**Decided.**
- **Scope is small on purpose:** add these two CLIs, each built **exactly like the Claude Code provider**. No new agent architecture, no ACP layer, no builder-job agents, no multi-provider framework. Keep changes to the core small.
- Each CLI is a **model**, not an agent: its own tools turned off, LearnHarness's tools only, LearnHarness keeps the agent loop and the transcript.
- Rejected for now: Grok CLI and GitHub Copilot CLI (they duplicate the existing Grok and Copilot sign-ins), Cursor CLI, OpenCode, Kiro, Antigravity, and letting a CLI run as a full agent.
- Built **after** the self-hosting plan.

**Facts.**
- The template is `src/agent/claude-code/` (`binary.ts`, `installation.ts`, `launch.ts`, `stream.ts`, `cli-events.ts`, `tool-bridge.ts`, `transcript.ts`, `reuse-context.ts`, `context-window.ts`, `live-processes.ts`, `provider.ts`, `constants.ts`), plus `src/core/contracts/claude-code.ts` (provider ID and minimum version), `app/api/claude-code/route.ts` (status), the `tests/claude-code-*.test.ts` suites and `docs/claude-code.md`.
- How Claude Code is run (`docs/claude-code.md`): no shell, an empty temporary folder per child, built-in tools, hooks, slash commands, session saving and `CLAUDE.md` loading all turned off. LearnHarness's tools go through a token-protected loopback MCP bridge, and a tool call only runs if an authenticated MCP request matches the streamed call. It's an app-wide opt-in under **Settings → Providers → External CLI**, off by default, with a minimum-version check.
- Why the ChatGPT sign-in hides models: `refreshChatGPTModels` in `src/agent/chatgpt-bridge.ts` keeps an account model **only if** it's also in Pi's `openai` catalog with the Responses API. Models the account offers that aren't in that catalog are dropped without notice. Pi has a separate `openai-codex` provider (mentioned in `src/core/auth-keys.ts`), so Codex-only models may be filtered out here. Not yet confirmed.
- T3 Code (MIT) has a Codex driver to learn from: `apps/server/src/provider/CodexProvider.ts`, `CodexInstallation.ts`, `CodexManagedRuntime.ts` and `CodexChatGptModels.ts` in `pingdotgg/t3code`. Code copied from it must keep T3's MIT notice. LearnHarness is AGPL-3.0-only.

**Proposed design (not approved).**
- Two sibling folders, `src/agent/gemini-cli/` and `src/agent/codex-cli/`, mirroring `claude-code/` file by file: discovery, version gate, launch with tools off, stream parsing into LearnHarness events, the MCP tool bridge, cancellation and child cleanup.
- Move code into a shared helper only where the three are truly identical (likely the MCP bridge and child-process cleanup), and only if that keeps the Claude Code tests passing unchanged. Otherwise accept some duplication to keep the change small.
- Matching contracts (`src/core/contracts/gemini-cli.ts`, `codex-cli.ts`), status routes (`app/api/gemini-cli`, `app/api/codex-cli`), and two more rows under **Settings → Providers → External CLI**, each off by default.
- Docs `docs/gemini-cli.md` and `docs/codex-cli.md`, written like `docs/claude-code.md`.

**Open questions.** Each must be checked against the real CLI before building:
- Can **all** built-in tools be turned off (shell, file edits, web search, and for Codex its sandboxed commands), leaving only MCP tools? If a CLI can't guarantee that, it doesn't qualify.
- Does it have a headless mode that streams structured events (text, tool calls, usage) good enough for LearnHarness's stream and cost meter?
- Can it be pointed at a per-turn MCP server from the command line or an inline config, without touching the user's own config files?
- Can it be stopped from loading its own instruction files (Gemini's `GEMINI.md`, Codex's `AGENTS.md`), the way `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` does for Claude?
- Which model IDs does each list, and how are they discovered (a command, a config, or a fixed list)?
- Minimum versions to require.
- Related, smaller fix to look at separately: should the ChatGPT sign-in also accept models from Pi's `openai-codex` catalog, or show which account models it dropped?

**Build outline.** (1) Spike each CLI against the open questions and write down the exact flags. (2) Codex CLI provider plus tests (stream fixtures, opt-in, status route, Settings row). (3) Gemini CLI provider the same way. (4) Docs. (5) Check that both work in the self-hosted install (found on the service's PATH, login done under the same OS user).

**Touches core.** Moderate: two new provider folders, contracts, routes, Settings rows and the model catalog. Existing Claude Code behavior stays unchanged.

---

## Desktop + distribution

### 1. Electron desktop nightlies

**Why.** A native app on Mac, Windows and Linux that tracks fork `main`, for when a browser tab on the self-hosted server isn't enough.

**Decided.** Not part of the self-hosting work. The owner has an Apple Developer Program membership, so signed and notarized Mac builds are possible.

**Facts.**
- `electron-builder.yml` hard-codes `appId: com.learnharness.LearnHarness`, `productName: LearnHarness`, `mac.notarize: true`, and `publish` to `provider: github`, `owner: amosblomqvist`, `repo: learnharness`, `releaseType: draft`.
- The inherited `.github/workflows/release.yml` uses secrets `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, and already overrides config on the command line (`-c.mac.notarize=false`). The self-hosting plan disables this workflow in the fork.
- `electron/main.cjs` sets `app.setName(PRODUCT_NAME)` from a hard-coded `"LearnHarness"`, so every build uses the same data folder (`~/.config/LearnHarness` on Linux). It checks for updates every 24 hours with electron-updater, and `LH_UPDATE_FEED` can point it at a generic feed.
- T3 Code signs with a Developer ID certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`) and notarizes with an App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). It uses **deferred notarization**: it submits to Apple, keeps building the other platforms, and waits only in a final "Await notarization" step. Notarization is an automated scan, usually minutes. The upstream notes saw about 2 hours.

**Proposed design (not approved).**
- A `desktop-nightly.yml` workflow runs after the server nightly and attaches desktop assets to the **same** `v<version>-nightly.<date>.<run>` prerelease. Matrix: `macos-26` arm64 (signed and notarized), `windows-2025` x64 (unsigned), `ubuntu-24.04` x64 (AppImage and deb, unsigned).
- Point the update feed at the fork: edit the `publish` block in `electron-builder.yml` (owner `max-miller1204`, repo `learnharness-nightly`, `releaseType: prerelease`).
- Give the nightly its own identity so it installs beside an upstream stable app: `appId: com.learnharness.LearnHarness.Nightly`, `productName: LearnHarness Nightly`, and change `PRODUCT_NAME` in `electron/main.cjs` (or read it from `package.json`) so its data lives in its own folder.
- Notarize with the App Store Connect API key, using T3-style deferred waiting.
- Reuse the existing gates from `release.yml`: `smoke-provider-runtime.mjs --standalone/--runtime` and `smoke-demo-runtime.mjs --browser`.

**Open questions.**
- Does electron-updater accept prerelease versions from a GitHub prerelease feed with the current `main.cjs` settings (`allowPrerelease` and channel detection from a `-nightly` version)? Verify first.
- Should Windows be signed (T3 uses Azure Trusted Signing)? Unsigned shows a SmartScreen warning.
- Mac x64 as well, or arm64 only?
- Should the desktop app and the self-hosted server share one data folder on a machine that runs both?

**Build outline.** Create the Developer ID Application certificate and an App Store Connect API key, then add the five secrets. Make the identity and feed edits. Write `desktop-nightly.yml` with deferred notarization. Test-install all three. Check that auto-update moves from one nightly to the next.

**Touches core.** Small: `electron-builder.yml` and one constant in `electron/main.cjs`.

### 2. Removing Electron

**Why.** A smaller repo and less to maintain if the fork only ever ships the server.

**Decided.** Not now, mainly to keep item 1 possible.

**Proposed design (not approved).** Delete `electron/`, `electron-builder.yml`, `release.yml`, the `desktop:*` npm scripts and the desktop docs. Remove desktop-only branches in `src/` (`src/server/desktop-access.ts` desktop-secret path, the Electron transport in `useUpdateState`, subscription bridges that assume Electron main). In Sync PRs, upstream edits to deleted files show up as "you deleted it, they changed it" conflicts. Resolve those by keeping them deleted, or mark the paths `merge=ours` in `.gitattributes`.

**Open questions.** Is item 1 ever wanted? Is `merge=ours` acceptable, given it hides upstream's desktop changes?

**Touches core.** Yes (deletions plus removing desktop branches).

### 3. macOS self-hosting

**Why.** Run the self-hosted server on a Mac (for example a Mac mini at home).

**Decided.** The first release is Linux x64 and arm64 only.

**Proposed design (not approved).** Add `darwin-arm64` to the nightly matrix (`macos-26` runner, bundled Node for darwin). Add a launchd backend in `selfhost/src/service.ts`: a `~/Library/LaunchAgents/com.learnharness.server.plist` with `KeepAlive` and `RunAtLoad`, chosen by platform behind one interface (`install`, `start`, `stop`, `restart`, `status`, `logs`).

**Open questions.** Sign the `node` binary and native modules? Test Gatekeeper with archives extracted by `curl`. Intel Mac too? Add Homebrew paths for `claude` and Chrome to PATH?

**Build outline.** Add the matrix entry and the launchd backend, make `install.sh` accept Darwin, add Mac Chrome paths, and run the end-to-end test from the self-hosting plan on a Mac.

**Touches core.** No.

### 4. Docker image

**Why.** For hosts without systemd, NAS boxes, or people who prefer containers.

**Decided.** Dropped as the main path because a container can't use the host's `claude` program, its login or the host's Chromium. A Docker attempt was built and then reverted.

**Proposed design (not approved).** Build the image **from the same nightly tarball**: `FROM debian:bookworm-slim`, copy in `node/` and `server/`, add `chromium`, data on a `/data` volume. Push `ghcr.io/max-miller1204/learnharness-nightly:nightly` and `:<version>` for amd64 and arm64. Document that API-key and subscription providers work but CLI providers (Claude Code, and item 20's Gemini and Codex CLIs) don't, unless installed in the image.

**Open questions.** Should the container run `lh __service` (rollback, backups) or `server.js` directly and leave updates to the container platform? How should it be protected, given there's no login until item 6?

**Touches core.** No.

### 10. Side-by-side installs

**Why.** Run nightly and stable (item 11), or two nightlies, on one machine.

**Decided.** The first release uses one install: `~/.learnharness`, `lh`, `learnharness.service`.

**Proposed design (not approved).** Install-wide names come from a single "instance" setting: `lh --instance stable …` gives `~/.learnharness-stable`, `lh-stable` and `learnharness-stable.service`, with its own port (`lh up` picks the next free one) and Tailscale Serve port.

**Open questions.** Separate data per instance (sharing is risky because versions upgrade records in place)? Should the default instance keep the plain names?

**Touches core.** No.

### 11. Stable channel

**Why.** A slower, safer track: only builds that have run as nightlies for a while.

**Decided.** Not in the first release. T3 builds its stable releases from the commit of the latest published nightly.

**Proposed design (not approved).** A manual `promote-stable` workflow republishes a chosen nightly's tarballs as `v<version>-stable.<n>` and updates a fixed `stable` pointer release with its own `latest.json`. A channel picker in **Settings → Updates** (and `lh channel stable|nightly`) chooses which feed `self-update.ts` reads. Moving from nightly to an older stable is a downgrade, so it goes through the launcher's restore question.

**Open questions.** What makes a nightly eligible (age, manual pick)? Version scheme? Should the server ever downgrade on its own?

**Touches core.** Small (feed choice in `self-update.ts`, picker in the update settings).

---

## Access + security

### 6. Login and pairing

**Why.** LearnHarness has no login: anyone who can reach the port can read every chat, change saved keys and start agent turns (`docs/development.md`). That's fine today because the server binds 127.0.0.1 and remote access goes through Tailscale. A login is required before LAN mode (item 5) or any public tunnel.

**Decided.** No login in the first release.

**Proposed design (not approved).** Build it **into the app**, copying T3's pairing model:
- An auth check in `proxy.ts`, next to the existing `apiRequestRefusal`, covering pages, API, server-sent events and the streamed documents route (which enforces the policy itself today).
- `lh pair` (or a Settings button on an already-paired device) creates a one-time code and QR code. Opening `/pair#token=…` trades it for a long-lived, `HttpOnly`, `SameSite=Strict` session cookie for that device.
- Settings → Devices lists paired devices and revokes them. `lh devices` does the same from the terminal.
- Requests from 127.0.0.1 with the launcher's token (for `lh status` and the health check) bypass pairing.
- Alternative if in-app proves awkward: a proxy inside the launcher in front of the server.

**Open questions.** Trust Tailscale identity (skip pairing on the tailnet) or always pair? Session lifetime? Rate limiting and lockout? How does this interact with the desktop app's per-launch secret mode (keep both paths)? Non-browser clients (the desktop server list in 23, a native phone app) can't rely on a cookie: should pairing also issue a bearer token for them?

**Build outline.** Session store in `userdata/`, the `proxy.ts` gate and its tests (including SSE and the documents route), the pairing page, the devices UI, then the `lh` commands. Then unblock item 5, any tunnel, and items 21 to 24.

**Touches core.** Yes (`proxy.ts`, a new auth module, Settings UI).

### 5. LAN mode

**Why.** Reach the server from phones and laptops on home Wi-Fi without Tailscale.

**Decided.** Left out of `lh up` because with no login, anyone on the network gets full access.

**Proposed design (not approved).** `lh up --lan` binds `0.0.0.0` (allowed only once item 6 is on) and prints the machine's LAN URLs. The app already accepts IP-address Host headers. Optional: an mDNS name such as `learnharness.local`, which then goes into `LH_ALLOWED_HOSTS`.

**Open questions.** Is plain HTTP on the LAN acceptable (the session cookie would travel unencrypted), or is a locally trusted certificate needed?

**Touches core.** Small. **Blocked on item 6.**

### 9. GitHub App instead of a personal token

**Why.** `FORK_BOT_TOKEN` is a fine-grained personal access token that expires and is tied to your account.

**Decided.** The first release uses the personal token (Contents, Pull requests, Issues: read/write on this fork only).

**Proposed design (not approved).** A private GitHub App with the same permissions, installed only on the fork, storing `FORK_BOT_APP_ID` and `FORK_BOT_PRIVATE_KEY`. Workflows mint a short-lived token with `actions/create-github-app-token`. PRs show the app as author and still trigger CI.

**Open questions.** Keep both (app if configured, otherwise the token)?

**Touches core.** No.

### 18. Signed releases

**Why.** Today `release.ts` checks each download's SHA-256 against `latest.json`, but both come from the same GitHub release. Anyone who can change the release can change both.

**Decided.** The first release uses SHA-256 only.

**Proposed design (not approved).** Pick one of two options:
- Sign `latest.json` and the tarballs with an Ed25519 key kept in CI secrets. `release.ts` and `install.sh` carry the public key and refuse anything unsigned.
- Use GitHub build provenance (`actions/attest-build-provenance`) and verify with `gh attestation verify`, which needs `gh` on the host.

Key rotation would ship a new public key inside a release signed by the old one.

**Open questions.** Which option? Is depending on `gh` on the host acceptable? What's the recovery plan if the key is lost?

**Touches core.** Small (`release.ts`, shared by the server and launcher).

---

## Clients + remote access

How the two reference products work, so the entries below can point at them:

- **T3 Code** (MIT, `pingdotgg/t3code`): the same `t3` server runs on a desktop, a VPS or anywhere else. The desktop app, a web client and a phone app connect to a server. Pairing codes are the lock, T3 Connect is a hosted relay for remote access, and `t3 environment link` connects machines.
- **OpenBot** (`nightly-labs/openbot`, PolyForm Noncommercial: read for ideas, don't copy code): the same server runs inside the desktop app, on its managed servers, or on your own Linux box (`docs/self-hosted-server.md`). Every server signs in to your OpenBot account and shows up in a server list in the desktop, iPhone and web apps. Clients and servers speak a frozen, versioned protocol with optional capabilities (for example `storage-v1`); a client hides a feature its server doesn't advertise.

What LearnHarness already has toward this: a standalone, versioned, self-updating server; a UI the server ships itself (so UI and server versions always match); `/api/health`; the `/api/events` channel; and the launcher protocol as a working example of frozen, versioned messages. A relay or account service (T3 Connect, OpenBot accounts) and a native phone app are deliberately not listed: they're hosted infrastructure or app-store work to consider only after these.

### 21. Client protocol and server info

**Why.** Today the API is internal Next.js routes that change freely. That's fine while the server ships its own UI, but any client released separately (a native phone app, a desktop app pointed at a remote server) lags behind the server and needs a contract it can rely on.

**Decided.** Nothing yet.

**Proposed design (not approved).**
- A server-info endpoint (or an extended `/api/health`) reporting the server version, a client protocol version and a list of capabilities, OpenBot-style: for example `attachments-upload-v1` (24) or `pairing-v1` (6).
- Freeze the routes a separate client uses behind versioned paths (for example `/api/v1/...`). The rule is the launcher protocol's: never change a frozen shape, add a new capability instead.
- Clients check capabilities and hide what the server lacks, instead of failing.

**Open questions.** Which routes need freezing first (chats, turn stream, events, settings)? Version by path, by header, or only by capability? How long does a server keep supporting old protocol versions?

**Build outline.** Server-info endpoint and tests, a frozen-shape fixture test per v1 route (like `selfhost/tests` does for the handshake), then a capability check helper for clients.

**Touches core.** Yes (new routes, plus discipline on existing ones).

### 22. Mobile web app (PWA)

**Why.** The cheapest way onto a phone: the server already serves the UI, and phones can open it today over Tailscale. Making it installable gives a home-screen app with no app store and automatic updates with the server.

**Decided.** Web app first; a native app only if it turns out to be needed.

**Proposed design (not approved).**
- A web app manifest and icons, plus a service worker that caches only the app shell (never chats or learning data, which stay server-side).
- Check and fix the layouts used on a phone: sessions, the composer, practice and the graph.
- Pair the phone with item 6 (scan the QR code from `lh pair`).

**Open questions.** Which screens matter most on a phone? Is offline reading wanted at all? Push notifications (iOS supports them only for installed web apps, and they need a push service)? Does the graph view work on a small touch screen?

**Build outline.** Manifest and service worker, a mobile layout pass with screenshots at phone width, then pairing on a real phone over Tailscale.

**Touches core.** Small (manifest, service worker, responsive CSS).

### 23. Desktop server list (choose a backend)

**Why.** Let the desktop app use either its own built-in server or a remote one (your self-hosted box), the way T3 and OpenBot let you pick a server.

**Decided.** Nothing yet. Relates to item 1 (desktop nightlies).

**Proposed design (not approved).**
- The Electron shell keeps a server list: "This computer" (today's spawned local server) plus remote servers, each an address and a pairing token from item 6.
- For a remote server, the window loads that server's own UI, so UI and server versions always match and the shell needs no copy of the app code.
- Desktop-only bridge features (`window.lh`: folder picker, local file paths, native updates) are offered only for "This computer", or replaced by the protocol in 21 (for example uploads from 24).
- Switching servers never moves data; each server keeps its own.

**Open questions.** Should the desktop app run its local server at all while a remote one is selected? How are remote servers found (typed address, QR code, Tailscale names)? How do subscription sign-ins behave when the server is remote (ChatGPT sign-in completes in a browser on the server machine today)?

**Build outline.** Server list storage and UI in the shell, remote window loading with the pairing token, gating of bridge features, then a test against a self-hosted install.

**Touches core.** Moderate (`electron/main.cjs`, `electron/preload.cjs`, small UI changes).

### 24. Remote-safe attachments

**Why.** Today the desktop paperclip inserts a file or folder **path**, and the agent reads the original in place on the server machine (`docs/getting-started.md`: "This is not an upload"). That only works when the client and the server are the same machine; browsers can't attach local files to a session at all.

**Decided.** Nothing yet.

**Facts.** T3 Code's method (`apps/server/src/assets/AttachmentUpload.ts`, `attachmentStore.ts`, `attachmentPaths.ts`):
1. The client asks the server for a short-lived, server-signed upload URL whose token names the file, its type and its exact size.
2. The client streams the bytes. The server writes a temporary `.part` file, hashes it while receiving, checks the exact size, then moves it into the attachments folder under a pending ID.
3. Sending the message claims the file and renames it to a thread-scoped ID. Unsent pending uploads are deleted after 24 hours, interrupted ones after 1 hour.
4. IDs must match a strict pattern, and a path check refuses anything outside the attachments folder.
5. The agent reads the server's copy (T3 adds the attachments folder as an agent working directory). Large things like code aren't uploaded: they live on the machine where the agent runs.

LearnHarness already uploads in two places (the graph's **Extract files** import and learner images) and snapshots displayed images into the session, which can be reused.

**Proposed design (not approved).** Hybrid:
- Client and server on the **same machine** (desktop with its local server): keep path attachments, so folders and live files keep working.
- **Remote** clients (phone, browser, desktop pointed at a remote server): T3-style signed uploads into a session-owned attachments folder under the data folder. The message carries a path to that copy, so the existing file tools and file-access guards work unchanged.
- Advertise it as a capability (item 21). T3's code is MIT, so it can be adapted with its license notice kept.

**Open questions.** Folder attachments: upload as several files, as an archive, or keep folders local-only? Per-file and per-session size limits? When are uploaded copies deleted (with the session, by age)? Should copies count toward the launcher's pre-update snapshot?

**Build outline.** Signing key and upload route, pending store with sweeping, claim-on-send, composer upload UI for remote clients, then tests for size mismatch, traversal attempts and expiry.

**Touches core.** Yes (new routes, composer, attachment handling).

## Files + ingestion

Where things stand, so the entries below start from facts:

- **In a session**, files reach the teacher as paths: the desktop paperclip or drag-and-drop inserts them, a browser can only paste them, and they render as path chips (`components/path-input.tsx`, `components/path-input-dom.ts`). The agent then reads on demand:
  - `read` (`src/agent/tools/read.ts`): any text file, including code, in 2,000-line / 50 KB slices; jpg, png, gif, webp and bmp come back as images the model sees. Every other file is decoded as UTF-8 text, so Office files come out as garbage.
  - `ls`, `find` and `grep` work across folders, so a whole code repository is usable.
  - PDFs go to a background pdf-reader agent (`src/agent/subagents/pdf-reader.ts`) that triages, extracts and looks at rendered pages.
  - Limits: reads run as the server's user. A sensitive-path guard blocks known credential locations (`src/agent/tools/fs-shared.ts`), and an optional folder boundary restricts reads to chosen folders (`src/agent/tools/file-access.ts`).
- **Into the knowledge graph**, the graph's **Extract files** accepts only `txt`, `md`, `markdown`, `rst`, `org`, `adoc`, `tex` and `pdf` (`IMPORT_EXTENSION_NAMES` in `lib/notes-import-limits.ts`).

### 25. Office and data formats

**Why.** A lot of study material is spreadsheets, Word documents and slide decks. Today the agent can't read any of them.

**Decided.** Nothing yet.

**Proposed design (not approved).**
- Convert to text the agent can read, behind the existing tools rather than as new ones where possible:
  - **Excel and CSV:** a "list the sheets first" step (names, sizes, header rows), like the PDF triage, then reading a sheet or a cell range as a Markdown table. Large sheets are read in ranges, like `read`'s line slices.
  - **Word (docx):** convert to Markdown, keeping headings, lists and tables.
  - **PowerPoint (pptx):** slide-by-slide text and speaker notes, and optionally rendered slide images for the model to look at, like PDF pages.
  - **Jupyter notebooks (ipynb):** cells in order, with outputs summarized.
- Two possible routes, to compare before choosing:
  1. JavaScript converter libraries in the server (candidates such as exceljs or SheetJS for spreadsheets and mammoth for Word; check licenses and maintenance before picking).
  2. Headless LibreOffice on the server converting documents and slides to PDF, then reusing the PDF pipeline. This keeps the visual layout but needs LibreOffice installed (`lh up` could detect it like Chrome).
- `read` recognizes these formats by extension and file signature and routes them to the converter instead of decoding them as text.

**Open questions.** Which formats matter most? How should formulas, charts and images inside documents be handled? What size limits? Should conversions be cached?

**Build outline.** Pick the route with a small spike on real files, add format detection to `read`, add the spreadsheet triage-and-range tool, add Word and PowerPoint conversion, then tests with fixture files of each type.

**Touches core.** Yes (`read`, a new converter module, possibly a new tool).

### 26. More file types in Extract files

**Why.** Extract files turns sources into knowledge-graph propositions, but code, spreadsheets and Office documents are turned away.

**Decided.** Nothing yet.

**Proposed design (not approved).**
- Office and notebook files: convert with item 25's converters, then extract like any text source.
- Code: accept source files (and folders of them, honoring `.gitignore`), with an extraction prompt aimed at concepts, APIs and design decisions rather than line-by-line content.
- Spreadsheets: extract from the sheet's structure and any explanatory text, not from every cell.

**Open questions.** What should the graph get from code or a spreadsheet: concepts, definitions, how a system works? Per file, or per folder or project? How big a code folder is reasonable? Does every type need its own extraction prompt?

**Build outline.** Decide the target output per type with the owner, extend `IMPORT_EXTENSION_NAMES` and the import route, add per-type extraction prompts, then test on a real repository and a real spreadsheet.

**Touches core.** Yes (import route, extraction prompts).

### 27. @-mentions for files and folders

**Why.** Attaching a file today means the paperclip, drag-and-drop, or typing a full path, and browsers can only do the last. Typing `@` to pick a file is faster everywhere.

**Decided.** Nothing yet.

**Facts.** T3 Code's design (MIT):
- Typing `@` opens a fuzzy search whose index lives **on the server** (`apps/server/src/workspace/WorkspaceSearchIndex.ts`, `WorkspaceEntries.ts`), with ignore patterns such as `.gitignore` (`IgnorePatterns.ts`).
- Picking a result inserts a mention segment that holds the path (`apps/web/src/composer-editor-mentions.ts`; menu in `apps/web/src/components/chat/useComposerMenuItems.ts`).

**Proposed design (not approved).**
- A server search endpoint over the folders you allow (the optional folder boundary, or a list of "places" in Settings), with the sensitive-path guard applied, `.gitignore`-style ignores, and result limits.
- In the composer, `@` opens a menu of matching files and folders; picking one inserts the existing path chip, so nothing downstream changes.
- Because the search runs on the server, browsers and phones can mention server files without typing paths. Files that exist only on the client still need item 24's uploads.

**Open questions.** Which folders are searchable by default (home folder, chosen places, recent paths)? How should folders show versus files? Should results rank recently used paths first? Should `@` also mention other things, such as sessions or graph sources?

**Build outline.** Search endpoint with tests (guard, ignores, limits), the composer menu with keyboard navigation, chip insertion, then a check in a plain browser.

**Touches core.** Yes (new route, composer).

---

## Review workflow

### 12. Preview builds of PRs

**Why.** The fork exists to review and merge upstream PRs. Running a PR on your real server before merging is the most direct review.

**Decided.** Not in the first release. T3 has a manual-only "preview" channel whose builds stay as draft releases, carry no update feed, and are never offered to installs automatically.

**Proposed design (not approved).**
- A `pr-preview.yml` workflow runs on a `preview` label or a manual dispatch with a PR number. It reuses the nightly bundle job and publishes a `preview-pr-<N>` prerelease (`<version>-preview.pr<N>.<run>`) that never touches `latest.json`, then comments the install command on the PR.
- `lh use pr-<N>` downloads it, snapshots data, switches and **pins** the install so `self-update.ts` stops auto-updating. Settings → Updates shows "Pinned to PR #N preview" with a "Back to nightly" button. `lh use nightly` does the same.
- Delete preview releases when their PR closes.

**Open questions.** Should previews share your real data (realistic, but a PR could rewrite records) or run as a separate instance with a copy of the data (needs item 10)? Who can trigger previews for outside PRs?

**Build outline.** Turn the nightly bundle job into a reusable workflow, add `pr-preview.yml`, add pinning to `service-state.json` and the update UI, add `lh use pr-<N>` / `lh use nightly`, and add cleanup.

**Touches core.** Small (pin state in the update UI).

### 13. Upstream issue intake

**Why.** The plan is to work upstream's issues here too, but only PR intake was planned.

**Decided.** Nothing yet.

**Proposed design (not approved).** A manual "Import upstream issue" workflow and script, mirroring "Import upstream PR": it copies the title, body and labels into a fork issue with a link back and credit, and adds an `upstream` label. Optionally, a weekly digest issue lists new upstream issues and PRs with a checkbox per item to trigger an import.

**Open questions.** Per-issue import only, or the digest too? Offer fork fixes back upstream as PRs, and from which branch? Keep comments in sync, or copy once?

**Touches core.** No.

---

## Ops + polish

### 7. Update deadline

**Why.** Updates apply only when idle. A stuck background job or a chat left `busy` could block updates forever.

**Decided.** First release: wait for idle with no deadline. "Restart" in the UI or `lh update --now` forces it.

**Proposed design (not approved).** An `updateDeadlineHours` setting (off by default) in `self-update.ts`. Once a staged version has waited that long, apply it at the next moment with no *main* chat turn running, even if background jobs are. If it's still never idle, apply at 2× the deadline. Show the countdown in Settings → Updates.

**Open questions.** What default? Should background jobs ever be interrupted?

**Touches core.** Small.

### 8. Chromium on demand

**Why.** Demo verification needs a headless Chrome. The first release uses the host's browser and warns if there isn't one.

**Decided.** Detect the host browser and warn if missing.

**Proposed design (not approved).** `lh browser install` downloads a pinned Chrome for Testing build into `~/.learnharness/tools/chrome/<version>/`, checks its published hash and sets `CHROME_PATH`. `lh browser update` and `lh browser remove` manage it, like T3's `~/.t3/tools/cloudflared`.

**Open questions.** Chrome for Testing doesn't publish linux-arm64 builds, so Debian's `chromium` would be the fallback there. Should the browser update automatically?

**Touches core.** No.

### 14. Keep the machine awake during agent work

**Why.** A machine that sleeps mid-turn loses the turn. T3 holds a `systemd-inhibit --what=idle:sleep` lock while its agents work.

**Decided.** Not in the first release.

**Proposed design (not approved).** In the server, next to the idle logic in `self-update.ts`: when work starts (the same busy sources), spawn `systemd-inhibit --what=idle:sleep --who=LearnHarness --why="Agent is working" --mode=block tail --pid=<server pid> -f /dev/null`, and kill it when idle again. Only on self-hosted Linux. A `keepAwake` setting (default on) in Settings.

**Open questions.** Block on background jobs, or main turns only? Default on?

**Touches core.** Small.

### 15. Resource limits for agent processes

**Why.** Agent turns spawn `claude` and other processes inside the server's service. A runaway one can starve the machine or get the server killed by the out-of-memory killer. T3 runs each agent in its own systemd scope under an agents slice, with memory priorities and an `OOMScoreAdjust`.

**Decided.** Not in the first release.

**Proposed design (not approved).**
- Unit-level: `MemoryHigh`, `MemoryMax`, `CPUWeight` and `OOMPolicy=continue` on `learnharness.service`, set from `config.json`.
- Per-agent, in the app: spawn each CLI child through `systemd-run --user --scope --slice=app-learnharness-agents.slice -p MemoryHigh=… -p OOMScoreAdjust=…` (where the claude-code launch code starts the process today). That keeps the server alive when a CLI child blows up. Applies to Claude Code and item 20's CLIs alike.

**Open questions.** Memory budget per agent? What happens when systemd isn't available (desktop, dev): plain spawn?

**Touches core.** Yes (the CLI spawn path).

### 17. Failure and conflict notifications

**Why.** If a nightly fails, a Sync PR conflicts, or an install rolls back, you only find out by looking.

**Decided.** First release: GitHub's own emails for failed workflows. The in-app rolled-back notice from the self-hosting plan covers the install side.

**Proposed design (not approved).**
- CI: on nightly failure, open or update one "Nightly failing" issue and close it on the next success. Optional webhook (`NOTIFY_WEBHOOK_URL`, e.g. ntfy or Discord).
- App: a notification center entry for "nightly failing upstream", read from the fork's release feed, plus browser notifications for update events when the tab allows them.

**Open questions.** Which channels? Notify on successful updates too?

**Touches core.** Small.

### 19. Scheduled and off-machine backups

**Why.** Today snapshots only happen before an update switch, and they sit on the same disk as the data.

**Decided.** First release: a full copy before each switch, 3 kept.

**Proposed design (not approved).** `lh backup now` and a systemd timer for daily backups with retention (for example 7 daily and 4 weekly). The timer asks `/api/health` and waits for idle so files aren't caught mid-write. Optional off-machine target: an `rclone` remote or `restic` repository from `config.json`. Backups listed in Settings with a restore button that hands off to the launcher.

**Open questions.** Which tool and target? Encrypt? Should `auth.json` (API keys) ever leave the machine?

**Touches core.** No (Settings listing is optional).

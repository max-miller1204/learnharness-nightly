# Self-hosting (nightly server)

This fork publishes LearnHarness as a self-hosted server on every push to `main` that passes CI. It runs on a Linux machine as a systemd user service, or on a Mac as a launchd agent, and you open it in a browser from any device. The design follows T3 Code's: versioned installs, a small launcher that supervises the server, in-app updates, and health-checked switches with rollback.

Because the server runs as you, on your machine, everything the desktop app can use works here too: the **Claude Code** provider finds your installed `claude` CLI and its login, demos are verified in your installed Chrome or Chromium, and subscription sign-ins work.

> **Every device signs in by pairing.** Each request needs a session. A browser gets one by opening a one-time pairing link from `lh pair` (below). The server only listens on `127.0.0.1`. Reach it from other devices through Tailscale (below), never by exposing the port.

## Requirements

- Linux on x86_64 or aarch64 (Raspberry Pi and ARM servers work) with systemd (user services), `curl`, `tar` and `sha256sum`.
- Or macOS on Apple silicon (M1 or newer). Intel Macs aren't supported. Everything needed ships with macOS.
- Optional: Chrome or Chromium for demo verification, Tailscale for access from other devices, the Claude Code CLI for that provider.

Nothing else: each version ships its own Node 26.

## Install

```sh
curl -fsSL https://github.com/max-miller1204/learnharness-nightly/releases/download/nightly/install.sh | sh
```

The installer picks your CPU's build, checks its SHA-256 against the release, unpacks it and runs `lh up`, which asks a few questions:

- whether to expose the server on your tailnet with Tailscale Serve,
- on Linux, whether to keep it running when you log out (`loginctl enable-linger`).

Then open `http://127.0.0.1:3774` on that machine, or the Tailscale address on other devices. Running the installer again installs the newest version and never touches your data.

## Everyday commands

| Command | What it does |
|---|---|
| `lh status` | Versions, service state, health, idle or busy, update state, URLs |
| `lh update` | Check for an update now. It doesn't download: click Download in the app, or use `lh update --now` |
| `lh update --now` | Download and install the newest version right away, even mid-turn |
| `lh rollback` | Switch back to the previous version |
| `lh use <version>` | Switch to any installed version (`lh versions` lists them) |
| `lh restore [<backup>]` | List data snapshots, or restore one |
| `lh logs [server\|service\|update] [-f]` | Show (or follow) a log |
| `lh preview <PR> [--port N]` | Run a PR's preview build beside your server (below) |
| `lh up [...]` | Change settings and (re)install the service |
| `lh restart` | Restart the service. Never required |
| `lh down` | Stop the service and don't start it at login |
| `lh uninstall [--keep-data]` | Remove it (with or without your learning data) |

`lh up` flags: `--port N` (default 3774), `--tailscale` / `--no-tailscale`, `--tailscale-port N` (default 8443), `--chrome-path P`, `--no-linger` (Linux only), `--no-open`, `--yes`.

## On a Mac

The same installer and commands work on a Mac. The differences:

- **It runs while you're logged in.** The service is a launch agent (`~/Library/LaunchAgents/com.learnharness.server.plist`), like T3 Code's: it starts when you log in and stops when you log out, and it runs as you, so the `claude` CLI's Keychain login and your Chrome work. For a Mac that serves unattended (a Mac mini at home, say), turn on automatic login (System Settings → Users & Groups) and keep it awake (System Settings → Energy or Battery → Options: prevent automatic sleeping when the display is off; also "Start up automatically after a power failure"). There's no lingering on macOS.
- **Over SSH**, if nobody is logged in at the Mac's screen, `lh up` can't start the agent; it stays installed and starts at the next login. The pairing link doesn't open a browser over SSH.
- **Tailscale**: any Tailscale for macOS works. If `tailscale` isn't on your `PATH`, `lh` uses the app's own CLI (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`).
- **Chrome**: `lh up` finds Google Chrome or Chromium in `/Applications` or `~/Applications`.
- **PATH**: launch agents don't read your shell profile, so `lh up` saves the `PATH` of the shell you run it in, plus Homebrew (`/opt/homebrew/bin`), into the plist. Run `lh up` again after installing tools somewhere new.
- **Folder access**: macOS may refuse agent work in Desktop, Documents or Downloads, because a background service can't show the permission prompt. Keep projects in other folders. Your learning data in `~/.learnharness` isn't affected.
- **Not signed or notarized**, and it doesn't need to be: Gatekeeper only checks files marked as downloaded by a browser, and neither the installer's `curl` nor in-app updates mark them. If you download an archive with a browser anyway, run `xattr -dr com.apple.quarantine` on it before unpacking.

## Updates

Updates are offered on their own, and download and install only when you say so (the T3 Code model; see [the spec](specs/t3-style-updates.md)).

1. **The server checks** for a new nightly 15 seconds after it starts (or after an update) and every 4 hours. There is no setting to turn this off. A newer version is offered, not downloaded: the round button at the right of the sidebar's Settings row becomes a download button, and Settings → General's button reads **Download**. Hover either to read what changed. The sidebar button checks when you click it; so does Settings' button, whose label follows the state (**Check for Updates**, **Checking…**, **Up to Date**, **Download**, **Downloading…**, **Install**). A newer nightly that appears while one is offered or ready replaces it.
2. **It downloads only when you click Download** (the sidebar button or Settings). If the download fails, the offer stays and the button says so; click it to try again.
3. **It installs only when you click Install** (the sidebar button, Settings, or `lh update --now`). It asks you first, since the restart interrupts running chat turns and jobs. Install checks once more for a newer build and downloads it first if there is one. `lh update --now` downloads and installs in one step. Nothing installs on its own.
4. **The launcher switches versions safely.** Before stopping anything it refuses an update that isn't newer, isn't fully downloaded, failed before, or doesn't leave room for a data snapshot (the old server keeps running and Settings shows why). Then it copies your data to a snapshot, starts the new version as a trial, and keeps it only once the new server reports it's ready.
5. **A failed trial rolls back by itself.** If the new version exits, misbehaves or isn't ready within 30 minutes, the launcher restores the snapshot, marks that version so it isn't retried, and goes back to the old one. A warning button in the sidebar explains what happened; clicking it dismisses it on every device.
6. **Open tabs.** After an update the same sidebar button reads "Updated to X. Click to reload." A tab never reloads on its own; if a message box has unsent text, it asks first.
7. **What's new.** The first time the app opens after an update, a "What's new in X" popup lists the changes since the version you last saw. Closing it on any device clears it on all of them.

### Update everything from the desktop app

When the LearnHarness Nightly desktop app is connected to your server and a newer nightly is out, the round sidebar button becomes a circle with an up arrow: **Update this app and 1 server**. Settings → General shows both versions, **Server X** and **This app Y**. Clicking the button (or the app row's Install) opens the app's own confirmation. Nothing happens before you confirm.

1. The app picks one exact version and downloads its own update first. If that fails, nothing changes.
2. It asks your server to install exactly that version (`POST /api/updates/install-version`, paired devices only). The server downloads that release's own build, checks its SHA-256, and switches through the launcher's usual snapshot, trial and rollback. The app window shows "Updating <server> to X… This can take a few minutes."
3. The app waits until the launcher has **kept** the new version, not just until it answers. A rollback, a refusal, or no answer after 32 minutes stops the run with the reason, and the app stays as it was (Retry, or Switch server…).
4. Then the app restarts after 5 seconds. **Later** keeps you working, and the button then only restarts the app. After the restart it reopens the same server. If the app update didn't apply, it tells you once.

When the app has no newer version but your server runs an older one, the button reads **Update 1 server**. The confirmation lists only the server, which moves to exactly the version the app runs, and the app doesn't restart.

It works with the Mac, Windows and Linux (AppImage) desktop apps, and a Linux or Mac server. The server needs a version that has this request; an older one asks you to update it from its own Settings first. Provider updates aren't part of it.

The launcher itself also updates by itself. An old launcher keeps working with newer servers, and when a version needs a newer launcher, the switch happens on its own the next time no agent is working (a restart of a few seconds onto the same, already-proven version).

### Rolling back by hand

`lh rollback` (or `lh use <version>`) switches versions through the same trial. It asks whether to also restore your data from just before that version was replaced; the default is no, because restoring discards everything since.

### Full manual recovery copy

Uploaded attachments live in `$LH_HOME/attachments`, beside `$LH_HOME/userdata`. Automatic rollback and `lh restore` restore the chat records in `userdata` and leave attachment bytes in place. Deleting a chat can remove its uploaded files. Restoring an older snapshot can bring back their filenames with an unavailable status.

For a full manual recovery copy, stop the server and copy both `userdata` and `attachments` from the same installation. Keep the copies together and restore both with the server stopped.

## Trying a PR (previews)

PR previews are built for Linux x64 and arm64. A PR with a preview build has a bot comment saying so (design: [specs/pr-previews.md](specs/pr-previews.md)). Your own PRs build one on every push; anyone else's PR (upstream imports, outside PRs) only when you add the `preview` label, and the label comes off once it's published. Adding it means you've read the diff: a preview runs that PR's code as you.

```sh
lh preview 123
```

It downloads PR #123's build, checks its SHA-256 and runs it in the foreground beside your server: port 3775 (`--port N`), plus `https://<machine>:8444` when Tailscale is on, with a pairing link and QR code. It has its own folder (`~/.learnharness/previews/pr-123/`) with fresh, empty data: none of your learning data, saved API keys or `service.env`. The Claude Code provider still works, through this machine's `claude` login. It never offers updates. **Ctrl+C stops it and deletes its folder**; your real server, its data and its updates are never touched. `lh preview` needs a launcher from a version that has it, so update first if `lh` says the command is unknown.

## Signing in (pairing)

Every request needs a session, even from the server machine itself. `lh up` prints a one-time pairing link and its QR code, and opens the link in a browser on the server machine when it can (`--no-open` skips that). For any other device:

```sh
lh pair [--label "My phone"]
```

It prints the loopback link first for use on the server machine. When Tailscale is on, the QR code uses the Tailscale HTTPS link, which appears just above the 12-character code under **From your other devices**. A code works once and expires after 5 minutes. `lh pair` works even when the server is stopped.

A paired session stays valid until revoked. Browser cookies renew as you use the app, subject to browser storage limits. On a signed-in device, **Settings → Devices** lists every device (label, type, OS, browser, IP, issued, expires, last seen), revokes one or all others, and makes a new pairing link with its QR code. There is no logout button: sign a device out from another one. Lost every device? Run `lh pair` on the server machine.

The login store is `userdata/data/auth/`. Backups skip it and `lh restore` keeps it, so restoring old data never brings back a revoked device. Anyone who can write that folder can sign in, the way `lh pair` does.

**Upgrading from a version without login:** after the update, an open browser shows the pairing screen on its next page load. Run `lh pair` (or `lh up`) on the server machine and open the link. If you only use a phone, you need a shell on the server once, for example over SSH. Until the service next restarts, the previous launcher stays in charge, and backups it takes still contain the login store; nothing to do, it switches over on its own.

Design and trade-offs: [docs/specs/login-pairing.md](specs/login-pairing.md).

## Access from other devices (Tailscale)

```sh
lh up --tailscale
```

This runs `tailscale serve --bg --https=8443 http://127.0.0.1:3774`. Open `https://<machine>.<tailnet>.ts.net:8443` from any device on your tailnet and pair it with `lh pair`.

- Only devices on your tailnet can reach it, and each one still has to pair. A paired device has full access.
- **Never use Tailscale Funnel** for this: it makes the server public.
- ChatGPT sign-in finishes in a browser **on the server machine** (its callback listens on `127.0.0.1`). GitHub Copilot and Grok sign-ins use device codes and work from anywhere.

`lh up --no-tailscale` turns it off again.

## Files

```
~/.learnharness/
  service.env                 your environment overrides (see below)
  runtime/
    service-state.json        active / previous version, last update and its outcome
    versions/<version>/       one self-contained build each; the newest 3 are kept
  userdata/
    config.json               lh's settings: port, Tailscale, Chrome path
    data/                     your learning data (LH_DATA_DIR)
      auth/                   the login store: signed-in devices and pairing links
    auth.json                 saved API keys (plus subscription credentials beside it)
    backups/<from>-<id>/      data snapshots taken before each switch; the newest 3 are kept
    logs/                     service.log, server.log, update.log (capped at 10 MB each)
~/.local/bin/lh               runs the active version's launcher
~/.config/systemd/user/learnharness.service               (Linux)
~/Library/LaunchAgents/com.learnharness.server.plist      (macOS; runs ~/.local/bin/lh __service)
```

### service.env

Put extra environment variables for the server here, one `NAME=value` per line, for example API keys or `CLAUDE_CODE_*` settings. Names the launcher manages (`PATH`, `PORT`, `HOSTNAME`, `LH_DATA_DIR`, `LH_AUTH_FILE`, `LH_HOME` and the other `LH_*` launcher variables) are ignored, and the launcher logs that once. Run `lh restart` after editing.

## One server per data folder

Every LearnHarness server, including `npm start`, `npm run dev` and the desktop app, locks its data folder while it runs. A second server pointed at the same folder exits right away with code 78 instead of risking corrupt records or credentials. The launcher treats that as "wait until the folder is free".

## Troubleshooting

- `lh status` first, then `lh logs update` for update decisions and `lh logs server` for the app itself.
- "Not enough disk space to back up your data": free some space; the update retries on the next check.
- "No Chrome or Chromium found": install one (for example `sudo apt install chromium`, or Google Chrome on a Mac) and run `lh up` again, or pass `--chrome-path`.
- On a Mac, `launchctl print gui/$(id -u)/com.learnharness.server` shows what launchd thinks of the service.
- The service won't start below 64 MB of free disk space; it retries every 30 seconds.
- The Claude Code provider needs `claude` installed and signed in as the same user; `~/.local/bin` is always on the server's `PATH`.

## How releases are built

`.github/workflows/nightly.yml` runs after CI passes on a push to `main` (CI covers typecheck, tests, lint and the launcher tests) and builds that exact commit: a native build on linux-x64, linux-arm64 and macOS (Apple silicon) runners, the same build-server gates as the desktop release, and a boot test of each assembled archive with its own bundled Node. Only if everything passes does it publish a prerelease `v<version>-nightly.<date>.<run>` and point the fixed `nightly` release's `latest.json` at it. `feed-check.yml` re-verifies that pointer after every nightly and once a day. The newest 30 nightlies are kept.

A manual run with **dry run** checked builds and tests any branch and publishes nothing; its archives are the run's artifacts. Set the repository variable `PAUSE_NIGHTLY=true` to stop publishing.

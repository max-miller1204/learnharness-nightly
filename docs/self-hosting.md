# Self-hosting (nightly server)

This fork publishes LearnHarness as a self-hosted server on every push to `main` that passes CI. It runs on a Linux machine as a systemd user service, and you open it in a browser from any device. The design follows T3 Code's: versioned installs, a small launcher that supervises the server, in-app updates, and health-checked switches with rollback.

Because the server runs as you, on your machine, everything the desktop app can use works here too: the **Claude Code** provider finds your installed `claude` CLI and its login, demos are verified in your installed Chrome or Chromium, and subscription sign-ins work.

> **Every device signs in by pairing.** Each request needs a session. A browser gets one by opening a one-time pairing link from `lh pair` (below). The server only listens on `127.0.0.1`. Reach it from other devices through Tailscale (below), never by exposing the port.

## Requirements

- Linux on x86_64 or aarch64 (Raspberry Pi and ARM servers work).
- systemd (user services), `curl`, `tar` and `sha256sum`.
- Optional: Chrome or Chromium for demo verification, Tailscale for access from other devices, the Claude Code CLI for that provider.

Nothing else: each version ships its own Node 26.

## Install

```sh
curl -fsSL https://github.com/max-miller1204/learnharness-nightly/releases/download/nightly/install.sh | sh
```

The installer picks your CPU's build, checks its SHA-256 against the release, unpacks it and runs `lh up`, which asks a few questions:

- whether to expose the server on your tailnet with Tailscale Serve,
- whether to keep it running when you log out (`loginctl enable-linger`).

Then open `http://127.0.0.1:3774` on that machine, or the Tailscale address on other devices. Running the installer again installs the newest version and never touches your data.

## Everyday commands

| Command | What it does |
|---|---|
| `lh status` | Versions, service state, health, idle or busy, update state, URLs |
| `lh update` | Check for an update now (it installs when no agent is working) |
| `lh update --now` | Install the newest version right away, even mid-turn |
| `lh rollback` | Switch back to the previous version |
| `lh use <version>` | Switch to any installed version (`lh versions` lists them) |
| `lh restore [<backup>]` | List data snapshots, or restore one |
| `lh logs [server\|service\|update] [-f]` | Show (or follow) a log |
| `lh up [...]` | Change settings and (re)install the service |
| `lh restart` | Restart the service. Never required |
| `lh down` | Stop the service and don't start it at login |
| `lh uninstall [--keep-data]` | Remove it (with or without your learning data) |

`lh up` flags: `--port N` (default 3774), `--tailscale` / `--no-tailscale`, `--tailscale-port N` (default 8443), `--chrome-path P`, `--no-linger`, `--yes`.

## Updates

Updates are automatic and need nothing from you.

1. **The app checks** for a new nightly at startup and every 15 minutes, and downloads it in the background. Settings → General shows the progress, and a banner appears when it's ready. Turn this off with **Automatic updates** in Settings; **Check for updates** still works.
2. **It installs when nothing is running:** no turn, no compaction, no background job, plugin worker or extraction. **Restart** in the banner or Settings (or `lh update --now`) installs right away.
3. **The launcher switches versions safely.** Before stopping anything it refuses an update that isn't newer, isn't fully downloaded, failed before, or doesn't leave room for a data snapshot (the old server keeps running and Settings shows why). Then it copies your data to a snapshot, starts the new version as a trial, and keeps it only once the new server reports it's ready.
4. **A failed trial rolls back by itself.** If the new version exits, misbehaves or isn't ready within 30 minutes, the launcher restores the snapshot, marks that version so it isn't retried, and goes back to the old one. A banner explains what happened.

The launcher itself also updates by itself. An old launcher keeps working with newer servers, and when a version needs a newer launcher, the switch happens on its own the next time no agent is working (a restart of a few seconds onto the same, already-proven version).

### Rolling back by hand

`lh rollback` (or `lh use <version>`) switches versions through the same trial. It asks whether to also restore your data from just before that version was replaced; the default is no, because restoring discards everything since.

## Signing in (pairing)

Every request needs a session, even from the server machine itself. `lh up` prints a one-time pairing link and its QR code, and opens the link in a browser on the server machine when it can. For any other device:

```sh
lh pair [--label "My phone"]
```

It prints the Tailscale HTTPS link when Tailscale is on, otherwise `http://127.0.0.1:<port>/pair#token=...`, with a QR code to scan and the 12-character code to type. A code works once and expires after 5 minutes. `lh pair` works even when the server is stopped.

A paired browser stays signed in for 30 days. On a signed-in device, **Settings → Devices** lists every device (label, type, OS, browser, IP, issued, expires, last seen), revokes one or all others, and makes a new pairing link with its QR code. There is no logout button: sign a device out from another one. Lost every device? Run `lh pair` on the server machine.

The login store is `userdata/data/auth/`. Backups skip it and `lh restore` keeps it, so restoring old data never brings back a revoked device. Anyone who can write that folder can sign in, the way `lh pair` does.

**Upgrading from a version without login:** after the update, an open browser shows the pairing screen on its next page load. Run `lh pair` (or `lh up`) on the server machine and open the link. If you only use a phone, you need a shell on the server once, for example over SSH.

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
~/.config/systemd/user/learnharness.service
```

### service.env

Put extra environment variables for the server here, one `NAME=value` per line, for example API keys or `CLAUDE_CODE_*` settings. Names the launcher manages (`PATH`, `PORT`, `HOSTNAME`, `LH_DATA_DIR`, `LH_AUTH_FILE`, `LH_HOME` and the other `LH_*` launcher variables) are ignored, and the launcher logs that once. Run `lh restart` after editing.

## One server per data folder

Every LearnHarness server, including `npm start`, `npm run dev` and the desktop app, locks its data folder while it runs. A second server pointed at the same folder exits right away with code 78 instead of risking corrupt records or credentials. The launcher treats that as "wait until the folder is free".

## Troubleshooting

- `lh status` first, then `lh logs update` for update decisions and `lh logs server` for the app itself.
- "Not enough disk space to back up your data": free some space; the update retries on the next check.
- "No Chrome or Chromium found": install one (for example `sudo apt install chromium`) and run `lh up` again, or pass `--chrome-path`.
- The service won't start below 64 MB of free disk space; it retries every 30 seconds.
- The Claude Code provider needs `claude` installed and signed in as the same user; `~/.local/bin` is always on the server's `PATH`.

## How releases are built

`.github/workflows/nightly.yml` runs after CI passes on a push to `main` (CI covers typecheck, tests, lint and the launcher tests) and builds that exact commit: a native build on linux-x64 and linux-arm64 runners, the same build-server gates as the desktop release, and a boot test of each assembled archive with its own bundled Node. Only if everything passes does it publish a prerelease `v<version>-nightly.<date>.<run>` and point the fixed `nightly` release's `latest.json` at it. `feed-check.yml` re-verifies that pointer after every nightly and once a day. The newest 30 nightlies are kept.

Set the repository variable `PAUSE_NIGHTLY=true` to stop publishing.

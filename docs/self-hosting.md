# Self-hosting (nightly server)

This fork publishes LearnHarness as a self-hosted server on every push to `main` that passes CI. It runs on a Linux machine as a systemd user service, and you open it in a browser from any device. The design follows T3 Code's: versioned installs, a small launcher that supervises the server, in-app updates, and health-checked switches with rollback.

Because the server runs as you, on your machine, everything the desktop app can use works here too: the **Claude Code** provider finds your installed `claude` CLI and its login, demos are verified in your installed Chrome or Chromium, and subscription sign-ins work.

> **There is no login.** Anyone who can reach the port can read every chat, change saved keys and start agent turns. The server only listens on `127.0.0.1`. Reach it from other devices through Tailscale (below), never by exposing the port.

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
| `lh update` | Check for an update now and download it (it installs when you click Install in the app) |
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

Updates download on their own and install when you say so (the T3 Code model; see [the spec](specs/t3-style-updates.md)).

1. **The app checks** for a new nightly at startup and every 4 hours, and downloads it in the background. Settings → General shows the progress, and an update button appears at the right of the sidebar's Settings row when it's ready. Hover it to read what changed. Turn checking off with **Check for updates automatically** in Settings; **Check for updates** still works. A newer nightly that appears while one is ready replaces it.
2. **It installs only when you click Install** (the sidebar button, Settings, or `lh update --now`). Install checks once more for a newer build, then asks you to confirm and lists what is running (chat turns, compactions, background jobs, plugin workers, extractions), since the restart interrupts them. Nothing installs on its own.
3. **The launcher switches versions safely.** Before stopping anything it refuses an update that isn't newer, isn't fully downloaded, failed before, or doesn't leave room for a data snapshot (the old server keeps running and Settings shows why). Then it copies your data to a snapshot, starts the new version as a trial, and keeps it only once the new server reports it's ready.
4. **A failed trial rolls back by itself.** If the new version exits, misbehaves or isn't ready within 30 minutes, the launcher restores the snapshot, marks that version so it isn't retried, and goes back to the old one. A warning button in the sidebar explains what happened; clicking it dismisses it on every device.
5. **What's new.** The first time the app opens after an update, a "What's new in X" popup lists the changes since the version you last saw. Closing it on any device clears it on all of them.

The launcher itself also updates by itself. An old launcher keeps working with newer servers, and when a version needs a newer launcher, the switch happens on its own the next time no agent is working (a restart of a few seconds onto the same, already-proven version).

### Rolling back by hand

`lh rollback` (or `lh use <version>`) switches versions through the same trial. It asks whether to also restore your data from just before that version was replaced; the default is no, because restoring discards everything since.

## Access from other devices (Tailscale)

```sh
lh up --tailscale
```

This runs `tailscale serve --bg --https=8443 http://127.0.0.1:3774` and adds your machine's MagicDNS name to `LH_ALLOWED_HOSTS` (the app refuses unknown host names). Open `https://<machine>.<tailnet>.ts.net:8443` from any device on your tailnet.

- Everyone on your tailnet gets full access. Use Tailscale ACLs to narrow that.
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
    auth.json                 saved API keys (plus subscription credentials beside it)
    backups/<from>-<id>/      data snapshots taken before each switch; the newest 3 are kept
    logs/                     service.log, server.log, update.log (capped at 10 MB each)
~/.local/bin/lh               runs the active version's launcher
~/.config/systemd/user/learnharness.service
```

### service.env

Put extra environment variables for the server here, one `NAME=value` per line, for example API keys or `CLAUDE_CODE_*` settings. Names the launcher manages (`PATH`, `PORT`, `HOSTNAME`, `LH_DATA_DIR`, `LH_AUTH_FILE`, `LH_HOME` and the other `LH_*` launcher variables) are ignored, and the launcher logs that once. `LH_ALLOWED_HOSTS` is merged with the Tailscale name. Run `lh restart` after editing.

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

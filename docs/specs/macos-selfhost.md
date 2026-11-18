# macOS self-hosting

Status: approved by the owner on 2026-11-17.

Goal: roadmap item 3. `lh` installs and runs LearnHarness as a background service on a Mac (Apple silicon), with the same updates (item 7), pairing (item 6) and Tailscale Serve as on Linux. The model is T3 Code's macOS background service (`pingdotgg/t3code`, MIT: `docs/user/background-service.md`, `apps/server/src/cloud/bootService.ts`).

## Design

1. **A launchd agent, not a daemon** (T3's answer). `~/Library/LaunchAgents/com.learnharness.server.plist` in the `gui/<uid>` domain. It runs as you, so `claude` and its Keychain login, Chrome and your files work as on Linux. It starts when you log in and stops when you log out, like T3: a Mac mini that serves unattended needs automatic login and sleep turned off (the docs say how). A daemon would need root and has no Keychain or login session.
2. **The plist** (T3's keys): `ProgramArguments` = `~/.local/bin/lh __service`, `RunAtLoad`, `KeepAlive`, `ThrottleInterval` 5, `ExitTimeOut` 30 (our systemd `TimeoutStopSec`), `ProcessType` Interactive, `WorkingDirectory` your home, stdout and stderr appended to `userdata/logs/service.log`, and `EnvironmentVariables` with `LH_HOME` and a `PATH` built like T3's: the `PATH` of the shell that ran `lh up`, then `/opt/homebrew/bin`, `/usr/local/bin` and the system folders.
3. **Why the plist names the `lh` shim, not a version folder** (our choice, unlike T3). launchd keeps the plist it loaded and restarts that command until the next `bootstrap`, so a version path would bring back the old launcher after an update or the launcher hand-off (exit 75). The shim is already repointed at each commit and rollback, which gives systemd's "next start runs the committed version". On macOS, repointing is just rewriting the shim.
4. **One service interface** in `selfhost/src/service.ts`, chosen by platform: write, start, stop, restart, is-running, enable, disable, remove. Linux keeps today's systemd code unchanged. launchd mapping (T3's commands): start = `launchctl enable` + `bootstrap gui/<uid> <plist>`; stop = `bootout --wait`; restart = `kickstart -k`; status = `launchctl print`; `lh down` adds a persisted `launchctl disable` so it stays off at login.
5. **Install paths are the same as Linux**: `~/.learnharness/` (runtime, userdata, service.env), `~/.local/bin/lh`. Only the unit file differs.
6. **Mac-specific bits in `lh`**: Chrome found in `/Applications` and `~/Applications` (Google Chrome, Chromium); `tailscale` falls back to `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; the pairing link opens with `open`; no linger question (`--no-linger` is ignored); over SSH with nobody logged in at the screen, the final start can fail and `lh up` says it starts at the next login (T3's behavior).
7. **Installer**: `install.sh` accepts `Darwin arm64`, uses `shasum -a 256` where `sha256sum` is missing, and needs `launchctl` instead of `systemctl`.
8. **Builds**: the nightly matrix gains `darwin-arm64` on `macos-26` (the runner the desktop release already uses), with Node's official `darwin-arm64` tarball, the same build gates, the archive boot test and the launcher tests. `latest.json` gains a `darwin-arm64` asset; old launchers and servers ignore keys they don't know. The archive is made with macOS `tar` without AppleDouble files.
9. **All or nothing**: a failed macOS build blocks that night's publish, as a failed Linux build does today.
10. **No signing or notarization for the server archive.** Gatekeeper checks only quarantined files, and neither `curl` nor the launcher's own downloads mark files quarantined. Node's `darwin-arm64` binary is signed by the Node.js project, and native modules built or installed on the runner carry the linker's ad-hoc signature, which Apple silicon requires and copying keeps. The docs say not to download the archive with a browser (or to run `xattr -dr com.apple.quarantine` on it). The desktop app's Developer ID signing and notarization stay in `release.yml` (items 1 and 18).
11. **Test builds from a branch**: a manual nightly run with `dry_run` works from any branch (it publishes nothing), so a PR can build Mac archives for testing.

## Stays Linux-only

- `loginctl enable-linger` (running with nobody logged in). On a Mac: automatic login.
- Intel Macs: not built. GitHub is retiring its Intel macOS runners and there is no Intel Mac to test on. Adding one later is a matrix line.

## Verification

Unit tests (run on Linux in CI and on macOS in the nightly bundle job): plist rendering and escaping, the launchd status parser, the platform choice, `currentArch`, the feed with a `darwin-arm64` asset, Mac Chrome detection. On a real Mac, with two archives from a branch dry run and a local `file://` feed: install with `install.sh`, `lh up` with Tailscale, pair a browser, update from the first build to the second through the app, `lh rollback`, `lh down`, `lh up`, `lh uninstall`.

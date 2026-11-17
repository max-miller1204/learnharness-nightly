# Self-hosted server and `lh` launcher (`selfhost/`)

The launcher (`selfhost/lh.ts`, Node built-ins, run by each version's bundled Node) installs versions under `$LH_HOME/runtime/versions/`, runs `lh __service` under a systemd user unit, switches versions through a trial (data snapshot first, rollback on failure), and keeps the server's own update flow (`src/server/self-update.ts`, `/api/updates`) honest. The launcher must keep working when the server is broken.

## Isolation (never the user's install)

| Variable | Real install | Prove run |
|---|---|---|
| `LH_HOME` | `~/.learnharness` | `$RUN/selfhost/lh-home/.learnharness` (tier A: `$RUN/<side>/lh-home/.learnharness`) |
| `LH_SERVICE_NAME` | `learnharness` | `lh-prove-<12 hex of sha256(run path)>` (tier A: `lh-prove-a`, never installed) |
| `LH_BIN_DIR` | `~/.local/bin` | `$RUN/selfhost/bin` |
| port | 3774 | a free port (`lh up --port`) |
| feed | GitHub `nightly/latest.json` | `file://$RUN/selfhost/feed/latest.json` |

Tier B also passes `--no-tailscale --no-linger`. The unit file lands in the systemd user unit folder (`~/.config/systemd/user/`, or under `$XDG_CONFIG_HOME`), and `stop.sh` finds it through `systemctl --user show -p FragmentPath`, disables and deletes it.

Guards, in order:
1. Before installing, both launchers (base and head) are asked where they would write (`lhHome`, `serviceName`, `shimPath`, `unitPath`); anything but the run's paths is BLOCKED.
2. Your real install is fingerprinted before and after, on every exit: `learnharness.service` pid, state and unit path; sha256 of its unit file, `~/.local/bin/lh`, `service-state.json`, `service.env` and `userdata/config.json`; a listing (path, size, mtime) of `~/.learnharness/runtime/` and `userdata/backups/`. Any difference fails the run. Learning data and logs are left out, since your own use changes them (if your real service updated itself during the run, rerun).
3. Every `lh` call is time-boxed (120 s), and tier B runs once per run folder.

## Tier A (routine)

`scripts/selfhost-a.sh "$RUN" base|head`: `node --test selfhost/tests/*.test.ts` in that tree, then `lh help|status|versions|update|rollback|use 9.9.9|restore|logs|__selftest-launcher|bogus-command` from source in an empty throwaway home (each must refuse cleanly). Outputs are observations: compare base and head with `compare.mjs`. No build needed beyond the base tree.

## Tier B (hard)

`scripts/selfhost-b.sh "$RUN"` after `build.sh "$RUN" both`:

1. Packs A (base build, `<base version>-nightly.20000101.1`, cached in `$PROVE_CACHE/base/<sha>/.prove-archive/`), B (head build, `...2`) and C (B with `server/server.js` replaced by `process.exit(3)`, `...3`) with `selfhost/scripts/package-archive.ts` and the host Node 26.
2. `install.sh` from the base tree with `LH_FEED_URL`, `LH_YES=1`, `LH_UP_ARGS`: installs A, writes the unit, starts it.
3. Seeds a session, then feed -> B, `lh update` (server downloads), `lh update --now`: waits for health on B and `update.status=committed`; checks the session and a backup named after A.
4. Feed -> C, same: waits for `update.status=rolled-back` for C, health on B, C in `badVersions`, session kept.
5. `lh rollback --yes`: waits for health on A and `committed`, session kept.

Evidence: `steps.log` (the verdict lines), `status.txt` (`lh status` and the state after each switch), `install.log`, `update.log`, `launcher-update.log`, `pack.log`. About 50 s after builds on this machine.

Versions are baked at build time (`LH_VERSION`), which is why every prove build bakes `...nightly.20000101.<n>`: one build per side serves web, API, Electron and selfhost.

## Adding a case

A new launcher behaviour (a new command, a new refusal, a new update rule) gets a step in `selfhost-b.sh` (or a command in tier A's list) that drives it through `lh` or the server's `/api/updates`, never by editing state files by hand, and asserts on `service-state.json`, `/api/health` and `lh status` together.

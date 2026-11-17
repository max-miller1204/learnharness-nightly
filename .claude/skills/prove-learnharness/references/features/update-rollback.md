# Self-hosted update and rollback

A self-hosted user gets new nightlies automatically: the server checks the feed, downloads, and installs when idle (or at once from the banner, Settings or `lh update --now`); the launcher snapshots data, trials the new version, keeps it when it reports ready, and rolls back by itself when it does not. `lh rollback` and `lh use` switch back by hand.

## Sub-features

- `install`: `install.sh` installs a version and the systemd user service.
- `update`: feed has a newer version -> download -> switch -> committed.
- `snapshot`: a data backup named after the old version before each switch.
- `auto-rollback`: a version that fails its trial is rolled back and marked bad.
- `manual-rollback`: `lh rollback` returns to the previous version.
- `status`: `lh status` reports versions, service, health and the last update.

## How to get to it

- One-line installer (`install.sh`), `lh up`, `lh update [--now]`, `lh rollback`, `lh use <v>`, `lh status`, `lh restore`.
- Server: `/api/updates`, `/api/updates/check`, `/api/updates/install`, the update banner and Settings -> General (browser on the self-hosted server).

## Driving it

Preconditions: `scripts/build.sh "$RUN" both`; systemd user manager running; nothing else needed (no network).

1. `scripts/selfhost-a.sh "$RUN" base`, `scripts/selfhost-a.sh "$RUN" head`, `node scripts/compare.mjs "$RUN/base/selfhost-a/result.json" "$RUN/head/selfhost-a/result.json"` -> 33 launcher tests pass on both; every `lh` command refuses the same way in an empty home.
2. `scripts/selfhost-b.sh "$RUN"` -> `$RUN/selfhost/steps.log`, one line per step:
   - install A under `lh-prove-<id>.service` on a free port -> health on A.
   - session created on A.
   - update to B -> health on B, state `committed`; session kept; backup named after A.
   - broken C -> state `rolled-back` for C, health on B, C in `badVersions`, session kept.
   - `lh rollback --yes` -> health on A, `committed`, session kept.
   - real `learnharness.service` untouched.
3. `scripts/stop.sh "$RUN"` removes the unit.

## Gotchas

- The unit runs under the real systemd user manager with the real HOME; only `LH_HOME`, the unit name, port and bin dir are throwaway.
- With Automatic updates on (the default), the server may install B by itself as soon as it downloads; the script waits on state, not on its own command.
- `lh status` can fail for a moment during a switch (the shim is being rewritten); it is evidence, not a crash.
- The update banner in the browser is not driven yet (gap).

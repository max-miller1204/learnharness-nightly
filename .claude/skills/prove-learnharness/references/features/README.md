# Feature recipes

One recipe per user feature. A recipe says how to reach and drive the feature; the answer key (base commit, spec, parity) says what right looks like.

## Baseline every recipe starts from

- `RUN=$(scripts/new-run.sh <slug>)`, `scripts/build.sh "$RUN" both`, `H=$(scripts/start.sh "$RUN" head)`, `B=$(scripts/start.sh "$RUN" base)`, `scripts/health.sh` on each.
- Each instance: empty data dir, empty `auth.json`, throwaway HOME holding `zz-prove-it-fixture.txt`, no ambient keys, the fake model in all three slots (`custom/prove-strong|cheap|vision`), scenario `scenarios/teach-read.json` unless the recipe says otherwise.
- Everything a drive creates is named `zz-prove-it ...`.

## Recipes

| Feature | Surfaces | Recipe |
|---|---|---|
| Teaching session: goal, tool call, graded question, answer, reload, delete | web, api, agent, electron | [teaching-session.md](teaching-session.md) |
| Self-hosted update and rollback | selfhost, api | [update-rollback.md](update-rollback.md) |
| Desktop window | electron | [desktop-window.md](desktop-window.md) |

## Gaps (no recipe yet: write one, run it, then list it above)

Practice sessions, the knowledge graph (view, import, extract files), plan view, side chats, settings pages (providers, models, prompts, themes, file access), plugins (install, enable, plugin views and questions), dictation, file attachments and path chips, research and demo jobs, compaction, session search and markdown export, the in-app update banner in the browser (selfhost web), subscription sign-ins (ChatGPT, Copilot, Grok).

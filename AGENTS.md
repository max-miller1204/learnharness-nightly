<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Specs and docs

- New specs are GitHub issues titled `Spec: <topic>`, published by idea-to-spec and revised in place. `docs/specs/` keeps the specs of shipped work.
- Docs and code comments hold only what stays true: no status tables, done or later lists, counts, or "currently", "not yet" or "today" claims. Specs are exempt.

## Verification

- Prove a change in the running app with the `verify-learnharness` skill (`.agents/skills/verify-learnharness/`), built on e2e (`e2e.config.ts`, `tests/e2e/`), before saying it is done or merging. When a route or label a test relies on changes, update the test and its feature file in the same commit.

## User data

- On-disk user data acquires compatibility obligations: persistent-schema changes are migrations with tolerant reads, not free edits plus wipe-your-dev-data. `data/jobs/` is scratch/transient, with no obligation.

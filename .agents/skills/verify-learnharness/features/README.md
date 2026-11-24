# Feature map

One file per user-facing feature: how a learner reaches it, how e2e drives
it, what proves it works, and the bug-bash charters for it. When a route or
label changes and a test fails, the feature file changes in the same commit.
A feature whose test file is `none` gets a test the first time a change
touches it.

| Feature | Route | Test file |
| --- | --- | --- |
| [Pairing and sign-in](pairing.md) | `/pair` | `tests/e2e/pairing.e2e.ts`, `tests/e2e/auth.setup.e2e.ts` |
| [Teaching session](teaching-session.md) | `/chat/new`, `/chat/<id>` | `tests/e2e/teaching-session.e2e.ts`, `tests/e2e/agent-teaching.e2e.ts` |
| [Session list](session-list.md) | sidebar on every signed-in page | none |
| [Settings](settings.md) | `/settings` | none |
| [Knowledge graph and notes import](graph.md) | `/` | none |

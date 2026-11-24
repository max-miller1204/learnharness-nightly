# Feature map

One file per user-facing feature: how a learner reaches it, how e2e drives
it, what proves it works, and the bug-bash charters for it. Each feature file
names the tests that drive it. When a route or label changes and a test fails,
the feature file changes in the same commit.

| Feature | Route |
| --- | --- |
| [Pairing and sign-in](pairing.md) | `/pair` |
| [Teaching session](teaching-session.md) | `/chat/new`, `/chat/<id>` |
| [Session list](session-list.md) | sidebar on every signed-in page |
| [Settings](settings.md) | `/settings` |
| [Knowledge graph and notes import](graph.md) | `/` |
| [Sidebar update pill and capsule](update-pill.md) | sidebar footer on every signed-in page |
| [Client protocol](client-protocol.md) | `/.well-known/learnharness/server`, `/oauth/token`, `/api/*` |

# Settings

## Sub-features

- Models: the Strong, Cheap and Vision slots and the providers that fill them (custom endpoint, Claude Code, ChatGPT, Copilot, xAI).
- Devices: the paired sessions, revoke, Create pairing link.
- Appearance and the rest of the settings panes.

## How to get to it (user POV)

The Settings button in the sidebar footer (`settings-entry`), or `/settings`.

## Driving it with e2e

The isolated instance's slots hold `e2e-strong`, `e2e-cheap` and `e2e-vision` from the fake model's custom endpoint; the stats bar shows the Strong slot (`stats-model`).

## Proof

A changed slot shows in the stats bar on `/chat/new` and in `GET /api/models`.

## Charters

```
settings-models|web|skeptic|Signed in (--session learner), starting at /settings, read every model and provider shown and compare each with the stats bar on /chat/new; report any that disagree
settings-devices|web|default|Signed in (--session learner), starting at /settings, create a pairing link, then revoke other sessions; report a revoke that signs this browser out or a link that is not one-time
```

## Gotchas

- No provider key reaches the instance: every real provider shows as not connected.

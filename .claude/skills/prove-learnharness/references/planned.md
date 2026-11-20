# Planned surfaces (extension points)

Not built yet. A diff that reaches one of these is BLOCKED for that surface until `/create-prove-it` adds its section to SKILL.md (Scope map row, Answer keys row, a surface section, scripts, a recipe). Keep these notes current as the specs land in `docs/specs/`.

## iOS (iPhone)

This machine has no iOS device or simulator, and an Android run says nothing about iOS rendering. #277's quiz choice math passed on Android and still shipped with the answered card's math on the wrong baseline on the iPhone. A diff that reaches `apps/mobile/**` therefore has an iOS variant: drive it with the iPhone CI job when the [mobile beta recipe](features/mobile-beta.md) has one, and otherwise put "iOS not proved" under Not covered, with the owner's TestFlight check as the unlock. Never count an Android pass as an iOS pass.

## Client protocol

Built (roadmap item 21, `docs/specs/client-protocol.md`): server info at `/.well-known/learnharness/server`, an exact version match through the `X-LearnHarness-Protocol` header on the existing routes (no `/api/v<N>` paths), and the contract in `src/client-protocol/`. It is driven as part of the API surface: recipe [features/client-protocol.md](features/client-protocol.md), script `scripts/protocol-check.mjs`. The `app/api/v<N>/**` rule in `scope.mjs` stays PLANNED in case a versioned path is ever added.

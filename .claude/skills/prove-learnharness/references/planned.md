# Planned surfaces (extension points)

A surface here has no section in SKILL.md. A diff that reaches one is BLOCKED for that surface until `/create-prove-it` adds its section to SKILL.md (Scope map row, Answer keys row, a surface section, scripts, a recipe). When a spec for one lands in `docs/specs/`, update its note here.

## iOS (iPhone)

An Android run says nothing about iOS rendering: #277's quiz choice math passed on Android and still shipped with the answered card's math on the wrong baseline on the iPhone. A diff that reaches `apps/mobile/**` therefore has an iOS variant, and the Android steps run as usual. Drive the iOS variant with the iPhone CI job when the [mobile beta recipe](features/mobile-beta.md) has a section for it. Without one, the iOS variant is BLOCKED, with the owner's TestFlight check as the unlock. Never count an Android pass as an iOS pass.

## Client protocol

Built (roadmap item 21, `docs/specs/client-protocol.md`): server info at `/.well-known/learnharness/server`, an exact version match through the `X-LearnHarness-Protocol` header on the existing routes (no `/api/v<N>` paths), and the contract in `src/client-protocol/`. It is driven as part of the API surface: recipe [features/client-protocol.md](features/client-protocol.md), script `scripts/protocol-check.mjs`. The `app/api/v<N>/**` rule in `scope.mjs` stays PLANNED in case a versioned path is ever added.

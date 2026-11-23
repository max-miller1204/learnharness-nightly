# Planned surfaces (extension points)

A surface here has no section in SKILL.md. A diff that reaches one is BLOCKED for that surface until `/create-prove-it` adds its section to SKILL.md (Scope map row, Answer keys row, a surface section, scripts, a recipe). When a `Spec:` issue is approved for one, update its note here.

## iOS (iPhone)

The phone app is proved on an iOS Simulator on the Mac: [iOS Simulator on the Mac](features/mobile-beta.md#ios-simulator-on-the-mac). Rendering differs by platform: #277's quiz choice math passed on Android and still shipped with the answered card's math on the wrong baseline on the iPhone. A diff that reaches `apps/mobile/**` therefore has an iOS drive, and Android runs, kept in the [Android archive](android-archive.md), never count for it. A device step the Mac can't give you is BLOCKED for that step, with the owner's TestFlight check as the unlock for what a simulator can't show.

## Client protocol

Built (roadmap item 21, `docs/specs/client-protocol.md`): server info at `/.well-known/learnharness/server`, an exact version match through the `X-LearnHarness-Protocol` header on the existing routes (no `/api/v<N>` paths), and the contract in `src/client-protocol/`. It is driven as part of the API surface: recipe [features/client-protocol.md](features/client-protocol.md), script `scripts/protocol-check.mjs`. The `app/api/v<N>/**` rule in `scope.mjs` stays PLANNED in case a versioned path is ever added.

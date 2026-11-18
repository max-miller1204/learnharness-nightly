# LearnHarness Nightly desktop releases

The owner approved this plan on November 18, 2026, including update discovery.

## App and server identity

The desktop app is **LearnHarness Nightly**, with bundle ID `com.learnharness.LearnHarness.Nightly`. On first launch it starts with a fresh Electron profile. Its bundled server uses `data` and `auth.json` under Electron’s `userData` for that profile. The self-hosted server uses `~/.learnharness/userdata` by default. Existing profiles, backups, restores, rollbacks and uninstall behavior stay in place. Item 23 covers connecting desktop to a self-hosted server.

## Build and publication

A successful push CI run on `main` supplies the exact commit. The nightly uses one `<version>-nightly.<UTC date>.<run number>` across the Electron metadata, bundled Next server, the self-hosted archives and update manifests.

- macOS arm64 ships a Developer ID Application-signed app in a DMG and updater ZIP. Electron Builder waits for Apple’s notarization result and staples the app before completing packaging. CI checks the signature, ticket and Gatekeeper result.
- Windows x64 ships an unsigned NSIS installer and its differential update blockmap.
- Linux x64 ships an AppImage.
- The self-hosted archives cover Linux x64, Linux arm64 and macOS arm64.

Every build and smoke check must pass before the publisher stages the assets on one GitHub draft. The publisher verifies the complete inventory, the bytes uploaded to that draft, the archive checksums and all three desktop manifests. It publishes the prerelease, then advances the fixed `nightly/latest.json`. Feed check can repair the pointer from the most recently published nightly if the final upload fails.

## Desktop update discovery

GitHub’s releases Atom feed returned ten entries when checked for this plan. Ten `preview-pr-N` tags can fill that window. The installed GitHub provider skips those non-SemVer tags when running on the nightly channel, leaving it without a nightly to offer. The automated fixture reproduces this for each desktop platform. [Fork release feed](https://github.com/max-miller1204/learnharness-nightly/releases.atom)

The desktop checks `nightly/latest.json` on each update check, validates the nightly version and matching tag, and lets electron-updater’s generic provider load the exact tag’s `latest-mac.yml`, `latest.yml` or `latest-linux.yml`. The manifest version must match the pointer, and installer references must be bare asset filenames. On Windows, the old and new blockmaps come from their corresponding tags, with the updater’s normal full-download fallback. Notes for releases between the running version and the offered version come from the pointer. An unavailable pointer or manifest delays update discovery until a later check.

## Artifact-only verification

Dispatch the existing **Nightly (self-hosted server)** workflow with `dry_run=true` on the branch and confirm the run’s head matches the commit under test. The dry run uploads the six platform artifacts to Actions. The Mac package in this mode is unsigned.

For the ThinkPad, download the Windows x64 and Linux x64 artifacts from that run. Record the run ID, SHA and version with the proof. Install the Windows package and launch the AppImage in the Linux desktop environment. Check that the app opens, its bundled server reports the nightly version and the app can restart with its local data intact. For an update rehearsal, dispatch a second dry run of the same SHA after the first finishes and use its higher-version artifacts with the local `LH_UPDATE_FEED` seam. Put the platform manifest, installer and blockmaps in the test feed. On Windows, record whether the updater used differential download and whether a full download recovered if it could not use the old installer. Record the installed version after relaunch. Use fresh test profiles and run one heavy ThinkPad job at a time. The offline fixture covers exact-tag discovery and Windows tag-to-blockmap routing. The localhost feed covers the packaged download and install path.

Signed macOS acceptance requires a Developer ID-signed and stapled app, Gatekeeper approval, and a successful update and relaunch between two signed builds. The unsigned artifact rehearsal covers packaging and smoke checks. [Signing setup](../electron-nightly-signing.md)

# LearnHarness Nightly mobile

See the [approved beta spec](../../docs/specs/mobile-beta.md). Install and run commands from `apps/mobile`; this npm project uses its own lockfile and Node 22.13 or newer in the Node 22 line.

```sh
npm ci
npm run deps:check
npm run lint
npm run typecheck
npm test
npm start
```

## Release a beta build

Run EAS CLI commands from `apps/mobile` in the full Git checkout. The source archive needs the shared `src/` tree, `build/icon.png` and the title font `public/fonts/cmunbx.ttf`. Before the first signed build, the owner needs to link the Expo project, confirm the two store IDs, authorize Apple signing and App Store Connect submission, configure the Android upload key and scoped Play submission access, and assign the testers. Store access and a test tailnet endpoint are separate from this code. [Expo build layout](https://docs.expo.dev/build-reference/build-with-monorepos/) · [EAS Submit](https://docs.expo.dev/deploy/submit-to-app-stores/)

On the exact approved source revision, run:

```sh
eas build --profile beta --platform all
eas submit --profile beta --platform ios --id <ios-build-id>
eas submit --profile beta --platform android --id <android-build-id>
```

Assign the iOS build to the TestFlight group. Roll out the Android bundle to Play's **Internal testing** track and confirm an invited tester can install it. Use `android-proof` for an installable APK on the proof device. Record the Git SHA, EAS build IDs, iOS build number, Android version code, and server revision. Every beta update uses fresh store builds.

## TestFlight expiration and proposed cadence

**A TestFlight build expires 90 days after upload.** Once it expires, the installed copy stops opening. Upload and assign a fresh build in time for testers to install it. [Apple TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/) · [App Store Connect build statuses](https://developer.apple.com/help/app-store-connect/reference/app-uploads/app-build-statuses)

**Proposal for owner approval:** Build and submit when a nightly includes changes to `apps/mobile/`, the shared protocol, or portable code the app imports. If TestFlight hasn't had a fresh upload by day 75, set a reminder to rebuild and submit the current approved source, then confirm the new build is available to testers. This cadence is pending approval.

Google's Play internal testing documentation lists no equivalent build expiration. Its separate **Internal App Sharing** feature expires download links after 60 days. This beta uses the internal testing track. [Play internal testing](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en) · [Play Internal App Sharing](https://support.google.com/googleplay/android-developer/answer/9844679?hl=en)

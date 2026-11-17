# Next.js security upgrade (16.4.3 to 16.4.5)

## Why

Every `next build` run by an agent stops once with `SecurityFatalError: upgrade Next.js`, and the retry only passes within 5 minutes. That blocks prove runs. Next shows the notice because the installed version is affected by an active npm advisory.

## Advisory

- GHSA-mfr8-8qww-v76h (CVE-2026-119790): information disclosure across root params when a `'use cache'` function is also called through `unstable_cache()`.
- Affected: `next >= 16.3.0, <= 16.4.4`. First patched: `16.4.5`.
- 16.4.5 is the November 2026 security release. It also fixes six related moderate advisories (GHSA-vc7v-qv4w-wrv8, GHSA-vvgp-ww4w-46vf, GHSA-rhh4-g77r-r9qj, GHSA-pc58-hwjq-p385, GHSA-7qx7-33qx-rqx2, GHSA-f3mh-rxg3-f5g2).
- The npm bulk advisory endpoint (the source Next's notice reads) lists no advisory for 16.4.5.
- Sources: https://github.com/advisories/GHSA-mfr8-8qww-v76h, https://github.com/vercel/next.js/releases/tag/v16.4.5, https://nextjs.org/blog/november-2026-security-release

## Change

- `next` `^16.4.3` to `^16.4.5`, and `@next/eslint-plugin-next` `^16.4.3` to `^16.4.5`. The lockfile pins 16.4.5 (with `@next/env` and the `@next/swc-*` binaries, which `next` pins to its own version).
- This is the smallest fixing upgrade: a patch release in the same minor. 16.4.6 (latest) is not taken. It adds only backported bug fixes, including automatic compression of route handler responses, which would be an unrelated behaviour change.
- No other packages change. The repo has no `eslint-config-next`.
- No code changes. The 16.4.4 and 16.4.5 release notes list no breaking changes, and the bundled docs (`node_modules/next/dist/docs/`) are identical between 16.4.3 and 16.4.5.

## What must keep working

- `next build` completes with no `SecurityFatalError` notice and no retry.
- `npm run typecheck`, `npm run lint` and `npm test` pass as on the base commit.
- Every surface behaves as on the base commit (the prove-learnharness smoke for a launch-config change): the app starts, a teaching session works end to end in the web UI, the HTTP API checks match, and the `lh` launcher commands work.

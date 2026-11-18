# Login and pairing

Status: approved by the owner on 2026-11-17. The owner changed the session lifetime on 2026-11-18.

Goal: roadmap item 6. Every request to a LearnHarness server needs a credential. A device gets one by opening a one-time pairing link (or typing its code), made by `lh pair`, by `lh up`, at server startup, or in Settings on a device that is already signed in. Browsers keep an `HttpOnly` session cookie; native clients and the desktop app send a bearer token. Settings lists the signed-in devices and revokes them. The model is T3 Code's (`pingdotgg/t3code`, MIT), ported with its notice kept where code is copied.

## Decided by the owner

1. **T3 model.** Copy T3 Code's auth model with the LearnHarness deviations below.
2. **Pairing link** `<origin>/pair#token=<CODE>` (the code is in the URL fragment, so it never reaches server logs), plus its QR code. Made by a new `lh pair` command and from Settings (Settings needs a signed-in device). T3's code format: 12 characters, 5 minute expiry, single use.
3. **No localhost bypass.** Every request needs a credential. `lh up` prints, and where possible opens, a one-time pairing link so the local browser signs in.
4. **Browsers** get an `HttpOnly` session cookie with T3's flags: `SameSite=Lax`, plus `Secure` over https. **Native clients** (the future phone app, the desktop server list) get a bearer token for the `Authorization` header. A paired session stays valid until revoked. Browsers renew the cookie during use. Native tokens have no expiry.
5. **Desktop app** swaps its per-launch secret for a session, so it shows in the device list.
6. **Settings → Devices** lists devices with T3's fields (label, device type, OS, browser, IP, issued, expires, last seen), with **Revoke** for one device and **Revoke all others**.
7. **Gate scope like T3.** Static assets load without a credential, and a signed-out device sees a pairing screen. All data routes (`/api`, the `/api/events` stream, uploads) need a credential.
8. **No rate limit on pairing**, like T3.
9. **LearnHarness's extra checks go** where T3 has none: the Host allowlist (`LH_ALLOWED_HOSTS`) and the cross-site write refusal in `src/server/desktop-access.ts`. See "Security trade-off" below.
10. **Remote clients** reach the server directly over Tailscale HTTPS (Tailscale Serve). Nothing beyond that.

## Security trade-off you chose (please confirm at approval)

Today `desktop-access.ts` has two browser-mode checks. With login on, this PR drops both:

- **Host allowlist (DNS rebinding defense).** It's no longer needed. A rebinding page runs on the attacker's host name, so the browser never sends it the LearnHarness cookie, and without a credential every data route refuses.
- **Cross-site write refusal.** It is replaced by T3's own cookie check: a **cookie** credential is accepted only when the request has no `Origin` header, or has `Sec-Fetch-Site: same-origin`, or its `Origin` host equals the `Host` header. That covers reads too, not only writes. Bearer tokens skip this check, as in T3, because browsers never attach them on their own.

What you give up compared with today's LearnHarness:

- **No limit on guessing pairing codes.** With 12 characters from a 32-letter alphabet (60 bits) and a 5 minute life, guessing is not practical, but nothing slows an attacker down.
- **Anyone holding a session has full access.** That includes Settings, saved keys, starting agent turns, and making new pairing links. There are no per-device permissions. T3 has scopes but gives every paired device all of them.
- **A stolen session credential works until revoked.** Use Settings → Devices to revoke it.
- **The data folder is the root of trust.** Anyone who can write `data/auth/` can mint sessions, the same way `lh pair` does.

## Adopted from T3 Code (veto any)

| Topic | T3's answer, adopted |
|---|---|
| Pairing code | Alphabet `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no 0, 1, I, O), 12 characters, cryptographic random bytes with rejection sampling. Typed codes are case-insensitive, and spaces and `-` are ignored, so `ABCD-EFGH-JKLM` works. |
| Expiry and use | 5 minutes. Single use: claiming a code marks it used in the same locked write that creates the session. |
| Link shape | `<origin>/pair#token=<CODE>`. A `?token=` query is also read, then removed. The page removes the fragment from the address bar with `history.replaceState` before doing anything else. |
| Pair page | Reads the token and submits it automatically. With no token (or after an error) it shows a code field and a **Pair** button. On success it loads `/`. |
| Session token | T3's compact signed format: `base64url(JSON claims) + "." + base64url(HMAC-SHA256(key, claims part))`. Claims: `{ v: 1, kind: "session", sid, iat, exp }` (epoch ms). The token itself isn't stored. LearnHarness keeps the format for compatibility. The signature and the active server-side session record determine whether the token is accepted. |
| Signing key | 32 random bytes, created on first use, file mode `0600`, in a `0700` folder. |
| One token, two carriers | The same token works as the cookie and as `Authorization: Bearer <token>`. The server checks the cookie first, then the bearer header. |
| Cookie | `HttpOnly`, `Path=/`, `SameSite=Lax`, `Secure` when the request is https (`X-Forwarded-Proto` counts), `Expires` is 400 days after issue or renewal, subject to browser limits. Credential responses send `Cache-Control: no-store`. |
| Cookie name | `lh_session_<port>`, where port is the server's own listening `PORT`. Like T3's `t3_session_<port>`, this stops two servers on `localhost` (dev on 3000, self-hosted on 3774) from overwriting each other's cookie. |
| Device fields | `label`, `deviceType` (`desktop`, `mobile`, `tablet`, `bot`, `unknown`), `os`, `browser`, `ip`, `userAgent`, `issuedAt`, `expiresAt`, `lastSeenAt`. Device type, OS and browser are parsed from the User-Agent with T3's rules (code ported from `apps/server/src/auth/utils.ts`). A native client may send its own label, device type and OS, which win. Otherwise the label comes from the pairing link's label, if any. |
| IP | T3's rule: the socket peer, or the last `X-Forwarded-For` entry when the peer is loopback (a local proxy such as Tailscale Serve). LearnHarness always binds 127.0.0.1, so the peer is always loopback: the IP is the last `X-Forwarded-For` entry, or `127.0.0.1` without one. It is recorded when the session is created. |
| Routes | `GET /api/auth/session` (public): `{ authenticated, expiresAt?, sessionId? }`. `POST /api/auth/browser-session` (public): body `{ credential }`, sets the cookie, returns `{ authenticated: true }`. `POST /oauth/token` (public): T3's RFC 8693 token exchange for native clients (below). `POST /api/auth/pairing-token` (signed in): body `{ label? }`, returns `{ id, credential, label?, expiresAt }`. `GET /api/auth/clients` (signed in): the device list with `expiresAt: null` for each non-expiring session. `POST /api/auth/clients/revoke` (signed in): body `{ sessionId }`, returns `{ revoked }`. Revoking your own session is refused (`current_session_revoke_not_allowed`). `POST /api/auth/clients/revoke-others` (signed in): returns `{ revokedCount }`. |
| Native token exchange | `POST /oauth/token`, form-encoded: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<code>`, `subject_token_type=urn:learnharness:params:oauth:token-type:pairing-code`, `requested_token_type=urn:ietf:params:oauth:token-type:access_token`, and optional `client_label`, `client_device_type`, `client_os`. Returns `{ access_token, issued_token_type, token_type: "Bearer" }`. Errors use OAuth's `{ error, error_description }` with status 400. |
| No logout | T3 has no logout route. A device is signed out by revoking it from another device (or by "Revoke all others"). |
| Desktop session | The desktop shell trades its launch secret for a bearer session labeled **LearnHarness Desktop**, device type `desktop`. Each launch revokes the previous desktop session (T3's `replaceActiveForSubjectAndMethod`), so the list shows one desktop row. |
| CLI talks to the store | Like `t3 pair`, `lh pair` writes the pairing link straight into the server's store files. It works whether or not the server is running. |
| Startup link | Like T3's startup link, a server started outside the desktop app and outside `lh` (`npm run dev`, `next start`) prints a one-time link to its terminal on boot. That's stdout, so it never goes into a log file. In `next dev` the link lasts 24 hours (T3's dev rule); otherwise 5 minutes. Startup links are hidden from lists. |
| Terminal and web QR | The Nayuki QR generator (MIT), vendored the way T3 vendors it (`packages/shared/src/qrCode.ts`), with its notice. The terminal draws it with half-block characters; the web draws an SVG. |
| Device list UI | The title is the label, or "OS · browser" when there's no label. Under it: device type · OS · browser · IP, then issued, expires and last seen. The current device has a **This device** badge and no Revoke button. The header has **Revoke all others** and **Create pairing link**. |
| Create link UI | An optional **Device label** field, then the link, its QR code, **Copy link**, **Copy code** and a live countdown to expiry. The link exists only in that dialog: closing it means making a new one (T3: links can only be copied from the client that created them). |

## Where LearnHarness differs from T3, and why (veto any)

1. **Pages are gated, not just the API.** T3's app shell holds no data, so T3 serves it to anyone. LearnHarness pages render data on the server: `/chat/[id]` puts the transcript into the HTML. So `proxy.ts` **rewrites** any signed-out page request to the pairing screen. The address bar keeps the URL, and after pairing the page loads normally. Static files stay public: `/_next/static/*`, `/_next/image`, `/favicon.ico`, `public/` (`/fonts/*`, `/siwc/*`, `/worklets/*`, `/plugin-loader.js`). Signed-out API calls get `401 { error }`.
2. **`/api/health` stays public.** Launchers already installed (launcher protocol 1, a frozen contract) health-check a newly installed version without any credential. If health needed one, the update that brings login would fail its health check and roll itself back. The body is unchanged: `ok`, `version`, `selfhost`, `idle`, `update`. T3 also publishes its version without auth, in `/.well-known/t3/environment`.
3. **No WebSocket tickets.** LearnHarness has no WebSockets. `/api/events` is an `EventSource` on the same origin, which sends the cookie (desktop: the injected header).
4. **The store is files, not SQLite.** Every LearnHarness store is a file adapter. The auth store lives in `data/auth/` (below), behind a lock file, so the server and `lh` never write it at the same time.
5. **Pairing codes are stored hashed** (SHA-256). T3 stores them in plain text. Nothing ever needs to read a code back, so the hash costs nothing. It means a leaked store file holds no usable codes.
6. **The device list is plain HTTP** (`GET /api/auth/clients`, refetched after each change and every 30 seconds while the section is open). T3 streams it over its WebSocket RPC.
7. **No scopes.** Every session has full access, which matches T3's default.
8. **Last seen** is updated on authenticated requests, at most once a minute per session. T3 updates it when a WebSocket connects, and LearnHarness has none.
9. **Paired sessions last until revoked (owner decision, 2026-11-18).** This supersedes T3's 30-day lifetime for this single-user, tailnet-only server. Existing signed tokens continue to work with their session records, including after the old token deadline. The store reads existing non-CLI records as non-expiring and persists that on its next write. Revocations stay in force. A browser that still holds its old cookie gets a new 400-day expiry during authenticated use through the gate. A browser that has already discarded its cookie needs a new pairing link. The hidden `lh update` sessions and single-use pairing links keep their five-minute limits.
10. **Pairing behind an HTTPS proxy.** The rewrite uses the local HTTP listener even when the incoming request advertises HTTPS. See [Pairing rewrite behind HTTPS](fix-pair-rewrite-https.md).

## Proposed defaults (veto any)

| Topic | Proposal |
|---|---|
| Store location | `<data folder>/auth/`: `signing-key` (32 bytes, `0600`), `sessions.json`, `pairing.json`, `.lock`. The folder is `0700`. The data folder is `LH_DATA_DIR` (self-hosted: `~/.learnharness/userdata/data`; desktop: the app's userData `data/`; dev: the repo's `data/`, already in `.gitignore`). |
| Backups | **Excluded.** The pre-update snapshot skips `data/auth/`, and `lh restore` keeps the live `data/auth/`. Restoring old learning data then never brings back a device you revoked, and never signs out the devices you have now. Stricter than T3, whose pre-update database backup includes sessions, so its rollbacks sign out devices paired after the backup (owner chose to keep this rule, 2026-11-17). |
| Pruning | When the store is written, sessions expired or revoked more than 30 days ago are removed, and so are pairing links past their expiry. |
| Shared code | `selfhost/src/auth-store.ts`, using Node built-ins and erasable TypeScript only, like `protocol.ts`. The server bundles it, and `lh` runs it directly. It owns the file formats, the lock, code and token creation, and token checks. |
| How `lh` authenticates | `lh pair` and `lh up` write links straight into the store. `lh status` and the launcher's health checks use the public `/api/health`. `lh update` needs `/api/updates/*`, so it writes itself a hidden 5 minute session into the store (method `cli`), sends it as a bearer token, and revokes it afterwards. Hidden sessions never appear in the device list, and "Revoke all others" leaves them alone. |
| `lh pair` | `lh pair [--label NAME]`. It prints `http://127.0.0.1:<port>/pair#token=...` first under **On this machine only**, then the QR code for the Tailscale HTTPS link when present or for the local link otherwise. The remote link is under **From your other devices**, just above the code in `XXXX-XXXX-XXXX` form and its expiry time. One code works in every printed link. |
| `lh up` | After starting the service, it prints a pairing link the same way. It opens the local link in a browser with `xdg-open` when a desktop session exists (`DISPLAY` or `WAYLAND_DISPLAY` set, or WSL) and the command runs in a terminal; `--no-open` skips opening it (owner approved, 2026-11-17). The old closing line "LearnHarness has no login" becomes: "Pair another device with `lh pair`. Never turn on Tailscale Funnel." |
| Settings link address | The link uses the address you have open. On a self-hosted server with Tailscale on, the dialog also offers the Tailscale HTTPS address. The server reads it from the launcher's `userdata/config.json` through `LH_HOME`, which already-installed launchers pass too. |
| Settings placement | A new **Devices** section in the settings nav, after General. |
| Pairing screen copy | Title "Pair this device". Body: "Open a pairing link, or enter its code. On the server machine, run `lh pair`. On a device that's already signed in, use Settings → Devices → Create pairing link." Then the code field and **Pair**. Errors: "That code is wrong, expired or already used. Make a new one." |
| Startup link line | `[auth] Pair a browser: http://localhost:<port>/pair#token=<CODE> (one-time, expires in 5 minutes). Make another with Settings → Devices, or \`npm run pair\`.` Printed only when neither `LH_SELFHOST` nor `LH_DESKTOP_SERVER` is set. |
| `npm run pair` | A small script for dev and `next start` servers. It writes a link into `./data` (or `LH_DATA_DIR`) and prints it with the port from `PORT` (default 3000). |
| Desktop bootstrap | The shell keeps generating the 32-byte per-launch secret and passing it as `LH_DESKTOP_API_SECRET`. When the server answers, the shell trades the secret at `/oauth/token` (`subject_token_type=urn:learnharness:params:oauth:token-type:desktop-bootstrap`; accepted only when `LH_DESKTOP_SERVER=1`, checked in constant time) before opening a window. The existing request hook then injects `Authorization: Bearer <token>` instead of `x-learnharness-desktop`, on every request to the app's own origin from trusted windows (pages too, not only `/api`), keeping all its current frame and origin checks. `desktop:dev` (`LH_DEV_URL`) has no secret, so its window pairs like a browser, using the startup link from `npm run dev`. |
| Revoked while open | When the events stream fails, the app checks `/api/auth/session`. If it reports signed out, the app reloads, which lands on the pairing screen. |
| Route-level checks | The same-origin checks inside `web-subscription-http.ts`, `claude-code.ts` and `custom-provider-http.ts` stay. They guard sign-in and installer controls, not the general gate. `custom-provider-http.ts` stops special-casing the desktop secret and uses its existing same-origin check in both modes. |
| `LH_ALLOWED_HOSTS` | No longer read. The launcher stops setting it, and the docs drop it. |
| Not in this PR | `lh devices` (list or revoke from the terminal), a list of pending pairing links, and a logout button. Revoking from another device, or `lh pair` plus "Revoke all others", covers lockout and loss. |

## Design

### Store (`selfhost/src/auth-store.ts`)

- **`sessions.json`:** `{ version: 1, sessions: [{ id, method: "pairing" | "desktop" | "cli", hidden?, label?, deviceType, os?, browser?, ip?, userAgent?, issuedAt, expiresAt, lastSeenAt?, revokedAt? }] }`. Times are ISO strings.
- **`pairing.json`:** `{ version: 1, links: [{ id, codeHash, label?, hidden?, createdAt, expiresAt, consumedAt? }] }`.
- **Writes:** read-modify-write under `auth/.lock`, taken with `O_EXCL` (a lock older than 10 seconds counts as stale). Each file is written to a temp file and renamed into place. A server request never blocks its event loop on a held lock: it tries once and retries asynchronously for up to 12 seconds (past the stale threshold), then answers 503 "The login store is busy" and the pairing screen says to try again (the code stays valid). Last-seen updates skip a held lock. `lh` and scripts wait synchronously.
- **Reads:** a cache keyed on file mtime and size, so the proxy pays one `stat` per request.
- **Functions:** `createPairingLink`, `claimPairingCode` (consumes the link and creates the session in one locked write), `issueSession`, `verifyToken`, `listSessions`, `revokeSession`, `revokeOthers`, `touchLastSeen`, `normalizeCode`, `formatCode`.

### Server

- **`src/server/auth.ts`:**
  - `requestCredential(request)` reads the cookie, then the bearer header, and applies the cookie origin rule.
  - `authenticate(request)` returns the session or nothing.
  - The UA parser is ported from T3, with its MIT notice.
  - Cookie helpers.
- **`proxy.ts`:**
  - The matcher covers everything except the static paths, plus the exact streamed documents route.
  - Public: `/pair`, `/api/health`, `/api/auth/session`, `/api/auth/browser-session`, `/oauth/token`.
  - Signed-out page requests are rewritten to `/pair`. Signed-out API requests get 401. A cookie that fails the origin rule gets 403.
  - A valid session gets its last-seen time touched. For cookie-authenticated requests, the gate renews the cookie when that write succeeds.
- **`src/server/desktop-access.ts`:** reduced to `subscriptionRequestOrigin`. `browserOnlyMode`, `desktopAPIAuthorized`, `browserHostAllowed`, `browserAPIRefusal` and `apiRequestRefusal` are deleted, and the streamed documents route calls the new auth check instead.
- **Routes:** `app/api/auth/session`, `app/api/auth/browser-session`, `app/api/auth/pairing-token`, `app/api/auth/clients`, `app/api/auth/clients/revoke`, `app/api/auth/clients/revoke-others`, `app/oauth/token`.
- **`app/pair/page.tsx`** with its client component.
- **`app/layout.tsx`:** when the request isn't signed in, renders only the page (the pairing screen) inside the themed `<html>`, without the app shell, events or plugin providers. So a signed-out page makes no data calls.
- **`instrumentation.ts`:** prints the startup link (rule above).

### Desktop (`electron/`)

- `main.cjs` makes the token exchange after `waitUntilUp`.
- `desktop-api.cjs` injects `Authorization` for every path on the app's origin, instead of `x-learnharness-desktop` for `/api` only.
- No other changes to `main.cjs`. The item 7 lane is editing its updater code, so this PR stays out of it.

### Launcher (`selfhost/`)

- `lh pair` is new.
- `lh up` prints and opens a link.
- `lh update` uses the hidden session.
- `backup.ts` excludes and preserves `data/auth/`.
- `config.ts` stops merging `LH_ALLOWED_HOSTS`.
- QR is vendored in `selfhost/src/qr.ts` and imported by the web as well.

### Settings

`components/settings/devices-section.tsx`: the list with **Never expires** for paired devices, revoke buttons, and the create-link dialog with a QR SVG.

### Docs

- `docs/self-hosting.md`: pairing, `lh pair`, the upgrade note.
- `docs/development.md`: the startup link, `npm run pair`, remove `LH_ALLOWED_HOSTS`, the new security model.
- `docs/fork-roadmap.md` item 6: marked built, linking this spec.
- `SECURITY.md`, if it describes the old trust model.
- The prove skill's references and scripts, which must pair before calling the API.

### Tests and smoke scripts

- **Unit tests:**
  - code format and normalizing;
  - single use, expiry, and that a used or expired code can't be claimed;
  - the token signature and tampering;
  - revoked and expired sessions;
  - revoke-others keeping the current and hidden sessions;
  - the cookie origin rule;
  - the proxy gate table: public paths, a signed-out page rewritten, signed-out API 401, the static paths, the streamed documents route;
  - UA parsing;
  - that backups exclude `data/auth`.
- **Smoke scripts** (`smoke-server.mjs`, the plugin smokes, the prove scripts) get a session by writing one into the store with `auth-store.ts` before the server starts, then send it as a bearer token or set it as the cookie in the browser.
- Existing tests of the deleted Host and cross-site checks are removed or rewritten for the new gate.

## Upgrading an existing install (no lockout)

- **Self-hosted.** The update installs as today. The already-installed launcher health-checks the public `/api/health`, so the trial passes and commits. Afterwards, any open browser shows the pairing screen on its next page load. The shim already points at the new version, so `lh pair` on the server machine prints a link at once, and so does the next `lh up`. The release notes and `docs/self-hosting.md` say this. Someone who only uses a phone needs a shell on the server, for example over SSH or Tailscale SSH, to run `lh pair` once.
- **One-time window after that upgrade (owner accepted, 2026-11-17).** The launcher already running keeps supervising until the next service restart (`lh status` says so). Its snapshots copy all of `userdata/`, so backups it takes in that window hold a copy of `data/auth/`, and if a trial fails in that window its rollback restores the login store from that snapshot, the way T3's rule would. Once the service restarts, the new launcher takes over and the rule above applies. `lh restore` run from the new `lh` always keeps the live store, even with one of those backups.
- **Desktop app.** Nothing to do: the shell signs itself in at launch.
- **`npm run dev` and `next start`.** Open the link printed at startup, or run `npm run pair`.

## What later items need from this (not built here)

- **21, client protocol.**
  - The bearer token format above is frozen as `pairing-v1`. A client gets a token from `/oauth/token` and sends `Authorization: Bearer`.
  - Item 21 adds a public server-info route (T3's `/.well-known/t3/environment` equivalent) reporting the server version, the protocol version and capabilities including `pairing-v1`.
  - The routes this PR adds (`/api/auth/*`, `/oauth/token`) are the first candidates to freeze.
- **22, PWA.** Its manifest, icons and service worker have to join the proxy's static exemption. A phone pairs by scanning `lh pair`'s QR code over Tailscale.
- **23, desktop server list.**
  - A remote server entry stores a bearer token from `/oauth/token`, with `client_label` and `client_device_type=desktop`.
  - The shell injects it with the same hook this PR changes.
- **24, remote attachments.** Its upload routes live under `/api`, so the gate covers them with no extra work.

## Out of scope

- LAN mode (item 5);
- T3 Connect or any relay;
- DPoP;
- scopes;
- MCP OAuth;
- rate limiting;
- `lh devices`;
- logout.

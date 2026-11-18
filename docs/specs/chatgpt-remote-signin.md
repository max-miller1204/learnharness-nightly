# ChatGPT sign-in from any device

Status: approved by the user on 2026-11-17.

## Problem

ChatGPT sign-in (`electron/chatgpt.cjs`, used by both the desktop main process and the self-hosted web server) starts a loopback listener on the machine running LearnHarness and sends OpenAI `redirect_uri=http://127.0.0.1:<port>/auth/callback`. When the browser is on another device (the user's Mac over Tailscale, a phone, any LAN browser), OpenAI redirects that device's browser to its own `127.0.0.1`, the page fails (`ERR_CONNECTION_REFUSED`) and sign-in never completes.

## Findings

1. **Device-code flow is not available to LearnHarness.** Codex CLI's `codex login --device-auth` calls `POST https://auth.openai.com/api/accounts/deviceauth/usercode` with Codex's own first-party client id (`app_EMoamEEZ73f0CkXaXp7hrann`). Probed on 2026-11-17: that id gets a user code (HTTP 200), but `dynamic_agent_client` and LearnHarness's saved `oaiapp_…` registration both get `400 invalid_client` ("This app is unavailable"). Borrowing Codex's client id would impersonate Codex CLI and would not give the agent-scoped (`chatgpt.tokens.use.direct`) registration, so it is out.
2. **Only loopback redirects are accepted.** Probed the authorize endpoint with the same parameters: `http://127.0.0.1:<port>/auth/callback` proceeds to log-in (302); `http://100.100.100.100:3000/auth/callback` and an `https://` public host both return 400. The server cannot ask OpenAI to redirect back to its own Tailscale or LAN address.
3. **T3 Code uses the same OAuth** (`dynamic_agent_client`, `agent_name_hint`, `ext_agent_host_id`, same scopes; `apps/server/src/provider/CodexChatGptAuth.ts`). For remote browsers it uses **paste-back**: the interaction is marked `acceptsCallback`, and the UI shows "If sign-in doesn't return to T3 Code, paste the URL from the final localhost page." with a field and a Connect button. The server validates the pasted URL with `codexCallbackUrl` (`packages/shared/src/codexAuthHandoff.ts`): exact origin and path of the redirect URI, no userinfo or hash, exactly one `state` equal to the expected one, at most one `client_id`, exactly one of `code` or `error`, and an added `http://` when the browser hid the scheme. A pasted URL and the listener share one single-use flag. T3's web UI shows the paste field directly when the page is not on a loopback host ("remote web") and hides it behind "Having trouble signing in?" when it is. T3's sign-in times out after 5 minutes. T3 also has a desktop-helper handoff (`t3code://auth/codex`) for when the remote client is T3 desktop; LearnHarness has no remote desktop client yet (item 23), so that part is out of scope.

## Design

Adopt T3's paste-back. Today's one-click flow is unchanged when the browser is on the server machine.

### Server core (`electron/chatgpt.cjs`)

- The loopback listener stays exactly as it is, with the same checks (method GET, exact origin, path `/auth/callback`, `Host` header, single use, duplicate-parameter and state rejection without consuming the attempt). Its post-validation work moves into one internal `accept(params)` function that both the listener and paste-back call, so the exchange, identity check and storage code exist once.
- New `complete(callbackUrl)` on the controller:
  - No sign-in pending: fails with "ChatGPT sign-in is no longer waiting. Start sign-in again."
  - Parses the pasted text: trims it; rejects anything over 8192 characters; adds `http://` when there is no scheme (browsers hide it); requires protocol `http:`, origin exactly equal to this attempt's redirect origin (`http://127.0.0.1:<port>`), path `/auth/callback`, no username, password or hash; at most one each of `state`, `code`, `client_id`, `error`; `state` equal to the expected state; exactly one of `code` or `error`.
  - Any of those failing: fails with "This address does not belong to the current ChatGPT sign-in. Copy the full address from the sign-in tab and try again." and **does not consume** the attempt (the real redirect, or a correct paste, can still finish it), matching the listener.
  - Passing: consumes the attempt (the same `consumed` flag as the listener, so a URL can complete it only once, by either path), closes the listener, runs the shared `accept`, and resolves when the attempt finishes with the resulting status (success or the same errors as today).
- The PKCE verifier, nonce and state never leave the server process. The pasted URL carries only the one-time code, which is useless without the verifier.
- Sign-in timeout goes from 3 to 5 minutes (T3's value), to leave time for signing in on another device and copying the address.

### Control surfaces (no new routes)

- `electron/chatgpt-ipc.cjs` `chatGPTControl`: new op `complete` with a string `url`.
- `src/server/web-subscription-http.ts`: add `complete` to the ChatGPT op allowlist on the existing `POST /api/subscriptions`. Everything else there stays: the same-origin checks, the custom header, the 16 KB body cap, and item 6's auth when it lands. No new route.
- `electron/preload.cjs` and `ChatGPTControlBridge` (`src/core/contracts/chatgpt.ts`): add `complete(callbackUrl)`. The web bridge (`components/settings/subscription-client.ts`) posts `{ providerId: "chatgpt", op: "complete", url }`. The pasted URL is never logged and never put in status, events or SSE.

### UI (`components/settings/chatgpt-connection.tsx`)

While a sign-in is pending ("Waiting for browser sign-in…"), the connect dialog shows a paste panel:

- **Remote** (web page whose host is not `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`): the panel is open:
  > Signing in from another device? When ChatGPT finishes, the sign-in tab ends on a page that won't load (its address starts with http://127.0.0.1). Copy that page's full address and paste it here.
  >
  > [ field: "Sign-in tab address", placeholder `http://127.0.0.1:…/auth/callback?…` ] [ Finish sign-in ]
- **Same machine** (loopback page, or the desktop app's own bridge): the panel is folded behind a quiet text button, "Sign-in tab didn't come back?", which opens the same panel.
- The field is a password-type input with autocomplete off (T3's choice, so the code isn't shown on a shared screen). "Finish sign-in" is disabled while the field is empty or a paste is being submitted.
- A rejected paste shows its error under the field; the sign-in stays pending and the field keeps its text, so the user can fix it or keep waiting. A paste that completes the sign-in follows today's path (background-use draft applied, dialog closes).
- Privacy notice in the web dialog: drops "Complete ChatGPT sign-in in a browser on that same machine." The rest is unchanged ("…on the machine running LearnHarness").
- The browser tab still opens through today's one-use same-origin action (`/api/subscriptions/browser?id=…`), which already works from a remote device.

### Not changed

- Native subscription sign-ins (Copilot, Grok, etc. in `electron/subscriptions.cjs`).
- The authorize URL parameters, token exchange, identity checks and credential storage.
- The listener's checks and behaviour.

## Small choices (open to veto)

1. Paste-back offered on every surface (remote web open, local web and desktop folded), as T3 does, rather than remote only.
2. "Remote" is decided in the browser from the page's own hostname (T3's `isLoopbackHost` rule). It only decides whether the panel starts open; the server accepts a valid paste either way.
3. Timeout 3 to 5 minutes. The one-use browser action stays at 3 minutes (it is used right away).
4. Pasted text limit 8192 characters; scheme-less paste accepted.
5. Password-type field.
6. Wording above.

## Follow-ups (not in this change)

- Phones (item 22): paste-back works from a phone browser. A smoother option is T3's desktop-helper style handoff or an app deep link; revisit with the Expo app.
- Native subscription providers with loopback callbacks may have the same remote problem.

## Verification

- Unit tests (`tests/chatgpt-auth.test.ts`, `tests/web-subscriptions.test.ts`, `tests/chatgpt-connection-ui.test.tsx`):
  - paste completes sign-in, exchanging with the original `redirect_uri` and verifier;
  - wrong state, wrong port, wrong host (`localhost`, a LAN IP), `https:`, extra path, hash, userinfo, duplicate params, both or neither of code and error, and oversize input are all rejected without consuming, and a later correct paste or redirect still completes;
  - single use: after a paste completes, the listener refuses; after the listener completes, a paste is refused;
  - scheme-less paste accepted;
  - `error=access_denied` paste ends as cancelled;
  - no pending attempt is refused;
  - pasted URL and code never appear in status;
  - HTTP: `complete` is reachable only through the existing same-origin checks;
  - UI: the panel starts open on a non-loopback host and folded on loopback, a rejected paste keeps the attempt pending and shows the error, and a successful paste closes the dialog.
- Live (prove-learnharness): run the self-hosted server and drive the web UI from a non-loopback address on this machine (Tailscale or LAN IP). Start ChatGPT sign-in, finish the real OpenAI page (the user clicks through if a real account login is needed), let the redirect fail, paste the address, and see the account connected. Also confirm the loopback one-click flow still completes without pasting.

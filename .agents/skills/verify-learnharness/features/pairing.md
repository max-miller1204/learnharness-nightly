# Pairing and sign-in

## Sub-features

- A signed-out page request is rewritten to the pairing screen (`proxy.ts`); a signed-out API request gets 401.
- A pairing link (`/pair#token=<code>`) signs the browser in without typing.
- A code typed on the pairing screen signs the browser in; a wrong one shows an error.
- A link opened in a browser that is already signed in asks before it replaces the session.

## How to get to it (user POV)

Open any page signed out, or a link from `npm run pair`, `lh pair`, or Settings → Devices → Create pairing link.

## Driving it with e2e

`tests/e2e/pairing.e2e.ts` (signed out) and `tests/e2e/auth.setup.e2e.ts` (the `learner` session every signed-in test uses). Codes come from `createPairingLink(state.dataDir)` (`selfhost/src/auth-store.ts`), the function `npm run pair` calls. Locators: the heading "Pair this device", the textbox "Pairing code", the button "Pair", `pair-error`, and `settings-entry` as the signed-in landmark.

## Proof

After pairing, the sidebar footer's Settings button shows and the page is the home graph. A refused code leaves the pairing screen with `pair-error` visible and no session.

## Charters

```
pair-edge|web|fuzzer|Starting signed out at /pair, enter the pairing code empty, with spaces, lowercase, with the dashes missing, and 300 characters long; report any input that signs in when it should not, or an error that is missing or misleading
pair-relink|web|default|Signed in (--session learner), open /pair and then a fresh pairing link; report a session replaced without asking or a confirm dialog whose Cancel still signs in
```

## Gotchas

- A pairing code is one-time: mint a fresh one per test.
- The session cookie is named after the port (`lh_session_<port>`), so a session from another run never applies.

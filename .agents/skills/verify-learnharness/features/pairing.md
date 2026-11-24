# Pairing and sign-in

## Sub-features

- A signed-out page request is rewritten to the pairing screen (`proxy.ts`); a signed-out API request gets 401.
- A pairing link (`/pair#token=<code>`) signs the browser in without typing.
- A code typed on the pairing screen signs the browser in; a wrong one shows an error.
- A link opened in a browser that is already signed in asks before it replaces the session.

## How to get to it (user POV)

Open any page signed out, or a link from `npm run pair`, `lh pair`, or Settings → Devices → Create pairing link.

## Driving it with e2e

`tests/e2e/pairing.e2e.ts` (signed out) and `tests/e2e/auth.setup.e2e.ts` (the `learner` session every signed-in test uses). Both fill the `pairing-code` secret (`e2e.config.ts`, `tests/e2e/support/instance.ts`), which mints a one-time code with `createPairingLink` (`selfhost/src/auth-store.ts`, the function `npm run pair` calls) in the instance's data folder, so the code stays out of `report.json` and traces. Locators: the heading "Pair this device", the textbox "Pairing code", the button "Pair", `pair-error`, and `settings-entry` as the signed-in landmark. No test opens `/pair#token=<code>`: a link puts the code in the URL, which reports record.

## Proof

After pairing, the sidebar footer's Settings button shows and the page is the home graph. A refused code leaves the pairing screen with `pair-error` visible and no session.

## Charters

```
pair-edge|web|fuzzer|Starting signed out at /pair, enter the pairing code empty, with spaces, lowercase, with the dashes missing, and 300 characters long; report any input that signs in when it should not, or an error that is missing or misleading
pair-relink|web|default|Signed in (--session learner), open /pair and then a fresh pairing link; report a session replaced without asking or a confirm dialog whose Cancel still signs in
```

## Gotchas

- A pairing code is one-time: each fill of the `pairing-code` secret mints a fresh one.
- The session cookie is named after the port (`lh_session_<port>`), so a session from another run never applies.

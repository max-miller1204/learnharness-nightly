# ChatGPT sign-in polish (paste-back)

Status: approved by the user on 2026-11-17. A follow-up to `docs/specs/chatgpt-remote-signin.md`, which still holds for everything not listed here.

## Changes

1. **Say it up front on another device.** In the ChatGPT connect dialog, before the sign-in tab opens, a page that is not on a loopback host (the same rule as the paste panel: not `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`) shows:
   > On this device, ChatGPT's last page will say it can't be reached. That's expected: copy its address, then come back here to paste it.

   It is not shown on a loopback page or in the desktop app, and it goes away once the sign-in is pending, when the paste panel takes over.
2. **One-tap Paste.** The paste panel gets a **Paste** button next to the address field. It reads the clipboard (`navigator.clipboard.readText()`) and puts the trimmed text in the field. It does not submit: the user still clicks **Finish sign-in**.
   - The button appears only where the browser can read the clipboard: `window.isSecureContext` is true and `navigator.clipboard.readText` exists. On plain-http LAN or Tailscale pages it is hidden and manual paste is unchanged.
   - If the read is refused or fails, the button is disabled for the rest of that attempt and the panel says "Clipboard access isn't allowed here. Paste into the field instead." Manual paste still works.
   - An empty clipboard leaves the field as it is.
   - A clipboard read that finishes after its attempt ended changes nothing.

## Not changed

- No Settings hint about signing in on the computer running LearnHarness (the user declined it).
- The server, routes, validation and everything else in `chatgpt-remote-signin.md`.

## Small choices (open to veto)

- Paste fills the field and does not auto-submit, so the user sees what is sent.
- The up-front sentence sits under the privacy notice in the connect dialog.

## Verification

- UI tests: the up-front sentence on a non-loopback web page before sign-in, not on loopback or desktop, and gone once pending; Paste hidden without a secure context or clipboard API; Paste fills the field from the clipboard; a refused read disables Paste and shows the fallback note while manual paste still completes.
- Live (prove-learnharness): from a non-loopback address the sentence shows before Continue and Paste is hidden (plain http); on a loopback page (a secure context) Paste reads the clipboard into the field.

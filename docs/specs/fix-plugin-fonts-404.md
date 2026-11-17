# Spec: no fonts.css 404 with the core plugins enabled

Status: bug fix. Approach chosen by the user, 2026-11-17 (inline the font faces).
Base: main at 6fdc890. Findings below were measured on the cached 42ae045 build, which has the same rich-code-blocks plugin.

## What main does today (measured)

With the 4 core plugins enabled (flashcards, coding-questions, drawing-pad, rich-code-blocks), a `prove-learnharness` web drive logs `Failed to load resource: 404` for `/chat/assets/fonts/fonts.css` three times: once on `/chat/new` and twice on `/chat/<chat>`.

- The app itself loads the fonts correctly. rich-code-blocks' `dist/styles.css` starts with `@import url("./assets/fonts/fonts.css")`. The browser resolves it against the stylesheet (`/api/plugins/rich-code-blocks/assets/assets/fonts/fonts.css`, 200), registers 140 `rich-code-blocks-font-*` faces, and `cmr10.ttf` loads (200, `document.fonts.check` true).
- The 404 comes from axe-core 4.10.3, which `web-teach.mjs` runs on exactly those three page loads. Its CSSOM preload (`parseSameOriginStylesheet`) reads `CSSImportRule.href`, which is the raw `./assets/fonts/fonts.css`, and fetches it with XHR against the page URL. Driving the same pages without axe logs no 404. Any CSSOM-walking tool a user runs (an accessibility browser extension built on axe) would log the same 404.

## Change

- `plugins/rich-code-blocks/scripts/build.mjs` stops writing `dist/assets/fonts/fonts.css`. It reads isomorphic-tikzjax's `css/fonts.css`, renames each family to `rich-code-blocks-font-<name>` as before, rebases each `url('bakoma/ttf/<name>.ttf')` to `url('assets/fonts/bakoma/ttf/<name>.ttf')` (relative to `styles.css`), and writes those `@font-face` rules followed by `src/styles.css` as `dist/styles.css`.
- The build fails if a line of the upstream font CSS does not match the pinned one-face-per-line format, if the file is empty, or if a rebased font file is missing from `dist/`. Same style as the build's other pinned-dependency checks.
- `src/styles.css` loses its `@import` line; a comment says why the faces are inlined.
- A plugin test (`plugins/rich-code-blocks/tests/build.test.ts`) runs the real build and asserts: no `@import` in `dist/styles.css`, no `dist/assets/fonts/fonts.css`, one face per upstream line, every font URL is `assets/fonts/bakoma/ttf/<name>.ttf` and that file exists, and the plugin's own rules follow unchanged.

## Done looks like

- With the 4 core plugins enabled, the prove web drive (with axe) logs zero `fonts.css` errors on `/chat/new`, a session with a question card, and a reloaded session.
- The TeX fonts still load and apply: the page registers the same 140 `rich-code-blocks-font-*` faces as base, `document.fonts.load("16px rich-code-blocks-font-cmr10")` resolves to a loaded face, and the `.ttf` comes from `/api/plugins/rich-code-blocks/assets/assets/fonts/bakoma/ttf/cmr10.ttf` with 200.
- No other request for a `fonts.css` anywhere.

## Must keep working (existing flows, answer key is the base commit)

- Every rich-code-blocks render (SMILES, ABC, TikZ) and its font sizing: the plugin's own `npm test` and `npm run test:browser` pass, the browser test still sees bundled `.ttf` requests.
- drawing-pad's reference capture still embeds the TeX fonts it uses: `referenceFontCSS` reads `@font-face` rules from any loaded sheet with the sheet's own `href` as the URL base, so faces in `styles.css` resolve the same way.
- The core plugin catalog (`GET /api/plugins`), enable and disable, and the plugin stylesheet and asset routes behave as on base. Only the rich-code-blocks revision hash and `styles.css` bytes change.
- The teaching session with plugins disabled and enabled: same steps, observations and budgets as base, apart from the 3 fonts.css errors base shows with plugins on.

## Not changed

- The plugin host, asset allowlist and routes, and the other plugins.
- The prove skill's scripts and axe configuration.
- `budgets.json` on main has no fonts.css entry today. PR #13 (dependency-update-bot) adds a TEMPORARY one; whichever of the two merges second must drop it (see this PR's body).

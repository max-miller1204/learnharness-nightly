# Sidebar update pill and capsule

## Sub-features

- The round button at the right end of the sidebar's Settings row offers an update (check, download, install, reload, or Update everything in the desktop app).
- During an Update everything run the pill becomes a capsule whose details (a portaled popover) hold the run's status, Later and Retry.
- The footer is reachable in order by keyboard: session search, Settings, the update control.
- Enter on a question goes to the question when the pill only has focus because of a pointer click.

## How to get to it (user POV)

The sidebar on any signed-in page. The desktop app's bridge (`window.lh.desktopUpdate`) is what shows Update everything, so a browser test stubs it.

## Driving it with e2e

`tests/e2e/sidebar-footer.e2e.ts` stubs `window.lh.desktopUpdate` with an init script, routes `/api/updates` to an idle answer carrying the page's own version (a different one makes the pill offer a reload), and sets the update run the stub reports with `browser.evaluate`. Locators: `update-pill`, `update-capsule-button`, `update-capsule-details-action`, `update-capsule-dismiss`, `update-capsule-action`, `session-search`, `settings-entry`.

## Proof

Which footer control has focus after each key (`document.activeElement`'s test id), and the stub's recorded calls (`everything`, `later`).

## Gotchas

- A question dock does not claim Enter right after it shows; the test waits before it picks an answer.
- The self-host update and rollback flow and the Electron window are not driven by e2e ([#447](https://github.com/max-miller1204/learnharness-nightly/issues/447)).

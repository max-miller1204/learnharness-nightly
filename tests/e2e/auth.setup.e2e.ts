import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { pairWithCode } from "./support/pair.ts";

// Signs the browser in with a one-time pairing code, typed on the pairing
// screen (what `npm run pair` prints). The code is the `pairing-code` secret
// (e2e.config.ts): a handle, so it never reaches report.json or a trace, which
// a `/pair#token=<code>` link would. Tests that declare `session: "learner"`
// start signed in.
test.setup("pair the browser as the learner", { sessions: ["learner"], requires: ["browser"] }, async ({ app, screen, session, browser }) => {
	await app.open("/pair");

	await pairWithCode(screen);

	await expect(screen.getByTestId("settings-entry")).toBeVisible({ timeout: 60_000 });
	await expect(browser).not.toHaveURL(/\/pair/);
	await session.save("learner");
});

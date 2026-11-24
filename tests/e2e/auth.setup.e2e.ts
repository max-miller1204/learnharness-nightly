import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createPairingLink } from "../../selfhost/src/auth-store.ts";
import { instance } from "./support/instance.ts";

// Signs the browser in the way `npm run pair` does: a one-time pairing link,
// opened in the browser. Tests that declare `session: "learner"` start signed in.
test.setup("pair the browser as the learner", { sessions: ["learner"] }, async ({ app, screen, session, browser }) => {
	const state = await instance(app.baseUrl);
	const { code } = createPairingLink(state.dataDir, { label: "e2e" });

	await app.open(`/pair#token=${code}`);

	await expect(screen.getByTestId("settings-entry")).toBeVisible({ timeout: 60_000 });
	await expect(browser).not.toHaveURL(/\/pair/);
	await session.save("learner");
});

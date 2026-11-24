import { connect, declineSavePassword, describe, freshCode, openPairScreen, phoneAddress, test } from "./support/phone.ts";
import { expect } from "e2e";

describe("pairing the phone app", { requires: ["native-app"] }, () => {
	test("a fresh code pairs the phone and opens the session list", async ({ app, device, screen }) => {
		const address = await phoneAddress();
		await openPairScreen({ app, device, screen });

		await connect(screen, address, freshCode());
		await declineSavePassword(screen);

		await expect(screen.getByRole("button", /Sets and unions/)).toBeVisible({ timeout: 60_000 });
		await expect(screen.getByRole("button", /Splits and gradient steps/)).toBeVisible();
		await app.screenshot("session-list");
	});

	test("a refused code shows an error and stays on the Pair screen", async ({ app, device, screen }) => {
		const address = await phoneAddress();
		await openPairScreen({ app, device, screen });

		await connect(screen, address, "AAAA-BBBB-CCCC");

		await expect(screen.getByText("That pairing code is wrong, expired or already used.")).toBeVisible({ timeout: 30_000 });
		await expect(screen.getByRole("textbox", "Server address")).toBeVisible();
		await expect(screen.getByRole("button", /Sets and unions/)).not.toBeVisible();
		await app.screenshot("code-refused");
	});
});

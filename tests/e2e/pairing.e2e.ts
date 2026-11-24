import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createPairingLink, formatCode } from "../../selfhost/src/auth-store.ts";
import { instance } from "./support/instance.ts";

describe("pairing a browser", () => {
	test("a signed-out page shows the pairing screen", async ({ app, screen }) => {
		await app.open("/chat/new");

		await expect(screen.getByRole("heading", "Pair this device")).toBeVisible({ timeout: 60_000 });
		await expect(screen.getByTestId("settings-entry")).toBeHidden();
	});

	test("a wrong code is refused", async ({ app, screen }) => {
		await app.open("/pair");

		await screen.getByLabel("Pairing code").fill("AAAA-BBBB-CCCC");
		await screen.getByRole("button", "Pair").click();

		await expect(screen.getByTestId("pair-error")).toBeVisible();
		await expect(screen.getByTestId("settings-entry")).toBeHidden();
	});

	test("a code typed on the pairing screen signs the browser in", async ({ app, screen }) => {
		const state = await instance(app.baseUrl);
		const { code } = createPairingLink(state.dataDir, { label: "e2e typed code" });
		await app.open("/pair");

		await screen.getByLabel("Pairing code").fill(formatCode(code));
		await screen.getByRole("button", "Pair").click();

		await expect(screen.getByTestId("settings-entry")).toBeVisible({ timeout: 60_000 });
	});
});

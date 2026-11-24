import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

// A pixel comparison of how the transcript draws math (#365, #351: the
// \xrightarrow width and \text inside colour boxes). Baselines live in
// math-rendering.e2e.ts-snapshots/ and come from CI's Linux runner, since
// fonts and antialiasing differ between machines (verify-learnharness, Evidence).
describe("math rendering", { session: "learner", tags: ["visual"] }, () => {
	test("a reply draws arrows with labels and text inside boxes", async ({ app, screen, browser }) => {
		await app.open("/chat/new");
		const input = screen.getByTestId("composer").getByRole("textbox");
		await input.fill("zz-e2e math how do arrows and boxes render");
		await input.press("Enter");
		await browser.waitForURL(/\/chat\/chat_/, { timeout: 60_000 });
		const reply = screen.getByText(/zz-e2e math:/, { visible: true });
		await reply.waitFor({ timeout: 60_000 });

		await expect(reply.filter({ has: browser.locator(".katex") })).toBeVisible();
		await expect(reply).toHaveScreenshot("math-reply.png");
	});
});

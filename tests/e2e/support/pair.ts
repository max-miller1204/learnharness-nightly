import { expect, secrets, type Screen } from "e2e";

/**
 * Types a fresh pairing code into /pair and presses Pair. The code is the
 * `pairing-code` secret, so it stays out of reports and traces.
 *
 * On a busy machine the page can still be hydrating when the code goes in, and
 * hydration then clears the field and leaves Pair disabled. So the fill is
 * repeated, with a new code each time, until Pair is enabled.
 */
export async function pairWithCode(screen: Screen) {
	const code = screen.getByLabel("Pairing code");
	const pair = screen.getByRole("button", "Pair");
	for (let attempt = 1; ; attempt++) {
		await code.fill(secrets.get("pairing-code"));
		try {
			await expect(pair).toBeEnabled({ timeout: 10_000 });
			break;
		} catch (error) {
			if (attempt >= 5) throw error;
		}
	}
	await pair.click();
}

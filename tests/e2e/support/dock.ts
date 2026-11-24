import { expect, type Screen } from "e2e";
import type { Browser } from "@e2e-dev/web";

/**
 * Waits until the question dock takes the keyboard and answers. A dock that has
 * just shown drops an answer sent at once, on a busy machine, and nothing on
 * screen says when it starts to take them. The page does: an Enter the dock
 * claims is default-prevented, and with no answer picked yet it submits nothing.
 */
export async function dockAcceptsAnswers(browser: Browser) {
	await expect.poll(() => browser.evaluate(() => {
		const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		document.body.dispatchEvent(enter);
		return enter.defaultPrevented;
	}), { timeout: 30_000 }).toBe(true);
}

/**
 * Picks the option named `label` and presses Submit answer. While the turn that asked
 * is still settling, the app ignores a submit (nothing is sent and the dock stays), so,
 * as a learner would, press it again until the dock goes. A press that is ignored has no
 * effect, so repeating it cannot hide a bug that sends a wrong or double answer: the
 * tests read what the tutor received.
 */
export async function answerQuestion(screen: Screen, label: RegExp) {
	const dock = screen.getByTestId("question-dock");
	const option = dock.getByRole("radio", label);
	await option.check();
	await expect(option).toBeChecked();
	for (let press = 1; ; press++) {
		await dock.getByRole("button", "Submit answer").click();
		try {
			await expect(dock).not.toBeVisible({ timeout: 5000 });
			return;
		} catch (error) {
			if (press >= 6) throw error;
		}
	}
}

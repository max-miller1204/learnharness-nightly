import { expect, type Screen } from "e2e";
import type { Browser } from "@e2e-dev/web";

/** Waits until the server reports no turn running for the chat the browser is on (its record is written by then). */
export async function turnSettled(browser: Browser, chatId: string) {
	await expect.poll(() => browser.evaluate(async (id: string) => {
		const record = (await (await fetch(`/api/chats/${id}`)).json()) as { turnInFlight?: unknown };
		return !record.turnInFlight;
	}, chatId), { timeout: 30_000 }).toBe(true);
}

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
 * Picks the option named `label` and presses Submit answer.
 *
 * While the turn that asked is still settling, the app drops a submit with no sign on screen,
 * even though the button is enabled (https://github.com/max-miller1204/learnharness-nightly/issues/449).
 * Until that is fixed, press it again, as a learner would, until the dock goes. A dropped press
 * sends nothing, so repeating cannot send a second answer unless the app does: the tests count
 * the tool results stored for the question (`probeResults`, read once the turn has
 * settled with `turnSettled`) and fail on more than one.
 */
export async function answerQuestion(screen: Screen, label: RegExp) {
	const dock = screen.getByTestId("question-dock");
	const option = dock.getByRole("radio", label);
	await option.check();
	await expect(option).toBeChecked();
	const closes = (timeout: number) => expect(dock).not.toBeVisible({ timeout }).then(() => true, () => false);
	for (let press = 1; ; press++) {
		const clicked = await dock.getByRole("button", "Submit answer").click({ timeout: 5000 }).then(() => true, () => false);
		// A press that finds no button means the answer went in, and the dock is on its way out.
		if (await closes(clicked ? 8000 : 3000)) return;
		if (press >= 6) throw new Error(`the question dock was still open after ${press} presses of Submit answer`);
	}
}

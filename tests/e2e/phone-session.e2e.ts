import * as fs from "node:fs";
import * as path from "node:path";
import { expect } from "e2e";
import { storedChat } from "./support/instance.ts";
import { beforeEach, describe, pairPhone, phoneInstance, test } from "./support/phone.ts";

// The server's data folder starts with two records from tests/fixtures/ (LH_E2E_FIXTURES in e2e.config.ts):
// a taught lesson ("Sets and unions") and a quiz whose last question is still open.
describe("a seeded session on the phone", { requires: ["native-app"] }, () => {
	beforeEach(async ({ app, device, screen }) => {
		// A test that answers the quiz changes its record, so each starts from the fixture again.
		const state = await phoneInstance();
		for (const [folder, id] of [["mobile-lesson", "chat_zzmobilelesson"], ["mobile-quiz", "chat_zzmobilequiz"]]) {
			fs.copyFileSync(path.resolve(import.meta.dirname, `../fixtures/${folder}/${id}.json`), path.join(state.dataDir, "chats", `${id}.json`));
		}
		await pairPhone({ app, device, screen });
	});

	test("the lesson fixture opens and shows what the tutor taught", async ({ app, screen }) => {
		await screen.getByRole("button", /Sets and unions/).tap();

		await expect(screen.getByText(/A set is a collection of distinct things/)).toBeVisible({ timeout: 30_000 });
		await app.screenshot("lesson");
	});

	test("the quiz fixture is answered through the dock", async ({ app, screen }) => {
		await screen.getByRole("button", /Splits and gradient steps/).tap();
		await expect(screen.getByText(/Pick every pair whose first number is smaller/)).toBeVisible({ timeout: 30_000 });

		await screen.getByRole("checkbox", /^Train: 4; test: 8$/).tap();
		await screen.getByRole("checkbox", /negative 0\.10 comma positive 0\.20/).tap();
		// Submit sits below the options, in the dock's own scroll view: scroll to its end, so the button is whole.
		const question = screen.getByText(/^Pick every pair/).first();
		const submit = screen.getByRole("button", "Submit answer");
		await question.scrollUntilVisible(submit);
		await question.swipe({ direction: "down", momentum: "slow" });
		await submit.tap();

		await expect(screen.getByText(/The first pair fits/)).toBeVisible({ timeout: 60_000 });
		await app.screenshot("quiz-answered");
		const state = await phoneInstance();
		await expect.poll(() => {
			const results = (storedChat(state, "chat_zzmobilequiz").messages as Array<{ role?: string; details?: { kind?: string; answers?: Array<{ value?: string }>; correct?: boolean } }>)
				.filter((message) => message.role === "toolResult" && message.details?.kind === "quiz");
			const answered = results.at(-1)?.details;
			return { picked: answered?.answers?.map((answer) => answer.value), correct: answered?.correct };
		}).toEqual({ picked: ["Train: $4$; test: $8$", "$(-0.10, +0.20)$"], correct: true });
	});
});

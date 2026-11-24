import { beforeEach, describe, test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";
import * as fs from "node:fs";
import { answerQuestion } from "./support/dock.ts";
import { answersReceived, instance, sessionRequests, storedChat, type InstanceState } from "./support/instance.ts";

// Plays tests/e2e/support/scenarios/teach.json on the fake model: the goal
// makes the tutor read two files, ask one question, then acknowledge the answer.
describe("teaching session", { session: "learner" }, () => {
	let state: InstanceState;
	// A unique goal per test, so a session left by another test never matches.
	let goal: string;

	beforeEach(async ({ app }) => {
		state = await instance(app.baseUrl);
		goal = `zz-e2e ${Date.now().toString(36)} why is the sky blue`;
		await app.open("/chat/new");
	});

	// Types the goal, then waits for the session's own page and its question.
	const startSession = async ({ screen, browser }: { screen: Screen; browser: Browser }) => {
		const input = screen.getByTestId("composer").getByRole("textbox");
		await input.fill(goal);
		await input.press("Enter");
		await browser.waitForURL(/\/chat\/chat_/, { timeout: 60_000 });
		await screen.getByTestId("question-dock").getByText("zz-e2e: which colour of sunlight scatters most in air?").waitFor({ timeout: 90_000 });
	};
	const answerBlue = ({ screen }: { screen: Screen; browser: Browser }) => answerQuestion(screen, /Blue$/);
	// The tutor's reply; `visible` drops the hidden copy a reload can leave for a moment.
	const reply = (screen: Screen) => screen.getByText(/zz-e2e acknowledged your answer/, { visible: true });

	test("a goal starts a session and the tutor asks about the files it read", async ({ screen, browser }) => {
		await startSession({ screen, browser });

		const dock = screen.getByTestId("question-dock");
		await expect(dock.getByRole("radio")).toHaveCount(2);
		await expect(dock.getByRole("radio", /Blue$/)).toBeVisible();
		await expect(dock.getByRole("radio", /Red$/)).toBeVisible();
		// Each read's result reached the model exactly as the file is on disk.
		const asked = sessionRequests(state, goal).find((r) => r.rule === "probe-asks-question");
		const toolResults = (asked?.request.messages ?? []).filter((m) => m.role === "tool").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
		expect(toolResults.slice(-2)).toEqual([fs.readFileSync(state.fixtureNoNewline, "utf8"), fs.readFileSync(state.fixture, "utf8")]);
	});

	test("an answer reaches the tutor and its reply shows", async ({ screen, browser }) => {
		await startSession({ screen, browser });

		await answerBlue({ screen, browser });

		await expect(reply(screen)).toBeVisible({ timeout: 60_000 });
		await expect(screen.getByTestId("question-dock")).not.toBeVisible();
		// The tutor's last message is the probe tool's result: it names the option the learner picked.
		const answered = sessionRequests(state, goal).find((r) => r.rule === "probe-acknowledges-answer");
		const result = answered?.request.messages?.at(-1);
		expect(result?.role).toBe("tool");
		const quiz = JSON.parse(String(result?.content)) as { kind: string; answers: Array<{ label: string }>; correct: boolean };
		expect(quiz.kind).toBe("quiz");
		expect(quiz.answers.map((a) => a.label)).toEqual(["Blue"]);
		expect(quiz.correct).toBe(true);
		// Pressing Submit again until the dock went (support/dock.ts) must not have sent a second answer.
		expect(answersReceived(state, goal)).toBe(1);
	});

	test("the session is stored and survives a reload", async ({ screen, browser }) => {
		await startSession({ screen, browser });
		await answerBlue({ screen, browser });
		await reply(screen).waitFor({ timeout: 60_000 });
		const chatId = new URL(await browser.url()).pathname.split("/").pop() ?? "";

		await browser.reload();

		await expect(reply(screen)).toBeVisible({ timeout: 60_000 });
		// The server writes the record after the reply streams, so wait for it.
		for (const part of [goal, "E2E-FIXTURE-SKY", "zz-e2e: which colour", "acknowledged your answer"]) {
			await expect.poll(() => JSON.stringify(storedChat(state, chatId)), { timeout: 10_000 }).toContain(part);
		}
	});
});

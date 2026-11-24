import { beforeEach, describe, test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";
import * as fs from "node:fs";
import { instance, modelRequests, storedChat, type InstanceState } from "./support/instance.ts";

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
	const answerBlue = async ({ screen }: { screen: Screen }) => {
		const dock = screen.getByTestId("question-dock");
		await dock.getByRole("radio", /Blue/).click();
		await dock.getByRole("button", "Submit answer").click();
	};

	test("a goal starts a session and the tutor asks about the files it read", async ({ screen, browser }) => {
		await startSession({ screen, browser });

		const dock = screen.getByTestId("question-dock");
		await expect(dock.getByRole("radio")).toHaveCount(2);
		await expect(dock.getByRole("radio", /Blue/)).toBeVisible();
		await expect(dock.getByRole("radio", /Red/)).toBeVisible();
		await expect(browser).toHaveURL(/\/chat\/chat_/);
		// Each read's result reached the model exactly as the file is on disk.
		const asked = modelRequests(state).find((r) => r.rule === "probe-asks-question");
		const toolResults = (asked?.request.messages ?? []).filter((m) => m.role === "tool").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
		expect(toolResults.slice(-2)).toEqual([fs.readFileSync(state.fixtureNoNewline, "utf8"), fs.readFileSync(state.fixture, "utf8")]);
	});

	test("an answer reaches the tutor and its reply shows", async ({ screen, browser }) => {
		await startSession({ screen, browser });

		await answerBlue({ screen });

		await expect(screen.getByText(/zz-e2e acknowledged your answer/)).toBeVisible({ timeout: 60_000 });
		await expect(screen.getByTestId("question-dock")).toBeHidden();
		const answered = modelRequests(state).find((r) => r.rule === "probe-acknowledges-answer");
		expect(JSON.stringify(answered?.request.messages?.slice(-2) ?? [])).toMatch(/blue/i);
	});

	test("the session is stored and survives a reload", async ({ screen, browser }) => {
		await startSession({ screen, browser });
		await answerBlue({ screen });
		await screen.getByText(/zz-e2e acknowledged your answer/).waitFor({ timeout: 60_000 });
		const chatId = new URL(await browser.url()).pathname.split("/").pop() ?? "";

		await browser.reload();

		await expect(screen.getByText(/zz-e2e acknowledged your answer/)).toBeVisible({ timeout: 60_000 });
		const stored = JSON.stringify(storedChat(state, chatId));
		for (const part of [goal, "E2E-FIXTURE-SKY", "zz-e2e: which colour", "acknowledged your answer"]) expect(stored).toContain(part);
	});
});

import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

// Agent steps run on the signed-in coding agent in e2e.config.ts (Claude Code
// by default). A passing run records the agent's actions in .e2e/cache, and
// later runs replay them with no model call until the screen changes.
describe("teaching session, driven by an agent", { session: "learner", tags: ["agent"], requires: ["browser"] }, () => {
	test("the agent starts a session from a plain-language goal", async ({ app, agent, screen }) => {
		await app.open("/");

		await agent.act("start a new teaching session whose goal is exactly {goal}", { params: { goal: "zz-e2e agent why is the sky blue" } });

		await expect(screen.getByTestId("question-dock").getByText("zz-e2e: which colour of sunlight scatters most in air?")).toBeVisible({ timeout: 90_000 });
		await agent.assert("the tutor is asking which colour of sunlight scatters most");
	});
});

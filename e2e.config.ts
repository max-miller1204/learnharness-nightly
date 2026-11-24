import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { claudeCode, codex } from "@e2e-dev/acp";

/**
 * End-to-end tests (tests/e2e/) and live drives over `npx e2e mcp`, against
 * one isolated LearnHarness per run: tests/e2e/support/serve.ts starts it on a
 * free port with a throwaway data folder and a scripted fake model, so tests
 * that use no `agent` step need no model and no provider key.
 *
 * `agent.act` and `agent.assert` run on a signed-in coding agent over ACP:
 * Claude Code by default (`claude` login), or Codex with `--agent codex`
 * (`codex login`). `agent.waitFor`, `agent.extract` and `e2e explore` need an
 * agent with an AI SDK `model`, which this config does not set.
 * The verify-learnharness skill (.agents/skills/) says how to use all of it.
 */
const context = [
	"LearnHarness is a tutoring app. A session (a chat) starts from a goal the learner types in the composer on /chat/new.",
	"The tutor asks questions in the question dock under the transcript; the learner picks an option and submits.",
	"The sidebar lists sessions and folders; Settings holds models, providers and devices.",
].join(" ");

export default {
	tests: "tests/e2e/**/*.e2e.ts",
	timeout: 180_000,
	targets: [
		{
			// Fixed locale, zone and motion, so a Mac and CI Linux render the same.
			engine: web({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" }),
			app: {
				url: "http://127.0.0.1:0",
				readyUrl: "http://127.0.0.1:{port}/api/health",
				command: {
					executable: "node",
					args: ["tests/e2e/support/serve.ts", "{port}"],
					inheritEnv: ["LH_E2E_*"],
					startupTimeout: 240_000,
					// serve.ts gives Next 10 s to stop before it kills its process group.
					shutdownTimeout: 20_000,
					log: ".e2e/logs/app.log",
				},
			},
		},
	],
	agents: {
		default: { executor: claudeCode({ model: "sonnet" }), context },
		codex: { executor: codex(), context },
	},
} satisfies E2EConfig;

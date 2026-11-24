import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { claudeCode, codex } from "@e2e-dev/acp";
import { github } from "@e2e-dev/github";
import { chatgpt } from "e2e/oauth/chatgpt";
import { randomUUID } from "node:crypto";
import { pairingCode, RUN_ENV } from "./tests/e2e/support/instance.ts";

// Names this run for serve.ts and the pairing-code secret (instance.ts).
process.env[RUN_ENV] ??= randomUUID();

/**
 * End-to-end tests (tests/e2e/) and live drives over `npx e2e mcp`, against
 * one isolated LearnHarness per run: tests/e2e/support/serve.ts starts it on a
 * free port with a throwaway data folder and a scripted fake model, so tests
 * that use no `agent` step need no model and no provider key.
 *
 * `agent.act` and `agent.assert` run on a signed-in coding agent over ACP:
 * Claude Code by default (`claude` login), or Codex with `--agent codex`
 * (`codex login`). `agent.waitFor`, `agent.extract` and `e2e explore` run
 * e2e's own agent, which needs an AI SDK model: the owner's ChatGPT plan
 * (`npx e2e login openai`, once per machine), read only when a step calls it.
 * The verify-learnharness skill (.agents/skills/) says how to use all of it.
 */
const context = [
	"LearnHarness is a tutoring app. A session (a chat) starts from a goal the learner types in the composer on /chat/new.",
	"The tutor asks questions in the question dock under the transcript; the learner picks an option and submits.",
	"The sidebar lists sessions and folders; Settings holds models, providers and devices.",
].join(" ");
// What explorers must not report: the instance's model is serve.ts's scripted fake.
const fakeModel = [
	"The tutor is a scripted fake model: a goal containing zz-e2e gets two file reads, one question and an acknowledgement; anything else gets 'zz-e2e fallback reply.'.",
	"Not bugs: that fallback reply, a 503 from /api/stt/token (dictation has no key), and 'Updates unavailable' in the sidebar footer.",
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
		default: { executor: claudeCode({ model: "sonnet" }), model: chatgpt("gpt-6-luna"), context },
		codex: { executor: codex(), model: chatgpt("gpt-6-luna"), context },
		// e2e's built-in agent on ChatGPT: `e2e explore --agent chatgpt` and bug bashes.
		chatgpt: { model: chatgpt("gpt-6-luna"), context: `${context} ${fakeModel}`, maxSteps: 40, maxModelCalls: 40 },
	},
	// A fresh pairing code for the run's instance, filled as a secret handle so
	// the code stays out of the report, traces and the model's input.
	secrets: { "pairing-code": pairingCode },
	// The job summary on GitHub Actions; nothing elsewhere. It posts no PR comment
	// without a token, and ci.yml gives the e2e step none: a separate job posts it.
	reporters: ["list", github()],
} satisfies E2EConfig;

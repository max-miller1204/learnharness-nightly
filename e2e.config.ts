import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { mobile } from "@e2e-dev/mobile";
import { claudeCode, codex } from "@e2e-dev/acp";
import { github } from "@e2e-dev/github";
import { chatgpt } from "e2e/oauth/chatgpt";
import { LAUNCH_ID_ENV, launchIdForConfig, pairingCode, phoneLaunchId } from "./tests/e2e/support/instance.ts";
import { verifyOwnedSimulator } from "./tests/e2e/support/ios-device.ts";
import { phoneAppPath, phoneBundleId, phonePort, phoneRunId, phoneTlsPort, phoneWrapped } from "./tests/e2e/support/phone-config.ts";

// Names this launch for serve.ts and the pairing-code secrets (instance.ts).
const launchId = launchIdForConfig();
// A simulator named in the environment must be one ios.sh made for this run.
if (process.env.E2E_IOS_DEVICE) verifyOwnedSimulator(process.env.E2E_IOS_DEVICE);
const phoneDevice = process.env.E2E_IOS_DEVICE ?? "lh-e2e-no-simulator-run-ios.sh-e2e";

/**
 * End-to-end tests (tests/e2e/) and live drives over `npx e2e mcp`, against
 * one isolated LearnHarness per run: tests/e2e/support/serve.ts starts it with
 * a throwaway data folder and a scripted fake model, so tests that use no
 * `agent` step need no model and no provider key. The targets share it:
 * `web` (a browser, on a free port) and `ios` (the phone app, apps/mobile, on
 * an iOS Simulator, on fixed ports behind TLS). A run names its target with
 * `--target` (the npm scripts and the MCP server settings do); the phone's
 * build and simulator come from tests/e2e/support/ios.sh.
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
			name: "web",
			// Fixed locale, zone and motion, so a Mac and CI Linux render the same.
			engine: web({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" }),
			app: {
				url: "http://127.0.0.1:0",
				readyUrl: "http://127.0.0.1:{port}/api/health",
				command: {
					executable: "node",
					args: ["tests/e2e/support/serve.ts", "{port}"],
					env: { [LAUNCH_ID_ENV]: launchId },
					inheritEnv: ["LH_E2E_SERVER", "LH_E2E_SCENARIO"],
					startupTimeout: 240_000,
					// serve.ts gives Next 10 s to stop before it kills its process group.
					shutdownTimeout: 20_000,
					log: ".e2e/logs/app.log",
				},
			},
		},
		{
			name: "ios",
			// Only the simulator `ios.sh e2e` created for this run (ios-device.ts checks its record; a
			// udid it did not create fails the config load). With none, the name below matches no
			// simulator, so the engine never falls back to every booted one, the owner's included.
			engine: mobile({ platform: "ios", device: phoneDevice, session: phoneRunId ? `lh-e2e-${phoneRunId}` : undefined }),
			app: {
				bundleId: phoneBundleId,
				appPath: phoneAppPath,
				// No url on a device target, so no {port}: the wrapper allocated the ports.
				readyUrl: `http://127.0.0.1:${phonePort ?? "1"}/api/health`,
				command: phoneWrapped ? {
					executable: "node",
					args: ["tests/e2e/support/serve.ts", phonePort!],
					env: {
						// A launch of its own: a run can start both targets, and each server records itself under its id.
						[LAUNCH_ID_ENV]: phoneLaunchId(launchId),
						LH_E2E_TLS_PORT: phoneTlsPort!,
						LH_E2E_IOS_DEVICE: process.env.E2E_IOS_DEVICE!,
						LH_E2E_IOS_APP: phoneAppPath,
						E2E_IOS_DEVICE: process.env.E2E_IOS_DEVICE!,
						E2E_IOS_SIM_RECORD: process.env.E2E_IOS_SIM_RECORD!,
						LH_E2E_FIXTURES: "tests/fixtures/mobile-lesson,tests/fixtures/mobile-quiz",
						LH_E2E_SCENARIO: "tests/fixtures/mobile-quiz/scenario.json",
					},
					inheritEnv: ["LH_E2E_SERVER"],
					startupTimeout: 240_000,
					shutdownTimeout: 20_000,
					log: ".e2e/logs/app-ios.log",
				} : {
					// Not started by ios.sh: say so instead of serving a phone nothing can reach.
					executable: "node",
					args: ["-e", "console.error('the ios target runs through tests/e2e/support/ios.sh e2e (it creates the simulator, the ports and the build path this target needs)'); process.exit(2)"],
					startupTimeout: 20_000,
					log: ".e2e/logs/app-ios.log",
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
	secrets: { "pairing-code": () => pairingCode(launchId), "phone-pairing-code": () => pairingCode(phoneLaunchId(launchId)) },
	// The job summary on GitHub Actions; nothing elsewhere. It posts no PR comment
	// without a token, and ci.yml gives the e2e step none: a separate job posts it.
	reporters: ["list", github()],
} satisfies E2EConfig;

// Decides what the mobile release workflow does: build, update, check or
// nothing. See docs/specs/mobile-auto-updates.md. The build-or-update rule
// follows T3 Code's .github/workflows/mobile-eas-production.yml
// (https://github.com/pingdotgg/t3code).
const fs = require("node:fs");

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_AFTER_DAYS = 76;
const MAIN = "refs/heads/main";
const ACTIVE = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS", "PENDING_CANCEL"]);
const FAILED = new Set(["ERRORED", "CANCELED"]);
const EXPECTED = /fingerprint ([0-9a-f]{40})/;
const RETRY = "Retry with Run workflow, mode build.";

/** Builds started here carry this message, so a later run can compare fingerprints. */
function buildMessage(sha, fingerprint) {
	return `Mobile release ${sha.slice(0, 9)}, fingerprint ${fingerprint}`;
}

function fingerprintOf(build) {
	return build.fingerprint?.hash ?? build.fingerprintHash ?? null;
}

/** Hashed sources that come from Expo native modules. Zero means autolinking failed. */
function countExpoModules(fingerprint, platform = "ios") {
	const reason = `expoAutolinking${platform[0].toUpperCase()}${platform.slice(1)}`;
	return fingerprint.sources.filter((source) => (source.reasons ?? []).includes(reason)).length;
}

function preflight({ ref, tokenPresent }) {
	if (ref !== MAIN) return { action: "fail", reason: `Runs only on main, not ${ref}.` };
	if (!tokenPresent) return { action: "fail", reason: "The EXPO_TOKEN repository secret is missing." };
	return null;
}

/**
 * builds: the newest beta iOS builds, newest first, as `eas build:list --json` prints them.
 * event: push, schedule or workflow_dispatch; mode: the button's build, update or check.
 */
function decide({ event, mode, ref, tokenPresent, fingerprint, expoModules, builds, now = Date.now() }) {
	const refused = preflight({ ref, tokenPresent });
	if (refused) return refused;
	const button = event === "workflow_dispatch";
	if (button && mode === "check") return { action: "check", reason: "Read-only check." };
	if (button && mode === "build") return { action: "build", reason: "Build requested with Run workflow." };
	if (button && mode !== "update") return { action: "fail", reason: `Unknown mode ${mode}.` };
	if (!button && event !== "push" && event !== "schedule") return { action: "fail", reason: `Unknown event ${event}.` };

	const newestFinished = builds.find((build) => build.status === "FINISHED");
	const expected = newestFinished?.message?.match(EXPECTED)?.[1];
	if (expected && fingerprintOf(newestFinished) !== expected) {
		return {
			action: "fail",
			reason: `Build ${newestFinished.id} recorded fingerprint ${fingerprintOf(newestFinished)}, but CI computed ${expected} for its commit. OTAs would never match it. Stop and report.`,
		};
	}

	if (event === "schedule") {
		if (builds.some((build) => ACTIVE.has(build.status))) return { action: "none", reason: "A beta build is in progress." };
		if (builds[0] && FAILED.has(builds[0].status)) return { action: "fail", reason: `The newest beta build ${builds[0].id} is ${builds[0].status}. ${RETRY}` };
		if (!newestFinished) return { action: "build", reason: "No finished beta build exists." };
		const age = Math.floor((now - Date.parse(newestFinished.completedAt ?? newestFinished.createdAt)) / DAY_MS);
		if (age >= REFRESH_AFTER_DAYS) return { action: "build", reason: `The newest beta build is ${age} days old.` };
		return { action: "none", reason: `The newest beta build is ${age} days old.` };
	}

	if (expoModules === 0) return { action: "fail", reason: `Fingerprint ${fingerprint} hashes no Expo native modules, so it cannot be trusted.` };
	const matching = builds.filter((build) => fingerprintOf(build) === fingerprint);
	if (matching.some((build) => build.status === "FINISHED")) return { action: "update", reason: `A finished build has fingerprint ${fingerprint}.` };
	const noPublish = (reason) => (button ? { action: "fail", reason: `Nothing to publish: ${reason}` } : { action: "none", reason });
	if (matching.some((build) => ACTIVE.has(build.status))) {
		return noPublish(`The build for fingerprint ${fingerprint} is in progress. OTAs resume on the first merge after it finishes.`);
	}
	const failed = matching.find((build) => FAILED.has(build.status));
	if (failed) return { action: "fail", reason: `Build ${failed.id} for fingerprint ${fingerprint} is ${failed.status}. ${RETRY}` };
	if (button) return noPublish(`No build has fingerprint ${fingerprint}.`);
	return { action: "build", reason: `No build has fingerprint ${fingerprint}.` };
}

/** Problems with the committed update config, empty when it is complete. */
function checkConfig(expoConfig, easJson) {
	const problems = [];
	const projectId = expoConfig.extra?.eas?.projectId;
	if (expoConfig.updates?.enabled !== true) problems.push("updates.enabled must be true");
	if (!projectId || expoConfig.updates?.url !== `https://u.expo.dev/${projectId}`) problems.push("updates.url must be https://u.expo.dev/<projectId>");
	if (expoConfig.runtimeVersion?.policy !== "fingerprint") problems.push("runtimeVersion.policy must be fingerprint");
	if (easJson.build?.beta?.channel !== "production") problems.push("eas.json build.beta.channel must be production");
	const submit = easJson.submit?.beta?.ios ?? {};
	for (const field of ["ascAppId", "ascApiKeyPath", "ascApiKeyIssuerId", "ascApiKeyId"]) {
		if (!submit[field]) problems.push(`eas.json submit.beta.ios.${field} is missing`);
	}
	return problems;
}

/** eas-cli can print notices before the JSON document even with --json. */
function readJson(file) {
	const text = fs.readFileSync(file, "utf8");
	const start = text.search(/^[[{]/m);
	return JSON.parse(start === -1 ? text : text.slice(start));
}

function main(argv, env) {
	const [command, ...args] = argv;
	if (command === "preflight") {
		const refused = preflight({ ref: env.GITHUB_REF, tokenPresent: Boolean(env.EXPO_TOKEN) });
		if (refused) throw new Error(refused.reason);
		return;
	}
	if (command === "expo-modules") {
		const count = countExpoModules(readJson(args[0]));
		console.log(`The iOS fingerprint hashes ${count} Expo native module sources.`);
		if (count === 0) throw new Error("The iOS fingerprint hashes no Expo native modules.");
		return;
	}
	if (command === "check-config") {
		const problems = checkConfig(readJson(args[0]), readJson(args[1]));
		if (problems.length > 0) throw new Error(problems.join("\n"));
		console.log("The update config is complete.");
		return;
	}
	if (command === "decide") {
		const fingerprintJson = readJson(args[0]);
		const fingerprint = fingerprintJson.hash;
		const decision = decide({
			event: env.GITHUB_EVENT_NAME,
			mode: env.MODE,
			ref: env.GITHUB_REF,
			tokenPresent: Boolean(env.EXPO_TOKEN),
			fingerprint,
			expoModules: countExpoModules(fingerprintJson),
			builds: readJson(args[1]),
		});
		console.log(`action=${decision.action}`);
		console.log(`fingerprint=${fingerprint}`);
		console.log(`message=${buildMessage(env.GITHUB_SHA, fingerprint)}`);
		console.log(`reason=${decision.reason}`);
		return;
	}
	throw new Error(`Unknown command ${command}. Use preflight, decide, expo-modules or check-config.`);
}

if (require.main === module) {
	try {
		main(process.argv.slice(2), process.env);
	} catch (error) {
		console.error(`::error::${error.message.replaceAll("\n", "%0A")}`);
		process.exit(1);
	}
}

module.exports = { buildMessage, checkConfig, countExpoModules, decide, preflight };

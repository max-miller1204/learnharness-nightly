// Decides what the mobile release workflow does: build, update, check or
// nothing. See docs/specs/mobile-auto-updates.md. The build-or-update rule
// follows T3 Code's .github/workflows/mobile-eas-production.yml
// (https://github.com/pingdotgg/t3code).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_AFTER_DAYS = 76;
const TESTFLIGHT_DAYS = 90;
const MAIN = "refs/heads/main";
const BUILD_ACTIVE = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS", "PENDING_CANCEL"]);
const BUILD_FAILED = new Set(["ERRORED", "CANCELED"]);
const SUBMIT_ACTIVE = new Set(["AWAITING_BUILD", "IN_QUEUE", "IN_PROGRESS"]);
const REQUESTED = /fingerprint ([0-9a-f]{40})/;
const RETRY = "Retry with Run workflow, mode build.";

/** Builds started here carry the runtime CI requested, so a later run can compare it. */
function buildMessage(sha, runtime) {
	return `Mobile release ${sha.slice(0, 9)}, fingerprint ${runtime}`;
}

/**
 * One build attempt as the rules see it. Only a build whose iOS submission
 * finished is on TestFlight ("shipped"). A failed, cancelled or missing
 * submission makes the attempt failed.
 */
function attempt(build) {
	const requested = build.message?.match(REQUESTED)?.[1] ?? null;
	const recorded = build.runtime?.version ?? null;
	const base = { id: build.id, requested, recorded, runtime: requested ?? recorded, finished: build.status === "FINISHED" };
	if (BUILD_ACTIVE.has(build.status)) return { ...base, state: "active", detail: `build ${build.status}` };
	if (build.status !== "FINISHED") return { ...base, state: "failed", detail: `build ${build.status}` };
	const submissions = (build.submissions ?? []).filter((submission) => submission.platform === "IOS");
	const done = submissions.find((submission) => submission.status === "FINISHED");
	if (done) return { ...base, state: "shipped", shippedAt: Date.parse(done.completedAt ?? build.completedAt) };
	const pending = submissions.find((submission) => SUBMIT_ACTIVE.has(submission.status));
	if (pending) return { ...base, state: "active", detail: `TestFlight upload ${pending.status}` };
	const last = submissions[0];
	return { ...base, state: "failed", detail: last ? `TestFlight upload ${last.status}` : "never sent to TestFlight" };
}

/** Hashed sources that come from Expo native modules. Zero means autolinking failed. */
function countExpoModules(sources, platform = "ios") {
	const reason = `expoAutolinking${platform[0].toUpperCase()}${platform.slice(1)}`;
	return sources.filter((source) => (source.reasons ?? []).includes(reason)).length;
}

function preflight({ ref, tokenPresent }) {
	if (ref !== MAIN) return { action: "fail", reason: `Runs only on main, not ${ref}.` };
	if (!tokenPresent) return { action: "fail", reason: "The EXPO_TOKEN secret is missing from the mobile-release environment." };
	return null;
}

/**
 * builds: every beta iOS build, newest first, with submissions and runtime.
 * runtime: the runtime version expo-updates resolves for this commit.
 * stale: a newer commit already published an OTA for this runtime.
 * event: push, schedule or workflow_dispatch; mode: the button's build, update or check.
 */
function decide({ event, mode, ref, tokenPresent, runtime, expoModules, builds, stale = false, now = Date.now() }) {
	const refused = preflight({ ref, tokenPresent });
	if (refused) return refused;
	const attempts = builds.map(attempt);
	const button = event === "workflow_dispatch";
	if (button && mode === "check") {
		const newest = attempts[0];
		if (newest?.state === "failed") return { action: "check", reason: "Read-only check.", problem: `The newest beta build ${newest.id} failed: ${newest.detail}. ${RETRY}` };
		return { action: "check", reason: "Read-only check." };
	}
	if (button && mode === "build") return { action: "build", reason: "Build requested with Run workflow." };
	if (button && mode !== "update") return { action: "fail", reason: `Unknown mode ${mode}.` };
	if (!button && event !== "push" && event !== "schedule") return { action: "fail", reason: `Unknown event ${event}.` };

	// Attempts newer than the newest build on TestFlight, and that build itself.
	const shippedIndex = attempts.findIndex((a) => a.state === "shipped");
	const shipped = attempts[shippedIndex];
	const recent = shippedIndex === -1 ? attempts : attempts.slice(0, shippedIndex + 1);
	const mismatched = recent.find((a) => a.finished && a.requested && a.recorded !== a.requested);
	if (mismatched) {
		return {
			action: "fail",
			reason: `Build ${mismatched.id} recorded runtime ${mismatched.recorded}, but CI requested ${mismatched.requested} for its commit. OTAs would never match it. Stop and report.`,
		};
	}
	const active = attempts.find((a) => a.state === "active");
	const ageMs = shipped ? now - shipped.shippedAt : Infinity;

	if (event === "schedule") {
		if (active) return { action: "none", reason: `Beta build ${active.id} is in progress (${active.detail}).` };
		if (attempts[0]?.state === "failed") return { action: "fail", reason: `The newest beta build ${attempts[0].id} failed: ${attempts[0].detail}. ${RETRY}` };
		if (!shipped) return { action: "build", reason: "No beta build is on TestFlight." };
		const age = Math.floor(ageMs / DAY_MS);
		if (age >= REFRESH_AFTER_DAYS) return { action: "build", reason: `The newest TestFlight build is ${age} days old.` };
		return { action: "none", reason: `The newest TestFlight build is ${age} days old.` };
	}

	const noPublish = (reason) => (button ? { action: "fail", reason: `Nothing to publish: ${reason}` } : { action: "none", reason });
	if (expoModules === 0) return { action: "fail", reason: `Runtime ${runtime} hashes no Expo native modules, so it cannot be trusted.` };
	// Only the newest TestFlight build is what phones install, and only until it expires.
	if (shipped?.recorded === runtime && ageMs < TESTFLIGHT_DAYS * DAY_MS) {
		if (stale) return noPublish(`A newer commit already published an OTA for runtime ${runtime}.`);
		return { action: "update", reason: `The newest TestFlight build ${shipped.id} has runtime ${runtime}.` };
	}
	if (active) return noPublish(`Beta build ${active.id} is in progress (${active.detail}). OTAs resume on the first merge after it finishes.`);
	const failed = recent.find((a) => a.runtime === runtime && a.state === "failed");
	if (failed) return { action: "fail", reason: `Build ${failed.id} for runtime ${runtime} failed: ${failed.detail}. ${RETRY}` };
	if (button) return noPublish(`The newest TestFlight build does not have runtime ${runtime}.`);
	return { action: "build", reason: `The newest TestFlight build does not have runtime ${runtime}.` };
}

/** Problems with the committed update config, empty when it is complete. */
function checkConfig(expoConfig, easJson) {
	const problems = [];
	const projectId = expoConfig.extra?.eas?.projectId;
	if (expoConfig.updates?.enabled !== true) problems.push("updates.enabled must be true");
	if (!projectId || expoConfig.updates?.url !== `https://u.expo.dev/${projectId}`) problems.push("updates.url must be https://u.expo.dev/<projectId>");
	if (expoConfig.runtimeVersion?.policy !== "fingerprint") problems.push("runtimeVersion.policy must be fingerprint");
	for (const platform of ["ios", "android"]) {
		if (expoConfig[platform]?.runtimeVersion !== undefined) problems.push(`${platform}.runtimeVersion must not override the fingerprint policy`);
	}
	if (easJson.build?.beta?.channel !== "production") problems.push("eas.json build.beta.channel must be production");
	const submit = easJson.submit?.beta?.ios ?? {};
	for (const field of ["ascAppId", "ascApiKeyPath", "ascApiKeyIssuerId", "ascApiKeyId"]) {
		if (!submit[field]) problems.push(`eas.json submit.beta.ios.${field} is missing`);
	}
	return problems;
}

/** Some CLIs print notices before the JSON document. */
function readJson(file) {
	const text = fs.readFileSync(file, "utf8");
	const start = text.search(/^[[{]/m);
	return JSON.parse(start === -1 ? text : text.slice(start));
}

const BUILD_FIELDS = "id status message createdAt completedAt appBuildVersion gitCommitHash runtime { version } submissions { platform status completedAt }";
const UPDATE_FIELDS = "group message createdAt gitCommitHash runtime { version }";

async function graphql(token, query, variables) {
	const response = await fetch("https://api.expo.dev/graphql", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	const body = await response.json();
	if (!response.ok || body.errors) throw new Error(`Expo API: ${JSON.stringify(body.errors ?? response.status)}`);
	return body.data.app.byId;
}

/** Read-only: every beta iOS build and the newest iOS updates, from Expo's API. */
async function fetchState({ token, appId, runtime }) {
	const builds = [];
	for (let offset = 0; ; offset += 50) {
		const page = await graphql(
			token,
			`query($appId: String!, $offset: Int!) { app { byId(appId: $appId) { builds(offset: $offset, limit: 50, filter: { platform: IOS, buildProfile: "beta" }) { ${BUILD_FIELDS} } } } }`,
			{ appId, offset },
		);
		builds.push(...page.builds);
		if (page.builds.length < 50) break;
		if (offset > 5000) throw new Error("More than 5000 beta builds. Raise the page cap.");
	}
	const updates = `query($appId: String!, $filter: UpdatesFilter) { app { byId(appId: $appId) { updateGroups(limit: 1, offset: 0, filter: $filter) { ${UPDATE_FIELDS} } } } }`;
	const newest = await graphql(token, updates, { appId, filter: { platform: "IOS" } });
	const forRuntime = await graphql(token, updates, { appId, filter: { platform: "IOS", runtimeVersions: [runtime] } });
	return { builds, latestUpdate: newest.updateGroups[0]?.[0] ?? null, latestUpdateForRuntime: forRuntime.updateGroups[0]?.[0] ?? null };
}

/** True when `newer` is a strict descendant of `sha` in this checkout. */
function isOlderThan(sha, newer) {
	if (!newer || newer === sha) return false;
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", sha, newer], { stdio: "ignore" });
		return true;
	} catch (error) {
		if (error.status === 1) return false;
		throw new Error(`Could not compare ${sha} with ${newer}. Is the checkout complete?`);
	}
}

async function main(argv, env) {
	const [command, ...args] = argv;
	if (command === "preflight") {
		const refused = preflight({ ref: env.GITHUB_REF, tokenPresent: Boolean(env.EXPO_TOKEN) });
		if (refused) throw new Error(refused.reason);
		return;
	}
	if (command === "expo-modules") {
		const count = countExpoModules(readJson(args[0]).fingerprintSources);
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
	if (command === "fetch") {
		const appId = readJson("app.json").expo.extra.eas.projectId;
		const state = await fetchState({ token: env.EXPO_TOKEN, appId, runtime: readJson(args[0]).runtimeVersion });
		fs.writeFileSync(args[1], JSON.stringify(state, null, 2));
		return;
	}
	if (command === "decide") {
		const resolved = readJson(args[0]);
		const state = readJson(args[1]);
		const runtime = resolved.runtimeVersion;
		const decision = decide({
			event: env.GITHUB_EVENT_NAME,
			mode: env.MODE,
			ref: env.GITHUB_REF,
			tokenPresent: Boolean(env.EXPO_TOKEN),
			runtime,
			expoModules: countExpoModules(resolved.fingerprintSources),
			builds: state.builds,
			stale: isOlderThan(env.GITHUB_SHA, state.latestUpdateForRuntime?.gitCommitHash),
		});
		console.log(`action=${decision.action}`);
		console.log(`runtime=${runtime}`);
		console.log(`message=${buildMessage(env.GITHUB_SHA, runtime)}`);
		console.log(`reason=${decision.reason}`);
		console.log(`problem=${decision.problem ?? ""}`);
		return;
	}
	throw new Error(`Unknown command ${command}. Use preflight, fetch, decide, expo-modules or check-config.`);
}

if (require.main === module) {
	main(process.argv.slice(2), process.env).catch((error) => {
		console.error(`::error::${error.message.replaceAll("\n", "%0A")}`);
		process.exit(1);
	});
}

module.exports = { attempt, buildMessage, checkConfig, countExpoModules, decide, isOlderThan, preflight };

// Decides what the mobile release workflow does: publish an OTA, start a
// build (button only), report, or fail loudly. See
// docs/specs/mobile-auto-updates.md. The OTA rule follows T3 Code's
// .github/workflows/mobile-eas-production.yml (https://github.com/pingdotgg/t3code).
const { createSign } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const DAY_MS = 24 * 60 * 60 * 1000;
const REMIND_AFTER_DAYS = 76;
const TESTFLIGHT_DAYS = 90;
const MAIN = "refs/heads/main";
const BUILD_ACTIVE = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS", "PENDING_CANCEL"]);
const SUBMIT_ACTIVE = new Set(["AWAITING_BUILD", "IN_QUEUE", "IN_PROGRESS"]);
const REQUESTED = /fingerprint ([0-9a-f]{40})/;
const PRESS_BUILD = "Press Run workflow on main with mode build.";

/** Builds started here carry the runtime CI requested, so a mismatch can be reported. */
function buildMessage(sha, runtime) {
	return `Mobile release ${sha.slice(0, 9)}, fingerprint ${runtime}`;
}

/** One build as the rules see it: active, failed, or uploaded to TestFlight by Expo. */
function attempt(build) {
	const base = { id: build.id, number: build.appBuildVersion, requested: build.message?.match(REQUESTED)?.[1] ?? null, recorded: build.runtime?.version ?? null, apple: build.apple ?? null };
	if (BUILD_ACTIVE.has(build.status)) return { ...base, state: "active", detail: `build ${build.status}` };
	if (build.status !== "FINISHED") return { ...base, state: "failed", detail: `build ${build.status}` };
	const submissions = (build.submissions ?? []).filter((submission) => submission.platform === "IOS");
	if (submissions.some((submission) => submission.status === "FINISHED")) return { ...base, state: "uploaded" };
	const pending = submissions.find((submission) => SUBMIT_ACTIVE.has(submission.status));
	if (pending) return { ...base, state: "active", detail: `TestFlight upload ${pending.status}` };
	return { ...base, state: "failed", detail: submissions[0] ? `TestFlight upload ${submissions[0].status}` : "never sent to TestFlight" };
}

/**
 * Whether the newest build Expo uploaded is one phones can install: Apple
 * finished processing it as VALID and it has not expired.
 */
function usable(newest, now) {
	if (!newest) return { ok: false, kind: "none", reason: `No build has reached TestFlight. ${PRESS_BUILD}` };
	const label = `TestFlight build ${newest.number} (${newest.id})`;
	const apple = newest.apple;
	if (!apple || apple.processingState === "PROCESSING") return { ok: false, kind: "processing", reason: `${label} is still processing at Apple.` };
	if (apple.processingState !== "VALID") return { ok: false, kind: "invalid", reason: `Apple marked ${label} ${apple.processingState}. ${PRESS_BUILD}` };
	const ageMs = now - Date.parse(apple.uploadedDate);
	if (apple.expired || ageMs >= TESTFLIGHT_DAYS * DAY_MS) return { ok: false, kind: "expired", reason: `${label} expired on TestFlight, so phones can no longer open it. ${PRESS_BUILD}` };
	return { ok: true, label, ageDays: Math.floor(ageMs / DAY_MS) };
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
 * builds: every beta iOS build, newest first, with submissions, runtime and
 * (on the newest uploaded one) Apple's processing record.
 * runtime: the runtime version eas update will publish to for this commit.
 * isStale: called only on the OTA path; true when a newer commit already
 * published an OTA for this runtime.
 */
function decide({ event, mode, ref, tokenPresent, sha, mainHead, runtime, expoModules, builds, isStale = () => false, now = Date.now() }) {
	const refused = preflight({ ref, tokenPresent });
	if (refused) return refused;
	const attempts = builds.map(attempt);
	const active = attempts.find((a) => a.state === "active");
	const newest = attempts.find((a) => a.state === "uploaded");
	const button = event === "workflow_dispatch";

	if (button && mode === "check") {
		const latest = attempts[0];
		if (latest?.state === "failed") return { action: "check", reason: "Read-only check.", problem: `The newest beta build ${latest.id} failed: ${latest.detail}. ${PRESS_BUILD}` };
		return { action: "check", reason: "Read-only check." };
	}
	if (button && mode === "build") {
		if (sha !== mainHead) return { action: "fail", reason: `This run checked out ${sha}, but main is at ${mainHead}. Press Run workflow again.` };
		if (active) return { action: "fail", reason: `Beta build ${active.id} is already running (${active.detail}). Wait for it to finish.` };
		return { action: "build", reason: "Build requested with Run workflow." };
	}
	if (button && mode !== "update") return { action: "fail", reason: `Unknown mode ${mode}.` };

	if (event === "schedule") {
		if (active) return { action: "none", reason: `Beta build ${active.id} is in progress (${active.detail}).` };
		const status = usable(newest, now);
		if (status.kind === "processing") return { action: "none", reason: status.reason };
		if (!status.ok) return { action: "fail", reason: status.reason };
		if (status.ageDays >= REMIND_AFTER_DAYS) return { action: "fail", reason: `${status.label} is ${status.ageDays} days old and expires at 90. ${PRESS_BUILD}` };
		return { action: "none", reason: `${status.label} is ${status.ageDays} days old.` };
	}
	if (!button && event !== "push") return { action: "fail", reason: `Unknown event ${event}.` };

	// The OTA path: push to main, or the update button. It never builds.
	if (expoModules === 0) return { action: "fail", reason: `Runtime ${runtime} hashes no Expo native modules, so it cannot be trusted.` };
	const status = usable(newest, now);
	if (!status.ok) return { action: "fail", reason: status.kind === "processing" ? `${status.reason} Publish this change with Run workflow, update, once Apple finishes.` : status.reason };
	if (newest.requested && newest.recorded !== newest.requested) {
		return { action: "fail", reason: `${status.label} recorded runtime ${newest.recorded}, but CI requested ${newest.requested} for its commit. OTAs would never match it. Stop and report.` };
	}
	if (newest.recorded !== runtime) {
		return { action: "fail", reason: `This change needs a new TestFlight build: ${status.label} has runtime ${newest.recorded}, this commit needs ${runtime}. ${PRESS_BUILD}` };
	}
	if (isStale()) {
		const reason = `A newer commit already published an OTA for runtime ${runtime}.`;
		return button ? { action: "fail", reason: `Nothing to publish: ${reason}` } : { action: "none", reason };
	}
	return { action: "update", reason: `${status.label} has runtime ${runtime}.` };
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

const BUILD_FIELDS = "id status message createdAt completedAt appVersion appBuildVersion gitCommitHash runtime { version } submissions { platform status completedAt }";
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

/** Read-only: Apple's processing record for one build number, or null before Apple lists it. */
async function appleBuild({ keyId, issuer, key, ascAppId, appVersion, number }) {
	const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const unsigned = `${b64({ alg: "ES256", kid: keyId, typ: "JWT" })}.${b64({ iss: issuer, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
	const signature = createSign("SHA256").update(unsigned).sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
	const query = new URLSearchParams({
		"filter[app]": ascAppId,
		"filter[version]": number,
		"filter[preReleaseVersion.version]": appVersion,
		"fields[builds]": "version,processingState,expired,uploadedDate",
	});
	const response = await fetch(`https://api.appstoreconnect.apple.com/v1/builds?${query}`, { headers: { Authorization: `Bearer ${unsigned}.${signature}` } });
	const body = await response.json();
	if (!response.ok) throw new Error(`App Store Connect API ${response.status}: ${JSON.stringify(body.errors ?? body)}`);
	return body.data[0]?.attributes ?? null;
}

/** Read-only: every beta iOS build, Apple's record for the newest uploaded one, and the newest iOS updates. */
async function fetchState({ token, appId, runtime, apple }) {
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
	const newest = builds.find((build) => attempt(build).state === "uploaded");
	if (newest) newest.apple = await appleBuild({ ...apple, appVersion: newest.appVersion, number: newest.appBuildVersion });
	const updates = `query($appId: String!, $filter: UpdatesFilter) { app { byId(appId: $appId) { updateGroups(limit: 1, offset: 0, filter: $filter) { ${UPDATE_FIELDS} } } } }`;
	const latest = await graphql(token, updates, { appId, filter: { platform: "IOS" } });
	const forRuntime = await graphql(token, updates, { appId, filter: { platform: "IOS", runtimeVersions: [runtime] } });
	return { builds, latestUpdate: latest.updateGroups[0]?.[0] ?? null, latestUpdateForRuntime: forRuntime.updateGroups[0]?.[0] ?? null };
}

/** True only when `newer` is a strict descendant of `sha`. A commit the checkout lacks is not newer. */
function isOlderThan(sha, newer) {
	if (!newer || newer === sha) return false;
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", sha, newer], { stdio: "ignore" });
		return true;
	} catch (error) {
		if (error.status !== 1) console.log(`Could not compare ${sha} with ${newer}; treating it as not newer.`);
		return false;
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
		const state = await fetchState({
			token: env.EXPO_TOKEN,
			appId: readJson("app.json").expo.extra.eas.projectId,
			runtime: readJson(args[0]).runtimeVersion,
			apple: { keyId: env.APPLE_API_KEY_ID, issuer: env.APPLE_API_ISSUER, key: env.APPLE_API_KEY, ascAppId: readJson("eas.json").submit.beta.ios.ascAppId },
		});
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
			sha: env.GITHUB_SHA,
			mainHead: env.MAIN_HEAD,
			runtime,
			expoModules: countExpoModules(resolved.fingerprintSources),
			builds: state.builds,
			isStale: () => isOlderThan(env.GITHUB_SHA, state.latestUpdateForRuntime?.gitCommitHash),
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

module.exports = { attempt, buildMessage, checkConfig, countExpoModules, decide, isOlderThan, preflight, usable };

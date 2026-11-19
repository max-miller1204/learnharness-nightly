const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { attempt, buildMessage, checkConfig, countExpoModules, decide, isOlderThan } = require("./mobile-release.cjs");

const F = "a".repeat(40);
const G = "b".repeat(40);
const X = "c".repeat(40);
const SHA = "1".repeat(40);
const NOW = Date.parse("2026-11-19T12:00:00Z");
const daysAgo = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

/**
 * A beta build as fetchState returns it. A finished build defaults to a
 * finished upload that Apple processed as VALID.
 */
function build(id, status, runtime, { submission = status === "FINISHED" ? "FINISHED" : undefined, apple = "VALID", expired = false, requested, days = 1, uploaded = daysAgo(days) } = {}) {
	return {
		id,
		status,
		appBuildVersion: id,
		message: requested ? buildMessage(SHA, requested) : null,
		createdAt: daysAgo(days),
		completedAt: daysAgo(days),
		runtime: runtime ? { version: runtime } : null,
		submissions: submission ? [{ platform: "IOS", status: submission, completedAt: daysAgo(days) }] : [],
		apple: submission === "FINISHED" && apple ? { processingState: apple, expired, uploadedDate: uploaded } : null,
	};
}
/** The same build with Apple's upload date missing entirely. */
function undated(b) {
	delete b.apple.uploadedDate;
	return b;
}
const run = (overrides) =>
	decide({ event: "push", ref: "refs/heads/main", tokenPresent: true, sha: SHA, mainHead: SHA, runtime: F, expoModules: 24, builds: [build("1", "FINISHED", F)], now: NOW, ...overrides });
const button = (mode, overrides) => run({ event: "workflow_dispatch", mode, ...overrides });

test("a merge publishes an OTA when the newest Apple-processed build has the runtime", () => {
	assert.equal(run({}).action, "update");
	assert.equal(button("update", {}).action, "update");
});

test("a push never builds: a new runtime fails loudly and asks for the build button", () => {
	for (const builds of [[build("1", "FINISHED", G)], []]) {
		const decision = run({ builds });
		assert.equal(decision.action, "fail");
		assert.match(decision.reason, /mode build/);
	}
	assert.match(run({ builds: [build("1", "FINISHED", G)] }).reason, /needs a new TestFlight build/);
});

test("a push never builds and ignores builds that are running or failed", () => {
	for (const status of ["IN_PROGRESS", "ERRORED", "CANCELED"]) {
		assert.equal(run({ builds: [build("2", status, G), build("1", "FINISHED", F)] }).action, "update", status);
		assert.equal(run({ runtime: G, builds: [build("2", status, G), build("1", "FINISHED", F)] }).action, "fail", status);
	}
});

test("only a build Apple finished processing as VALID counts", () => {
	const processing = run({ builds: [build("2", "FINISHED", F, { apple: "PROCESSING" }), build("1", "FINISHED", F)] });
	assert.equal(processing.action, "fail");
	assert.match(processing.reason, /still processing at Apple/);
	assert.match(run({ builds: [build("2", "FINISHED", F, { apple: null })] }).reason, /still processing at Apple/);
	for (const state of ["INVALID", "FAILED"]) {
		const decision = run({ builds: [build("2", "FINISHED", F, { apple: state }), build("1", "FINISHED", F)] });
		assert.equal(decision.action, "fail", state);
		assert.match(decision.reason, new RegExp(`Apple marked .* ${state}`));
	}
});

test("an upload Expo has not finished does not count", () => {
	for (const submission of ["AWAITING_BUILD", "IN_PROGRESS", "ERRORED", "CANCELED", null]) {
		assert.equal(attempt(build("2", "FINISHED", G, { submission })).state === "uploaded", false, String(submission));
		assert.equal(run({ builds: [build("2", "FINISHED", G, { submission }), build("1", "FINISHED", F)] }).action, "update", String(submission));
	}
});

test("an expired build has its own failure reason", () => {
	for (const options of [{ days: 90 }, { days: 10, expired: true }]) {
		const decision = run({ builds: [build("1", "FINISHED", F, options)] });
		assert.equal(decision.action, "fail");
		assert.match(decision.reason, /expired on TestFlight/);
	}
	assert.equal(run({ builds: [build("1", "FINISHED", F, { days: 89 })] }).action, "update");
});

test("after a native change and a revert, the old build does not get the OTA", () => {
	assert.equal(run({ builds: [build("2", "FINISHED", G), build("1", "FINISHED", F, { days: 10 })] }).action, "fail");
});

test("a build whose recorded runtime differs from the requested one is reported", () => {
	assert.match(run({ builds: [build("2", "FINISHED", X, { requested: F })] }).reason, /recorded runtime .* Stop and report/);
	assert.equal(run({ builds: [build("2", "FINISHED", F, { requested: F })] }).action, "update");
});

test("an older commit never publishes after a newer OTA for the same runtime", () => {
	assert.equal(run({ isStale: () => true }).action, "none");
	assert.equal(button("update", { isStale: () => true }).action, "fail");
});

test("staleness is worked out only on the OTA path", () => {
	const isStale = () => assert.fail("isStale called");
	button("build", { isStale });
	button("check", { isStale });
	run({ event: "schedule", isStale });
	run({ runtime: G, isStale });
});

test("a runtime that hashes no Expo native modules publishes nothing", () => {
	assert.equal(run({ expoModules: 0 }).action, "fail");
	assert.equal(button("update", { expoModules: 0 }).action, "fail");
});

test("Monday never builds: it fails as a reminder at 76 days and stays quiet at 75", () => {
	const at = (days) => run({ event: "schedule", builds: [build("1", "FINISHED", F, { days })] });
	assert.equal(at(75).action, "none");
	assert.equal(at(75.9).action, "none");
	assert.equal(at(76).action, "fail");
	assert.match(at(76).reason, /76 days old .* mode build/);
	assert.match(at(91).reason, /expired on TestFlight/);
	assert.equal(run({ event: "schedule", builds: [] }).action, "fail");
});

test("Monday ignores an unrelated failed build and waits while a build runs at Expo", () => {
	const old = build("1", "FINISHED", F, { days: 10 });
	assert.equal(run({ event: "schedule", builds: [build("2", "ERRORED", G), old] }).action, "none");
	assert.equal(run({ event: "schedule", builds: [build("2", "FINISHED", G, { submission: "CANCELED" }), old] }).action, "none");
	assert.equal(run({ event: "schedule", builds: [build("2", "IN_PROGRESS", G), build("1", "FINISHED", F, { days: 80 })] }).action, "none");
});

test("Monday reminds when the newest build is stuck processing, expired, rejected, undated or missing", () => {
	const monday = (builds) => run({ event: "schedule", builds });
	for (const builds of [
		[build("2", "FINISHED", G, { apple: "PROCESSING", days: 77 })],
		[build("2", "FINISHED", G, { apple: "PROCESSING", days: 91 })],
		[build("2", "FINISHED", G, { apple: "PROCESSING", expired: true, days: 10 })],
		[build("2", "FINISHED", G, { apple: "PROCESSING", days: 1 }), build("1", "FINISHED", F, { days: 80 })],
		[build("2", "FINISHED", G, { apple: null })],
		[build("2", "FINISHED", G, { apple: "INVALID" })],
		[undated(build("2", "FINISHED", G))],
		[],
	]) {
		const decision = monday(builds);
		assert.equal(decision.action, "fail", JSON.stringify(builds.map((b) => b.apple)));
		assert.match(decision.reason, /mode build/);
	}
	assert.match(monday([build("2", "FINISHED", G, { apple: "PROCESSING", days: 91 })]).reason, /expired on TestFlight/);
});

test("a build with no known upload date is not usable, and a push asks for a build", () => {
	const cases = { missing: () => undated(build("1", "FINISHED", F)), null: () => build("1", "FINISHED", F, { uploaded: null }), garbage: () => build("1", "FINISHED", F, { uploaded: "not a date" }) };
	for (const [name, make] of Object.entries(cases)) {
		const decision = run({ builds: [make()] });
		assert.equal(decision.action, "fail", name);
		assert.match(decision.reason, /needs a new TestFlight build/, name);
		assert.equal(button("update", { builds: [make()] }).action, "fail", name);
	}
});

test("an expired build still marked processing reports expiry", () => {
	assert.match(run({ builds: [build("1", "FINISHED", F, { apple: "PROCESSING", days: 91 })] }).reason, /expired on TestFlight/);
});

test("only main runs share a concurrency group, so an off-main request displaces nothing", () => {
	const workflow = fs.readFileSync(path.join(__dirname, "..", "workflows", "mobile-release.yml"), "utf8");
	const expression = workflow.match(/^ {2}group: \$\{\{ (.+) \}\}$/m)[1];
	assert.doesNotMatch(expression, /[^!=]=[^=]|\b(?:contains|startsWith|endsWith|fromJSON|toJSON)\(/, "only format, ==, != , && and || are evaluated here");
	const format = (template, ...values) => template.replace(/\{(\d+)\}/g, (_, index) => values[index]);
	const evaluate = new Function("github", "inputs", "format", `return (${expression});`);
	const group = (ref, event, mode = "", runId = "1") => evaluate({ ref, event_name: event, run_id: runId }, { mode }, format);
	const main = "refs/heads/main";
	assert.equal(group(main, "push"), group(main, "workflow_dispatch", "update"));
	const others = [group(main, "workflow_dispatch", "check"), group(main, "workflow_dispatch", "build"), group(main, "schedule")];
	assert.equal(new Set([group(main, "push"), ...others]).size, 4);
	for (const mode of ["update", "build", "check"]) {
		const offMain = group("refs/heads/feature", "workflow_dispatch", mode, "77");
		assert.notEqual(offMain, group(main, "push"), mode);
		assert.ok(!others.includes(offMain), mode);
		assert.notEqual(offMain, group("refs/heads/feature", "workflow_dispatch", mode, "78"), mode);
	}
});

test("the build button builds only from main's head and while no build runs", () => {
	assert.equal(button("build", { builds: [build("1", "FINISHED", F), build("0", "ERRORED", G)] }).action, "build");
	const old = button("build", { mainHead: "2".repeat(40) });
	assert.equal(old.action, "fail");
	assert.match(old.reason, /main is at/);
	for (const status of ["NEW", "IN_QUEUE", "IN_PROGRESS"]) {
		assert.equal(button("build", { builds: [build("2", status, G), build("1", "FINISHED", F)] }).action, "fail", status);
	}
	assert.equal(button("build", { builds: [build("2", "FINISHED", G, { submission: "IN_PROGRESS" })] }).action, "fail");
});

test("the check button only reads, and flags a newest build that failed or was cancelled", () => {
	assert.equal(button("check", {}).action, "check");
	assert.equal(button("check", {}).problem, undefined);
	for (const newest of [build("2", "CANCELED", G), build("2", "FINISHED", G, { submission: "CANCELED" })]) {
		const decision = button("check", { builds: [newest, build("1", "FINISHED", F)] });
		assert.equal(decision.action, "check");
		assert.match(decision.problem, /failed/);
	}
});

test("refs other than main and a missing token fail before anything else", () => {
	for (const mode of ["build", "update", "check"]) {
		assert.equal(button(mode, { ref: "refs/heads/feature" }).action, "fail", mode);
		assert.equal(button(mode, { tokenPresent: false }).action, "fail", mode);
	}
	assert.match(run({ ref: "refs/tags/v1" }).reason, /only on main/);
	assert.match(run({ tokenPresent: false }).reason, /EXPO_TOKEN/);
});

test("countExpoModules counts only Expo autolinking sources for the platform", () => {
	const sources = [{ reasons: ["expoAutolinkingIos"] }, { reasons: ["expoAutolinkingAndroid"] }, { reasons: ["bareGitIgnore"] }, {}];
	assert.equal(countExpoModules(sources), 1);
	assert.equal(countExpoModules([]), 0);
});

test("checkConfig accepts the committed config and names each missing field", () => {
	const mobile = path.join(__dirname, "..", "..", "apps", "mobile");
	const appJson = JSON.parse(fs.readFileSync(path.join(mobile, "app.json"), "utf8")).expo;
	const easJson = JSON.parse(fs.readFileSync(path.join(mobile, "eas.json"), "utf8"));
	assert.deepEqual(checkConfig(appJson, easJson), []);
	assert.deepEqual(checkConfig({ extra: { eas: { projectId: "p" } }, ios: { runtimeVersion: "1" }, android: { runtimeVersion: { policy: "appVersion" } } }, {}), [
		"updates.enabled must be true",
		"updates.url must be https://u.expo.dev/<projectId>",
		"runtimeVersion.policy must be fingerprint",
		"ios.runtimeVersion must not override the fingerprint policy",
		"android.runtimeVersion must not override the fingerprint policy",
		"eas.json build.beta.channel must be production",
		"eas.json submit.beta.ios.ascAppId is missing",
		"eas.json submit.beta.ios.ascApiKeyPath is missing",
		"eas.json submit.beta.ios.ascApiKeyIssuerId is missing",
		"eas.json submit.beta.ios.ascApiKeyId is missing",
	]);
});

test("isOlderThan is true only for a strict ancestor, and a missing commit is not newer", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-release-git-"));
	const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
	git("init", "-q");
	git("commit", "-q", "--allow-empty", "-m", "a");
	const a = git("rev-parse", "HEAD");
	git("commit", "-q", "--allow-empty", "-m", "b");
	const b = git("rev-parse", "HEAD");
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		assert.equal(isOlderThan(a, b), true);
		assert.equal(isOlderThan(b, a), false);
		assert.equal(isOlderThan(b, b), false);
		assert.equal(isOlderThan(b, undefined), false);
		assert.equal(isOlderThan(b, X), false);
	} finally {
		process.chdir(cwd);
		fs.rmSync(dir, { recursive: true });
	}
});

test("the decide command reads CLI output with leading notices and prints step outputs", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-release-"));
	const runtimeFile = path.join(dir, "runtime.json");
	const stateFile = path.join(dir, "state.json");
	fs.writeFileSync(runtimeFile, `A notice\n${JSON.stringify({ runtimeVersion: F, fingerprintSources: [{ reasons: ["expoAutolinkingIos"] }] })}`);
	fs.writeFileSync(stateFile, JSON.stringify({ builds: [build("1", "FINISHED", F)], latestUpdate: null, latestUpdateForRuntime: { gitCommitHash: X } }));
	const env = { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "0123456789abcdef", MAIN_HEAD: "0123456789abcdef", EXPO_TOKEN: "x" };
	const script = path.join(__dirname, "mobile-release.cjs");
	const output = execFileSync(process.execPath, [script, "decide", runtimeFile, stateFile], { env, encoding: "utf8" });
	assert.match(output, /^action=update$/m);
	assert.match(output, new RegExp(`^runtime=${F}$`, "m"));
	assert.match(output, new RegExp(`^message=Mobile release 012345678, fingerprint ${F}$`, "m"));
	assert.match(output, /^problem=$/m);
	fs.rmSync(dir, { recursive: true });
	assert.throws(() => execFileSync(process.execPath, [script, "preflight"], { env: { ...env, GITHUB_REF: "refs/heads/x" }, stdio: "pipe" }));
});

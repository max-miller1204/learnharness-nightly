const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildMessage, checkConfig, countExpoModules, decide } = require("./mobile-release.cjs");

const F = "a".repeat(40);
const G = "b".repeat(40);
const NOW = Date.parse("2026-11-19T12:00:00Z");
const daysAgo = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
const build = (id, status, hash, extra = {}) => ({ id, status, fingerprint: { hash }, createdAt: daysAgo(1), completedAt: daysAgo(1), ...extra });
const run = (overrides) => decide({ event: "push", ref: "refs/heads/main", tokenPresent: true, fingerprint: G, expoModules: 24, builds: [build("old", "FINISHED", F)], now: NOW, ...overrides });

test("a JS-only merge publishes an OTA for the fingerprint's finished build", () => {
	assert.equal(run({ fingerprint: F }).action, "update");
});

test("a new fingerprint with no build starts exactly one build", () => {
	assert.equal(run({}).action, "build");
});

test("a build in progress for the fingerprint publishes and builds nothing", () => {
	for (const status of ["NEW", "IN_QUEUE", "IN_PROGRESS"]) {
		assert.equal(run({ builds: [build("new", status, G), build("old", "FINISHED", F)] }).action, "none", status);
	}
});

test("an errored or canceled build for the fingerprint fails the run without a build", () => {
	for (const status of ["ERRORED", "CANCELED"]) {
		const decision = run({ builds: [build("new", status, G), build("old", "FINISHED", F)] });
		assert.equal(decision.action, "fail", status);
		assert.match(decision.reason, /mode build/);
	}
});

test("a finished build whose recorded fingerprint differs from CI's fails without a build", () => {
	const mismatched = build("new", "FINISHED", F, { message: buildMessage("1234567890abc", G) });
	for (const event of ["push", "schedule"]) {
		const decision = run({ event, builds: [mismatched] });
		assert.equal(decision.action, "fail", event);
		assert.match(decision.reason, /recorded fingerprint/);
	}
	assert.equal(run({ fingerprint: F, builds: [build("new", "FINISHED", F, { message: buildMessage("1234567890abc", F) })] }).action, "update");
});

test("a fingerprint that hashes no Expo native modules publishes nothing", () => {
	assert.equal(run({ fingerprint: F, expoModules: 0 }).action, "fail");
	assert.equal(run({ event: "workflow_dispatch", mode: "update", fingerprint: F, expoModules: 0 }).action, "fail");
});

test("Monday refreshes a build 76 or more days old and leaves 75 days alone", () => {
	const at = (days) => run({ event: "schedule", builds: [build("old", "FINISHED", F, { completedAt: daysAgo(days) })] });
	assert.equal(at(75).action, "none");
	assert.equal(at(75.9).action, "none");
	assert.equal(at(76).action, "build");
	assert.equal(at(82).action, "build");
});

test("Monday does nothing while a build runs and fails after an errored build", () => {
	const finished = build("old", "FINISHED", F, { completedAt: daysAgo(80) });
	assert.equal(run({ event: "schedule", builds: [build("new", "IN_PROGRESS", F), finished] }).action, "none");
	assert.equal(run({ event: "schedule", builds: [build("new", "ERRORED", F), finished] }).action, "fail");
	assert.equal(run({ event: "schedule", builds: [] }).action, "build");
});

test("the build button always builds, even with a finished, errored or mismatched build", () => {
	for (const builds of [[build("x", "FINISHED", G)], [build("x", "ERRORED", G)], [build("x", "FINISHED", F, { message: buildMessage("123456789", G) })]]) {
		assert.equal(run({ event: "workflow_dispatch", mode: "build", builds }).action, "build");
	}
});

test("the update button publishes only for a fingerprint with a finished build", () => {
	assert.equal(run({ event: "workflow_dispatch", mode: "update", fingerprint: F }).action, "update");
	assert.equal(run({ event: "workflow_dispatch", mode: "update" }).action, "fail");
	assert.equal(run({ event: "workflow_dispatch", mode: "update", builds: [build("new", "IN_PROGRESS", G)] }).action, "fail");
});

test("the check button only reads", () => {
	assert.equal(run({ event: "workflow_dispatch", mode: "check" }).action, "check");
});

test("refs other than main and a missing token fail before anything else", () => {
	for (const mode of ["build", "update", "check"]) {
		assert.equal(run({ event: "workflow_dispatch", mode, ref: "refs/heads/feature" }).action, "fail", mode);
		assert.equal(run({ event: "workflow_dispatch", mode, tokenPresent: false }).action, "fail", mode);
	}
	assert.match(run({ ref: "refs/tags/v1" }).reason, /only on main/);
	assert.match(run({ tokenPresent: false }).reason, /EXPO_TOKEN/);
});

test("countExpoModules counts only Expo autolinking sources for the platform", () => {
	const fingerprint = { sources: [{ reasons: ["expoAutolinkingIos"] }, { reasons: ["expoAutolinkingAndroid"] }, { reasons: ["bareGitIgnore"] }, {}] };
	assert.equal(countExpoModules(fingerprint), 1);
	assert.equal(countExpoModules({ sources: [] }), 0);
});

test("checkConfig accepts the committed config and names each missing field", () => {
	const mobile = path.join(__dirname, "..", "..", "apps", "mobile");
	const appJson = JSON.parse(fs.readFileSync(path.join(mobile, "app.json"), "utf8")).expo;
	const easJson = JSON.parse(fs.readFileSync(path.join(mobile, "eas.json"), "utf8"));
	assert.deepEqual(checkConfig(appJson, easJson), []);
	assert.deepEqual(checkConfig({ extra: { eas: { projectId: "p" } } }, {}), [
		"updates.enabled must be true",
		"updates.url must be https://u.expo.dev/<projectId>",
		"runtimeVersion.policy must be fingerprint",
		"eas.json build.beta.channel must be production",
		"eas.json submit.beta.ios.ascAppId is missing",
		"eas.json submit.beta.ios.ascApiKeyPath is missing",
		"eas.json submit.beta.ios.ascApiKeyIssuerId is missing",
		"eas.json submit.beta.ios.ascApiKeyId is missing",
	]);
});

test("the decide command reads eas-cli output with leading notices and prints step outputs", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-release-"));
	const fingerprintFile = path.join(dir, "fingerprint.json");
	const buildsFile = path.join(dir, "builds.json");
	fs.writeFileSync(fingerprintFile, `Loaded environment variables\n${JSON.stringify({ hash: F, sources: [{ reasons: ["expoAutolinkingIos"] }] })}`);
	fs.writeFileSync(buildsFile, JSON.stringify([build("old", "FINISHED", F)]));
	const env = { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "0123456789abcdef", EXPO_TOKEN: "x" };
	const output = execFileSync(process.execPath, [path.join(__dirname, "mobile-release.cjs"), "decide", fingerprintFile, buildsFile], { env, encoding: "utf8" });
	assert.match(output, /^action=update$/m);
	assert.match(output, new RegExp(`^fingerprint=${F}$`, "m"));
	assert.match(output, new RegExp(`^message=Mobile release 012345678, fingerprint ${F}$`, "m"));
	fs.rmSync(dir, { recursive: true });
	assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, "mobile-release.cjs"), "preflight"], { env: { ...env, GITHUB_REF: "refs/heads/x" }, stdio: "pipe" }));
});

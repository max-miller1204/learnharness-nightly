// The CI iPhone job runs PR code, so it holds no secrets and reads only.
// See docs/specs/ios-simulator-ci.md.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8");

/** The text of one job under `jobs:`, from its key to the next job's key. */
function jobBlock(text, id) {
	const lines = text.split("\n");
	const start = lines.indexOf(`  ${id}:`);
	assert.notEqual(start, -1, `no ${id} job in ci.yml`);
	const end = lines.findIndex((line, i) => i > start && /^ {2}[A-Za-z_-]+:\s*$/.test(line));
	return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function secretsProblems(block) {
	const problems = [];
	if (/\bsecrets\b/.test(block)) problems.push("references secrets");
	if (!/\n {4}permissions:\n {6}contents: read\n(?! {6})/.test(block)) problems.push("permissions are not exactly contents: read");
	return problems;
}

test("the iPhone job holds no secrets and only reads the repository", () => {
	assert.deepEqual(secretsProblems(jobBlock(workflow, "iphone")), []);
});

test("the check catches a secret or a wider permission added to the job", () => {
	const block = jobBlock(workflow, "iphone");
	assert.deepEqual(secretsProblems(block.replace("    env:\n", "    env:\n      TOKEN: ${{ secrets.EXPO_TOKEN }}\n")), ["references secrets"]);
	assert.deepEqual(secretsProblems(block.replace("      contents: read\n", "      contents: read\n      id-token: write\n")), ["permissions are not exactly contents: read"]);
});

test("Check needs the iPhone job, so it can only skip through its gate", () => {
	assert.match(jobBlock(workflow, "check"), /needs: \[[^\]]*\biphone\b[^\]]*\]/);
	assert.match(jobBlock(workflow, "iphone"), /if: needs\.changes\.outputs\.iphone == 'true'/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const script = new URL("../.claude/skills/prove-learnharness/scripts/scope.mjs", import.meta.url).pathname;

/** The surfaces the prove skill's scope.mjs reaches for these paths. */
function surfaces(...files: string[]): string[] {
	const out = execFileSync(process.execPath, [script, "--files", files.join(","), "--json"], { encoding: "utf8" });
	return Object.keys(JSON.parse(out).surfaces ?? {});
}

test("inputs the phone app shares with the web select the mobile surface", () => {
	for (const file of [
		"src/core/math-delims.ts",
		"src/client-protocol/index.ts",
		"public/fonts/cmunbx.ttf",
		"build/icon.png",
		"package.json",
		"tests/fixtures/mobile-quiz/scenario.json",
		"tests/fixtures/mobile-lesson/chat_zzmobilelesson.json",
		"scripts/iphone-check/drive.mjs",
		"apps/mobile/src/App.tsx",
	]) {
		assert.ok(surfaces(file).includes("mobile"), file);
	}
});

test("web-only and unrelated paths do not select the mobile surface", () => {
	for (const file of ["app/page.tsx", "src/server/chats.ts", "docs/self-hosting.md", "tests/jobs.test.ts"]) {
		assert.ok(!surfaces(file).includes("mobile"), file);
	}
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { splitLabel } from "../src/choice-math.ts";
import { spokenLabel, startSpeech } from "../src/math-speech.ts";

const require = createRequire(import.meta.url);

// Math rendering and speech load nothing from the network at run time.
const offline = () => { throw new Error("No network in this test"); };
Object.assign(globalThis, { fetch: offline, XMLHttpRequest: offline });

// The phone's order: the engine is imported at app start, where it sets itself up and
// loads its rules on its own, and speech only starts once a math choice is shown. With
// no file system the engine reported ready with no rules, and speech threw in
// getEvaluator ("Cannot convert undefined value to object" on Hermes).
test("speaks after the engine's own start-up setup has run, offline", async () => {
  require("speech-rule-engine/js/common/system.js");
  await new Promise((done) => setTimeout(done, 50));
  await startSpeech();
  assert.equal(spokenLabel(splitLabel("No, $P\\to Q$ is blocked."), true), "No, P right arrow Q is blocked.");
  assert.equal(spokenLabel(splitLabel("$\\sqrt{x}$"), true), "the square root of x", "ClearSpeak, not MathSpeak");
  assert.equal(spokenLabel(splitLabel("$\\frac{1}{2}$"), true), "one half");
});

test("the engine reads only the English rules bundled into the app", () => {
  const { SystemExternal } = require("speech-rule-engine/js/common/system_external.js");
  assert.equal(SystemExternal.documentSupported, false);
  assert.equal(SystemExternal.mathmapsIePath, "");
  assert.ok(SystemExternal.fs.readFileSync("mathmaps/en.json")["en/rules/clearspeak_english.min"]);
  assert.throws(() => SystemExternal.fs.readFileSync("mathmaps/de.json"), /No bundled speech rules/);
  assert.throws(() => SystemExternal.fs.readFileSync("/etc/hosts"), /No bundled speech rules/);
});

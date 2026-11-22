#!/usr/bin/env node
/**
 * web-tool-error.mjs <instance.env>
 *
 * #335: drives a session whose only tool call fails (scenarios/teach-read-fails.json,
 * a `read` of a missing file) and records what the transcript shows for it, live
 * and after a reload: the tool-call card, its red name, its Error section, and
 * whether a "Retrying…" line is there. Start the instance with that scenario.
 * Writes <side dir>/web-tool-error/result.json and screenshots. Exit 0 = the
 * script ran to the end (the verdict is the `ok` of each step); 1 = it could not.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { signIn, signInPage } from "./sign-in.mjs";

const instPath = process.argv[2];
if (!instPath) { console.error("usage: web-tool-error.mjs <instance.env>"); process.exit(2); }
const inst = Object.fromEntries(fs.readFileSync(instPath, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
	const i = l.indexOf("=");
	return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
}));
const OUT = path.join(path.dirname(instPath), "web-tool-error");
fs.mkdirSync(OUT, { recursive: true });
signIn(inst);
const APP = inst.APP_URL;
const REPO = path.resolve(import.meta.dirname, "../../../..");
const puppeteer = createRequire(path.join(REPO, "package.json"))("puppeteer-core");
const turnMs = Number(process.env.TURN_TIMEOUT_S || 60) * 1000;
const GOAL = `zz-prove-it ${Date.now().toString(36)} read a file that is not there`;
const steps = [];
const result = { side: inst.SIDE, app: APP, build: inst.BUILD_STAMP, startedAt: new Date().toISOString(), steps, observations: {} };
const save = () => fs.writeFileSync(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
const step = (name, ok, note) => { steps.push({ name, ok, note }); save(); console.log(`[${ok ? "ok" : "FAIL"}] ${name}: ${note}`); };

const browser = await puppeteer.launch({ executablePath: process.env.PROVE_CHROME || "/usr/bin/google-chrome", headless: true, args: ["--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(path.dirname(instPath), "chrome-profile")}`] });
fs.writeFileSync(path.join(path.dirname(instPath), "chrome-web-tool-error.pid"), String(browser.process().pid));
let exitCode = 0;
try {
	const page = await browser.newPage();
	await signInPage(page, inst);
	await page.setViewport({ width: 1280, height: 900 });
	await fetch(`${inst.FAKE_CONTROL}/__prove/reset`, { method: "POST" });
	await page.goto(`${APP}/chat/new`, { waitUntil: "domcontentloaded" });
	const composer = '[data-testid="composer"] [contenteditable="true"]';
	await page.waitForSelector(composer, { timeout: 30_000 });
	// Typing before the page has hydrated loses the first keys (the goal's start,
	// "zz-prove-it", then never matches the fake model's rule): type, read the
	// composer back, and start over until the whole goal is there.
	const typed = async () => {
		for (let attempt = 0; attempt < 6; attempt++) {
			await page.click(composer);
			await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
			await page.keyboard.press("Backspace");
			await page.keyboard.type(GOAL);
			if ((await page.$eval(composer, (el) => el.textContent?.trim())) === GOAL) return true;
			await new Promise((r) => setTimeout(r, 1000));
		}
		return false;
	};
	const setupError = (name, note) => { step(`SETUP ERROR (not a product result): ${name}`, false, note); throw new Error(`setup: ${name}`); };
	if (!(await typed())) setupError("the goal never reached the composer intact", "typed text did not match after 6 tries");
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => /\/chat\/chat_/.test(location.pathname), { timeout: turnMs });
	const seenPrompt = await page.waitForFunction((goal) => document.querySelector('[data-testid="user-message"]')?.textContent?.includes(goal), { timeout: turnMs }, GOAL).then(() => true, () => false);
	if (!seenPrompt) setupError("the sent prompt is not in the transcript intact", GOAL);
	// The model must have been asked for the failing read, or there is nothing to judge.
	const modelLog = () => fs.existsSync(inst.MODEL_LOG) ? fs.readFileSync(inst.MODEL_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	const fired = await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="tool-call-card"] .text-error, [data-testid="tool-retry"]')), { timeout: turnMs }).then(() => true, () => false);
	if (!fired || !modelLog().some((r) => r.rule === "read-missing-file")) setupError("the fake model never called read", `rules fired: ${modelLog().map((r) => r.rule).join(",")}`);

	const observe = async (label) => {
		if (label === "live") {
			const early = await page.evaluate(() => !document.body.innerText.includes("zz-prove-it fallback reply."));
			if (!early) setupError("the live check ran after the next model reply arrived", "fallback reply already on the page");
		}
		const seen = await page.evaluate(() => {
			const card = document.querySelector('[data-testid="tool-call-card"][data-tool="read"]');
			const name = card?.querySelector("summary span");
			const errorHeading = card ? [...card.querySelectorAll("div")].find((d) => d.textContent?.trim() === "Error") : null;
			return {
				card: Boolean(card),
				nameRed: Boolean(name?.classList.contains("text-error")),
				nameRedColor: name ? getComputedStyle(name).color : null,
				errorHeading: Boolean(errorHeading),
				errorText: errorHeading?.nextElementSibling?.textContent?.trim().slice(0, 200) ?? null,
				retryLines: document.querySelectorAll('[data-testid="tool-retry"]').length,
				retryingText: /Retrying/.test(document.body.innerText),
			};
		});
		await page.evaluate(() => { const d = document.querySelector('[data-testid="tool-call-card"][data-tool="read"]'); if (d) d.open = true; });
		await page.screenshot({ path: path.join(OUT, `${label}.png`) });
		result.observations[label] = seen;
		step(`${label}: failed read shows its card with the Error, no Retrying`, seen.card && seen.nameRed && seen.errorHeading && /ENOENT|no such file|not found|does not exist/i.test(seen.errorText ?? "") && seen.retryLines === 0 && !seen.retryingText, JSON.stringify(seen));
		return seen;
	};
	await observe("live");
	await page.waitForFunction(() => document.body.innerText.includes("zz-prove-it fallback reply."), { timeout: turnMs });
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => document.body.innerText.includes("zz-prove-it fallback reply."), { timeout: turnMs });
	await observe("reloaded");
} catch (e) {
	step("drive", false, String(e?.stack ?? e).slice(0, 500));
	exitCode = 1;
} finally {
	await browser.close().catch(() => {});
}
process.exit(exitCode);

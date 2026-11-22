#!/usr/bin/env node
/**
 * web-hydration.mjs <instance.env> [--selector "<css>"]
 *
 * Text typed into a field the server rendered, before the page hydrates, must
 * survive hydration (issue #366). Drives real Chrome against one instance
 * started by start.sh:
 *   1. holds every /_next/static script request, so the server render is on
 *      screen but React has not run
 *   2. types into the composer (checks first that React has not attached to it)
 *   3. releases the scripts and waits for hydration
 *   4. reads the field, the saved draft in localStorage, and whether the field
 *      is still the same element
 * Three times: a session with no saved draft, a session with a saved draft
 * (#362), and the new-session page (the same field, no draft).
 *
 * Writes <side dir>/web-hydration/result.json (compare.mjs format: steps,
 * observations) and screenshots. `observations` is what compare.mjs diffs
 * between base and head; on a build with the bug the typed text is gone.
 * Exit 0 = the script ran to the end (not a verdict); 1 = a step could not
 * be done.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { signIn, signInPage } from "./sign-in.mjs";

const instPath = process.argv[2];
if (!instPath) { console.error("usage: web-hydration.mjs <instance.env>"); process.exit(2); }
const inst = Object.fromEntries(fs.readFileSync(instPath, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
	const i = l.indexOf("=");
	return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
}));
const SIDE_DIR = path.dirname(instPath);
const OUT = path.join(SIDE_DIR, "web-hydration");
fs.mkdirSync(OUT, { recursive: true });
signIn(inst);
const APP = inst.APP_URL;
const REPO = path.resolve(import.meta.dirname, "../../../..");
const puppeteer = createRequire(path.join(REPO, "package.json"))("puppeteer-core");
const chrome = process.env.PROVE_CHROME || "/usr/bin/google-chrome";
const FIELD = '[data-testid="composer"] [contenteditable="true"]';
const DRAFT_KEY = (id) => `lh:composer-draft:v1:${id}`;
const TYPED = "typed before hydration";
const SAVED = "saved draft from an earlier visit";

const steps = [];
const result = { side: inst.SIDE, app: APP, build: inst.BUILD_STAMP, startedAt: new Date().toISOString(), steps, observations: {}, evidence: {} };
const save = () => fs.writeFileSync(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
const step = (name, ok, detail) => { steps.push({ name, ok, ...detail }); save(); console.log(`[${ok ? "ok" : "FAIL"}] ${name}${detail?.note ? `: ${detail.note}` : ""}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(route, body) {
	const response = await fetch(APP + route, { method: "POST", headers: { "content-type": "application/json", origin: APP }, body: JSON.stringify(body) });
	if (!response.ok) throw new Error(`${route} -> ${response.status}`);
	return response.json();
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(SIDE_DIR, "chrome-profile", "hydration")}`] });
const chromePid = path.join(SIDE_DIR, "chrome-hydration.pid");
fs.writeFileSync(chromePid, String(browser.process().pid)); // stop.sh ends Chrome if this script dies

async function drive(label, savedDraft, newSession = false) {
	const obs = { savedDraft: savedDraft !== null };
	const page = await browser.newPage();
	page.setDefaultTimeout(30_000);
	const errors = [];
	page.on("pageerror", (error) => errors.push(String(error.message ?? error)));
	await page.setViewport({ width: 1280, height: 900 });
	await signInPage(page, inst);
	const { id } = newSession ? { id: "none" } : await api("/api/chats", { title: `zz-prove-it hydration ${label} ${Date.now().toString(36)}` });
	// The origin must be loaded to seed its localStorage; this visit is not held.
	await page.goto(`${APP}/api/health`, { waitUntil: "domcontentloaded" });
	await page.evaluate((key, draft) => {
		localStorage.clear();
		if (draft !== null) localStorage.setItem(key, JSON.stringify({ text: draft, at: Date.now() }));
	}, DRAFT_KEY(id), savedDraft);

	// Hold the scripts: the document renders, nothing hydrates.
	const held = [];
	let release = false;
	await page.setRequestInterception(true);
	page.on("request", (request) => {
		const url = request.url();
		if (!release && request.resourceType() === "script" && url.includes("/_next/static/")) held.push(request);
		else request.continue().catch(() => {});
	});
	await page.goto(`${APP}${newSession ? "/chat/new" : `/chat/${id}`}`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(FIELD, { visible: true });
	await sleep(500); // time for any script that was not held to have run
	obs.heldScripts = held.length > 0;
	obs.hydratedBeforeTyping = await page.$eval(FIELD, (el) => Object.keys(el).some((key) => key.startsWith("__react")));
	await page.focus(FIELD);
	await page.keyboard.type(TYPED);
	obs.typedBeforeHydration = await page.$eval(FIELD, (el) => el.textContent);
	await page.screenshot({ path: path.join(OUT, `${label}-1-typed-before-hydration.png`) });
	await page.$eval(FIELD, (el) => { el.setAttribute("data-prove-same-element", "1"); });

	release = true;
	for (const request of held) await request.continue().catch(() => {});
	await page.waitForFunction((selector) => {
		const el = document.querySelector(selector);
		return el && Object.keys(el).some((key) => key.startsWith("__react"));
	}, { timeout: 60_000 }, FIELD);
	await sleep(1500); // the draft restore runs in an effect after mount; the save debounces 300 ms
	await page.evaluate(() => window.dispatchEvent(new Event("pagehide"))); // flush the pending draft save
	await sleep(300);
	obs.afterHydration = await page.$eval(FIELD, (el) => el.textContent);
	obs.sameElement = await page.$eval(FIELD, (el) => el.getAttribute("data-prove-same-element") === "1");
	obs.placeholderHidden = await page.$eval(FIELD, (el) => el.dataset.empty === "false");
	obs.storedDraft = await page.evaluate((key) => {
		const raw = localStorage.getItem(key);
		try { return raw === null ? null : JSON.parse(raw).text; } catch { return "unparsable"; }
	}, DRAFT_KEY(id));
	await page.screenshot({ path: path.join(OUT, `${label}-2-after-hydration.png`) });

	// Typing still works after hydration: the field is live, not stuck.
	await page.focus(FIELD);
	await page.keyboard.press("End");
	await page.keyboard.type("!");
	obs.afterMoreTyping = await page.$eval(FIELD, (el) => el.textContent);
	obs.pageErrors = errors;
	await page.close();
	if (!newSession) await fetch(`${APP}/api/chats/${id}`, { method: "DELETE", headers: { origin: APP } }).catch(() => {});
	return obs;
}

try {
	for (const [label, saved, newSession] of [["no-draft", null, false], ["saved-draft", SAVED, false], ["new-session", null, true]]) {
		const obs = await drive(label, saved, newSession);
		result.observations[label] = obs;
		step(`${label}: the server render was editable with no React attached`, obs.heldScripts && !obs.hydratedBeforeTyping && obs.typedBeforeHydration === TYPED, { note: JSON.stringify({ held: obs.heldScripts, hydrated: obs.hydratedBeforeTyping, typed: obs.typedBeforeHydration }) });
		step(`${label}: text typed before hydration is kept`, obs.afterHydration === TYPED, { note: `field shows ${JSON.stringify(obs.afterHydration)}` });
		step(`${label}: the placeholder is hidden over kept text`, obs.placeholderHidden, {});
		step(`${label}: typing carries on after hydration`, obs.afterMoreTyping === `${TYPED}!`, { note: JSON.stringify(obs.afterMoreTyping) });
		if (label !== "new-session") step(`${label}: the typed text, not the old draft, is the saved draft`, obs.storedDraft === TYPED, { note: `stored ${JSON.stringify(obs.storedDraft)}` });
		step(`${label}: no page errors`, obs.pageErrors.length === 0, { note: obs.pageErrors.join("; ") });
	}
	save();
} catch (error) {
	step("drive", false, { note: String(error?.stack ?? error) });
	process.exitCode = 1;
} finally {
	await browser.close().catch(() => {});
	try { fs.unlinkSync(chromePid); } catch { /* already gone */ }
}
console.log(`result: ${path.join(OUT, "result.json")}`);

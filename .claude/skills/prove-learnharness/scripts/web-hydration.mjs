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
 * Five drives: a session with no saved draft, a session with a saved draft
 * (#362), the new-session page, a session where Send is pressed right after
 * hydration with no further typing, and a session waiting on a teach check,
 * whose reading-notes field is typed into and then submitted with the check.
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
const READING = '[data-testid="reading-thinking-field"] [contenteditable="true"]';
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

// A teaching session waiting on a check (as tests/chat-hydration-owners.test.tsx
// builds it): its reading-notes field is server-rendered next to the dock.
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (id, content) => ({ id, role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "synthetic", timestamp: 1, stopReason: "toolUse", usage, content });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const quiz = { type: "check", nodeId: "addition", question: "What is 1 + 1?", options: [{ value: "two", label: "2" }, { value: "three", label: "3" }], explanation: "Adding one to one gives two.", correctAnswer: "two" };
const WAITING_ON_CHECK = [
	{ id: "sent_user", role: "user", content: "Start", timestamp: 0 },
	assistant("m_probe", [{ type: "text", text: "Lesson." }, call("call_probe", "probe_done", { assessment: { strands: [{ strand: "Addition", assessment: "Ready." }] } })]),
	{ id: "m_probe_result", role: "toolResult", toolCallId: "call_probe", toolName: "probe_done", content: [{ type: "text", text: "Synthetic tool completed." }], details: { ok: true }, isError: false, timestamp: 2 },
	assistant("m_quiz", [call("call_quiz", "quiz", quiz)]),
];
function seedPendingCheck(id) {
	const file = path.join(SIDE_DIR, "data", "chats", `${id}.json`);
	const record = JSON.parse(fs.readFileSync(file, "utf8"));
	record.messages = WAITING_ON_CHECK;
	fs.writeFileSync(file, `${JSON.stringify(record, null, "\t")}\n`);
}

/** kind: "session" | "new-session" | "send" (press Send right after hydration) | "reading" (the reading-notes field of a pending check). */
async function drive(label, { saved = null, kind = "session" } = {}) {
	const newSession = kind === "new-session";
	const field = kind === "reading" ? READING : FIELD;
	const obs = { savedDraft: saved !== null };
	const page = await browser.newPage();
	page.setDefaultTimeout(30_000);
	const errors = [];
	const posts = [];
	page.on("pageerror", (error) => errors.push(String(error.message ?? error)));
	await page.setViewport({ width: 1280, height: 900 });
	await signInPage(page, inst);
	const { id } = newSession ? { id: "none" } : await api("/api/chats", { title: `zz-prove-it hydration ${label} ${Date.now().toString(36)}` });
	if (kind === "reading") seedPendingCheck(id);
	// The origin must be loaded to seed its localStorage; this visit is not held.
	await page.goto(`${APP}/api/health`, { waitUntil: "domcontentloaded" });
	await page.evaluate((key, draft) => {
		localStorage.clear();
		if (draft !== null) localStorage.setItem(key, JSON.stringify({ text: draft, at: Date.now() }));
	}, DRAFT_KEY(id), saved);

	// Hold the scripts: the document renders, nothing hydrates.
	const held = [];
	let release = false;
	await page.setRequestInterception(true);
	page.on("request", (request) => {
		const url = request.url();
		if (request.method() === "POST" && new URL(url).pathname === "/api/chat") posts.push(request.postData() ?? "");
		if (!release && request.resourceType() === "script" && url.includes("/_next/static/")) held.push(request);
		else request.continue().catch(() => {});
	});
	await page.goto(`${APP}${newSession ? "/chat/new" : `/chat/${id}`}`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(field, { visible: true });
	await sleep(500); // time for any script that was not held to have run
	obs.heldScripts = held.length > 0;
	obs.hydratedBeforeTyping = await page.$eval(field, (el) => Object.keys(el).some((key) => key.startsWith("__react")));
	await page.focus(field);
	await page.keyboard.type(TYPED);
	obs.typedBeforeHydration = await page.$eval(field, (el) => el.textContent);
	await page.screenshot({ path: path.join(OUT, `${label}-1-typed-before-hydration.png`) });
	await page.$eval(field, (el) => { el.setAttribute("data-prove-same-element", "1"); });

	release = true;
	for (const request of held) await request.continue().catch(() => {});
	await page.waitForFunction((selector) => {
		const el = document.querySelector(selector);
		return el && Object.keys(el).some((key) => key.startsWith("__react"));
	}, { timeout: 60_000 }, field);
	await sleep(1500); // the draft restore runs in an effect after mount; the save debounces 300 ms
	await page.evaluate(() => window.dispatchEvent(new Event("pagehide"))); // flush the pending draft save
	await sleep(300);
	obs.afterHydration = await page.$eval(field, (el) => el.textContent);
	obs.sameElement = await page.$eval(field, (el) => el.getAttribute("data-prove-same-element") === "1");
	obs.placeholderHidden = await page.$eval(field, (el) => el.dataset.empty === "false");
	obs.storedDraft = await page.evaluate((key) => {
		const raw = localStorage.getItem(key);
		try { return raw === null ? null : JSON.parse(raw).text; } catch { return "unparsable"; }
	}, DRAFT_KEY(id));
	await page.screenshot({ path: path.join(OUT, `${label}-2-after-hydration.png`) });

	if (kind === "send") {
		// Send right after hydration, with no more typing: the typed text alone must enable it.
		obs.sendButton = await page.$eval('[data-testid="composer"] button[type="submit"]', (el) => ({ label: el.getAttribute("aria-label"), disabled: el.disabled }));
		await page.click('[data-testid="composer"] button[type="submit"]');
		const until = Date.now() + 15_000;
		while (!posts.length && Date.now() < until) await sleep(100);
		obs.sentText = posts.length ? JSON.parse(posts[0])?.input?.text ?? posts[0] : null;
	} else if (kind === "reading") {
		// Open the waiting check, answer it and submit: the notes ride the answer.
		await page.keyboard.press("Enter");
		await page.waitForSelector('[data-testid="question-dock"] [role="radio"]', { visible: true });
		obs.notesAfterReveal = await page.$eval(field, (el) => el.textContent);
		const radios = await page.$$('[data-testid="question-dock"] [role="radio"]');
		for (const radio of radios) {
			if ((await radio.evaluate((el) => el.querySelector("p")?.textContent)) === "2") { await radio.click(); break; }
		}
		await page.click('[data-testid="question-dock"] form button[type="submit"]');
		const until = Date.now() + 15_000;
		while (!posts.length && Date.now() < until) await sleep(100);
		obs.submittedReadingNotes = posts.length ? JSON.stringify(posts[0]).includes(TYPED) && posts[0].includes("readingThinking") : false;
	} else {
		// Typing still works after hydration: the field is live, not stuck.
		await page.focus(field);
		await page.keyboard.press("End");
		await page.keyboard.type("!");
		obs.afterMoreTyping = await page.$eval(field, (el) => el.textContent);
	}
	obs.pageErrors = errors;
	await page.close();
	if (!newSession) await fetch(`${APP}/api/chats/${id}`, { method: "DELETE", headers: { origin: APP } }).catch(() => {});
	return obs;
}

try {
	for (const [label, options] of [
		["no-draft", {}], ["saved-draft", { saved: SAVED }], ["new-session", { kind: "new-session" }],
		["send-right-after", { kind: "send" }], ["reading-notes", { kind: "reading" }],
	]) {
		const obs = await drive(label, options);
		result.observations[label] = obs;
		const kind = options.kind ?? "session";
		step(`${label}: the server render was editable with no React attached`, obs.heldScripts && !obs.hydratedBeforeTyping && obs.typedBeforeHydration === TYPED, { note: JSON.stringify({ held: obs.heldScripts, hydrated: obs.hydratedBeforeTyping, typed: obs.typedBeforeHydration }) });
		step(`${label}: text typed before hydration is kept`, obs.afterHydration === TYPED, { note: `field shows ${JSON.stringify(obs.afterHydration)}` });
		step(`${label}: the placeholder is hidden over kept text`, obs.placeholderHidden, {});
		if (kind === "send") {
			step(`${label}: Send is enabled by the typed text alone`, obs.sendButton?.label === "Send" && obs.sendButton?.disabled === false, { note: JSON.stringify(obs.sendButton) });
			step(`${label}: pressing Send sends the typed text`, typeof obs.sentText === "string" && obs.sentText.includes(TYPED), { note: JSON.stringify(obs.sentText) });
		} else if (kind === "reading") {
			step(`${label}: opening the check keeps the notes`, obs.notesAfterReveal === TYPED, { note: JSON.stringify(obs.notesAfterReveal) });
			step(`${label}: the submitted check carries the reading notes`, obs.submittedReadingNotes === true, {});
		} else {
			step(`${label}: typing carries on after hydration`, obs.afterMoreTyping === `${TYPED}!`, { note: JSON.stringify(obs.afterMoreTyping) });
		}
		if (kind === "session") step(`${label}: the typed text, not the old draft, is the saved draft`, obs.storedDraft === TYPED, { note: `stored ${JSON.stringify(obs.storedDraft)}` });
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

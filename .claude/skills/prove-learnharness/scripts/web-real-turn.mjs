#!/usr/bin/env node
/**
 * web-real-turn.mjs <instance.env> [goal text]
 *
 * Opt-in real-model check (instance started with PROVE_MODEL=claude-code):
 * one teaching turn in Chrome with a real model. Real output varies, so this
 * checks only what must hold for any good turn: the turn ends, it ends
 * without an error, the learner sees something to act on (a question card
 * or teacher text), and the stored record agrees. Judge the content itself
 * from the screenshot and the stored record against the spec. Costs one
 * turn of subscription usage. Writes <side dir>/web-real-turn/result.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const instPath = process.argv[2];
if (!instPath) { console.error("usage: web-real-turn.mjs <instance.env> [goal]"); process.exit(2); }
const inst = Object.fromEntries(fs.readFileSync(instPath, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
	const i = l.indexOf("=");
	return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
}));
if (inst.MODEL !== "claude-code") { console.error("BLOCKED: this instance runs the fake model; start it with PROVE_MODEL=claude-code"); process.exit(2); }
const GOAL = process.argv[3] ?? "zz-prove-it: I want to understand why the sky is blue";
const SIDE_DIR = path.dirname(instPath);
const OUT = path.join(SIDE_DIR, "web-real-turn");
fs.mkdirSync(OUT, { recursive: true });
import { signIn, signInPage } from "./sign-in.mjs";
signIn(inst);
const APP = inst.APP_URL;
const REPO = path.resolve(import.meta.dirname, "../../../..");
const puppeteer = createRequire(path.join(REPO, "package.json"))("puppeteer-core");
const turnMs = Math.max(180, Number(process.env.TURN_TIMEOUT_S || 60)) * 1000;
const steps = [];
const result = { side: inst.SIDE, model: inst.MODEL, app: APP, goal: GOAL, steps, consoleErrors: [], evidence: {} };
const save = () => fs.writeFileSync(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
const step = (name, ok, note) => { steps.push({ name, ok, note }); save(); console.log(`[${ok ? "ok" : "FAIL"}] ${name}${note ? `: ${note}` : ""}`); };

const browser = await puppeteer.launch({ executablePath: process.env.PROVE_CHROME || "/usr/bin/google-chrome", headless: true, args: ["--no-first-run", `--user-data-dir=${path.join(SIDE_DIR, "chrome-profile")}`] });
const chromePid = path.join(SIDE_DIR, "chrome-web-real-turn.pid");
fs.writeFileSync(chromePid, String(browser.process().pid)); // stop.sh ends Chrome if this script dies
try {
	const page = await browser.newPage();
	await signInPage(page, inst);
	await page.setViewport({ width: 1280, height: 900 });
	page.on("console", (m) => { if (m.type() === "error") result.consoleErrors.push({ text: m.text().slice(0, 300), url: m.location()?.url ?? null }); });
	await page.goto(`${APP}/chat/new`, { waitUntil: "domcontentloaded" });
	const composer = '[data-testid="composer"] [contenteditable="true"]';
	await page.waitForSelector(composer, { timeout: 30_000 });
	await page.click(composer);
	await page.keyboard.type(GOAL);
	const t0 = Date.now();
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => /\/chat\/chat_/.test(location.pathname), { timeout: 30_000 });
	const chatId = new URL(page.url()).pathname.split("/").pop();
	let busy = true;
	while (busy && Date.now() - t0 < turnMs) {
		await new Promise((r) => setTimeout(r, 2000));
		const list = await (await fetch(`${APP}/api/chats`)).json();
		busy = Boolean(list.chats.find((c) => c.id === chatId)?.busy);
	}
	step("the real-model turn ends", !busy, `${Math.round((Date.now() - t0) / 1000)}s`);
	const record = JSON.parse(fs.readFileSync(path.join(inst.DATA_DIR, "chats", `${chatId}.json`), "utf8"));
	const assistants = (record.messages ?? []).filter((m) => m.role === "assistant");
	const errors = assistants.filter((m) => m.stopReason === "error");
	step("no assistant message ended in an error", assistants.length > 0 && errors.length === 0, `${assistants.length} assistant messages, errors: ${errors.map((m) => m.errorMessage).join("; ").slice(0, 300)}`);
	await new Promise((r) => setTimeout(r, 1500));
	const card = await page.$('[data-testid="question-dock"]');
	const text = await page.evaluate(() => document.querySelector("main")?.innerText ?? document.body.innerText);
	step("the learner sees something to act on (a question card or teacher text)", Boolean(card) || text.replace(GOAL, "").trim().length > 40, card ? "question card" : `${text.length} chars of text`);
	result.toolCalls = assistants.flatMap((m) => (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => c.name));
	const file = path.join(OUT, "turn.png");
	await page.screenshot({ path: file, fullPage: true });
	result.evidence.screenshot = file;
	fs.writeFileSync(path.join(OUT, "record.json"), JSON.stringify(record, null, 2));
	result.evidence.record = path.join(OUT, "record.json");
} catch (error) {
	step("drive", false, String(error?.stack ?? error).slice(0, 800));
} finally {
	save();
	await browser.close();
	fs.rmSync(chromePid, { force: true });
}
console.log(`result: ${path.join(OUT, "result.json")}`);
process.exit(steps.every((s) => s.ok) ? 0 : 1);

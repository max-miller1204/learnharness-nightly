#!/usr/bin/env node
// probes.mjs <instance.env>: break-it probes through the UI (first written by
// a checker during the 2026-11-17 proving run, then adopted into the skill).
//  A. model failure mid-turn (broken-stream): recorded error, the UI says so,
//     the composer stays usable and a follow-up turn works.
//  B. doing it twice: Enter twice on Submit answer -> one answer stored.
//  C. Retry after a failed turn (http500), by mouse and from the keyboard:
//     one POST, the turn's GET stream settles ([DONE], not busy), the
//     question card, Retry gone.
//  However a probe ends, the fake model's fail mode is set back to none.
// Writes <side dir>/probes/result.json (compare.mjs format: steps,
// observations) and screenshots. Run on base and head, then compare.
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const [instPath] = process.argv.slice(2);
if (!instPath) { console.error("usage: probes.mjs <instance.env>"); process.exit(2); }
const REPO = path.resolve(import.meta.dirname, "../../../..");
const inst = Object.fromEntries(fs.readFileSync(instPath, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }));
const OUT = path.join(path.dirname(instPath), "probes");
fs.mkdirSync(OUT, { recursive: true });
import { signIn, signInPage } from "./sign-in.mjs";
signIn(inst);
const APP = inst.APP_URL;
const puppeteer = createRequire(path.join(REPO, "package.json"))("puppeteer-core");
const res = { side: inst.SIDE, build: inst.BUILD_STAMP, steps: [], observations: {}, budgets: {}, probes: {}, consoleErrors: [] };
const save = () => fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(res, null, 2) + "\n");
const fake = (p) => fetch(`${inst.FAKE_CONTROL}${p}`, { method: "POST" }).then((r) => r.status);
const record = (id) => { const f = path.join(inst.DATA_DIR, "chats", `${id}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; };
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); } return null; };
const shape = (msgs) => msgs.map((m) => `${m.role}${m.role === "assistant" ? `[${(m.content ?? []).filter((c) => c.type === "toolCall").map((c) => c.name).join(",")}]${m.stopReason === "error" ? "!error" : ""}` : m.role === "toolResult" ? `(${m.toolName ?? ""})` : ""}`);
const composer = '[data-testid="composer"] [contenteditable="true"]';

const browser = await puppeteer.launch({ executablePath: process.env.PROVE_CHROME || "/usr/bin/google-chrome", headless: true, args: ["--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(path.dirname(instPath), "chrome-profile")}`] });
const chromePid = path.join(path.dirname(instPath), "chrome-probes.pid");
fs.writeFileSync(chromePid, String(browser.process().pid)); // stop.sh ends Chrome if this script dies
let code = 0;
try {
	const page = await browser.newPage();
	await signInPage(page, inst);
	await page.setViewport({ width: 1280, height: 900 });
	page.on("console", (m) => { if (m.type() === "error") res.consoleErrors.push({ text: m.text().slice(0, 200), url: m.location()?.url?.replace(/chat_[a-z0-9]+_[a-f0-9]+/g, "<chat>") ?? null }); });
	page.on("pageerror", (e) => res.consoleErrors.push({ text: `uncaught: ${e.message.slice(0, 200)}` }));
	const newSession = async (goal) => {
		await page.goto(`${APP}/chat/new`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector(composer, { timeout: 30_000 });
		await page.click(composer);
		await page.keyboard.type(goal);
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => /\/chat\/chat_/.test(location.pathname), { timeout: 60_000 });
		return new URL(page.url()).pathname.split("/").pop();
	};

	// A. broken stream
	await fake("/__prove/reset");
	let failSet, idA, errored, uiText, retryShown, composerState, errShape;
	try {
		failSet = await fake("/__prove/fail?mode=broken-stream");
		idA = await newSession(`zz-prove-it ${Date.now().toString(36)} broken stream probe`);
		errored = await until(() => { const r = record(idA); const last = r?.messages?.at(-1); return last?.role === "assistant" && last.stopReason === "error" ? last : null; }, 60_000);
		await new Promise((r) => setTimeout(r, 1000));
		await page.screenshot({ path: path.join(OUT, "A1-broken-stream.png") });
		uiText = await page.evaluate(() => document.body.innerText);
		retryShown = Boolean(await page.$('[data-testid="retry-failed-turn"]')); // before the follow-up clears the banner
		composerState = await page.evaluate((sel) => { const el = document.querySelector(sel); return el ? { present: true, editable: el.isContentEditable, ariaDisabled: el.getAttribute("aria-disabled") } : { present: false }; }, composer);
		errShape = shape(record(idA)?.messages ?? []);
	} finally {
		// However the probe ends, later probes and later scripts get a working model.
		await fake("/__prove/fail?mode=none");
	}
	// recover: switch the failure off, send a follow-up from the same composer
	await fake("/__prove/fail?mode=none");
	await fake("/__prove/reset");
	await page.click(composer);
	await page.keyboard.type("zz-prove-it follow-up after the failure");
	await page.keyboard.press("Enter");
	const recovered = await until(() => { const m = record(idA)?.messages ?? []; return m.length > errShape.length && m.some((x) => x.role === "user" && JSON.stringify(x.content).includes("follow-up after the failure")) && m.at(-1)?.role !== "user" ? m : null; }, 60_000);
	await page.waitForSelector('[data-testid="question-dock"]', { timeout: 60_000 }).catch(() => null);
	await page.screenshot({ path: path.join(OUT, "A2-recovered.png") });
	res.probes.brokenStream = {
		failSwitch: failSet,
		recordedError: Boolean(errored),
		errorMessage: errored?.errorMessage?.slice(0, 160) ?? null,
		shapeAfterFailure: errShape,
		uiShowsError: /Something went wrong/.test(uiText) && retryShown,
		uiErrorSnippet: (uiText.match(/.{0,60}(error|failed|went wrong|retry).{0,60}/i)?.[0] ?? null),
		composerAfterFailure: composerState,
		followUpAccepted: Boolean(recovered),
		shapeAfterFollowUp: shape(record(idA)?.messages ?? []),
		questionCardAfterFollowUp: Boolean(await page.$('[data-testid="question-dock"]')),
	};
	save();

	// B. Enter twice on Submit answer
	await fake("/__prove/fail?mode=none");
	await fake("/__prove/reset");
	const idB = await newSession(`zz-prove-it ${Date.now().toString(36)} double submit probe`);
	await page.waitForFunction(() => document.querySelector('[data-testid="question-dock"]')?.textContent?.includes("zz-prove-it: which colour"), { timeout: 60_000 });
	for (const r of await page.$$('[data-testid="question-dock"] [role="radio"]')) if ((await r.evaluate((e) => e.textContent.trim())) === "Blue") await r.click();
	await page.focus('[data-testid="question-dock"] form button[type="submit"]');
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => document.body.innerText.includes("zz-prove-it acknowledged your answer"), { timeout: 60_000 });
	await new Promise((r) => setTimeout(r, 3000));
	await page.screenshot({ path: path.join(OUT, "B1-double-submit.png") });
	const msgsB = record(idB)?.messages ?? [];
	// Only tool results are answers (the fake model's acknowledgement echoes the answer JSON).
	const quizAnswers = msgsB.filter((m) => m.role === "toolResult" && JSON.stringify(m.content ?? "").includes("quiz")).length;
	const ackShown = await page.evaluate(() => (document.body.innerText.match(/zz-prove-it acknowledged your answer/g) ?? []).length);
	res.probes.doubleSubmit = { storedShape: shape(msgsB), quizAnswerMessages: quizAnswers, acknowledgementsShown: ackShown, questionCardClosed: !(await page.$('[data-testid="question-dock"]')) };
	save();

	// C. Retry after a failed turn: the button must resend, not just be there.
	// Once by mouse, once from the keyboard (focus it, Enter). A retried turn
	// counts only once the turn has settled: its POST acknowledged, the
	// session's GET stream finished ([DONE]) and the server no longer busy, the
	// scenario's question card up, Retry gone, and the record ending on the
	// question, not an error.
	const retryCase = async (how) => {
		await fake("/__prove/reset");
		let id, button = null, shapeBefore = [];
		try {
			await fake("/__prove/fail?mode=http500");
			id = await newSession(`zz-prove-it ${Date.now().toString(36)} retry probe (${how})`);
			await until(() => { const last = record(id)?.messages?.at(-1); return last?.role === "assistant" && last.stopReason === "error" ? last : null; }, 60_000);
			button = await page.waitForSelector('[data-testid="retry-failed-turn"]', { timeout: 30_000 }).catch(() => null);
			shapeBefore = shape(record(id)?.messages ?? []);
		} finally {
			await fake("/__prove/fail?mode=none");
		}
		await fake("/__prove/reset");
		// The POST only acknowledges the turn; its events come on the session's
		// GET stream (/api/chats/<id>/stream), which ends with [DONE] when the
		// turn settles. Count both, and ask the server whether the turn still runs.
		// The client cancels its reader once it reads [DONE], so a stream that
		// settled shows as finished or as aborted by the client; one whose
		// [DONE] never comes stays pending.
		const posts = { started: 0, finished: 0 };
		const streams = { started: 0, finished: 0, aborted: 0 };
		const kind = (r) => { const u = new URL(r.url()); if (u.origin !== APP) return null; if (u.pathname === "/api/chat" && r.method() === "POST") return posts; if (u.pathname === `/api/chats/${id}/stream` && r.method() === "GET") return streams; return null; };
		const onStart = (r) => { const k = kind(r); if (k) k.started++; };
		const onDone = (r) => { const k = kind(r); if (k) k.finished++; };
		const onFail = (r) => { const k = kind(r); if (k === streams) k.aborted++; };
		const busy = async () => (await (await fetch(`${APP}/api/chats`)).json()).chats.find((c) => c.id === id)?.busy;
		page.on("request", onStart);
		page.on("requestfinished", onDone);
		page.on("requestfailed", onFail);
		const pressedAt = Date.now();
		if (button && how === "click") await button.click();
		if (button && how === "keyboard") { await button.focus(); await page.keyboard.press("Enter"); }
		const dockShown = await page.waitForFunction(() => document.querySelector('[data-testid="question-dock"]')?.textContent?.includes("zz-prove-it: which colour"), { timeout: 60_000 }).then(() => true, () => false);
		const dockMs = dockShown ? Date.now() - pressedAt : null;
		const postAcked = Boolean(await until(() => posts.finished >= 1, 30_000));
		// Settled: the server no longer marks the session busy (the turn ended),
		// and the turn's GET stream has ended on the client (it read [DONE]).
		const settled = await until(async () => streams.finished + streams.aborted >= 1 && (await busy()) === false, 60_000);
		const settleMs = settled ? Date.now() - pressedAt : null;
		const finished = await until(() => { const last = record(id)?.messages?.at(-1); return last?.role === "assistant" && last.stopReason !== "error" && (last.content ?? []).some((c) => c.type === "toolCall" && c.name === "probe") ? last : null; }, 30_000);
		const bannerGone = !(await page.$('[data-testid="retry-failed-turn"]'));
		page.off("request", onStart);
		page.off("requestfinished", onDone);
		page.off("requestfailed", onFail);
		await page.screenshot({ path: path.join(OUT, `C-retry-${how}.png`) });
		return { id, how, buttonShown: Boolean(button), posts, streams, postAcked, dockShown, dockMs, settled: Boolean(settled), settleMs, turnFinished: Boolean(finished), bannerGone, shapeBeforeRetry: shapeBefore, shapeAfterRetry: shape(record(id)?.messages ?? []) };
	};
	res.probes.retry = [await retryCase("click"), await retryCase("keyboard")];
	save();
	// leave no sessions behind on the instance
	for (const id of [idA, idB, ...res.probes.retry.map((r) => r.id)]) if (id) await fetch(`${APP}/api/chats/${id}?mode=preserve-graph`, { method: "DELETE", headers: { origin: APP } });
	res.cleanup = { remaining: (await (await fetch(`${APP}/api/chats`)).json()).chats.length };
	const a = res.probes.brokenStream, b = res.probes.doubleSubmit, c = res.probes.retry;
	res.steps.push(
		{ name: "broken stream: the turn ends with a recorded error", ok: a.recordedError, note: a.errorMessage },
		{ name: "broken stream: the UI says so and the composer stays usable", ok: a.uiShowsError && a.composerAfterFailure.present && a.composerAfterFailure.editable, note: a.uiErrorSnippet },
		{ name: "broken stream: a follow-up turn works", ok: a.followUpAccepted, note: a.shapeAfterFollowUp.join(" ") },
		{ name: "Enter twice on Submit answer: one answer stored and shown", ok: b.quizAnswerMessages === 1 && b.acknowledgementsShown === 1 && b.questionCardClosed, note: JSON.stringify(b) },
		...c.map((r) => ({ name: `Retry (${r.how}) after a failed turn resends it: one POST, the turn's stream settles, the question card, Retry gone`, ok: r.buttonShown && r.posts.started === 1 && r.postAcked && r.settled && r.dockShown && r.turnFinished && r.bannerGone, note: JSON.stringify({ ...r, id: undefined }) })),
	);
	res.observations = { brokenStream: [a.shapeAfterFailure.join(" "), a.shapeAfterFollowUp.join(" "), `uiShowsError ${a.uiShowsError}`], doubleSubmit: [b.storedShape.join(" "), `answers ${b.quizAnswerMessages}`, `acks ${b.acknowledgementsShown}`], retry: c.flatMap((r) => [`${r.how}: ${r.shapeBeforeRetry.join(" ")} -> ${r.shapeAfterRetry.join(" ")}`, `${r.how}: posts ${r.posts.started}, settled ${r.settled}, question card ${r.dockShown}, finished ${r.turnFinished}, banner gone ${r.bannerGone}`]) };
} catch (e) {
	code = 1;
	res.error = String(e?.stack ?? e).slice(0, 800);
	res.steps.push({ name: "probes", ok: false, note: res.error });
} finally {
	// A probe that threw mid-failure must not leave the fake model failing for the next script.
	await fake("/__prove/fail?mode=none").catch(() => null);
	save();
	await browser.close();
	fs.rmSync(chromePid, { force: true });
}
for (const st of res.steps) console.log(`[${st.ok ? "ok" : "FAIL"}] ${st.name}${st.note ? `: ${String(st.note).slice(0, 200)}` : ""}`);
console.log(`result: ${path.join(OUT, "result.json")}`);
process.exit(code || res.steps.some((st) => !st.ok) ? 1 : 0);

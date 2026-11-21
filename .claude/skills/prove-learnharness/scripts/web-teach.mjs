#!/usr/bin/env node
/**
 * web-teach.mjs <instance.env> [--keep]
 *
 * Drives the main flow in Chrome like a user, against one instance started by
 * start.sh with scenarios/teach-read.json:
 *   1. /chat/new, type a goal, Enter            -> a session is created
 *   2. the fake prober calls `read` on both fixtures, then `probe`
 *                                               -> each tool result equals its file
 *                                               -> the question card shows,
 *                                                  with no layout shift from the dock
 *   3. pick "Blue", submit                      -> the answer reaches the model,
 *                                                  its reply shows
 *   4. reload the session                       -> transcript persists
 *   5. delete the session (reverse action)      -> gone from list and disk
 *   6. three sessions, a turn on the first      -> the sidebar orders them by
 *                                                  last activity, then they go
 *       (5 and 6 skipped with --keep)
 * Budgets measured on every page it drives: console errors, CLS, axe.
 *
 * With CDP_URL in the instance file (electron.sh writes one), it attaches to
 * that running Electron window instead of launching Chrome, and seeds the
 * fake model from inside the page when SEED_IN_PAGE=1 (the packaged app's
 * API only answers its own window). In a desktop window it also records the
 * bridge's platform and the window-control gutter (`observations.desktop`).
 *
 * Writes <side dir>/web-teach/result.json and screenshots. `observations` in
 * the result is what compare.mjs diffs between base and head; `budgets` is
 * checked against budgets.json. Exit 0 = the script ran to the end (not a
 * verdict); exit 1 = a step could not be done (evidence says which).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const instPath = process.argv[2];
const keep = process.argv.includes("--keep");
if (!instPath) { console.error("usage: web-teach.mjs <instance.env> [--keep]"); process.exit(2); }
const inst = Object.fromEntries(fs.readFileSync(instPath, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
	const i = l.indexOf("=");
	return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
}));
const SIDE_DIR = path.dirname(instPath);
const OUT = path.join(SIDE_DIR, "web-teach");
fs.mkdirSync(OUT, { recursive: true });
import { signIn, signInPage } from "./sign-in.mjs";
signIn(inst);
const APP = inst.APP_URL;
const REPO = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(REPO, "package.json"));
const puppeteer = require("puppeteer-core");
const chrome = process.env.PROVE_CHROME || "/usr/bin/google-chrome";
const turnMs = Number(process.env.TURN_TIMEOUT_S || 60) * 1000;
const axePath = path.join(REPO, ".prove-it/tools/node_modules/axe-core/axe.min.js");
const axeSource = fs.existsSync(axePath) ? fs.readFileSync(axePath, "utf8") : null;

// A unique goal per drive, so leftovers from an earlier drive never match.
const GOAL = `zz-prove-it ${Date.now().toString(36)} why is the sky blue`;
const steps = [];
const result = { side: inst.SIDE, app: APP, build: inst.BUILD_STAMP, startedAt: new Date().toISOString(), steps, observations: {}, budgets: { consoleErrors: [], cls: {}, axe: {} }, evidence: {} };
const save = () => fs.writeFileSync(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
const step = (name, ok, detail) => { steps.push({ name, ok, ...detail }); save(); console.log(`[${ok ? "ok" : "FAIL"}] ${name}${detail?.note ? `: ${detail.note}` : ""}`); };
const normalizePath = (p) => p.replace(/chat_[a-z0-9]+_[a-f0-9]+/g, "<chat>").replace(/\/[0-9a-f]{16,}/g, "/<id>");

const attached = Boolean(inst.CDP_URL);
const browser = attached
	? await puppeteer.connect({ browserURL: inst.CDP_URL, defaultViewport: null })
	: await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(SIDE_DIR, "chrome-profile")}`] });
// Puppeteer starts Chrome detached (its own process group): a pid file lets
// stop.sh end it if this script dies before closing it.
const chromePid = attached ? null : path.join(SIDE_DIR, "chrome-web-teach.pid");
if (chromePid) fs.writeFileSync(chromePid, String(browser.process().pid));
let exitCode = 0;
let cdp = null;
try {
	let page;
	if (attached) {
		const deadline = Date.now() + 30_000;
		while (!page && Date.now() < deadline) {
			page = (await browser.pages()).find((p) => p.url().startsWith(APP));
			if (!page) await new Promise((r) => setTimeout(r, 500));
		}
		if (!page) throw new Error(`no Electron window showing ${APP}; pages: ${(await browser.pages()).map((p) => p.url()).join(", ")}`);
		result.window = { bridge: await page.evaluate(() => typeof window.lh), title: await page.title() };
		step("Electron window shows the app with the desktop bridge", result.window.bridge === "object", { note: JSON.stringify(result.window) });
		// The dev window opened on the head server's sign-in page: give it the
		// head session cookie, so every page the drive opens next is signed in.
		await signInPage(page, inst);
		if (inst.SEED_IN_PAGE === "1") {
			const seeded = await page.evaluate(async (fake) => {
				const r1 = await fetch("/api/custom-provider");
				const r2 = await fetch("/api/custom-provider", { method: "POST", headers: { "content-type": "application/json", "if-match": r1.headers.get("etag") }, body: JSON.stringify({ baseUrl: fake, authMode: "keyless" }) });
				const slot = (id) => ({ model: { provider: "custom", id } });
				const r3 = await fetch("/api/settings/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ strong: slot("prove-strong"), cheap: slot("prove-cheap"), vision: slot("prove-vision") }) });
				return [r1.status, r2.status, r3.status];
			}, inst.FAKE_URL);
			step("fake model seeded from inside the window", seeded.every((x) => x === 200), { note: JSON.stringify(seeded) });
		}
	} else {
		page = await browser.newPage();
		await signInPage(page, inst);
		await page.setViewport({ width: 1280, height: 900 });
	}
	await page.evaluateOnNewDocument(() => {
		window.__proveCLS = 0;
		window.__proveDockShifts = [];
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) {
				if (e.hadRecentInput) continue;
				window.__proveCLS += e.value;
				// The dock's frame (overlay, gradient, shell) must never be a shift
				// source; the stats row's live counters inside it are not the dock.
				const inDock = (node) => {
					const el = node?.nodeType === 1 ? node : node?.parentElement;
					return Boolean(el?.closest('[data-testid="dock-overlay"]') && !el.closest('[data-testid="stats-bar"]'));
				};
				if (e.sources.some((src) => inDock(src.node))) window.__proveDockShifts.push(Number(e.value.toFixed(4)));
			}
		}).observe({ type: "layout-shift", buffered: true });
	});
	const http = [];
	page.on("console", (m) => { if (m.type() === "error") result.budgets.consoleErrors.push({ page: normalizePath(new URL(page.url() || APP).pathname), text: m.text().slice(0, 300), url: m.location()?.url ?? null }); });
	page.on("pageerror", (e) => result.budgets.consoleErrors.push({ page: normalizePath(new URL(page.url() || APP).pathname), text: `uncaught: ${e.message.slice(0, 300)}` }));
	page.on("response", (r) => {
		const u = new URL(r.url());
		if (u.origin === APP && u.pathname.startsWith("/api/") && !u.pathname.startsWith("/api/events")) http.push(`${r.request().method()} ${normalizePath(u.pathname)} ${r.status()}`);
	});
	const shot = async (name) => { const file = path.join(OUT, `${name}.png`); await page.screenshot({ path: file }); result.evidence[name] = file; return file; };
	const budgetsHere = async (label) => {
		await new Promise((r) => setTimeout(r, 500));
		result.budgets.cls[label] = Number((await page.evaluate(() => window.__proveCLS)).toFixed(4));
		if (axeSource) {
			await page.evaluate(axeSource);
			const axe = await page.evaluate(async () => {
				const r = await window.axe.run(document, { resultTypes: ["violations"] });
				return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
			});
			result.budgets.axe[label] = axe;
		} else {
			result.budgets.axe[label] = "axe-core not installed: run scripts/ensure-axe.sh";
		}
		save();
	};
	// In the packaged app only the window may call the API, so ask through it.
	const chats = async () => attached
		? (await page.evaluate(async () => (await fetch("/api/chats")).json())).chats
		: (await (await fetch(`${APP}/api/chats`)).json()).chats;

	// 1. new session (fresh scenario state, and only this drive's requests count)
	await fetch(`${inst.FAKE_CONTROL}/__prove/reset`, { method: "POST" });
	const logStart = fs.existsSync(inst.MODEL_LOG) ? fs.readFileSync(inst.MODEL_LOG, "utf8").trim().split("\n").filter(Boolean).length : 0;
	const before = await chats();
	// Warm-up load: a fresh profile's first paint (cold font and asset cache)
	// reads a different CLS than every later load; measure the warm one on both sides.
	await page.goto(`${APP}/chat/new`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector('[data-testid="composer"]', { timeout: 30_000 });
	await new Promise((r) => setTimeout(r, 1000));
	if (attached) {
		// Desktop-only: the bridge's OS identity drives the native window-control
		// gutters, and browser parity can't see it. The window runs on this host.
		const desktop = await page.evaluate(() => {
			const gutter = document.querySelector(".lh-lights-gutter");
			return { platform: window.lh?.platform ?? null, htmlPlatform: document.documentElement.dataset.lhPlatform ?? null, gutterPaddingLeft: gutter ? getComputedStyle(gutter).paddingLeft : null };
		});
		result.window = { ...result.window, ...desktop, hostPlatform: process.platform };
		// Desktop-only output: compared with a base desktop window (compare.mjs --only desktop), skipped against the browser.
		result.observations.desktop = [`platform ${desktop.platform}`, `html data-lh-platform ${desktop.htmlPlatform}`, `lights gutter padding-left ${desktop.gutterPaddingLeft}`];
		step("desktop window reports this machine's platform to the page", desktop.platform === process.platform && desktop.htmlPlatform === process.platform, { note: JSON.stringify({ ...desktop, hostPlatform: process.platform }) });
	}
	await page.goto(`${APP}/chat/new`, { waitUntil: "domcontentloaded" });
	const composer = '[data-testid="composer"] [contenteditable="true"]';
	await page.waitForSelector(composer, { timeout: 30_000 });
	await budgetsHere("/chat/new");
	await shot("01-new-session");
	await page.click(composer);
	await page.keyboard.type(GOAL);
	// 4x CPU while the question arrives: unthrottled, headless Chrome scores the
	// dock's composer-to-question height morph on some runs and not others.
	cdp = await page.createCDPSession();
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
	// Shifts within 500 ms of input are marked hadRecentInput and never reach
	// the dock check, so note when Enter goes in and when the question dock
	// mounts (the scenario holds the question back for 1.5 s).
	await page.evaluate(() => {
		window.__proveDockShifts = [];
		window.__proveEnterAt = performance.now();
		window.__proveDockAt = null;
		const seen = new MutationObserver(() => {
			if (!document.querySelector('[data-testid="question-dock"]')) return;
			window.__proveDockAt = performance.now();
			seen.disconnect();
		});
		seen.observe(document.body, { childList: true, subtree: true });
	});
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => /\/chat\/chat_/.test(location.pathname), { timeout: turnMs });
	const chatId = new URL(page.url()).pathname.split("/").pop();
	const after = await chats();
	step("goal submitted creates a session", after.length === before.length + 1 && after.some((c) => c.id === chatId), { note: `sessions ${before.length} -> ${after.length}, url ${normalizePath(new URL(page.url()).pathname)}` });

	// 2. read tool, then the graded question
	await page.waitForSelector('[data-testid="question-dock"]', { timeout: turnMs });
	await page.waitForFunction(() => document.querySelector('[data-testid="question-dock"]')?.textContent?.includes("zz-prove-it: which colour"), { timeout: turnMs });
	await shot("02-question-card");
	const log = () => fs.existsSync(inst.MODEL_LOG) ? fs.readFileSync(inst.MODEL_LOG, "utf8").trim().split("\n").filter(Boolean).slice(logStart).map((l) => JSON.parse(l)) : [];
	const readResult = log().find((r) => r.rule === "probe-asks-question");
	// The scenario reads two files in one turn: the no-final-newline fixture,
	// then the main one, so the last two messages are their tool results.
	const textOf = (m) => typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
	const toolMsg = readResult?.request?.messages?.at(-1);
	const nonlMsg = readResult?.request?.messages?.at(-2);
	const toolText = textOf(toolMsg);
	const nonlText = textOf(nonlMsg);
	const fixture = fs.readFileSync(inst.FIXTURE, "utf8");
	const nonlPath = `${inst.FIXTURE}-nonl.txt`;
	const nonl = fs.existsSync(nonlPath) ? fs.readFileSync(nonlPath, "utf8") : null;
	// Exact, not "contains": a lost final newline or last line is a different file.
	step("read tool results sent back to the model are the fixture files, byte for byte", toolMsg?.role === "tool" && toolText === fixture && nonlMsg?.role === "tool" && nonl !== null && nonlText === nonl, { note: `fixture ${toolText.length}/${fixture.length} chars, no-final-newline fixture ${nonlText.length}/${nonl?.length ?? "missing"} chars` });
	result.observations.readResults = [`fixture equal ${toolText === fixture} (${toolText.length} chars)`, `no-final-newline fixture equal ${nonl !== null && nonlText === nonl} (${nonlText.length} chars)`];
	const options = await page.$$eval('[data-testid="question-dock"] [role="radio"]', (els) => els.map((e) => e.textContent.trim()));
	// The card shuffles options on purpose, so compare them as a set.
	options.sort();
	step("question card shows the scenario's options", JSON.stringify(options) === JSON.stringify(["Blue", "Red"]), { note: JSON.stringify(options) });
	await budgetsHere("/chat/<chat> (question)");
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
	const dock = await page.evaluate(() => ({ shifts: window.__proveDockShifts, afterEnterMs: window.__proveDockAt === null ? null : Math.round(window.__proveDockAt - window.__proveEnterAt) }));
	// Under 1 s, the morph could fall inside the input window: no verdict.
	const outsideInput = dock.afterEnterMs !== null && dock.afterEnterMs > 1000;
	step("no layout shift comes from the dock while the question arrives", outsideInput && dock.shifts.length === 0, { note: `question dock mounted ${dock.afterEnterMs ?? "?"} ms after Enter (needs > 1000); dock shifts ${JSON.stringify(dock.shifts)}` });

	// 3. answer it
	const radios = await page.$$('[data-testid="question-dock"] [role="radio"]');
	for (const r of radios) if ((await r.evaluate((e) => e.textContent.trim())) === "Blue") await r.click();
	await page.click('[data-testid="question-dock"] form button[type="submit"]');
	await page.waitForFunction(() => document.body.innerText.includes("zz-prove-it acknowledged your answer"), { timeout: turnMs });
	await shot("03-answered");
	const answerReq = log().find((r) => r.rule === "probe-acknowledges-answer");
	const sent = JSON.stringify(answerReq?.request?.messages?.slice(-2) ?? []);
	step("the answer reaches the model and its reply shows", Boolean(answerReq) && /blue/i.test(sent), { note: `model saw: ${sent.slice(0, 240)}` });
	await page.waitForFunction(() => !document.querySelector('[data-testid="question-dock"]'), { timeout: 10_000 }).then(() => step("question card closes after the answer", true), () => step("question card closes after the answer", false));

	// stored state
	const file = path.join(inst.DATA_DIR, "chats", `${chatId}.json`);
	const record = JSON.parse(fs.readFileSync(file, "utf8"));
	const messages = record.messages ?? [];
	const shape = messages.map((m) => `${m.role}${m.role === "assistant" ? `[${(m.content ?? []).filter((c) => c.type === "toolCall").map((c) => c.name).join(",")}]` : m.role === "toolResult" ? `(${m.toolName ?? ""})` : ""}`);
	const stored = JSON.stringify(record);
	step("stored record holds the goal, the read, the probe and the answer", stored.includes(GOAL) && stored.includes("PROVE-FIXTURE-SKY") && stored.includes("zz-prove-it: which colour") && stored.includes("acknowledged your answer"), { note: shape.join(" ") });

	// 4. reload
	await page.goto(`${APP}/chat/${chatId}`, { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => document.body.innerText.includes("zz-prove-it acknowledged your answer"), { timeout: 30_000 }).then(() => step("transcript survives a reload", true), () => step("transcript survives a reload", false));
	await budgetsHere("/chat/<chat> (reloaded)");
	await shot("04-reloaded");
	// This page's CLS flickers between two states on main (about 0.2476 or
	// 0.2654 on identical code): three loads per side, judged by compare.mjs
	// as head median vs base max (budgets.json cls.relativeRule).
	const label = "/chat/<chat> (reloaded)";
	const samples = [result.budgets.cls[label]];
	for (let i = 0; i < 2; i++) {
		await page.goto(`${APP}/chat/${chatId}`, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => document.body.innerText.includes("zz-prove-it acknowledged your answer"), { timeout: 30_000 });
		await new Promise((r) => setTimeout(r, 500));
		samples.push(Number((await page.evaluate(() => window.__proveCLS)).toFixed(4)));
	}
	result.budgets.clsSamples = { [label]: samples };
	result.budgets.cls[label] = [...samples].sort((a, b) => a - b)[1];
	save();

	result.observations = {
		...result.observations,
		modelRules: log().map((r) => r.rule),
		proberTools: (log()[0]?.request?.tools ?? []).map((t) => t.function?.name).sort(),
		storedShape: shape,
		options,
		apiCalls: [...new Set(http)].sort(),
	};
	save();

	// 5. reverse: delete the session from the sidebar (right-click, Delete,
	// confirm), from /chat/new. Deleting the session you are viewing is a
	// break-it probe of its own (SKILL.md, Try to break it), not part of this
	// flow's budget.
	if (!keep) {
		await page.goto(`${APP}/chat/new`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector('[data-testid="session-row"]', { timeout: 30_000 });
		// The row can render before it is interactive: retry the right-click.
		let menu = false;
		for (let attempt = 0; attempt < 5 && !menu; attempt++) {
			const rows = await page.$$('[data-testid="session-row"]');
			let row;
			for (const r of rows) if ((await r.evaluate((e) => e.textContent)).includes(GOAL)) row = r;
			if (!row) throw new Error("session row for the new session not found in the sidebar");
			await row.click({ button: "right" });
			menu = await page.waitForSelector('[data-testid="ctx-delete"]', { timeout: 2_000 }).then(() => true, () => false);
		}
		if (!menu) throw new Error("right-clicking the session row never opened its menu (ctx-delete)");
		await page.click('[data-testid="ctx-delete"]');
		await page.waitForSelector('[data-testid="delete-session-dialog"]', { timeout: 5_000 });
		await shot("05-delete-dialog");
		await page.click('[data-testid="delete-confirm"]');
		await page.waitForFunction(() => !document.querySelector('[data-testid="delete-session-dialog"]'), { timeout: 10_000 });
		await new Promise((r) => setTimeout(r, 500));
		const afterDelete = await chats();
		const rowGone = !(await page.$$eval('[data-testid="session-row"]', (els, goal) => els.some((e) => e.textContent.includes(goal)), GOAL));
		step("deleting the session removes it from the sidebar, the API list and disk", rowGone && !afterDelete.some((c) => c.id === chatId) && !fs.existsSync(file), { note: `sidebar row ${rowGone ? "gone" : "still there"}, sessions ${afterDelete.length}, file ${fs.existsSync(file) ? "still there" : "gone"}` });
		await shot("06-deleted");
		result.observations.deleted = { rowGone, listed: afterDelete.some((c) => c.id === chatId), fileExists: fs.existsSync(file) };
		result.observations.apiCalls = [...new Set(http)].sort();

		// 6. the sidebar's order (after apiCalls, so these calls don't count there):
		// three sessions, then a turn on the first, so ordering by last activity
		// (first, third, second) differs from ordering by creation (third, second, first).
		const api = async (method, p, body) => attached
			? page.evaluate(async (m, u, b) => { const r = await fetch(u, { method: m, headers: { "content-type": "application/json" }, body: b }); return { status: r.status, text: await r.text() }; }, method, p, body)
			: fetch(`${APP}${p}`, { method, headers: { origin: APP, "content-type": "application/json" }, body }).then(async (r) => ({ status: r.status, text: await r.text() }));
		const made = [];
		for (const label of ["first", "second", "third"]) {
			const r = await api("POST", "/api/chats", JSON.stringify({ title: `zz-prove-it sidebar ${label}` }));
			made.push({ label, id: r.status === 200 ? JSON.parse(r.text).id : null });
			await new Promise((res) => setTimeout(res, 50));
		}
		const touch = await api("POST", "/api/chat", JSON.stringify({ chatId: made[0].id, input: { type: "text", text: "sidebar order touch" } }));
		await page.goto(`${APP}/chat/new`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector('[data-testid="session-row"]', { timeout: 30_000 });
		await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="session-row"]')].filter((e) => e.textContent.includes("zz-prove-it sidebar")).length >= 3, { timeout: 10_000 }).catch(() => null);
		const sidebarOrder = await page.$$eval('[data-testid="session-row"]', (els) => els.map((e) => e.textContent.match(/zz-prove-it sidebar (first|second|third)/)?.[1]).filter(Boolean));
		await shot("07-sidebar-order");
		for (const m of made) if (m.id) await api("DELETE", `/api/chats/${m.id}?mode=preserve-graph`);
		result.observations.sidebarOrder = sidebarOrder;
		step("the sidebar lists sessions by last activity: a session with a new turn moves to the top", touch.status === 200 && JSON.stringify(sidebarOrder) === JSON.stringify(["first", "third", "second"]), { note: `turn ${touch.status}, order ${JSON.stringify(sidebarOrder)}` });
	}
} catch (error) {
	exitCode = 1;
	step("drive", false, { note: String(error?.stack ?? error).slice(0, 800) });
	try { const pages = (await browser.pages()).filter((p) => p.url().startsWith(APP)); await pages.at(-1)?.screenshot({ path: path.join(OUT, "failure.png") }); result.evidence.failure = path.join(OUT, "failure.png"); } catch { /* best effort */ }
} finally {
	await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
	result.finishedAt = new Date().toISOString();
	save();
	if (attached) await browser.disconnect(); else { await browser.close(); fs.rmSync(chromePid, { force: true }); }
}
console.log(`result: ${path.join(OUT, "result.json")}`);
process.exit(exitCode);

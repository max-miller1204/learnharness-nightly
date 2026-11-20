#!/usr/bin/env node
/**
 * drive.mjs: the CI iPhone job's driver (docs/specs/ios-simulator-ci.md).
 *
 *   node scripts/iphone-check/drive.mjs --udid <sim> --bundle <id> --origin https://127.0.0.1:<port>
 *     --instance <instance.env> --out <dir> --axe <path> --chrome <path> --metro-log <file>
 *
 * Pairs the Debug simulator app with the throwaway server through the Pair
 * screen with real taps and typing (AXe), then screenshots the Pair screen,
 * the session list, the lesson fixture and the quiz fixture (waiting, then
 * answered through the dock) in light and dark mode. The same screens are
 * shot in the web app on the same server: light against the Ivory theme,
 * dark against Default. Fails, naming the screen, when the app does not
 * open from Metro, a screen is not reached, an error or crash screen shows,
 * or a quiz choice row is not exactly one accessibility item whose label
 * speaks its math.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";

const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const arg = (name) => {
	const i = process.argv.indexOf(`--${name}`);
	if (i === -1 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
	return process.argv[i + 1];
};
const UDID = arg("udid");
const BUNDLE = arg("bundle");
const ORIGIN = arg("origin");
const OUT = path.resolve(arg("out"));
const AXE = arg("axe");
const CHROME = arg("chrome");
const METRO_LOG = arg("metro-log");
const inst = Object.fromEntries(readFileSync(arg("instance"), "utf8").split("\n").filter((line) => line.includes("="))
	.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "")]));

const LESSON = { id: "chat_zzmobilelesson", title: "Sets and unions" };
const QUIZ = { id: "chat_zzmobilequiz", title: "Splits and gradient steps" };
// The pending question's choices (tests/fixtures/mobile-quiz), each matched
// by its spoken label. A label may never show `$` or `\`.
const CHOICES = [
	{ label: "Train: $4$; test: $8$", spoken: /train\D*4\D*test\D*8/i, answer: true },
	{ label: "$(+0.20, -0.10)$", spoken: /0\.20?\D+0\.10?(?!\d)/, answer: true },
	{ label: "$(-0.10, +0.20)$", spoken: /0\.10?\D+0\.20?(?!\d)/ },
	{ label: "None of these", spoken: /^None of these$/ },
];
const MODES = [
	{ mode: "light", webTheme: "ivory" },
	{ mode: "dark", webTheme: "default" },
];

mkdirSync(path.join(OUT, "iphone"), { recursive: true });
mkdirSync(path.join(OUT, "web"), { recursive: true });
const shots = []; // { screen, mode, side, file }
const log = (line) => console.log(`[iphone] ${line}`);
class Failure extends Error {}
const fail = (screen, message) => { throw new Failure(`${screen}: ${message}`); };

// ── the simulator ────────────────────────────────────────────────────────────

// T3 Code's showcase sets this too (scripts/mobile-showcase.ts:1007-1011): HID
// input sent right after the simulator settles is otherwise dropped. AXe caps it at 1 s.
const axe = (args) => run(AXE, [...args, "--udid", UDID], { maxBuffer: 64 << 20, env: { ...process.env, AXE_HID_STABILIZATION_MS: "1000" } });
const simctl = (...args) => run("xcrun", ["simctl", ...args], { maxBuffer: 64 << 20 });

function flatten(nodes, out = []) {
	for (const node of nodes ?? []) {
		out.push(node);
		flatten(node.children, out);
	}
	return out;
}
const label = (el) => String(el.AXLabel ?? "").trim();
const frame = (el) => el.frame ?? { x: 0, y: 0, width: 0, height: 0 };
const center = (el) => ({ x: Math.round(frame(el).x + frame(el).width / 2), y: Math.round(frame(el).y + frame(el).height / 2) });
// React Native on iOS announces a radio or checkbox role in the value
// ("radio button, unchecked"), since UIKit has no such trait.
const isChoice = (el) => /radio|check ?box/i.test(`${el.AXValue ?? ""} ${el.role_description ?? ""} ${el.type ?? ""} ${el.role ?? ""}`);

let screenSize = { width: 402, height: 874 };
async function describe() {
	const { stdout } = await axe(["describe-ui"]);
	const tree = JSON.parse(stdout);
	const roots = Array.isArray(tree) ? tree : [tree];
	if (roots[0]?.frame?.width) screenSize = { width: roots[0].frame.width, height: roots[0].frame.height };
	return flatten(roots);
}

// React Native's LogBox: an error or crash screen, or a toast. A warnings
// toast is closed so it stays out of the pictures; anything else fails.
const CRASH = /Render Error|Uncaught Error|Unhandled JS Exception|Syntax Error|No script URL provided|Could not connect to development server|Open debugger to view errors|There was a problem loading the project/i;
const APP_ERROR = /Couldn['’]t |Something went wrong|^Retry( connection| reply| question)?$|^Reconnect$|This session was deleted/;
async function settled(screen) {
	for (let attempt = 0; attempt < 4; attempt++) {
		const elements = await describe();
		const crash = elements.find((el) => CRASH.test(label(el)));
		if (crash) fail(screen, `error screen: "${label(crash).slice(0, 200)}"`);
		const appError = elements.find((el) => APP_ERROR.test(label(el)));
		if (appError) fail(screen, `the app shows an error: "${label(appError).slice(0, 200)}"`);
		const toast = elements.find((el) => /Open debugger to view warnings/i.test(label(el)));
		if (!toast) return elements;
		const f = frame(toast);
		log(`closing the LogBox warnings toast on ${screen}`);
		await axe(["tap", "-x", String(Math.round(f.x + f.width - 22)), "-y", String(Math.round(f.y + f.height / 2))]);
		await sleep(800);
	}
	fail(screen, "the LogBox warnings toast would not close");
}

async function waitFor(screen, test, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	let elements = [];
	while (Date.now() < deadline) {
		elements = await settled(screen);
		if (test(elements)) return elements;
		await sleep(1000);
	}
	const seen = elements.filter(label).slice(0, 60).map((el) => `${label(el)} [${[el.type, el.role_description, el.AXValue].filter(Boolean).join("/")}]`).join(" | ");
	fail(screen, `not reached within ${timeoutMs / 1000}s. On screen: ${seen}`);
}
const has = (text) => (elements) => elements.some((el) => label(el) === text);
const hasMatch = (pattern) => (elements) => elements.some((el) => pattern.test(label(el)));

async function tap(screen, find) {
	const elements = await settled(screen);
	const target = elements.find(find);
	if (!target) fail(screen, "the control to tap is missing");
	const { x, y } = center(target);
	// A real touch down and up, as a finger sends.
	await axe(["tap", "-x", String(x), "-y", String(y), "--tap-style", "physical"]);
	await sleep(700);
}

/** Does a tap reach the app? Open the session's options menu and close it again. */
async function tapsReachApp(screen) {
	await tap(screen, (el) => label(el) === "Session options");
	await sleep(800);
	if (!has("Close menu")(await settled(screen))) return false;
	await tap(screen, (el) => label(el) === "Close menu");
	return true;
}

/** After the Pair screen's secure field, iOS offers to save the password in a
 * system sheet that AXe's tree does not list and that takes every touch. A real
 * user answers it once; this answers Not Now (where it sits on an iPhone 17). */
async function dismissSavePassword(screen) {
	await sleep(6000);
	if (await tapsReachApp(screen)) return;
	log("a system sheet takes the taps (iOS's Save Password? offer); answering Not Now");
	await axe(["tap", "--label", "Not Now"]).catch(() => axe(["tap", "-x", String(Math.round(screenSize.width * 0.315)),
		"-y", String(Math.round(screenSize.height * 0.626)), "--tap-style", "physical"]));
	await sleep(1500);
	if (!(await tapsReachApp(screen))) fail(screen, "a system sheet over the app takes every tap and Not Now did not close it");
}

/** Type into a text field a few keys at a time, and check what landed: with
 * the on-screen keyboard up, keys typed in one burst can be dropped. A secure
 * field shows one dot per character. */
async function typeInto(screen, name, text) {
	const field = (el) => label(el) === name && /text ?field/i.test(`${el.type ?? ""} ${el.role_description ?? ""} ${el.role ?? ""}`);
	let shown = "";
	for (let attempt = 1; attempt <= 3; attempt++) {
		await tap(screen, field);
		if (attempt > 1) {
			await axe(["key-combo", "--modifiers", "227", "--key", "4"]);
			await axe(["key", "42"]);
		}
		for (let i = 0; i < text.length; i += 4) {
			await axe(["type", text.slice(i, i + 4)]);
			await sleep(250);
		}
		const target = (await settled(screen)).find(field);
		shown = String(target?.AXValue ?? "");
		const secure = /secure/i.test(`${target?.type ?? ""} ${target?.role_description ?? ""}`);
		if (secure ? [...shown].length === text.length : shown === text) return;
		log(`${name} shows ${secure ? `${[...shown].length} characters` : JSON.stringify(shown)} after typing; typing it again`);
	}
	fail(screen, `could not type into ${name}: it shows ${JSON.stringify(shown)}`);
}

async function phoneShot(screen, mode, page) {
	const file = path.join(OUT, "iphone", `${screen}-${mode}${page ? `-${page}` : ""}.png`);
	await simctl("io", UDID, "screenshot", file);
	shots.push({ screen, mode, side: "iphone", file });
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function setPhoneMode(mode) {
	await simctl("ui", UDID, "appearance", mode);
	await sleep(1500);
}

/** Screenshot a session: from the top of the transcript down, a page at a time. */
async function phonePages(screen, mode, marker, { dock = false } = {}) {
	await waitFor(screen, marker);
	const x = Math.round(screenSize.width / 2);
	// The transcript sits between the top bar and the dock or composer.
	const top = Math.round(screenSize.height * 0.16);
	const bottom = Math.round(screenSize.height * (dock ? 0.4 : 0.75));
	for (let i = 0; i < 12; i++) await axe(["swipe", "--start-x", String(x), "--start-y", String(top), "--end-x", String(x), "--end-y", String(bottom)]);
	await sleep(1200);
	let previous = "";
	for (let page = 1; page <= 10; page++) {
		await settled(screen);
		const hash = await phoneShot(screen, mode, page);
		if (hash === previous) {
			shots.pop();
			break;
		}
		previous = hash;
		await axe(["drag", "--start-x", String(x), "--start-y", String(bottom), "--end-x", String(x), "--end-y", String(top)]);
		await sleep(900);
	}
}

/** Goal 4: each choice is one accessibility item that speaks its math. The
 * speech engine loads after the first render, so this waits up to 20 s for
 * the rows to settle before it fails. */
async function checkChoiceRows(screen, ready) {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const elements = await waitFor(screen, ready);
		const { rows, problems } = rowProblems(elements);
		if (!problems.length) {
			log(`${screen}: ${rows.length} choice rows, one item each: ${rows.map((row) => JSON.stringify(label(row))).join(", ")}`);
			return rows;
		}
		if (Date.now() > deadline) fail(screen, `quiz choice rows:\n  - ${problems.join("\n  - ")}`);
		await sleep(1500);
	}
}

function rowProblems(elements) {
	const rows = elements.filter(isChoice);
	const problems = [];
	if (rows.length !== CHOICES.length) {
		problems.push(`expected ${CHOICES.length} choice rows, found ${rows.length}: ${rows.map((row) => JSON.stringify(label(row))).join(", ")}`);
	}
	for (const row of rows) {
		if (!label(row)) problems.push("a choice row has no label");
		if (/[$\\]/.test(label(row))) problems.push(`row "${label(row)}" shows $ or \\ instead of spoken math`);
		const f = frame(row);
		const inside = elements.filter((el) => el !== row && !el.children?.length && label(el) && (() => {
			const c = center(el);
			return c.x > f.x && c.x < f.x + f.width && c.y > f.y && c.y < f.y + f.height;
		})());
		if (inside.length) problems.push(`row "${label(row)}" is split: ${inside.map((el) => JSON.stringify(label(el))).join(", ")} is a separate item inside it`);
	}
	for (const choice of CHOICES) {
		const matches = rows.filter((row) => choice.spoken.test(label(row)));
		if (matches.length !== 1) problems.push(`choice ${JSON.stringify(choice.label)} matches ${matches.length} rows, expected exactly 1`);
	}
	return { rows, problems };
}

// ── the web app on the same server ───────────────────────────────────────────

const api = (route, init = {}) => fetch(`${inst.APP_URL}${route}`, {
	...init,
	headers: { authorization: `Bearer ${inst.APP_TOKEN}`, origin: inst.APP_URL, "content-type": "application/json", ...init.headers },
});

async function setWebTheme(theme) {
	const response = await api("/api/settings/appearance", { method: "PUT", body: JSON.stringify({ theme }) });
	if (!response.ok) fail("web", `PUT /api/settings/appearance ${theme}: ${response.status} ${await response.text()}`);
}

async function webShots(browser, screens) {
	for (const { mode, webTheme } of MODES) {
		await setWebTheme(webTheme);
		for (const { screen, route, text, signedOut } of screens) {
			const context = await browser.createBrowserContext();
			try {
				const page = await context.newPage();
				await page.setViewport({ width: 1280, height: 860 });
				if (!signedOut) await page.setCookie({ name: `lh_session_${inst.APP_PORT}`, value: inst.APP_TOKEN, url: inst.APP_URL, httpOnly: true, sameSite: "Lax" });
				await page.goto(`${inst.APP_URL}${route}`, { waitUntil: "domcontentloaded" });
				try {
					await page.waitForFunction((want) => document.body?.innerText.includes(want), { timeout: 30_000 }, text);
				} catch {
					fail(`web ${screen}`, `"${text}" never showed`);
				}
				await sleep(2000);
				// The tallest scrolling element holds the transcript; shoot it a page at a time.
				const pages = await page.evaluate(() => {
					const scrollers = [...document.querySelectorAll("*")].filter((el) => el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY));
					scrollers.sort((a, b) => b.clientHeight - a.clientHeight);
					const main = scrollers[0];
					if (!main) return 1;
					main.setAttribute("data-iphone-check-scroller", "");
					main.scrollTop = 0;
					return Math.min(10, Math.ceil(main.scrollHeight / (main.clientHeight * 0.85)));
				});
				for (let n = 1; n <= pages; n++) {
					if (n > 1) {
						await page.evaluate(() => {
							const main = document.querySelector("[data-iphone-check-scroller]");
							main.scrollTop += main.clientHeight * 0.85;
						});
						await sleep(500);
					}
					const file = path.join(OUT, "web", `${screen}-${mode}${pages > 1 ? `-${n}` : ""}.png`);
					await page.screenshot({ path: file });
					shots.push({ screen, mode, side: "web", file });
				}
			} finally {
				await context.close();
			}
		}
	}
}

// ── side by side ─────────────────────────────────────────────────────────────

const SCREENS = ["pair", "sessions", "lesson", "quiz-waiting", "quiz-answered"];
async function sideBySide(browser) {
	mkdirSync(path.join(OUT, "pairs"), { recursive: true });
	const rows = [];
	for (const screen of SCREENS) {
		for (const { mode } of MODES) {
			const phone = shots.filter((s) => s.screen === screen && s.mode === mode && s.side === "iphone");
			const web = shots.filter((s) => s.screen === screen && s.mode === mode && s.side === "web");
			if (!phone.length || !web.length) continue;
			const img = (s, height) => `<img style="height:${height}px;border:1px solid #888" src="data:image/png;base64,${readFileSync(s.file).toString("base64")}">`;
			const html = `<body style="margin:0;padding:16px;background:#777;font:14px sans-serif;display:flex;gap:24px;align-items:flex-start">
				<div><b>iPhone, ${mode}</b><div style="display:flex;gap:8px;flex-wrap:wrap;max-width:1700px">${phone.map((s) => img(s, 760)).join("")}</div></div>
				<div><b>Web, ${mode === "light" ? "Ivory" : "Default"}</b><div style="display:flex;flex-direction:column;gap:8px">${web.map((s) => img(s, 360)).join("")}</div></div></body>`;
			const page = await browser.newPage();
			await page.setViewport({ width: 2600, height: 800 });
			await page.setContent(html, { waitUntil: "load" });
			const file = path.join(OUT, "pairs", `${screen}-${mode}.png`);
			await page.screenshot({ path: file, fullPage: true });
			await page.close();
			rows.push({ screen, mode, pair: file, phone, web });
		}
	}
	const rel = (file) => path.relative(OUT, file);
	const summary = ["## iPhone and web screenshots", "", "Download the `iphone-screenshots` artifact. Each `pairs/` picture puts the iPhone pages beside the web pages of the same screen.", "",
		"| Screen | Mode | Side by side | iPhone | Web |", "| --- | --- | --- | --- | --- |",
		...rows.map((r) => `| ${r.screen} | ${r.mode} | \`${rel(r.pair)}\` | ${r.phone.map((s) => `\`${rel(s.file)}\``).join("<br>")} | ${r.web.map((s) => `\`${rel(s.file)}\``).join("<br>")} |`)];
	writeFileSync(path.join(OUT, "summary.md"), summary.join("\n") + "\n");
	const missing = SCREENS.flatMap((screen) => MODES.filter(({ mode }) => !rows.some((r) => r.screen === screen && r.mode === mode)).map(({ mode }) => `${screen} ${mode}`));
	if (missing.length) fail("artifact", `no iPhone and web pair for ${missing.join(", ")}`);
}

// ── the drive ────────────────────────────────────────────────────────────────

// Chrome runs only while the web is shot, never beside the simulator drive.
async function withBrowser(work) {
	const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
	try {
		return await work(browser);
	} finally {
		await browser.close();
	}
}

async function main() {
	await withBrowser((browser) => webShots(browser, [
		{ screen: "pair", route: "/pair", text: "Pair", signedOut: true },
		{ screen: "sessions", route: "/", text: QUIZ.title },
		{ screen: "lesson", route: `/chat/${LESSON.id}`, text: LESSON.title },
		{ screen: "quiz-waiting", route: `/chat/${QUIZ.id}`, text: "None of these" },
	]));
	await phone();
	await withBrowser(async (browser) => {
		await webShots(browser, [{ screen: "quiz-answered", route: `/chat/${QUIZ.id}`, text: "The first pair fits" }]);
		await sideBySide(browser);
	});
}

async function readable() {
	for (let boot = 0; ; boot++) {
		const start = Date.now();
		for (let attempt = 1; Date.now() - start < 120_000; attempt++) {
			try {
				await axe(["displays"]);
				await describe();
				return;
			} catch (error) {
				const why = String(error.stderr || error.message).trim().split("\n")[0];
				log(`accessibility read ${attempt} after boot ${boot} failed at ${Math.round((Date.now() - start) / 1000)}s: ${why}`);
				if (boot === 2 && Date.now() - start >= 115_000) fail("simulator", `the accessibility tree never became readable: ${why}`);
				await sleep(5000);
			}
		}
		if (boot === 2) fail("simulator", "the accessibility tree never became readable");
		// Setup, not a retry of the check: this happens only before the first screen read.
		console.log(`::notice title=iPhone simulator reboot::AXe could not read the simulator's screen for 2 minutes; rebooting it (${boot + 1} of 2) before the drive starts.`);
		await simctl("shutdown", UDID);
		await simctl("boot", UDID);
		await simctl("bootstatus", UDID, "-b");
		await simctl("status_bar", UDID, "override", "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100", "--wifiBars", "3", "--cellularBars", "4");
	}
}

async function phone() {
	// The first reads after boot can overrun AXe's short deadlines while its
	// frameworks load cold, and one try can take minutes on a CI Mac; a later
	// read works. A simulator whose screens never settle stays unreadable
	// until it reboots (AXe's AccessibilityFetcher says so), so after two
	// minutes it reboots, at most twice. AXe asks for a displays read first.
	await readable();
	log(`AXe reads the screen (${screenSize.width}x${screenSize.height} pt)`);
	await setPhoneMode("light");
	const bundled = () => (readFileSync(METRO_LOG, "utf8").match(/iOS Bundled/g) ?? []).length;
	const before = bundled();
	await simctl("launch", UDID, BUNDLE);
	await waitFor("app launch", has("Pair a server"), 180_000);
	// Goal: the pictures show this PR's code. The Debug app has no embedded
	// bundle; it must have loaded the one the job's own Metro just built.
	if (bundled() <= before) fail("app launch", `the app opened but ${METRO_LOG} shows no iOS bundle served after launch`);
	log(`app opened from Metro (${bundled() - before} iOS bundle(s) served)`);

	await tap("saved servers", (el) => label(el) === "Pair a server");
	for (const { mode } of MODES) {
		await setPhoneMode(mode);
		await waitFor("pair", has("Server address"));
		await phoneShot("pair", mode);
	}
	await setPhoneMode("light");

	const minted = await api("/api/auth/pairing-token", { method: "POST", body: JSON.stringify({ label: "CI iPhone" }) });
	const { credential } = await minted.json().catch(() => ({}));
	if (!minted.ok || !credential) fail("pair", `could not mint a pairing code: ${minted.status}`);
	await typeInto("pair", "Server address", ORIGIN);
	await typeInto("pair", "Pairing code", credential);
	await tap("pair", (el) => label(el) === "Connect");

	// The one step not driven: AXe's touches do not reach session rows inside
	// the long-press menu on the simulator, so the job's Metro bundles with
	// EXPO_PUBLIC_CI_OPEN_SESSIONS (apps/mobile/src/workspace-view.ts) and each
	// connection opens the next fixture session instead of a tapped row.
	const sessionsReached = (elements) => hasMatch(new RegExp(QUIZ.title))(elements) && hasMatch(new RegExp(LESSON.title))(elements);
	const inSession = (title) => (elements) => has("Sessions")(elements) && elements.some((el) => label(el) === title);
	await waitFor("lesson", inSession(LESSON.title), 60_000);
	await dismissSavePassword("lesson");
	for (const { mode } of MODES) {
		await setPhoneMode(mode);
		await phonePages("lesson", mode, inSession(LESSON.title));
	}
	await tap("lesson", (el) => label(el) === "Sessions");
	for (const { mode } of MODES) {
		await setPhoneMode(mode);
		await waitFor("sessions", sessionsReached);
		await phoneShot("sessions", mode);
	}

	await tap("sessions", (el) => label(el) === "Servers");
	await waitFor("saved servers", has("Open"));
	await tap("saved servers", (el) => label(el) === "Open");
	const waiting = (elements) => inSession(QUIZ.title)(elements) && elements.filter(isChoice).length > 0;
	for (const { mode } of MODES) {
		await setPhoneMode(mode);
		await checkChoiceRows("quiz-waiting", waiting);
		await phonePages("quiz-waiting", mode, waiting, { dock: true });
	}

	// Answer through the dock: pick the two math choices, then submit.
	const rows = await checkChoiceRows("quiz-waiting", waiting);
	for (const choice of CHOICES.filter((c) => c.answer)) {
		await tap("quiz-waiting", (el) => isChoice(el) && choice.spoken.test(label(el)));
	}
	log(`picked ${CHOICES.filter((c) => c.answer).map((c) => c.label).join(" and ")} of ${rows.length} rows`);
	const x = String(Math.round(screenSize.width / 2));
	for (let i = 0; i < 8; i++) {
		const elements = await settled("quiz-waiting");
		const submit = elements.find((el) => label(el) === "Submit answer");
		if (!submit) fail("quiz-waiting", "no Submit answer button");
		if (center(submit).y < screenSize.height - 60) break;
		await axe(["drag", "--start-x", x, "--start-y", String(Math.round(screenSize.height * 0.85)), "--end-x", x, "--end-y", String(Math.round(screenSize.height * 0.65))]);
		await sleep(700);
	}
	await tap("quiz-waiting", (el) => label(el) === "Submit answer");
	// The fake model answers the saved quiz answer with one scripted reply.
	const replied = () => readFileSync(inst.MODEL_LOG, "utf8").includes("quiz-answered");
	const answered = (elements) => replied() && inSession(QUIZ.title)(elements) && !elements.some(isChoice)
		&& has("Message")(elements) && !has("Reply in progress…")(elements);
	await waitFor("quiz-answered", answered, 90_000);
	for (const { mode } of MODES) {
		await setPhoneMode(mode);
		await phonePages("quiz-answered", mode, answered);
	}
}

main().then(() => log(`done: ${shots.length} screenshots in ${OUT}`), (error) => {
	console.error(error instanceof Failure ? `::error title=iPhone check::${error.message.replace(/\n/g, "%0A")}` : error);
	process.exit(1);
});

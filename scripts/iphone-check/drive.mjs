#!/usr/bin/env node
/**
 * drive.mjs: the iPhone simulator driver (docs/specs/ios-simulator-ci.md).
 *
 *   node scripts/iphone-check/drive.mjs --phase web-before|phone|web-after --udid <sim> --bundle <id>
 *     --origin https://127.0.0.1:<port> --instance <instance.env> --out <dir> --axe <path> --chrome <path>
 *     --metro-log <file>
 *
 * The driver runs the three phases in turn, so Chrome never runs beside the
 * booted simulator: web-before shoots the web's screens while the quiz waits,
 * phone drives the app and answers the quiz, and web-after shoots the
 * answered quiz on the web and puts every iPhone and web picture side by side.
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
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import { toEnd, toTop } from "./paging.mjs";

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
const PHASE = arg("phase");
const inst = Object.fromEntries(readFileSync(arg("instance"), "utf8").split("\n").filter((line) => line.includes("="))
	.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "")]));

const LESSON = { id: "chat_zzmobilelesson", title: "Sets and unions" };
const QUIZ = { id: "chat_zzmobilequiz", title: "Splits and gradient steps" };
// The pending question's choices (tests/fixtures/mobile-quiz), each matched
// by its spoken label. A label may never show `$` or `\`.
const CHOICES = [
	{ label: "Train: $4$; test: $8$", spoken: /^Train: 4; test: 8$/, answer: true },
	{ label: "$(+0.20, -0.10)$", spoken: /^open paren (positive|plus) 0\.20 comma (negative|minus) 0\.10 close paren$/, answer: true },
	{ label: "$(-0.10, +0.20)$", spoken: /^open paren (negative|minus) 0\.10 comma (positive|plus) 0\.20 close paren$/ },
	{ label: "None of these", spoken: /^None of these$/ },
];
// The answered card's line: both chosen answers, math spoken, in order.
const ANSWER_LINE = /^Train: 4; test: 8,\s*open paren (positive|plus) 0\.20 comma (negative|minus) 0\.10 close paren$/;
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
// AXe itself can crash (a signal, seen as SIGSEGV on a swipe). Reads and scrolls
// are safe to repeat, so those run again, at most twice; a tap or keys never do.
// A scroll that timed out may have moved the screen, so only a crash repeats it.
const REPEATABLE = new Set(["describe-ui", "displays", "swipe", "drag"]);
async function axe(args) {
	for (let attempt = 1; ; attempt++) {
		try {
			// No AXe call may hang the job: each is stopped after 2 minutes.
			return await run(AXE, [...args, "--udid", UDID], { maxBuffer: 64 << 20, timeout: 120_000, env: { ...process.env, AXE_HID_STABILIZATION_MS: "1000" } });
		} catch (error) {
			if (!error.signal || !REPEATABLE.has(args[0]) || attempt === 3) throw error;
			if (error.killed && (args[0] === "swipe" || args[0] === "drag")) throw error;
			log(`AXe ${error.killed ? "timed out" : `crashed (${error.signal})`} on ${args[0]}; running it again`);
		}
	}
}
const simctl = (...args) => run("xcrun", ["simctl", ...args], { maxBuffer: 64 << 20, timeout: 300_000 });

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
	const all = elements.filter(label).map((el) => `${label(el)} [${[el.type, el.role_description, el.AXValue].filter(Boolean).join("/")}]`);
	log(`${screen} not reached; the whole screen:\n  ${all.join("\n  ")}`);
	const seen = all.slice(0, 60).join(" | ");
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

/** Does a tap reach the app? Toggle the session's options menu twice and check
 * that each tap changed it; it passes only when a fresh read finds it closed. */
async function tapsReachApp(screen) {
	for (let i = 0; i < 2; i++) {
		const open = has("Close menu")(await settled(screen));
		await tap(screen, (el) => label(el) === (open ? "Close menu" : "Session options"));
		await sleep(800);
		if (has("Close menu")(await settled(screen)) === open) return false;
	}
	if (has("Close menu")(await settled(screen))) {
		await tap(screen, (el) => label(el) === "Close menu");
		await sleep(800);
	}
	return !has("Close menu")(await settled(screen));
}

/** After the Pair screen's secure field, iOS offers to save the password in a
 * system sheet that AXe's tree does not list and that takes every touch. It can
 * arrive several seconds after pairing. A real user answers it once; this
 * answers Not Now (where it sits on an iPhone 17) whenever a probe fails, and
 * goes on only after two passing probes 8 s apart. */
async function dismissSavePassword(screen) {
	let passes = 0;
	for (let probe = 1; probe <= 6 && passes < 2; probe++) {
		await sleep(8000);
		if (await tapsReachApp(screen)) {
			passes++;
			continue;
		}
		passes = 0;
		log("a system sheet takes the taps (iOS's Save Password? offer); answering Not Now");
		await axe(["tap", "--label", "Not Now"]).catch(() => axe(["tap", "-x", String(Math.round(screenSize.width * 0.315)),
			"-y", String(Math.round(screenSize.height * 0.626)), "--tap-style", "physical"]));
	}
	if (passes < 2) fail(screen, "a system sheet over the app takes the taps and Not Now did not close it");
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

/** One pixel of an 8-bit RGB or RGBA PNG (what simctl screenshots are). */
function pngPixel(file, x, y) {
	const buf = readFileSync(file);
	let width = 0, depth = 0, color = 0, pos = 8;
	const idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") [width, depth, color] = [data.readUInt32BE(0), data[8], data[9]];
		else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		pos += 12 + len;
	}
	if (depth !== 8 || (color !== 2 && color !== 6)) throw new Error(`${file}: unsupported PNG (depth ${depth}, color ${color})`);
	const bpp = color === 6 ? 4 : 3, stride = width * bpp, raw = inflateSync(Buffer.concat(idat));
	let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
	for (let row = 0; row <= y; row++) {
		const filter = raw[row * (stride + 1)], line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
			const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
			const add = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
			cur[i] = (line[i] + add) & 255;
		}
		[prev, cur] = [cur, prev];
	}
	return [prev[x * bpp], prev[x * bpp + 1], prev[x * bpp + 2]];
}

/** Overlays that must never be in a picture: the session menu, the keyboard,
 * React Native's LogBox. (iOS's own sheets are not in the tree; the appearance
 * check below catches their dimming.) */
function overlayIn(elements) {
	return elements.find((el) => label(el) === "Close menu" || label(el) === "Typing Predictions" || /^Open debugger to view/.test(label(el)));
}

/** A screenshot taken only once the appearance has settled: two shots 0.7 s
 * apart both show the page background in the mode's colour at the left
 * gutter (light near white, dark near black), so no cross-fade or dimmed
 * overlay is pictured. (Frames are not compared: a spinner may always move.)
 * Fails after 20 s. */
async function settledShot(screen, mode, file) {
	const deadline = Date.now() + 20_000;
	const background = () => {
		const [r, g, b] = pngPixel(file, 6, Math.round(screenSize.height * 1.5));
		const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		return { rgb: `${r},${g},${b}`, right: mode === "light" ? light > 200 : light < 70 };
	};
	for (;;) {
		const overlay = overlayIn(await settled(screen));
		if (overlay) fail(screen, `an overlay is on screen for the ${mode} picture: "${label(overlay)}"`);
		await simctl("io", UDID, "screenshot", file);
		const first = background();
		await sleep(700);
		await simctl("io", UDID, "screenshot", file);
		const second = background();
		if (first.right && second.right) return createHash("sha256").update(readFileSync(file)).digest("hex");
		if (Date.now() > deadline) fail(screen, `the ${mode} picture never settled: page background ${second.rgb}`);
		await sleep(800);
	}
}

async function phoneShot(screen, mode) {
	const file = path.join(OUT, "iphone", `${screen}-${mode}.png`);
	await settledShot(screen, mode, file);
	shots.push({ screen, mode, side: "iphone", file });
}

async function setPhoneMode(mode) {
	await simctl("ui", UDID, "appearance", mode);
	await sleep(1500);
}

/** The scrolling areas of a session, top to bottom, by their vertical scroll
 * bars: "Vertical scroll bar, 3 pages", valued "0%" at the top, "100%" at the end. */
async function scrollBars(screen) {
	return (await settled(screen))
		.map((el) => ({ el, m: /^Vertical scroll bar, (\d+) pages?$/.exec(label(el)) }))
		.filter(({ m }) => m && Number(m[1]) > 1)
		.map(({ el, m }) => ({ pages: Number(m[1]), at: Number.parseInt(String(el.AXValue ?? ""), 10), y: frame(el).y }))
		.sort((a, b) => a.y - b.y);
}

/** Screenshot a session in full, numbered top to bottom. Each area (the
 * transcript, then a dock that scrolls) is flicked to its top, then paged to
 * its end (paging.mjs says what counts as each). An area gives the screen
 * fractions a finger drags between (top, bottom) and the band its scroll bar
 * sits in (within). A stalled or unfinished area fails the job, named. */
async function phonePages(screen, mode, marker, areas) {
	await waitFor(screen, marker);
	const x = String(Math.round(screenSize.width / 2));
	const probe = path.join(OUT, `.probe-${screen}-${mode}.png`);
	// kept: the hash of the last page kept, across areas (paging.mjs compares the same way).
	let page = 0, kept = null;
	for (const [index, area] of areas.entries()) {
		const name = `${screen} ${mode} ${index === 0 ? "transcript" : "dock"}`;
		const top = String(Math.round(screenSize.height * area.top));
		const bottom = String(Math.round(screenSize.height * area.bottom));
		const bar = async () => (await scrollBars(screen))
			.find((b) => b.y >= screenSize.height * area.within[0] && b.y < screenSize.height * area.within[1])?.at ?? null;
		// A dock that doesn't scroll is already in the transcript's pictures.
		if (index > 0 && (await bar()) == null) {
			log(`${name}: no scroll bar, nothing to scroll`);
			continue;
		}
		const hash = async () => {
			await simctl("io", UDID, "screenshot", probe);
			return createHash("sha256").update(readFileSync(probe)).digest("hex");
		};
		const flick = async () => {
			await axe(["swipe", "--start-x", x, "--start-y", top, "--end-x", x, "--end-y", bottom]);
			await sleep(900);
		};
		const drag = async () => {
			await axe(["drag", "--start-x", x, "--start-y", bottom, "--end-x", x, "--end-y", top]);
			await sleep(900);
		};
		let file = "";
		const shoot = async () => {
			file = path.join(OUT, "iphone", `${screen}-${mode}-${page + 1}.png`);
			const shot = await settledShot(screen, mode, file);
			if (shot !== kept) {
				page++;
				kept = shot;
				shots.push({ screen, mode, side: "iphone", file });
			}
			return shot;
		};
		const discard = async () => unlinkSync(file);
		try {
			log(await toTop({ area: name, hash, bar, flick }));
			const done = await toEnd({ area: name, bar, shoot, discard, drag, previous: kept });
			log(done.line);
			// A dock goes back to its top, where its choices and their checks are.
			if (index > 0) log(await toTop({ area: name, hash, bar, flick }));
		} catch (error) {
			fail(screen, error.message);
		}
	}
	try { unlinkSync(probe); } catch { /* no probe was taken */ }
}

/** Goal 4: each choice is one accessibility item that speaks its math. The
 * speech engine loads after the first render, so this waits up to 20 s for
 * the rows to settle before it fails. */
async function checkChoiceRows(screen, ready) {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const elements = await waitFor(screen, ready);
		const { rows, problems } = rowProblems(elements);
		if (!problems.length) problems.push(...await rowHits(rows));
		if (!problems.length) {
			log(`${screen}: ${rows.length} choice rows, one item each: ${rows.map((row) => JSON.stringify(label(row))).join(", ")}`);
			return rows;
		}
		if (Date.now() > deadline) fail(screen, `quiz choice rows:\n  - ${problems.join("\n  - ")}`);
		await sleep(1500);
	}
}

/** What the screen itself finds across each row: the box, the label's start and
 * the label's end must all be that one row, not a separate item inside it. */
async function rowHits(rows) {
	const problems = [];
	for (const row of rows) {
		const f = frame(row);
		for (const x of [f.x + 18, f.x + 60, f.x + f.width * 0.6]) {
			const point = `${Math.round(x)},${Math.round(f.y + f.height / 2)}`;
			let stdout = "";
			for (let attempt = 1; !stdout.trim(); attempt++) {
				if (attempt > 3) fail("quiz-waiting", `could not read the screen at ${point}: AXe returned nothing three times`);
				try { ({ stdout } = await axe(["describe-ui", "--point", point])); } catch (error) {
					if (attempt === 3) fail("quiz-waiting", `could not read the screen at ${point}: ${String(error.stderr || error.message).trim().split("\n")[0]}`);
					await sleep(1500);
				}
			}
			const hit = JSON.parse(stdout);
			const found = (Array.isArray(hit) ? hit[0] : hit) ?? {};
			if (label(found) !== label(row)) {
				problems.push(`row "${label(row)}" is split: at ${point} the screen finds a separate item ${JSON.stringify(label(found))}`);
				break;
			}
		}
	}
	return problems;
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
		for (const { screen, route, text, signedOut, shows = [] } of screens) {
			const context = await browser.createBrowserContext();
			try {
				const page = await context.newPage();
				await page.setViewport({ width: 1280, height: 860 });
				if (!signedOut) await page.setCookie({ name: `lh_session_${inst.APP_PORT}`, value: inst.APP_TOKEN, url: inst.APP_URL, httpOnly: true, sameSite: "Lax" });
				// A cold server on a busy CI Mac can take longer than puppeteer's 30 s default.
				await page.goto(`${inst.APP_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 120_000 })
					.catch((error) => fail(`web ${screen}`, `${route} did not load: ${error.message}`));
				try {
					await page.waitForFunction((want) => document.body?.innerText.includes(want), { timeout: 90_000 }, text);
				} catch {
					fail(`web ${screen}`, `"${text}" never showed`);
				}
				const body = await page.evaluate(() => document.body.innerText);
				for (const pattern of shows) if (!pattern.test(body)) fail(`web ${screen}`, `the page does not show ${pattern}`);
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
	// The pictures of every phase, from disk: <screen>-<mode>[-<page>].png.
	shots.length = 0;
	for (const side of ["iphone", "web"]) {
		const named = readdirSync(path.join(OUT, side)).map((name) => ({ name, m: /^(.+)-(light|dark)(?:-(\d+))?\.png$/.exec(name) })).filter(({ m }) => m);
		named.sort((a, b) => Number(a.m[3] ?? 0) - Number(b.m[3] ?? 0));
		for (const { name, m } of named) shots.push({ screen: m[1], mode: m[2], side, file: path.join(OUT, side, name) });
	}
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
	// Chrome's first launch on a busy CI Mac can outlast puppeteer's 30 s default.
	const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"], timeout: 120_000 })
		.catch((error) => fail("web", `Chrome did not start: ${error.message}`));
	try {
		return await work(browser);
	} finally {
		await browser.close();
	}
}

async function main() {
	if (PHASE === "web-before") {
		await withBrowser((browser) => webShots(browser, [
			{ screen: "pair", route: "/pair", text: "Pair", signedOut: true },
			{ screen: "sessions", route: "/", text: QUIZ.title },
			{ screen: "lesson", route: `/chat/${LESSON.id}`, text: LESSON.title },
			{ screen: "quiz-waiting", route: `/chat/${QUIZ.id}`, text: "None of these" },
		]));
	} else if (PHASE === "phone") {
		await phone();
	} else if (PHASE === "web-after") {
		await withBrowser(async (browser) => {
			// The answered card lists both picked answers before the scripted reply.
			await webShots(browser, [{ screen: "quiz-answered", route: `/chat/${QUIZ.id}`, text: "The first pair fits",
				shows: [/Pick every pair[^]*?Train:[^]*?test:[^]*?0\.20[^]*?0\.10[^]*?The first pair fits/] }]);
			await sideBySide(browser);
		});
	} else {
		throw new Error(`unknown --phase ${PHASE}`);
	}
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
	// the long-press menu on the simulator, so the simulator run's Metro bundles with
	// EXPO_PUBLIC_CI_OPEN_SESSIONS (apps/mobile/src/workspace-view.ts) and each
	// connection opens the next fixture session instead of a tapped row.
	const sessionsReached = (elements) => hasMatch(new RegExp(QUIZ.title))(elements) && hasMatch(new RegExp(LESSON.title))(elements);
	const inSession = (title) => (elements) => has("Sessions")(elements) && elements.some((el) => label(el) === title);
	// Each screen must show its fixture's own content, not just its title.
	const lesson = (elements) => inSession(LESSON.title)(elements) && has("Teach me about sets and unions")(elements)
		&& has("Check your understanding")(elements);
	await waitFor("lesson", inSession(LESSON.title), 60_000);
	await dismissSavePassword("lesson");
	await setPhoneMode("light");
	// The pending check's dock covers the bottom quarter; drag above it.
	const lessonAreas = [{ top: 0.16, bottom: 0.66, within: [0, 0.74] }];
	await phonePages("lesson", "light", lesson, lessonAreas);
	await setPhoneMode("dark");
	await phonePages("lesson", "dark", lesson, lessonAreas);
	await tap("lesson", (el) => label(el) === "Sessions");
	for (const { mode } of MODES) {
		await setPhoneMode(mode);
		await waitFor("sessions", sessionsReached);
		await phoneShot("sessions", mode);
	}

	await tap("sessions", (el) => label(el) === "Servers");
	await waitFor("saved servers", has("Open"));
	await tap("saved servers", (el) => label(el) === "Open");
	const waiting = (elements) => inSession(QUIZ.title)(elements) && elements.filter(isChoice).length > 0
		&& has("Quiz me on train and test splits and on one gradient step")(elements);
	await setPhoneMode("light");
	await checkChoiceRows("quiz-waiting", waiting);
	// The transcript above the question dock (at most 55% of the screen), then the dock.
	const waitingAreas = [{ top: 0.16, bottom: 0.40, within: [0, 0.46] }, { top: 0.60, bottom: 0.88, within: [0.46, 1] }];
	await phonePages("quiz-waiting", "light", waiting, waitingAreas);
	await setPhoneMode("dark");
	await checkChoiceRows("quiz-waiting", waiting);
	await phonePages("quiz-waiting", "dark", waiting, waitingAreas);

	// Answer through the dock: pick the two math choices (each tap reads the
	// screen afresh), check that exactly those two are ticked, then submit.
	const want = CHOICES.filter((c) => c.answer);
	for (const choice of want) {
		await tap("quiz-waiting", (el) => isChoice(el) && choice.spoken.test(label(el)));
	}
	const ticked = (await settled("quiz-waiting")).filter((el) => isChoice(el) && /(^|, )checked/.test(String(el.AXValue ?? ""))).map(label);
	if (ticked.length !== want.length || !want.every((c) => ticked.some((text) => c.spoken.test(text)))) {
		fail("quiz-waiting", `the dock shows ${JSON.stringify(ticked)} ticked, expected exactly ${want.map((c) => c.label).join(" and ")}`);
	}
	log(`picked ${want.map((c) => c.label).join(" and ")}`);
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
		// The card's answer line and its verdict (the fixture's earlier cards are correct). The
		// scripted reply has math, and a paragraph with math is not in the accessibility
		// tree, so the web pass checks the reply's text.
		&& !has("Reply in progress…")(elements) && hasMatch(ANSWER_LINE)(elements) && has("INCORRECT")(elements);
	await waitFor("quiz-answered", answered, 90_000);
	// The saved answer holds exactly the two picked choices.
	const record = JSON.parse(readFileSync(path.join(inst.DATA_DIR, "chats", `${QUIZ.id}.json`), "utf8"));
	const saved = record.messages.find((m) => m.role === "toolResult" && m.toolCallId === "call_q3")?.details?.answers?.map((a) => a.label) ?? [];
	if (JSON.stringify([...saved].sort()) !== JSON.stringify(want.map((c) => c.label).sort())) {
		fail("quiz-answered", `the saved answer is ${JSON.stringify(saved)}, expected ${JSON.stringify(want.map((c) => c.label))}`);
	}
	await setPhoneMode("light");
	const answeredAreas = [{ top: 0.16, bottom: 0.75, within: [0, 0.86] }];
	await phonePages("quiz-answered", "light", answered, answeredAreas);
	await setPhoneMode("dark");
	await phonePages("quiz-answered", "dark", answered, answeredAreas);
}

main().then(() => log(`${PHASE} done: ${shots.length} screenshots in ${OUT}`), (error) => {
	const escaped = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
	console.error(error instanceof Failure ? `::error title=iPhone check::${escaped(error.message)}` : error);
	process.exit(1);
});

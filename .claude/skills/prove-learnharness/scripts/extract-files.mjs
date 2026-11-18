#!/usr/bin/env node
/**
 * extract-files.mjs <instance.env> <label> --files <path>... | --folder <dir> [--cancel] [--close-empty] [--slow-estimate]
 *
 * Drives the graph view's "Extract files…" button like a user, against one
 * instance started by start.sh (use scenarios/extract-files.json so the fake
 * extractor, auditor and image reader answer):
 *   1. /, click [data-testid=import-notes], click the "Files" or "Folder"
 *      menu item, and accept the native file chooser with the given paths
 *      (a folder goes to the webkitdirectory input, as a user's pick does).
 *   2. Folder: wait for [data-testid=folder-review-dialog], record its lines
 *      and whether Extract was disabled while the estimate loaded, then
 *      Cancel (--cancel / --close-empty) or Extract.
 *   3. Poll /api/graph/status while the button reads "Extracting…", until it
 *      reads "Extract files…" again and no run is left.
 *   4. Record the error (role=alert) and notice (role=status) lines, the
 *      sources and nodes before and after, /api/graph/costs, and every model
 *      request the drive caused (rule, system prompt head, tools, last
 *      message, images sent).
 *
 * Writes <side dir>/extract-files/<label>/result.json and screenshots.
 * Exit 0 = the script ran to the end (not a verdict); 1 = a step failed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const argv = process.argv.slice(2);
const [instPath, label] = argv;
if (!instPath || !label) { console.error("usage: extract-files.mjs <instance.env> <label> --files <path>... | --folder <dir> [--cancel] [--close-empty]"); process.exit(2); }
const flag = (name) => argv.includes(`--${name}`);
const filesAt = argv.indexOf("--files");
const files = filesAt >= 0 ? argv.slice(filesAt + 1).filter((a) => !a.startsWith("--")).map((p) => path.resolve(p)) : [];
const folderAt = argv.indexOf("--folder");
const folder = folderAt >= 0 ? path.resolve(argv[folderAt + 1]) : null;
if (!files.length && !folder) { console.error("give --files or --folder"); process.exit(2); }

const inst = Object.fromEntries(fs.readFileSync(instPath, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
	const i = l.indexOf("=");
	return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
}));
const SIDE_DIR = path.dirname(instPath);
const OUT = path.join(SIDE_DIR, "extract-files", label);
fs.mkdirSync(OUT, { recursive: true });
const APP = inst.APP_URL;
const REPO = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(REPO, "package.json"));
const puppeteer = require("puppeteer-core");
const chrome = process.env.PROVE_CHROME || "/usr/bin/google-chrome";
const runMs = Number(process.env.EXTRACT_TIMEOUT_S || 180) * 1000;
const axePath = path.join(REPO, ".prove-it/tools/node_modules/axe-core/axe.min.js");
const axeSource = fs.existsSync(axePath) ? fs.readFileSync(axePath, "utf8") : null;

const steps = [];
const result = { side: inst.SIDE, app: APP, build: inst.BUILD_STAMP, label, picked: folder ? { folder: path.basename(folder) } : { files: files.map((f) => path.basename(f)) }, startedAt: new Date().toISOString(), steps, observations: {}, budgets: { consoleErrors: [], cls: {}, axe: {} }, evidence: {} };
const save = () => fs.writeFileSync(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
const step = (name, ok, detail) => { steps.push({ name, ok, ...detail }); save(); console.log(`[${ok ? "ok" : "FAIL"}] ${name}${detail?.note ? `: ${detail.note}` : ""}`); };
const getJson = async (p) => (await fetch(`${APP}${p}`)).json();
const modelLog = () => fs.existsSync(inst.MODEL_LOG) ? fs.readFileSync(inst.MODEL_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("\n") : "";

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(SIDE_DIR, "chrome-profile")}`] });
fs.writeFileSync(path.join(SIDE_DIR, "chrome-extract-files.pid"), String(browser.process().pid));
let exitCode = 0;
try {
	const page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 900 });
	page.on("console", (m) => { if (m.type() === "error") result.budgets.consoleErrors.push({ page: new URL(page.url() || APP).pathname, text: m.text().slice(0, 300), url: m.location()?.url ?? null }); });
	page.on("pageerror", (e) => result.budgets.consoleErrors.push({ page: new URL(page.url() || APP).pathname, text: `uncaught: ${e.message.slice(0, 300)}` }));
	const uploads = [];
	page.on("request", (r) => {
		const u = new URL(r.url());
		if (u.origin === APP && u.pathname.startsWith("/api/graph/import")) uploads.push({ method: r.method(), path: u.pathname, ...(u.pathname.endsWith("/estimate") ? { body: r.postData() } : {}) });
	});
	// --slow-estimate: hold the estimate answer for 3 s, to see the dialog while it loads.
	if (flag("slow-estimate")) {
		await page.setRequestInterception(true);
		page.on("request", (r) => {
			if (r.isInterceptResolutionHandled()) return;
			if (new URL(r.url()).pathname === "/api/graph/import/estimate") setTimeout(() => r.continue(), 3_000);
			else r.continue();
		});
	}
	const responses = [];
	page.on("response", async (r) => {
		const u = new URL(r.url());
		if (u.origin !== APP || !u.pathname.startsWith("/api/graph/import")) return;
		let body = null;
		try { body = await r.json(); } catch { /* not JSON */ }
		responses.push({ path: u.pathname, status: r.status(), body });
	});
	const shot = async (name) => { const file = path.join(OUT, `${name}.png`); await page.screenshot({ path: file }); result.evidence[name] = file; };
	const axeHere = async (name) => {
		if (!axeSource) { result.budgets.axe[name] = "axe-core not installed: run scripts/ensure-axe.sh"; return; }
		await page.evaluate(axeSource);
		result.budgets.axe[name] = await page.evaluate(async () => {
			const r = await window.axe.run(document, { resultTypes: ["violations"] });
			return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
		});
		save();
	};

	await fetch(`${inst.FAKE_CONTROL}/__prove/reset`, { method: "POST" });
	const logStart = modelLog().length;
	const sourcesBefore = (await getJson("/api/graph/sources")).sources ?? [];
	const graphBefore = await getJson("/api/graph");
	result.observations.before = { sources: sourcesBefore.length, nodes: (graphBefore.nodes ?? []).length };

	await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector('[data-testid="import-notes"]', { timeout: 30_000 });
	await new Promise((r) => setTimeout(r, 800));
	await shot("01-graph-view");
	const buttonText = () => page.$eval('[data-testid="import-notes"]', (e) => e.textContent.trim());

	// 1. the button, the menu item, the native chooser
	await page.click('[data-testid="import-notes"]');
	await page.waitForSelector('[role="menu"] [role="menuitem"]', { timeout: 5_000 });
	result.observations.menu = await page.$$eval('[role="menu"] [role="menuitem"]', (els) => els.map((e) => e.textContent.trim()));
	const item = folder ? "Folder" : "Files";
	const [chooser] = await Promise.all([
		page.waitForFileChooser({ timeout: 5_000 }),
		page.evaluate((text) => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((e) => e.textContent.trim() === text).click(), item),
	]);
	result.observations.chooser = { multiple: chooser.isMultiple() };
	result.observations.accept = await page.$eval('input[type=file][multiple]', (e) => e.getAttribute("accept"));
	await chooser.accept(folder ? [folder] : files);
	step(`picked with ${item}`, true, { note: folder ? path.basename(folder) : files.map((f) => path.basename(f)).join(", ") });

	// 2. the folder review
	if (folder) {
		const dialog = '[data-testid="folder-review-dialog"]';
		await page.waitForSelector(dialog, { timeout: 30_000 });
		const read = () => page.evaluate(() => {
			const q = (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null;
			const confirm = document.querySelector('[data-testid="folder-review-confirm"]');
			return { title: document.querySelector('[data-testid="folder-review-dialog"] h2')?.textContent?.trim(), contents: q("folder-review-contents"), skipped: q("folder-review-skipped"), codeSkipped: q("folder-review-code-skipped"), estimate: q("folder-review-estimate"), confirm: confirm ? { disabled: confirm.disabled, text: confirm.textContent.trim() } : null, cancel: q("folder-review-cancel") };
		});
		const first = await read();
		result.observations.reviewFirst = first;
		if (flag("slow-estimate")) {
			await shot("02a-folder-review-loading");
			// A click on Extract while the estimate loads must start nothing.
			await page.click('[data-testid="folder-review-confirm"]').catch(() => {});
			await new Promise((r) => setTimeout(r, 300));
			result.observations.clickWhileLoading = { dialogStillOpen: Boolean(await page.$(dialog)), importPosts: uploads.filter((u) => u.path === "/api/graph/import").length };
		}
		await page.waitForFunction(() => !/Estimating/.test(document.querySelector('[data-testid="folder-review-estimate"]')?.textContent ?? ""), { timeout: 15_000 }).catch(() => {});
		const review = await read();
		result.observations.review = review;
		result.observations.uploadsBeforeChoice = uploads.filter((u) => u.path === "/api/graph/import").length;
		result.observations.modelRequestsBeforeChoice = modelLog().length - logStart;
		await shot("02-folder-review");
		await axeHere("/ (folder review)");
		step("folder review dialog shows", Boolean(review.title), { note: JSON.stringify(review) });
		if (flag("cancel") || flag("close-empty")) {
			await page.click('[data-testid="folder-review-cancel"]');
			await page.waitForFunction(() => !document.querySelector('[data-testid="folder-review-dialog"]'), { timeout: 5_000 });
			await new Promise((r) => setTimeout(r, 2_000));
			await shot("03-after-cancel");
			const sourcesAfter = (await getJson("/api/graph/sources")).sources ?? [];
			result.observations.afterCancel = { dialogGone: true, importPosts: uploads.filter((u) => u.path === "/api/graph/import").length, modelRequests: modelLog().length - logStart, sources: sourcesAfter.length, button: await buttonText(), alerts: await page.$$eval('[role="alert"]', (els) => els.map((e) => e.textContent.trim())) };
			step("cancel closes the review and runs nothing", result.observations.afterCancel.importPosts === 0 && result.observations.afterCancel.sources === sourcesBefore.length, { note: JSON.stringify(result.observations.afterCancel) });
			throw "done";
		}
		await page.click('[data-testid="folder-review-confirm"]');
	}

	// 3. the run
	const labels = new Set();
	const phases = new Set();
	const buttonStates = new Set();
	const deadline = Date.now() + runMs;
	let quiet = 0;
	while (Date.now() < deadline) {
		const status = await getJson("/api/graph/status");
		for (const r of status.runs ?? []) { labels.add(r.label ?? r.title ?? JSON.stringify(r).slice(0, 80)); if (r.phase) phases.add(r.phase); }
		const text = await buttonText();
		buttonStates.add(text);
		const posting = uploads.filter((u) => u.path === "/api/graph/import").length > responses.filter((r) => r.path === "/api/graph/import").length;
		if ((status.runs ?? []).length === 0 && text === "Extract files…" && !posting) { if (++quiet >= 3) break; } else quiet = 0;
		await new Promise((r) => setTimeout(r, 150));
	}
	await new Promise((r) => setTimeout(r, 800));
	result.observations.runLabels = [...labels].sort();
	result.observations.phases = [...phases].sort();
	result.observations.buttonStates = [...buttonStates];
	const finished = (await buttonText()) === "Extract files…";
	step("extraction finishes (button back to Extract files…)", finished, { note: `labels seen ${JSON.stringify(result.observations.runLabels)}; button states ${JSON.stringify(result.observations.buttonStates)}` });
	await shot("04-after");

	// 4. what it left
	result.observations.alerts = await page.$$eval('[role="alert"]', (els) => els.map((e) => e.textContent.trim()));
	result.observations.notices = await page.$$eval('[role="status"]', (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
	result.observations.importRequests = uploads;
	result.observations.importResponses = responses.map((r) => ({ path: r.path, status: r.status, results: r.body?.results?.map((x) => ({ filePath: x.filePath, outcome: x.outcome, ok: x.ok, error: x.error, notice: x.notice, nodes: x.stats?.nodes })) ?? r.body }));
	const sourcesAfter = (await getJson("/api/graph/sources")).sources ?? [];
	const graphAfter = await getJson("/api/graph");
	const beforeIds = new Set(sourcesBefore.map((s) => s.id));
	result.observations.newSources = sourcesAfter.filter((s) => !beforeIds.has(s.id)).map((s) => ({ id: s.id, path: s.path ?? s.filePath ?? s.title, kind: s.kind, label: s.label }));
	result.observations.sourcesRaw = sourcesAfter.filter((s) => !beforeIds.has(s.id));
	const nodeIdsBefore = new Set((graphBefore.nodes ?? []).map((n) => n.id));
	result.observations.newNodes = (graphAfter.nodes ?? []).filter((n) => !nodeIdsBefore.has(n.id)).map((n) => n.name ?? n.label).sort();
	result.observations.after = { sources: sourcesAfter.length, nodes: (graphAfter.nodes ?? []).length };
	result.observations.costs = await getJson("/api/graph/costs");
	result.observations.modelRequests = modelLog().slice(logStart).map((r) => {
		const msgs = r.request?.messages ?? [];
		const system = msgs.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
		const last = msgs.at(-1) ?? {};
		const images = msgs.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p?.type === "image_url").map((p) => (p.image_url?.url ?? "").slice(0, 40)) : []);
		return { n: r.n, rule: r.rule, model: r.request?.model, tools: (r.request?.tools ?? []).map((t) => t?.function?.name).sort(), systemHead: system.slice(0, 160), lastRole: last.role, lastText: textOf(last.content), images, reply: r.reply };
	});
	result.observations.modelRules = result.observations.modelRequests.map((r) => r.rule);
	await axeHere("/ (after extraction)");
	step("drive complete", true, { note: `sources ${result.observations.before.sources} -> ${result.observations.after.sources}, nodes ${result.observations.before.nodes} -> ${result.observations.after.nodes}, ${result.observations.modelRequests.length} model requests` });
} catch (error) {
	if (error !== "done") {
		exitCode = 1;
		step("drive", false, { note: String(error?.stack ?? error).slice(0, 600) });
	}
} finally {
	result.finishedAt = new Date().toISOString();
	save();
	await browser.close();
	fs.rmSync(path.join(SIDE_DIR, "chrome-extract-files.pid"), { force: true });
	console.log(`result: ${path.join(OUT, "result.json")}`);
}
process.exit(exitCode);

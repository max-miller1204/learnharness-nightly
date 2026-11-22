#!/usr/bin/env node
/**
 * Unsent attachments across Back (issue #367, recipe: references/features/remote-attachments.md,
 * "Unsent attachment and Back"). Drives a production instance in real Chromium:
 *
 *   node scripts/web-attachment-draft.mjs <instance.env>
 *
 * Needs the capability `attachment-status-v1`, so a base build from before it
 * has nothing to restore and the drive reports each step as it finds it.
 * Everything it makes is named zz-prove-it. Writes <side>/web-attachment-draft/result.json
 * and screenshots, and exits 1 when a step fails.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import { signIn, signInPage } from "./sign-in.mjs";

const instancePath = process.argv[2];
const sideDir = path.dirname(instancePath);
const inst = Object.fromEntries(fs.readFileSync(instancePath, "utf8").split("\n")
	.filter(line => line.includes("=")).map(line => {
		const index = line.indexOf("=");
		return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "")];
	}));
const APP = inst.APP_URL;
const OUT = path.join(sideDir, "web-attachment-draft");
const PENDING = `${inst.DATA_DIR}-attachments/pending`;
const KEY = id => `lh:composer-attachments:v1:${id}`;
const TEXT_KEY = id => `lh:composer-draft:v1:${id}`;
fs.mkdirSync(OUT, { recursive: true });
signIn(inst);

const steps = [];
const step = (name, ok, note = "") => { steps.push({ name, ok: Boolean(ok), note }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${note ? ` (${note})` : ""}`); return ok; };

async function post(route, body) {
	const response = await fetch(APP + route, { method: "POST", headers: { "content-type": "application/json", origin: APP }, body: JSON.stringify(body) });
	assert.equal(response.status, 200, route);
	return response.json();
}
async function settled(id) {
	for (let i = 0; i < 200; i++) {
		const chats = (await (await fetch(`${APP}/api/chats`)).json()).chats;
		if (chats.find(chat => chat.id === id)?.busy === false) return;
		await delay(100);
	}
	assert.fail(`${id} never settled`);
}
const record = async id => (await (await fetch(`${APP}/api/chats/${id}`)).json());

const small = path.join(OUT, "zz-prove-it-notes.txt");
const big = path.join(OUT, "zz-prove-it-big.bin");
fs.writeFileSync(small, "zz-prove-it attachment draft fixture\n");
fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 7));

const browser = await puppeteer.launch({
	executablePath: process.env.PROVE_CHROME || "/usr/bin/google-chrome",
	headless: true,
	userDataDir: path.join(sideDir, "chrome-profile", "attachment-draft"),
});
const consoleErrors = [];
try {
	const stamp = Date.now();
	const ids = {};
	for (const name of ["a", "b"]) {
		const { id } = await post("/api/chats", { title: `zz-prove-it attach ${name} ${stamp}` });
		ids[name] = id;
	}
	const fresh = async key => {
		const { id } = await post("/api/chats", { title: `zz-prove-it attach ${key} ${stamp}` });
		ids[key] = id;
		return key;
	};
	const page = await browser.newPage();
	page.setDefaultTimeout(15_000);
	await page.setViewport({ width: 1280, height: 900 });
	await signInPage(page, inst);
	page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
	page.on("pageerror", error => consoleErrors.push(String(error)));
	const seen = [];
	page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/attachments")) seen.push({ method: request.method(), url: request.url().replace(APP, ""), at: seen.length, failed: false, status: 0 }); });
	page.on("response", response => {
		const entry = seen.findLast(item => item.url === response.url().replace(APP, "") && item.method === response.request().method() && !item.status);
		if (entry) entry.status = response.status();
	});
	page.on("requestfailed", request => {
		const entry = seen.findLast(item => item.url === request.url().replace(APP, "") && item.method === request.method() && !item.status);
		if (entry) entry.failed = true;
	});
	const cdp = await page.createCDPSession();
	await cdp.send("Network.enable");
	const throttle = async bytesPerSecond => cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: bytesPerSecond });
	const shot = async name => page.screenshot({ path: path.join(OUT, `${name}.png`) });
	const count = (method, test) => seen.filter(item => item.method === method && test(item.url)).length;
	const grantPosts = () => count("POST", url => url === "/api/attachments");

	const open = async id => {
		await page.goto(`${APP}/chat/${ids[id]}`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector('[data-testid="composer"] [contenteditable="true"]', { timeout: 30_000 });
		await page.waitForSelector("[data-attachment-upload]"); // the composer's uploads are on once server info says so
	};
	const chips = () => page.$$eval("[data-attachment-upload] span.truncate", els => els.map(element => element.textContent));
	const progress = () => page.$$eval("[data-attachment-upload] progress", els => els.length);
	const alerts = () => page.$$eval('[data-attachment-upload] [role="alert"]', els => els.map(element => element.textContent));
	const stored = id => page.evaluate(key => localStorage.getItem(key), KEY(ids[id]));
	const waitChips = async (expected, ms = 10_000) => {
		const until = Date.now() + ms;
		for (;;) {
			const now = await chips();
			if (JSON.stringify(now) === JSON.stringify(expected) && await progress() === 0) return true; // no bar: the upload is ready
			if (Date.now() > until) return false;
			await delay(100);
		}
	};
	const attach = async file => { const input = await page.$('[data-testid="attach-files-input"]'); await input.uploadFile(file); };
	const reload = async () => {
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForSelector('[data-testid="composer"] [contenteditable="true"]');
		await page.waitForSelector("[data-attachment-upload]");
	};
	const goToSession = async id => {
		await page.click(`[data-testid="session-rows"] [data-session-id="${ids[id]}"]`);
		await page.waitForFunction(target => location.pathname === `/chat/${target}`, {}, ids[id]);
		await page.waitForSelector('[data-testid="composer"] [contenteditable="true"]');
		await delay(300);
	};
	const back = async id => {
		await page.goBack();
		await page.waitForFunction(target => location.pathname === `/chat/${target}`, {}, ids[id]);
		await page.waitForSelector('[data-testid="composer"] [contenteditable="true"]');
	};
	const sendText = async text => {
		await page.click('[data-testid="composer"] [contenteditable="true"]');
		await page.keyboard.type(text);
		await page.keyboard.press("Enter");
	};
	const pendingFiles = () => fs.existsSync(PENDING) ? fs.readdirSync(PENDING).sort() : [];

	// 1. Attach, leave, Back: the chip is restored and sendable.
	await open("a");
	await page.waitForSelector('[data-testid="session-rows"] [data-session-id]');
	await attach(small);
	step("1a. a small file uploads to a ready chip", await waitChips(["zz-prove-it-notes.txt"]) && await progress() === 0 && await stored("a") !== null, `chips ${JSON.stringify(await chips())}`);
		const storedRow = JSON.parse(await stored("a") ?? "{\"rows\":[]}").rows?.[0];
	step("1b. the finished upload is saved with the draft (id and name, no bytes)", storedRow?.name === "zz-prove-it-notes.txt" && /^[0-9a-f-]{36}$/.test(storedRow?.id ?? "") && !JSON.stringify(storedRow).includes("fixture"), JSON.stringify(storedRow));
	await shot("01-attached");
	const putsBefore = count("PUT", () => true);
	const postsBefore = grantPosts();
	await goToSession("b");
	step("1c. the other session shows no chip", (await chips()).length === 0, JSON.stringify(await chips()));
	await back("a");
	step("1d. Back restores the chip", await waitChips(["zz-prove-it-notes.txt"]));
	await shot("02-restored");
	const statusCall = seen.find(item => item.method === "GET" && item.url === `/api/attachments/${storedRow?.id}?chatId=${ids.a}`);
	step("1e. the restore asked the server and it answered 204", statusCall?.status === 204, JSON.stringify(statusCall));
	step("1f. nothing uploaded a second time", grantPosts() === postsBefore && count("PUT", () => true) === putsBefore);
	await sendText("zz-prove-it send with the restored file");
	let saved;
	for (let i = 0; i < 100 && !saved; i++) {
		const messages = (await record(ids.a)).messages ?? [];
		saved = messages.find(message => message.role === "user" && message.attachments?.length);
		if (!saved) await delay(200);
	}
	step("1g. the restored chip sends: the saved message carries the attachment", saved?.attachments?.[0]?.name === "zz-prove-it-notes.txt" && saved.attachments[0].id === storedRow?.id, JSON.stringify(saved?.attachments));
	await settled(ids.a);
	step("1h. sending clears the chip and the stored row", (await chips()).length === 0 && await stored("a") === null);
	await goToSession("b");
	await back("a");
	await delay(500);
	step("1i. a sent attachment never comes back", (await chips()).length === 0);

	await fresh("s2");
	await open("s2");
	// 2. Reload with a finished upload: restored; Remove releases it.
	await attach(small);
	if (!await waitChips(["zz-prove-it-notes.txt"])) { await shot("debug-s2"); console.log("s2 debug", JSON.stringify({ chips: await chips(), alerts: await alerts(), seen: seen.slice(-4), errors: consoleErrors.slice(-3) })); }
	const second = JSON.parse(await stored("s2")).rows[0];
	await reload();
	step("2a. a reload restores a finished upload", await waitChips(["zz-prove-it-notes.txt"]));
	await page.click('[data-attachment-upload] button[aria-label^="Remove"]');
	await delay(800);
	const removal = seen.findLast(item => item.method === "DELETE" && item.url === `/api/attachments/${second.id}`);
	step("2b. Remove forgets it and releases the server's copy", (await chips()).length === 0 && await stored("s2") === null && removal?.status === 204 && !pendingFiles().some(file => file.startsWith(second.id)), JSON.stringify({ removal, pending: pendingFiles() }));

	await fresh("s3");
	await open("s3");
	// 3. An upload still running when the learner leaves.
	await throttle(64 * 1024);
	await attach(big);
	await page.waitForSelector("[data-attachment-upload] progress");
	await delay(1500);
	const running = seen.findLast(item => item.method === "PUT");
	step("3a. a throttled upload is mid-transfer (progress bar, PUT in flight)", await progress() === 1 && running && !running.status && !running.failed, JSON.stringify(running));
	await shot("03-pending");
	const grantBeforeLeave = seen.findLast(item => item.method === "POST" && item.url === "/api/attachments");
	const postsAtLeave = grantPosts();
	await goToSession("b");
	await throttle(-1);
	await delay(1500);
	const pendingId = running?.url.split("id=")[1]?.split("&")[0];
	const release = seen.findLast(item => item.method === "DELETE" && item.url.startsWith("/api/attachments/") && item.url.endsWith(pendingId ?? "?"));
	step("3b. leaving aborted the transfer", running?.failed === true, JSON.stringify(running));
	step("3c. leaving released the reservation (DELETE issued)", Boolean(release), JSON.stringify({ release, pendingId }));
	step("3d. nothing half-kept: no stored row for the session", await stored("s3") === null);
	await back("s3");
	await delay(800);
	step("3e. Back shows no chip and uploads nothing again", (await chips()).length === 0 && grantPosts() === postsAtLeave, `posts ${grantPosts()} vs ${postsAtLeave}`);
	await shot("04-after-pending-back");
	const pendingAfter = pendingFiles();
	step("3f. the server holds no bytes for it", !pendingAfter.some(file => file.startsWith(pendingId ?? "-")) || (release?.status !== 204), JSON.stringify({ releaseStatus: release?.status, pendingAfter }));

	await fresh("s4");
	await open("s4");
	// 4. Reload while an upload runs: reselect required, nothing stored.
	await throttle(64 * 1024);
	await attach(big);
	await page.waitForSelector("[data-attachment-upload] progress");
	await delay(1000);
	await reload();
	await throttle(-1);
	await delay(800);
	step("4. a reload mid-upload leaves no chip and no stored row", (await chips()).length === 0 && await stored("s4") === null);

	await fresh("s5");
	await open("s5");
	// 5. The server's copy is gone: the chip drops out quietly.
	await attach(small);
	await waitChips(["zz-prove-it-notes.txt"]);
	const third = JSON.parse(await stored("s5")).rows[0];
	await goToSession("b");
	let removed = 0;
	for (const file of pendingFiles().filter(name => name.startsWith(third.id))) { fs.unlinkSync(path.join(PENDING, file)); removed++; }
	await back("s5");
	const gone = await waitChips([], 8000);
	await delay(500);
	const gate = seen.findLast(item => item.method === "GET" && item.url === `/api/attachments/${third.id}?chatId=${ids.s5}`);
	step("5a. an upload the server dropped leaves quietly: no chip, no alert, no stored row", removed > 0 && gone && (await alerts()).length === 0 && await stored("s5") === null && gate?.status === 404, JSON.stringify({ removed, gate, alerts: await alerts() }));
	await sendText("zz-prove-it send after the file expired");
	let plain;
	for (let i = 0; i < 100 && !plain; i++) {
		plain = ((await record(ids.s5)).messages ?? []).find(message => message.role === "user" && JSON.stringify(message.content).includes("after the file expired"));
		if (!plain) await delay(200);
	}
	step("5b. the text still sends, with no attachment", Boolean(plain) && !plain.attachments?.length);
	await settled(ids.s5);

	await fresh("s6");
	await open("s6");
	// 6. Tolerant reads in the real browser.
	const good = { id: "11111111-1111-4111-8111-111111111111", name: "zz-prove-it-ghost.txt", at: Date.now(), mimeType: "text/plain", size: 3 };
	for (const [label, value] of [["unparsable", "{corrupt"], ["wrong shape", JSON.stringify({ rows: "no" })], ["malformed rows", JSON.stringify({ rows: [null, 5, { id: "x" }, { ...good, size: -1 }] })], ["a row the server never had", JSON.stringify({ rows: [good, { id: 1 }] })]]) {
		await page.evaluate((key, text) => localStorage.setItem(key, text), KEY(ids.s6), value);
		await reload();
		await delay(1200);
		step(`6. stored state "${label}": the page loads and shows no chip`, (await chips()).length === 0 && (await alerts()).length === 0);
	}
	await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ text: "an old text-only draft", at: Date.now() })), TEXT_KEY(ids.s6));
	await reload();
	step("6. an old text-only draft still restores its text, with no chip", (await page.$eval('[data-testid="composer"] [contenteditable="true"]', element => element.textContent)).includes("an old text-only draft") && (await chips()).length === 0);

	// Chrome logs each non-2xx fetch: the known 503 (/api/stt/token, no Deepgram key, budgets.json) and one 404 per status check the server answered 404 (the dropped chips).
	const answered404 = seen.filter(item => item.method === "GET" && item.status === 404).length;
	const unexpected = consoleErrors.filter(text => !/status of 503/.test(text) && !/status of 404/.test(text));
	const logged404 = consoleErrors.filter(text => /status of 404/.test(text)).length;
	step("console: no errors beyond the known 503 and one 404 per dropped chip", unexpected.length === 0 && logged404 === answered404 && answered404 === 2, JSON.stringify({ answered404, logged404, unexpected }));
	fs.writeFileSync(path.join(OUT, "attachment-requests.json"), JSON.stringify(seen, null, "\t"));
	for (const id of Object.values(ids)) await fetch(`${APP}/api/chats/${id}?mode=delete`, { method: "DELETE", headers: { origin: APP } }).catch(() => {});
} catch (error) {
	step("the drive itself completed", false, String(error?.stack ?? error));
} finally {
	fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ steps, consoleErrors }, null, "\t"));
	await browser.close();
}
const failed = steps.filter(item => !item.ok);
console.log(`${steps.length - failed.length}/${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);

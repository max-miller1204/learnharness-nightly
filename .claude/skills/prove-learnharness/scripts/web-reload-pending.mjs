#!/usr/bin/env node
/**
 * Reload while an upload is running (issue #367): does the server keep the
 * reservation? Prints what `pending/` holds for the upload before the reload
 * and 15 s after, and the DELETE the page sent. Runs on any build:
 *
 *   node scripts/web-reload-pending.mjs <instance.env>
 *
 * Exit 1 when files for the upload are still staged after the wait.
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import { signIn, signInPage } from "./sign-in.mjs";

const instancePath = process.argv[2];
const sideDir = path.dirname(instancePath);
const inst = Object.fromEntries(fs.readFileSync(instancePath, "utf8").split("\n").filter(line => line.includes("=")).map(line => {
	const index = line.indexOf("=");
	return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "")];
}));
const APP = inst.APP_URL;
const PENDING = `${inst.DATA_DIR}-attachments/pending`;
signIn(inst);
const out = path.join(sideDir, "web-reload-pending");
fs.mkdirSync(out, { recursive: true });
const big = path.join(out, "zz-prove-it-big.bin");
fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 7));
const { id } = await (await fetch(`${APP}/api/chats`, { method: "POST", headers: { "content-type": "application/json", origin: APP }, body: JSON.stringify({ title: `zz-prove-it reload pending ${Date.now()}` }) })).json();
const staged = () => (fs.existsSync(PENDING) ? fs.readdirSync(PENDING) : []);
const before = new Set(staged());

const browser = await puppeteer.launch({ executablePath: process.env.PROVE_CHROME || "/usr/bin/google-chrome", headless: true, userDataDir: path.join(sideDir, "chrome-profile", "reload-pending") });
let result;
try {
	const page = await browser.newPage();
	await signInPage(page, inst);
	const deletes = [];
	page.on("request", request => { if (request.method() === "DELETE" && request.url().includes("/api/attachments/")) deletes.push(request.url().replace(APP, "")); });
	await page.goto(`${APP}/chat/${id}`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector("[data-attachment-upload]");
	const cdp = await page.createCDPSession();
	await cdp.send("Network.enable");
	await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 64 * 1024 });
	await (await page.$('[data-testid="attach-files-input"]')).uploadFile(big);
	await page.waitForSelector("[data-attachment-upload] progress");
	await delay(2000);
	const during = staged().filter(file => !before.has(file));
	await page.reload({ waitUntil: "domcontentloaded" });
	await delay(15_000);
	const after = staged().filter(file => !before.has(file));
	result = { stagedDuring: during, stagedAfter15s: after, deletesSentByThePage: deletes };
} finally { await browser.close(); }
console.log(JSON.stringify(result));
fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, "\t"));
process.exit(result.stagedAfter15s.length ? 1 : 0);

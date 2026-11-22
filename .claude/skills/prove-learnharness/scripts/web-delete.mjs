#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";
import { signIn, signInPage } from "./sign-in.mjs";

const instancePath = process.argv[2];
const sideDir = dirname(instancePath);
const inst = Object.fromEntries(readFileSync(instancePath, "utf8").split("\n")
	.filter((line) => line.includes("=")).map((line) => {
		const index = line.indexOf("=");
		return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "")];
	}));
const app = inst.APP_URL;
signIn(inst);
async function post(path, body) {
	const response = await fetch(app + path, {
		method: "POST",
		headers: { "content-type": "application/json", origin: app },
		body: JSON.stringify(body),
	});
	assert.equal(response.status, 200, path);
	return response.json();
}

const browser = await puppeteer.launch({
	executablePath: process.env.PROVE_CHROME || "/usr/bin/google-chrome",
	headless: true,
	userDataDir: join(sideDir, "chrome-profile", "delete"),
});
const results = [];
const testId = (id) => `[data-testid="${id}"]`;

try {
	for (const mode of ["single", "folder", "graph"]) {
		const page = await browser.newPage();
		page.setDefaultTimeout(10_000);
		const result = { mode, session404s: [] };
		let stage = "fixture setup";
		results.push(result);
		try {
			const title = `zz-prove-it delete ${mode} ${Date.now()}`;
			const marker = `Delete transcript fixture ${mode}`;
			const { id } = await post("/api/chats", { title });
			const sessionApi = `/api/chats/${id}`;
			const sessionPage = `/chat/${id}`;
			await post("/api/chat", { chatId: id, input: { type: "text", text: marker } });
			const settledBy = Date.now() + 20_000;
			for (;;) {
				const response = await fetch(app + "/api/chats");
				assert.equal(response.status, 200);
				if ((await response.json()).chats.find((chat) => chat.id === id)?.busy === false) break;
				assert.ok(Date.now() < settledBy, "fixture turn must settle before deletion");
				await delay(100);
			}

			let folderId;
			if (mode === "folder") {
				({ createdFolderId: folderId } = await post("/api/graph/sources", { action: "create-folder", name: title, parentId: null }));
				await post("/api/graph/sources", { action: "move", kind: "source", id, parentId: folderId });
			}
			await signInPage(page, inst);
			await page.setViewport({ width: 1280, height: 900 });
			await page.goto(app, { waitUntil: "domcontentloaded" });
			const row = `[data-session-id="${id}"]`;
			const click = async (selector, options) => {
				await page.waitForSelector(selector, { visible: true });
				await page.click(selector, options);
			};
			const waitForSession = () => page.waitForFunction((path, text) =>
				location.pathname === path &&
				document.querySelector("[data-session-surface]")?.textContent.includes(text) &&
				document.querySelector('[data-testid="composer"]'), {}, sessionPage, marker);
			const home = 'a[aria-label="Home"]';
			const folder = `button${testId(`sidebar-folder-${folderId}`)}`;
			if (folderId && !(await page.$(row))) await click(folder);
			await click(row);
			await waitForSession();
			await click(home);
			await page.waitForFunction(() => location.pathname === "/");

			let deletePath = "/api/graph/sources";
			let confirm = "source-delete-confirm";
			if (mode === "graph") {
				await click(row);
				await waitForSession();
				await click(home);
				await click(testId("open-chain-table"));
				await click(testId(`cluster-checkbox-${id}`));
				await click(testId("chain-delete"));
				await click(testId("delete-source-sessions"));
			} else {
				await click(row);
				await waitForSession();
				await click(folderId ? folder : row, { button: "right" });
				await click(testId(folderId ? "folder-ctx-delete" : "ctx-delete"));
				deletePath = folderId ? `/api/graph/sources/folders/${folderId}` : sessionApi;
				confirm = "delete-confirm";
			}
			await page.waitForSelector(testId(confirm), { visible: true });
			const isDelete = (request) => request.method() === "DELETE" &&
				new URL(request.url()).pathname === deletePath;

			// Hold the real success at the browser boundary. With graph deletion,
			// revisit the cached session while the server has removed it and the
			// deleting window still considers the DELETE pending.
			if (mode === "graph") {
				await page.evaluate((path) => {
					const original = window.fetch;
					window.fetch = async (...args) => {
						const response = await original(...args);
						if (args[0] === path && args[1]?.method === "DELETE") {
							await new Promise((release) => { window.__proveReleaseDelete = release; });
						}
						return response;
					};
				}, deletePath);
			}
			page.on("response", (response) => {
				const url = new URL(response.url());
				if (url.origin === app && response.status() === 404 &&
					(url.pathname === sessionApi || url.pathname.startsWith(sessionApi + "/"))) {
					result.session404s.push(`${response.request().method()} ${url.pathname}`);
				}
			});
			stage = "confirm deletion";
			const deletion = page.waitForResponse((response) => isDelete(response.request()));
			await click(testId(confirm));
			result.deleteStatus = (await deletion).status();
			assert.equal(result.deleteStatus, 200, "server accepted deletion");
			if (mode === "graph") {
				stage = "revisit cached session during deletion";
				await page.waitForFunction(() => typeof window.__proveReleaseDelete === "function");
				await page.evaluate(() => history.back());
				await waitForSession();
				// Session mount reads and their retries can run before the held
				// response is released if the graph fails to mark the session.
				await delay(2_200);
				await page.evaluate(() => window.__proveReleaseDelete());
				// The sidebar replaces the open session with Home. The older
				// visit is exercised independently below by Back.
			}
			stage = "clear open session after DELETE";
			await page.waitForFunction(() => location.pathname === "/" &&
				!document.querySelector("[data-session-surface]"));
			stage = "Back to deleted session";
			await page.evaluate(() => history.go(-2));
			await page.waitForFunction((path) => location.pathname === path &&
				document.body.textContent.includes("This page could not be found."), {}, sessionPage);
			assert.equal(await page.$("[data-session-surface]"), null, "transcript surface is gone");
			assert.equal(await page.$(testId("composer")), null, "composer is gone");
			await delay(2_200);
			result.notFound = true;
		} catch (error) {
			result.error = `${stage}: ${error.message}`;
			result.view = await page.evaluate(() => ({
				path: location.pathname,
				transcript: Boolean(document.querySelector("[data-session-surface]")),
				composer: Boolean(document.querySelector('[data-testid="composer"]')),
			})).catch(() => null);
		} finally {
			result.ok = !result.error && result.session404s.length === 0;
			console.log(JSON.stringify(result));
			await page.close();
		}
	}
} finally {
	await browser.close();
	writeFileSync(join(sideDir, "web-delete.json"), JSON.stringify(results, null, 2) + "\n");
}
if (results.some((result) => !result.ok)) process.exitCode = 1;

"use strict";

const http = require("node:http");
const { AUTHORIZE, pastedCallback } = require("./chatgpt.cjs");
const { isBrowserAction } = require("./web-subscription-browser.cjs");
const { requestServer, ServerProblem } = require("./remote-server.cjs");

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const LOGIN_PATH = "/api/subscriptions";

async function remoteChatGPTSignIn(origin, token, {
	openExternal, signal, request, createListener = () => http.createServer(),
	timeoutMs = 180000,
}) {
	const listener = createListener();
	const timeout = AbortSignal.timeout(timeoutMs);
	const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const headers = { origin, "x-learnharness-subscriptions": "1" };
	const send = (pathname, options) => requestServer(origin, pathname, { ...options, signal: lifetime, token, request });
	const control = async (op, fields) => {
		const response = await send(LOGIN_PATH, {
			method: "POST", headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ providerId: "chatgpt", op, ...fields }),
		});
		if (!response.ok) throw new ServerProblem("sign-in", "The server couldn’t complete the ChatGPT request.");
		return response.json();
	};
	const bind = new Promise((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(0, CALLBACK_HOST, resolve);
	});
	let settling;
	let consumed = false;
	try {
		try { await bind; } catch { throw new ServerProblem("sign-in", "Couldn’t reserve the local ChatGPT callback port."); }
		lifetime.throwIfAborted();
		const { port } = listener.address();
		const callbackHost = `${CALLBACK_HOST}:${port}`;
		const callbackUrl = `http://${callbackHost}${CALLBACK_PATH}`;
		const reply = await control("login", { desktopRedirectPort: port });
		if (!isBrowserAction(reply?.browserAction)) throw new ServerProblem("sign-in", "The server couldn’t start ChatGPT sign-in. Check Providers on the server.");
		const action = await send(reply.browserAction, { method: "POST", headers, redirect: "manual" });
		let target;
		try { target = new URL(action.headers.get("location")); } catch { /* Fail below. */ }
		const state = target?.searchParams.getAll("state");
		if (action.status !== 303 || !target || target.username || target.password || target.hash ||
			`${target.origin}${target.pathname}` !== AUTHORIZE ||
			target.searchParams.getAll("redirect_uri").length !== 1 ||
			target.searchParams.get("redirect_uri") !== callbackUrl || state.length !== 1 || !state[0]) {
			throw new ServerProblem("sign-in", "The server returned an unexpected ChatGPT callback. Update LearnHarness on the server and try again.");
		}
		const callback = new Promise((resolve) => {
			listener.on("request", (req, res) => {
				res.setHeader("Cache-Control", "no-store");
				res.setHeader("Content-Security-Policy", "default-src 'none'");
				res.setHeader("Referrer-Policy", "no-referrer");
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				if (consumed || lifetime.aborted || req.method !== "GET" || req.headers.host !== callbackHost || !req.url?.startsWith(`${CALLBACK_PATH}?`)) {
					res.writeHead(404).end();
					return;
				}
				const exact = `http://${callbackHost}${req.url}`;
				try { pastedCallback(exact, callbackUrl, state[0]); } catch {
					res.writeHead(400).end("Sign-in could not be verified.");
					return;
				}
				consumed = true;
				res.writeHead(200).end("Return to LearnHarness to view the sign-in result. You may close this tab.");
				resolve(exact);
			});
		});
		lifetime.throwIfAborted();
		const interrupted = new Promise((resolve) => {
			const cancel = () => resolve(null);
			lifetime.addEventListener("abort", cancel, { once: true });
			settling = () => lifetime.removeEventListener("abort", cancel);
		});
		await openExternal(target.href);
		const exact = await Promise.race([callback, interrupted]);
		if (!exact) throw new ServerProblem("sign-in", "ChatGPT sign-in ended. Try again from Switch server.");
		const { value } = await control("complete", { url: exact });
		if (!value?.activeId || value.error) throw new ServerProblem("sign-in", "ChatGPT sign-in did not complete. Check Providers on the server.");
	} finally {
		settling?.();
		listener.close();
		listener.closeAllConnections();
	}
}

module.exports = { remoteChatGPTSignIn };

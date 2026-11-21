"use strict";

const http = require("node:http");
const { AUTHORIZE, pastedCallback } = require("./chatgpt.cjs");
const { isBrowserAction } = require("./web-subscription-browser.cjs");
const { requestServer, ServerProblem } = require("./remote-server.cjs");

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const LOGIN_PATH = "/api/subscriptions";
const ENDED = "ChatGPT sign-in ended. Try again.";

// `accountId`: sign in again to that saved account (the server's own `login` id).
async function remoteChatGPTSignIn(origin, token, {
	openExternal, signal, request, createListener = () => http.createServer(),
	timeoutMs = 180000, accountId,
}) {
	const listener = createListener();
	const timeout = AbortSignal.timeout(timeoutMs);
	const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const headers = { origin, "x-learnharness-subscriptions": "1" };
	const send = (pathname, options) => requestServer(origin, pathname, { ...options, signal: lifetime, token, request });
	const control = async (op, fields, operationSignal = lifetime) => {
		const response = await requestServer(origin, LOGIN_PATH, {
			request, token, signal: operationSignal,
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
	let pending = false;
	// The server's id for this attempt: the cancel below ends only it, never a newer sign-in.
	// An older server sends none, and its cancel ends whatever is pending, as before.
	let attemptId;
	try {
		try { await bind; } catch { throw new ServerProblem("sign-in", "Couldn’t reserve the local ChatGPT callback port."); }
		lifetime.throwIfAborted();
		const { port } = listener.address();
		const callbackHost = `${CALLBACK_HOST}:${port}`;
		const callbackUrl = `http://${callbackHost}${CALLBACK_PATH}`;
		// Collect the login reply even if the user aborts during this request.
		// Only an acknowledged browser action establishes an attempt to cancel.
		const reply = await control("login", { ...(accountId && { id: accountId }), desktopRedirectPort: port }, AbortSignal.timeout(15000));
		if (!isBrowserAction(reply?.browserAction)) {
			// The server's own public reason (a sign-in already pending, disconnected), bounded.
			const reason = typeof reply?.value?.error === "string" && reply.value.error.trim() ? reply.value.error.trim().slice(0, 300) : null;
			throw new ServerProblem("sign-in", reason ?? "The server couldn’t start ChatGPT sign-in. Check Providers on the server.");
		}
		pending = true;
		if (typeof reply.attemptId === "string" && reply.attemptId.length <= 200) attemptId = reply.attemptId;
		lifetime.throwIfAborted();
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
		const opened = openExternal(target.href).then(() => callback);
		const exact = await Promise.race([opened, interrupted]);
		if (!exact) throw new ServerProblem("sign-in", ENDED);
		const { value } = await control("complete", { url: exact });
		pending = false;
		if (!value?.activeId || value.error) throw new ServerProblem("sign-in", "ChatGPT sign-in did not complete. Check Providers on the server.");
	} finally {
		settling?.();
		listener.close();
		listener.closeAllConnections();
		if (pending) {
			await control("cancel", attemptId ? { attemptId } : undefined, AbortSignal.timeout(5000)).catch(() => {});
		}
	}
}

/**
 * The open remote window's sign-in (electron/remote-chatgpt-ipc.cjs). One at a time: a new
 * start ends the previous one, after that one's cancel reached its server. The page sees
 * only { ok: true } or a fixed message, never a URL, port or credential.
 * `selection()`: { origin, token } of the open remote window, or null while there is none
 * or its server is being removed or updated.
 */
function createRemoteChatGPTSignIn({ selection, openExternal, run = remoteChatGPTSignIn, ...options }) {
	let current = null;
	// Settles after the latest attempt, including any cancel it sends.
	let last = Promise.resolve();
	async function signIn(accountId) {
		const selected = selection();
		if (!selected) return { error: "Open this server in the desktop app to sign in to ChatGPT." };
		current?.abort();
		const operation = new AbortController();
		current = operation;
		const previous = last;
		let settled;
		last = new Promise((resolve) => { settled = resolve; });
		try {
			await previous;
			operation.signal.throwIfAborted();
			// Queued behind a slow cancel: the window may have switched, or its server be held, by now.
			const still = selection();
			if (!still || still.origin !== selected.origin || still.token !== selected.token) return { error: ENDED };
			await run(selected.origin, selected.token, { ...options, accountId, openExternal, signal: operation.signal });
			return { ok: true };
		} catch (error) {
			if (operation.signal.aborted) return { error: ENDED };
			return { error: error instanceof ServerProblem ? error.message : "ChatGPT sign-in failed. Try again." };
		} finally {
			settled();
			if (current === operation) current = null;
		}
	}
	function abort() { current?.abort(); current = null; }
	return {
		signIn,
		/** The window closed or switched, or an update covers its server: its sign-in ends. */
		abort,
		/** Settings' Cancel: ends this window's sign-in, also while its login is in flight, and
		 *  resolves once that attempt's own cancel reached its server. `ended`: there was one,
		 *  so the page sends no cancel of its own (that would end whatever is pending). */
		async cancel() {
			const ended = current !== null;
			abort();
			await last;
			return { ok: true, ended };
		},
	};
}

module.exports = { remoteChatGPTSignIn, createRemoteChatGPTSignIn };

"use strict";

const http = require("node:http");
const { AUTHORIZE, pastedCallback, publicError } = require("./chatgpt.cjs");
const { isBrowserAction } = require("./web-subscription-browser.cjs");
const { requestServer, ServerProblem } = require("./remote-server.cjs");

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const LOGIN_PATH = "/api/subscriptions";
const ENDED = "ChatGPT sign-in ended. Try again.";
// The server's own refusal while another sign-in is pending (electron/chatgpt.cjs).
const SERVER_PENDING = publicError({ code: "pending" });
const STALE = "A sign-in started before this server was removed is still finishing on the server. Try again in a few minutes.";
// The server's own sign-in timeout (createChatGPT's default): an attempt whose cancel was
// skipped stays pending on the server at most this long.
const SERVER_ATTEMPT_MS = 300000;

// `accountId`: sign in again to that saved account (the server's own `login` id).
// `revoked`: aborts once `token` must never be sent again (its server is being removed).
// The attempt then ends at once and sends nothing more, not even its own cancel. An
// acknowledged attempt hands that cancel to `deferCancel(send)` instead, for the caller to
// send only if the removal fails and the bearer is kept after all.
async function remoteChatGPTSignIn(origin, token, {
	openExternal, signal, revoked, deferCancel, request, createListener = () => http.createServer(),
	timeoutMs = 180000, accountId,
}) {
	const listener = createListener();
	const timeout = AbortSignal.timeout(timeoutMs);
	const lifetime = AbortSignal.any([timeout, ...(signal ? [signal] : []), ...(revoked ? [revoked] : [])]);
	const headers = { origin, "x-learnharness-subscriptions": "1" };
	const send = (pathname, options) => {
		revoked?.throwIfAborted();
		return requestServer(origin, pathname, { ...options, signal: lifetime, token, request });
	};
	const post = async (op, fields, operationSignal) => {
		const response = await requestServer(origin, LOGIN_PATH, {
			request, token, signal: operationSignal,
			method: "POST", headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ providerId: "chatgpt", op, ...fields }),
		});
		if (!response.ok) throw new ServerProblem("sign-in", "The server couldn’t complete the ChatGPT request.");
		return response.json();
	};
	const control = (op, fields, operationSignal = lifetime) => {
		revoked?.throwIfAborted();
		return post(op, fields, revoked ? AbortSignal.any([operationSignal, revoked]) : operationSignal);
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
		if (!exact || lifetime.aborted) throw new ServerProblem("sign-in", ENDED);
		const { value } = await control("complete", { url: exact });
		pending = false;
		if (!value?.activeId || value.error) throw new ServerProblem("sign-in", "ChatGPT sign-in did not complete. Check Providers on the server.");
	} finally {
		settling?.();
		listener.close();
		listener.closeAllConnections();
		const fields = attemptId ? { attemptId } : undefined;
		// A revoked credential is never sent, not even to cancel. The server's attempt then
		// either finishes a `complete` already sent, or waits for a callback this closed
		// listener never relays and ends at the server's own sign-in timeout.
		if (pending && revoked?.aborted) deferCancel?.(() => post("cancel", fields, AbortSignal.timeout(5000)).catch(() => {}));
		else if (pending) await control("cancel", fields, AbortSignal.timeout(5000)).catch(() => {});
	}
}

/**
 * The open remote window's sign-in (electron/remote-chatgpt-ipc.cjs). One at a time: a new
 * start ends the previous one, after that one's cancel reached its server. The page sees
 * only { ok: true } or a fixed message, never a URL, port or credential.
 * `selection()`: { origin, token } of the open remote window, or null while there is none
 * or its server is being removed or updated.
 */
function createRemoteChatGPTSignIn({ selection, openExternal, run = remoteChatGPTSignIn, now = Date.now, ...options }) {
	let current = null;
	// Every attempt that hasn't settled, the current one and any older one still ending:
	// { origin, operation, revoked, finished, deferred }.
	const attempts = new Set();
	// Origins with an attempt whose cancel a removal skipped: until when the server may still
	// hold it pending, and refuse a new sign-in for it.
	const stale = new Map();
	// Settles after the latest attempt, including any cancel it sends.
	let last = Promise.resolve();
	async function signIn(accountId) {
		const selected = selection();
		if (!selected) return { error: "Open this server in the desktop app to sign in to ChatGPT." };
		current?.abort();
		const operation = new AbortController();
		let settled;
		const finished = new Promise((resolve) => { settled = resolve; });
		const attempt = { origin: selected.origin, operation, revoked: new AbortController(), finished, deferred: null };
		attempts.add(attempt);
		current = operation;
		const previous = last;
		last = finished;
		try {
			await previous;
			operation.signal.throwIfAborted();
			// Queued behind a slow cancel: the window may have switched, or its server be held, by now.
			const still = selection();
			if (!still || still.origin !== selected.origin || still.token !== selected.token) return { error: ENDED };
			const deferCancel = (send) => {
				attempt.deferred = send;
				stale.set(selected.origin, now() + SERVER_ATTEMPT_MS);
			};
			await run(selected.origin, selected.token, { ...options, accountId, openExternal, signal: operation.signal, revoked: attempt.revoked.signal, deferCancel });
			return { ok: true };
		} catch (error) {
			if (operation.signal.aborted) return { error: ENDED };
			// Paired again right after a removal: the server still holds the attempt that removal
			// ended without a cancel, and says only that a sign-in is pending.
			if (error instanceof ServerProblem && error.message === SERVER_PENDING && (stale.get(selected.origin) ?? 0) > now()) return { error: STALE };
			return { error: error instanceof ServerProblem ? error.message : "ChatGPT sign-in failed. Try again." };
		} finally {
			attempts.delete(attempt);
			settled();
			if (current === operation) current = null;
		}
	}
	function abort() { current?.abort(); current = null; }
	return {
		signIn,
		/** The window closed or switched, or an update covers its server: its sign-in ends. */
		abort,
		/** `origin` is being removed: every attempt for it ends now, also one still ending after
		 *  a switch, and none sends another request with its bearer, not even its cancel.
		 *  `kept()`: the removal failed and the bearer stays saved, so the cancels it skipped go
		 *  out after all, with that kept bearer. Resolves once they have. */
		forget(origin) {
			const forgotten = [...attempts].filter((attempt) => attempt.origin === origin);
			for (const attempt of forgotten) {
				attempt.revoked.abort();
				attempt.operation.abort();
				if (current === attempt.operation) current = null;
			}
			return {
				async kept() {
					await Promise.all(forgotten.map((attempt) => attempt.finished));
					const sends = forgotten.map((attempt) => attempt.deferred).filter(Boolean);
					if (sends.length) stale.delete(origin);
					await Promise.all(sends.map((send) => send()));
				},
			};
		},
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

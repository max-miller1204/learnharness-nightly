"use strict";

const http = require("node:http");
const { AUTHORIZE, ATTEMPT_TIMEOUT_MS, pastedCallback, publicError } = require("./chatgpt.cjs");
const { isBrowserAction } = require("./web-subscription-browser.cjs");
const { requestServer, ServerProblem } = require("./remote-server.cjs");

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const LOGIN_PATH = "/api/subscriptions";
const ENDED = "ChatGPT sign-in ended. Try again.";
// The server's own refusal while another sign-in is pending (electron/chatgpt.cjs).
const SERVER_PENDING = publicError({ code: "pending" });
const STALE = "A sign-in started before this server was removed is still finishing on the server. Try again in a few minutes.";

// `accountId`: sign in again to that saved account (the server's own `login` id).
// `onLogin()`: runs as the `login` request goes out (the server's attempt may start then).
// `revoked`: aborts once `token` must never be sent again (its server is being removed).
// The attempt then ends at once and sends nothing more, not even its own cancel. It calls
// `deferCancel(send)` instead whenever the server may still hold the attempt pending:
// `send` is the cancel to send only if the removal fails and the bearer is kept after all,
// or null when there is none to send.
async function remoteChatGPTSignIn(origin, token, {
	openExternal, signal, revoked, deferCancel, onLogin, request, createListener = () => http.createServer(),
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
	let loginSent = false;
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
		revoked?.throwIfAborted();
		loginSent = true;
		onLogin?.();
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
		const sendCancel = () => post("cancel", fields, AbortSignal.timeout(5000));
		// A revoked credential is never sent, not even to cancel. The server's attempt then
		// either finishes a `complete` already sent, or waits for a callback this closed
		// listener never relays and ends at the server's own sign-in timeout.
		if (revoked?.aborted && pending) deferCancel?.(sendCancel);
		// The login went out but its reply was cut off: the server may have started an attempt
		// this desktop never learned the id of. No cancel at all, not even later: without an
		// id an older server would end whatever is pending, possibly another device's sign-in.
		// That attempt ends at the server's own timeout.
		else if (revoked?.aborted && loginSent) deferCancel?.(null);
		else if (pending) {
			try { await control("cancel", fields, AbortSignal.timeout(5000)); }
			catch {
				// The removal cut this cancel off, perhaps before the server saw it. Only one that
				// names its attempt is safe to send again; a blind one could end a newer sign-in.
				if (revoked?.aborted) deferCancel?.(attemptId ? sendCancel : null);
			}
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
function createRemoteChatGPTSignIn({ selection, openExternal, run = remoteChatGPTSignIn, now = Date.now, ...options }) {
	let current = null;
	// Every attempt that hasn't settled, the current one and any older one still ending:
	// { origin, operation, revoked, finished, deferred }.
	const attempts = new Set();
	// Origins with an attempt a removal ended without its cancel: until when the server may
	// still hold it pending (its `login` time plus the server's timeout), and so refuse a new
	// sign-in for it.
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
		for (const [origin, until] of stale) if (until <= now()) stale.delete(origin);
		const attempt = { origin: selected.origin, operation, revoked: new AbortController(), finished, loginAt: null, stale: false, deferred: null };
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
			const onLogin = () => { attempt.loginAt = now(); };
			const deferCancel = (send) => {
				attempt.deferred = send;
				attempt.stale = true;
				const until = (attempt.loginAt ?? now()) + ATTEMPT_TIMEOUT_MS;
				stale.set(selected.origin, Math.max(stale.get(selected.origin) ?? 0, until));
			};
			await run(selected.origin, selected.token, { ...options, accountId, openExternal, signal: operation.signal, revoked: attempt.revoked.signal, deferCancel, onLogin });
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
		 *  `kept()`: the removal failed and the bearer is verifiably still saved, so the cancels it
		 *  skipped go out after all, with that kept bearer. Resolves once they have. The origin
		 *  stops counting as stale only when every attempt it skipped has been cancelled. */
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
					const skipped = forgotten.filter((attempt) => attempt.stale);
					const results = await Promise.allSettled(skipped.map((attempt) => attempt.deferred ? attempt.deferred() : Promise.reject(new Error("No cancel to send."))));
					if (skipped.length && results.every(({ status }) => status === "fulfilled")) stale.delete(origin);
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

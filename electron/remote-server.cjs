"use strict";

const { desktopAPIHeaders } = require("./desktop-api.cjs");

// The packaged shell has no TS runtime dependency. The focused protocol test
// checks these values against the server contract.
const CLIENT_PROTOCOL_VERSION = 1;
const PROTOCOL_HEADER = "x-learnharness-protocol";
const SERVER_INFO_PATH = "/.well-known/learnharness/server";
const TOKEN_PATH = "/oauth/token";
const SESSION_PATH = "/api/auth/session";
const PAIRING_CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;
// Like T3's bootstrap retry: a server that is starting or restarting
// answers with a network error or a gateway status for a moment.
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const retryTiming = { windowMs: 15000, stepMs: 500 };

class ServerProblem extends Error {
	constructor(kind, message) {
		super(message);
		this.kind = kind;
	}
}

function parseOrigin(value) {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!/^https:\/\/[^/\\?#@\s]+\/?$/i.test(text)) return null;
	try { return new URL(text).origin; } catch { return null; }
}

function normalizeCode(value) {
	const code = typeof value === "string" && value.replace(/[\s-]+/g, "").toUpperCase();
	return PAIRING_CODE.test(code) ? code : null;
}

function parsePairLink(value) {
	try {
		const url = new URL(value.trim());
		const origin = parseOrigin(url.origin);
		const tokens = new URLSearchParams(url.hash.slice(1)).getAll("token");
		const code = normalizeCode(tokens[0]);
		if (origin && !url.username && !url.password && url.pathname === "/pair" && !url.search && tokens.length === 1 && code) return { origin, code };
	} catch { /* The manual fields are still available. */ }
	return null;
}

function atOrigin(value, origin) {
	try {
		const url = new URL(value);
		return url.origin === origin && !url.username && !url.password;
	} catch { return false; }
}

function requestServer(origin, pathname, { request = fetch, signal, redirect = "error", token, headers, timeoutMs = 15000, ...options } = {}) {
	const url = new URL(pathname, origin);
	if (parseOrigin(origin) !== origin || !atOrigin(url, origin)) throw new Error("Expected a request to the selected server.");
	const timeout = AbortSignal.timeout(timeoutMs);
	return request(url, {
		...options, redirect, credentials: "omit", cache: "no-store",
		headers: { [PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION), ...headers, ...(token && { authorization: `Bearer ${token}` }) },
		signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
	});
}

function unreachable() {
	return new ServerProblem("retry", "Couldn’t reach the LearnHarness server. Check the address and connection, then retry.");
}

function pause(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const done = () => { signal?.removeEventListener("abort", stop); resolve(); };
		const timer = setTimeout(done, ms);
		const stop = () => { clearTimeout(timer); reject(signal.reason); };
		signal?.addEventListener("abort", stop, { once: true });
	});
}

function isTransportError(error) {
	return error instanceof TypeError || error?.name === "TimeoutError" || error?.name === "AbortError";
}

// `retry` waits out a starting server. The one-use pairing exchange never sets it.
async function serverJSON(origin, pathname, { retry = false, ...options } = {}) {
	// The whole wait, including a silent attempt's timeout, ends at the deadline.
	const deadline = Date.now() + retryTiming.windowMs;
	try {
		for (;;) {
			const timeoutMs = retry ? Math.max(deadline - Date.now(), retryTiming.stepMs) : undefined;
			let response;
			try {
				response = await requestServer(origin, pathname, { ...options, ...(timeoutMs && { timeoutMs }) });
			} catch (error) {
				const waiting = retry && Date.now() < deadline;
				if (!waiting || options.signal?.aborted || !isTransportError(error)) throw error;
				await pause(retryTiming.stepMs, options.signal);
				continue;
			}
			if (retry && Date.now() < deadline && TRANSIENT_STATUS.has(response.status)) {
				await response.body?.cancel().catch(() => {});
				await pause(retryTiming.stepMs, options.signal);
				continue;
			}
			if (response.status === 426) throw new ServerProblem("mismatch", "The desktop app and server use different client protocol versions.");
			return { response, data: await response.json() };
		}
	} catch (error) {
		if (error instanceof ServerProblem) throw error;
		throw unreachable();
	}
}

async function checkDescriptor(origin, options) {
	const { response, data } = await serverJSON(origin, SERVER_INFO_PATH, options);
	if (!response.ok || !Number.isSafeInteger(data?.protocolVersion) || typeof data.name !== "string") throw unreachable();
	if (data.protocolVersion !== CLIENT_PROTOCOL_VERSION) {
		const message = data.protocolVersion > CLIENT_PROTOCOL_VERSION
			? `This app is too old for ${data.name}. Update the app to connect.`
			: `${data.name} runs an older LearnHarness. Update LearnHarness on ${data.name} to connect.`;
		throw new ServerProblem("mismatch", message);
	}
	return data;
}

async function checkSession(origin, token, options) {
	const { response, data } = await serverJSON(origin, SESSION_PATH, { ...options, token });
	if (response.ok && data?.authenticated === true) return;
	if (response.ok && data?.authenticated === false) {
		throw new ServerProblem("pair", "This desktop is no longer paired with the server.");
	}
	throw unreachable();
}

async function pairServer(origin, code, options) {
	const { response, data } = await serverJSON(origin, TOKEN_PATH, {
		...options, retry: false,
		method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: code,
			subject_token_type: "urn:learnharness:params:oauth:token-type:pairing-code",
			requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
			client_label: "LearnHarness Desktop",
			client_device_type: "desktop",
			client_os: { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] ?? process.platform,
		}),
	});
	if (response.ok && data?.token_type === "Bearer" && validToken(data.access_token)) return data.access_token;
	if (data?.error === "invalid_grant") throw new ServerProblem("pair", "That pairing code is wrong, expired or already used.");
	throw unreachable();
}

function validToken(value) {
	return typeof value === "string" && /^[A-Za-z0-9._~-]+$/.test(value);
}

function remoteHeaders(details, origin, token, win) {
	// A browser-initiated navigation can precede creation of a requesting
	// frame. Only Chromium's mainFrame request in this WebContents may use
	// the known main frame in that case. Subresources must name their frame.
	let request = details;
	if (details.resourceType === "subFrame") request = { ...details, frame: null };
	if (details.resourceType === "mainFrame" && !details.frame && !win.isDestroyed()) {
		request = { ...details, frame: win.webContents.mainFrame };
	}
	const headers = desktopAPIHeaders(request, origin, token, [win]);
	if (headers.authorization === `Bearer ${token}`) {
		for (const key of Object.keys(headers)) {
			if (["cookie", PROTOCOL_HEADER].includes(key.toLowerCase())) delete headers[key];
		}
		headers[PROTOCOL_HEADER] = String(CLIENT_PROTOCOL_VERSION);
	}
	return headers;
}

function isPairPage(url) {
	return /^\/pair(?:\/|$)/.test(decodeURIComponent(url.pathname));
}

function isRemotePage(value, origin) {
	if (!atOrigin(value, origin)) return false;
	try { return !isPairPage(new URL(value)); } catch { return false; }
}

function responseHeader(details, lowerName) {
	return Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === lowerName)?.[1]?.[0];
}

function rewritesToPairPage(details) {
	// Protocol-compatible builds predating the desktop shell can still
	// rewrite a revoked navigation to the web pairing page.
	for (const name of ["x-middleware-rewrite", "x-nextjs-rewritten-path"]) {
		const target = responseHeader(details, name);
		if (!target) continue;
		try { if (isPairPage(new URL(target, details.url))) return true; } catch { /* Invalid rewrite. */ }
	}
	return false;
}

function redirectLocation(details) {
	return details.statusCode >= 300 && details.statusCode < 400 ? responseHeader(details, "location") : undefined;
}

function allowsRemoteRedirect(details, origin) {
	const location = redirectLocation(details);
	if (!location || !atOrigin(details.url, origin)) return true;
	try { return isRemotePage(new URL(location, details.url), origin); } catch { return false; }
}

module.exports = {
	CLIENT_PROTOCOL_VERSION, PROTOCOL_HEADER, SERVER_INFO_PATH, TOKEN_PATH, SESSION_PATH, ServerProblem, retryTiming,
	parseOrigin, normalizeCode, parsePairLink, requestServer, checkDescriptor, checkSession, pairServer, validToken,
	atOrigin, remoteHeaders, isRemotePage, rewritesToPairPage, allowsRemoteRedirect, redirectLocation,
};

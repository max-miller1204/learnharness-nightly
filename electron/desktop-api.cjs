"use strict";

/** The desktop window's login (docs/specs/login-pairing.md): main trades the
 * per-launch secret for a bearer session at /oauth/token, then injects
 * `Authorization: Bearer <token>` on requests to the app's own origin from
 * trusted app windows, pages and API alike. Never expose the token to preload. */
const { isSkeletonPage } = require("./skeleton.cjs");

const HEADER = "authorization";
const DESKTOP_BOOTSTRAP_TOKEN_TYPE = "urn:learnharness:params:oauth:token-type:desktop-bootstrap";

/** Called for EVERY outgoing request, so redirects cannot carry the token
 * to another origin. Other origins' own Authorization headers are left alone. */
function desktopAPIHeaders(details, origin, token, windows) {
	const headers = { ...details.requestHeaders };
	let target;
	try { target = new URL(details.url); } catch { return headers; }
	const ours = target.origin === origin && !target.username && !target.password;
	for (const name of Object.keys(headers)) {
		if (name.toLowerCase() !== HEADER) continue;
		if (ours || (token && headers[name] === `Bearer ${token}`)) delete headers[name];
	}
	if (!token || !ours) return headers;
	try {
		const win = windows.find((candidate) => !candidate.isDestroyed() && candidate.webContents.id === details.webContentsId);
		if (!win || win.webContents.isDestroyed()) return headers;
		const contents = win.webContents;
		if (details.webContents && details.webContents !== contents) return headers;
		if (!details.frame || details.frame !== contents.mainFrame) return headers;
		// The window's own first navigation has no committed URL yet, or
		// the bundled ghost dashboard (a local page with no network).
		const committed = contents.mainFrame.url;
		if (committed && committed !== "about:blank" && !isSkeletonPage(committed) && new URL(committed).origin !== origin) return headers;
		if (details.initiatorOrigin !== undefined && details.initiatorOrigin !== origin) return headers;
		headers[HEADER] = `Bearer ${token}`;
	} catch { /* Missing/destroyed/navigated frames fail closed. */ }
	return headers;
}

/** Trade the per-launch secret for a desktop session (one row in Settings →
 * Devices; each launch replaces the previous one). */
async function exchangeDesktopSession(origin, secret, { fetchImpl = fetch, attempts = 5, os = process.platform } = {}) {
	const body = new URLSearchParams({
		grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
		subject_token: secret,
		subject_token_type: DESKTOP_BOOTSTRAP_TOKEN_TYPE,
		requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
		client_label: "LearnHarness Desktop",
		client_device_type: "desktop",
		client_os: { darwin: "macOS", win32: "Windows", linux: "Linux" }[os] ?? os,
	});
	let lastError;
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetchImpl(`${origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
			const json = await res.json();
			if (res.ok && typeof json.access_token === "string") return json.access_token;
			lastError = new Error(json.error_description ?? `token exchange answered ${res.status}`);
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw lastError ?? new Error("token exchange failed");
}

module.exports = { desktopAPIHeaders, exchangeDesktopSession, HEADER, DESKTOP_BOOTSTRAP_TOKEN_TYPE };

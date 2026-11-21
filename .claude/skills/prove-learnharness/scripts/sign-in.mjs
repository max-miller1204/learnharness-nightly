/**
 * Sign the prove scripts in (docs/specs/login-pairing.md). start.sh writes a
 * session into the instance's login store and saves it as APP_TOKEN in
 * instance.env; a base build from before login has none, and these do nothing.
 *
 *   signIn(inst)               node-side fetch to APP_URL sends the bearer token
 *   await signInPage(page, inst)  the browser page gets the session cookie
 */
export function signIn(inst) {
	const token = inst.APP_TOKEN || process.env.APP_TOKEN;
	const app = inst.APP_URL;
	if (!token || !app || globalThis.fetch.__proveSignedIn) return;
	const original = globalThis.fetch;
	const signed = (input, init = {}) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.startsWith(app)) return original(input, init);
		const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
		if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
		return original(input, { ...init, headers });
	};
	signed.__proveSignedIn = true;
	globalThis.fetch = signed;
}

export async function signInPage(page, inst) {
	const token = inst.APP_TOKEN;
	// The packaged window signs itself in (desktop secret) and its instance has
	// no APP_TOKEN; the dev window loads the head server and needs the cookie.
	if (!token || inst.SEED_IN_PAGE === "1") return;
	await page.setCookie({ name: `lh_session_${inst.APP_PORT}`, value: token, url: inst.APP_URL, httpOnly: true, sameSite: "Lax" });
}

/** For raw http.request callers: the headers to add. */
export const authHeaders = (inst) => (inst.APP_TOKEN ? { authorization: `Bearer ${inst.APP_TOKEN}` } : {});

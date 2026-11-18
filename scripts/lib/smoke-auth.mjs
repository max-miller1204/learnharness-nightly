/**
 * Smoke scripts sign in the way `lh` does (docs/specs/login-pairing.md):
 * write a session straight into the server's login store, then send it as a
 * bearer token. Node-side fetch to the smoke origin gets the header added.
 */
import { issueSession } from "../../selfhost/src/auth-store.ts";

export function smokeToken(dataDir) {
	return issueSession(dataDir, { method: "cli", client: { label: "smoke", deviceType: "bot" } }).token;
}

let target;
/** Add `Authorization: Bearer <token>` to node-side fetch calls to `origin`. Call again to retarget. */
export function signFetch(origin, token) {
	target = { origin, token };
	if (globalThis.fetch.__smokeSigned) return;
	const original = globalThis.fetch;
	const signed = (input, init = {}) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!target || !url.startsWith(target.origin)) return original(input, init);
		const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
		if (!headers.has("authorization")) headers.set("authorization", `Bearer ${target.token}`);
		return original(input, { ...init, headers });
	};
	signed.__smokeSigned = true;
	globalThis.fetch = signed;
}

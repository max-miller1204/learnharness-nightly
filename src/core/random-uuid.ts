/**
 * A random RFC 4122 version 4 UUID. crypto.randomUUID exists only in a secure context (HTTPS
 * or loopback), and a browser on a self-hosted server at http://<LAN address> isn't one, but
 * crypto.getRandomValues works in every context, so the UUID is built from it there.
 */
export function randomUuid(): string {
	const crypto = globalThis.crypto;
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40; // version 4
	bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // the RFC 4122 variant
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

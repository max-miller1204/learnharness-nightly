import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUuid } from "../src/core/random-uuid.ts";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it("builds an RFC 4122 version 4 UUID from getRandomValues when randomUUID is missing (#360)", () => {
	Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
	try {
		const ids = Array.from({ length: 500 }, () => randomUuid());
		for (const id of ids) assert.match(id, V4);
		assert.equal(new Set(ids).size, ids.length, "no repeats");
	} finally {
		delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
	}
});

it("uses crypto.randomUUID when it is there", () => {
	assert.equal(typeof globalThis.crypto.randomUUID, "function");
	const original = globalThis.crypto.randomUUID;
	Object.defineProperty(globalThis.crypto, "randomUUID", { value: () => "00000000-0000-4000-8000-000000000000", configurable: true });
	try {
		assert.equal(randomUuid(), "00000000-0000-4000-8000-000000000000");
	} finally {
		delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
	}
	assert.equal(globalThis.crypto.randomUUID, original);
	assert.match(randomUuid(), V4);
});

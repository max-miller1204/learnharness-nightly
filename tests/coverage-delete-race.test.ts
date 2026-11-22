import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fetchCoverage } from "../components/extraction-coverage.tsx";
import { beginSessionDelete, beginSessionDeletes } from "../components/session-deletion.ts";

test("a pending coverage read is aborted before session deletion", async () => {
	const original = globalThis.fetch;
	let reachedServer = false;
	try {
		globalThis.fetch = ((_url, init) => new Promise((_resolve, reject) => {
			const signal = init?.signal;
			const timer = setTimeout(() => { reachedServer = true; reject(new Error("404")); }, 50);
			signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); });
		})) as typeof fetch;
		const read = fetchCoverage("coverage-race");
		const finish = beginSessionDelete("coverage-race");
		finish(true);
		assert.equal(await read, null);
		assert.equal(reachedServer, false);
	} finally { globalThis.fetch = original; }
});

test("batch deletion aborts only reads for its sessions", async () => {
	const original = globalThis.fetch;
	try {
		globalThis.fetch = ((_url, init) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
		})) as typeof fetch;
		const read = fetchCoverage("coverage-batch");
		const finish = beginSessionDeletes(["coverage-batch"]);
		finish(["coverage-batch"]);
		assert.equal(await read, null);
	} finally { globalThis.fetch = original; }
});

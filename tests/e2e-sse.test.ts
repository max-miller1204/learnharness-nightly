// The SSE helper the e2e protocol tests read streams with (tests/e2e/support/sse.ts),
// against a local server whose streams behave badly on purpose.
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { openStream, StreamBag, streamStatus } from "./e2e/support/sse.ts";

let server: http.Server;
let base = "";
/** Which requests the server saw closed from the client's side. */
const closed = new Set<string>();

before(async () => {
	server = http.createServer((req, res) => {
		const path = req.url ?? "";
		res.on("close", () => closed.add(path));
		if (path === "/silent") return; // no head, ever
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (path === "/ends") { res.write("event: a\ndata: {\"n\":1}\n\ndata: [DONE]\n\n"); res.end(); return; }
		if (path === "/done-but-open") { res.write("data: [DONE]\n\n"); return; } // [DONE], then the connection stays open
		if (path === "/short") { res.write("data: 1\n\n"); res.end(); return; }
		if (path === "/status") { res.end(); return; }
		res.write(": hello\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.closeAllConnections(); server.close(); });
const closedSoon = async (path: string) => { for (let i = 0; i < 100 && !closed.has(path); i++) await new Promise((r) => setTimeout(r, 20)); return closed.has(path); };

describe("the SSE helper", () => {
	it("keeps event names and reads a stream that ends to EOF", async () => {
		const stream = await openStream(base, "/ends", {});
		const frames = await stream.drain(2000);
		assert.deepEqual(frames, [{ event: "a", data: "{\"n\":1}" }, { data: "[DONE]" }]);
		assert.equal(stream.contentType, "text/event-stream");
		stream.close();
	});

	it("drain needs the end of the stream: [DONE] on a connection that stays open times out and aborts the request", { timeout: 5000 }, async () => {
		const stream = await openStream(base, "/done-but-open", {});
		await assert.rejects(stream.drain(300), /timed out after 300 ms waiting for the end of the stream/);
		assert.ok(await closedSoon("/done-but-open"), "the request was aborted");
	});

	it("until throws when the stream ends first, and when its budget runs out", { timeout: 5000 }, async () => {
		const short = await openStream(base, "/short", {});
		await assert.rejects(short.until((frames) => frames.length > 1, "two frames", 2000), /ended before two frames/);
		const open = await openStream(base, "/open", {});
		await assert.rejects(open.until(() => false, "never", 200), /timed out after 200 ms waiting for never/);
		assert.ok(await closedSoon("/open"), "a read that ran out aborts the request");
	});

	it("a head that never comes is abandoned at its own deadline, apart from any read budget", { timeout: 5000 }, async () => {
		const started = Date.now();
		const bag = new StreamBag();
		await assert.rejects(bag.add(base, "/silent", {}, 250), /no response head from \/silent within 250 ms/);
		assert.ok(Date.now() - started < 3000);
		assert.ok(await closedSoon("/silent"));
	});

	it("closing the bag ends streams, including one still waiting for its head", { timeout: 5000 }, async () => {
		const bag = new StreamBag();
		const waiting = bag.add(base, "/silent", {}, 60_000);
		waiting.catch(() => {});
		const stream = await bag.add(base, "/open", {});
		assert.equal(stream.status, 200);
		closed.delete("/silent");
		closed.delete("/open");
		bag.closeAll();
		await assert.rejects(waiting);
		assert.ok(await closedSoon("/silent"), "the pending request was aborted");
		assert.ok(await closedSoon("/open"), "the open stream was closed");
	});

	it("streamStatus returns the status and drops the connection", async () => {
		assert.equal(await streamStatus(base, "/status", {}), 200);
	});
});

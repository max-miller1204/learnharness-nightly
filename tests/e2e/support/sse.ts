/**
 * Server-sent-event streams for the protocol tests: raw `fetch`, frames with their
 * `event:` names, separate connection and read budgets, aborts on timeout, and a bag that
 * closes every stream a test opened.
 */
export type Frame = { event?: string; data: string };
export const parse = (data: string): any => { try { return JSON.parse(data); } catch { return undefined; } };

/**
 * Opens an SSE stream. `fetch` resolves once the response head arrives, and the app has
 * subscribed by then, so a caller that awaits this has missed nothing sent after it. (A
 * dev server sends the head with the stream's first frame, which an idle `/api/events` only
 * has at its 25 s heartbeat; the budget covers that, and a test can provoke a frame.) Two
 * separate budgets apply: `connectMs` for the head (the request is aborted when it does not
 * come), and the `readMs` of each `until` or `drain` call for the frames, which starts when
 * that call does. A read that runs out aborts the request and throws. Frames keep their
 * `event:` names. Streams are closed by their test, in a `finally` (see `StreamBag`).
 */
export const openStream = async (baseUrl: string, path: string, headers: Record<string, string>, controller = new AbortController(), connectMs = 45_000) => {
	const connectTimer = setTimeout(() => controller.abort(new Error(`no response head from ${path} within ${connectMs} ms`)), connectMs);
	let response: Response;
	try { response = await fetch(`${baseUrl}${path}`, { headers: { accept: "text/event-stream", ...headers }, signal: controller.signal }); } finally { clearTimeout(connectTimer); }
	const frames: Frame[] = [];
	const reader = response.body?.getReader();
	let eof = !reader;
	let failure: unknown;
	// One free-running reader, so frames are taken off the connection as they arrive.
	void (async () => {
		if (!reader) return;
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) { eof = true; return; }
				buffer += decoder.decode(value, { stream: true });
				let end: number;
				while ((end = buffer.indexOf("\n\n")) >= 0) {
					const lines = buffer.slice(0, end).split("\n");
					buffer = buffer.slice(end + 2);
					const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
					const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
					if (data || event) frames.push({ ...(event ? { event } : {}), data });
				}
			}
		} catch (error) { failure = error; }
	})();
	const wait = async (ready: () => boolean, readMs: number, what: string) => {
		const deadline = Date.now() + readMs;
		while (!ready()) {
			if (failure !== undefined) throw new Error(`${path} failed while waiting for ${what}: ${String(failure)}`);
			if (Date.now() > deadline) { controller.abort(); throw new Error(`${path} timed out after ${readMs} ms waiting for ${what} (${frames.length} frames)`); }
			if (eof) throw new Error(`${path} ended before ${what} (${frames.length} frames)`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return frames;
	};
	return {
		status: response.status,
		contentType: response.headers.get("content-type") ?? "",
		frames,
		/** Waits for a predicate over the frames so far. */
		until: (done: (frames: Frame[]) => boolean, what: string, readMs = 30_000) => wait(() => done(frames), readMs, what),
		/** Reads to the end of the stream (EOF); a stream that does not end within `readMs` fails. */
		drain: (readMs = 30_000) => wait(() => eof, readMs, "the end of the stream"),
		close() {
			controller.abort();
			void reader?.cancel().catch(() => {});
		},
	};
};
export type Stream = Awaited<ReturnType<typeof openStream>>;
/** The streams a test opened, all closed in its `finally`. */
export class StreamBag {
	private controllers: AbortController[] = [];
	private open: Stream[] = [];
	async add(baseUrl: string, path: string, headers: Record<string, string>, connectMs?: number) {
		// Registered before the head arrives, so closing the bag also ends a request still waiting for it.
		const controller = new AbortController();
		this.controllers.push(controller);
		const stream = await openStream(baseUrl, path, headers, controller, connectMs);
		this.open.push(stream);
		return stream;
	}
	closeAll() {
		for (const controller of this.controllers.splice(0)) controller.abort();
		for (const stream of this.open.splice(0)) stream.close();
	}
}
/** The status of a stream request alone: the head, then the connection is dropped. */
export const streamStatus = async (baseUrl: string, path: string, headers: Record<string, string>) => {
	const stream = await openStream(baseUrl, path, headers);
	try { return stream.status; } finally { stream.close(); }
};

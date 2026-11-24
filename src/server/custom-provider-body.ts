/** Byte-bounded JSON for the custom endpoint's request/discovery surfaces. */
export class CustomBodyLimitError extends Error {}

export async function readBoundedJson(message: Request | Response, limit: number, allowEmptyObject = false): Promise<unknown> {
	if (Number(message.headers.get("content-length")) > limit) {
		void message.body?.cancel().catch(() => undefined);
		throw new CustomBodyLimitError("JSON body exceeds the allowed byte limit");
	}
	const reader = message.body?.getReader();
	if (!reader) {
		if (allowEmptyObject) return {};
		throw new SyntaxError("Missing JSON body");
	}
	// Preserve a leading UTF-8 BOM so JSON.parse rejects BOM-prefixed bodies.
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	let text = "";
	let bytes = 0;
	let finished = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				break;
			}
			bytes += value.byteLength;
			if (bytes > limit) throw new CustomBodyLimitError("JSON body exceeds the allowed byte limit");
			text += decoder.decode(value, { stream: true });
		}
		if (bytes === 0 && allowEmptyObject) return {};
		return JSON.parse(text + decoder.decode());
	} finally {
		if (finished) {
			reader.releaseLock();
		} else {
			void reader.cancel().catch(() => undefined).finally(() => {
				try { reader.releaseLock(); } catch { /* already released */ }
			});
		}
	}
}

// Runs one document extraction off the main thread (see ./index.ts and
// docs/specs/document-converters.md). Replies once with the text or a classified error.
import { parentPort } from "node:worker_threads";
import { EMPTY, ENCRYPTED, extractDocumentText } from "./document-text.mjs";

const port = parentPort;
if (!port) throw new Error("document text worker requires parentPort");

/** Rejections are properties of the bytes (cached by the caller); OS errors are not. */
function classify(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (message === ENCRYPTED) return "encrypted";
	if (message === EMPTY) return "empty";
	if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) return "failed";
	return "invalid";
}

port.once("message", (message) => {
	void (async () => {
		try {
			const text = await extractDocumentText(message.bytes, message.extension);
			port.postMessage({ text });
		} catch (error) {
			port.postMessage({ reason: classify(error), error: error instanceof Error ? error.message : String(error) });
		}
	})();
});

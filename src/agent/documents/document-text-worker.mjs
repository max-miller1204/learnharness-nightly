// Runs one document extraction in its own process (see ./index.ts and
// docs/specs/document-converters.md), as T3 Code does: an out-of-memory or
// crash here ends only this process. Reads `<extension>` from argv and the
// document bytes from stdin, and writes one JSON reply to stdout: the text,
// or a classified error.
import { EMPTY, ENCRYPTED, extractDocumentText } from "./document-text.mjs";

/** Rejections are properties of the bytes (cached by the caller); OS errors are not. */
function classify(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (message === ENCRYPTED) return "encrypted";
	if (message === EMPTY) return "empty";
	if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) return "failed";
	return "invalid";
}

const extension = process.argv[2] ?? "";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let reply;
try {
	reply = { text: await extractDocumentText(new Uint8Array(Buffer.concat(chunks)), extension) };
} catch (error) {
	reply = { reason: classify(error), error: error instanceof Error ? error.message : String(error) };
}
process.stdout.write(JSON.stringify(reply));

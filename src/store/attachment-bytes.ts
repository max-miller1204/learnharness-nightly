import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export class AttachmentSizeMismatch extends Error {
	constructor() {
		super("Uploaded bytes do not match the declared file size.");
	}
}

/** Count before writing each chunk, so an oversized body never uses more
 * space than its reservation even when Content-Length is absent. */
export async function writeAttachmentBytes(
	body: ReadableStream<Uint8Array> | null,
	file: string,
	size: number,
	signal: AbortSignal,
): Promise<void> {
	let received = 0;
	const count = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			received += chunk.byteLength;
			if (received > size) callback(new AttachmentSizeMismatch());
			else callback(null, chunk);
		},
	});
	await pipeline(
		body ? Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>) : Readable.from([]),
		count,
		createWriteStream(file, { flags: "wx", mode: 0o600 }),
		{ signal },
	);
	if (received !== size) throw new AttachmentSizeMismatch();
	const handle = await open(file, "r+");
	try { await handle.sync(); }
	finally { await handle.close(); }
}

/** Called only when the exact same upload ID already has bytes. */
export async function attachmentDigest(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest("hex");
}

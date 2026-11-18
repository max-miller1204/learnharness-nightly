// HEIC/HEIF handling for Extract files, ported from T3 Code (https://github.com/pingdotgg/t3code),
// apps/web/src/lib/imageCompression.ts (isHeicImageFile, findHeicMetadataBox, validateHeicImageDimensions
// and the heic-to conversion), commit 4ecbe550. MIT License, Copyright (c) 2026 T3 Tools Inc.; the full
// license text is in lib/ignore-patterns.LICENSE. Browser only: the converter is loaded on first use.

const MAX_HEIC_DECODE_PIXELS = 64_000_000;
const MAX_HEIC_METADATA_BYTES = 1024 * 1024;
const HEIC_IMAGE_MIME_TYPE = /^image\/hei(?:c|f)$/i;
const HEIC_IMAGE_EXTENSION = /\.(?:heic|heif)$/i;
const JPEG_QUALITY = 0.92;

export type HeicFailure = "too-large" | "unreadable";

/** Finder and some browsers omit the MIME type when dragging HEIC photos. */
export function isHeicImageFile(file: Pick<File, "name" | "type">): boolean {
	if (HEIC_IMAGE_MIME_TYPE.test(file.type)) return true;
	return (file.type === "" || file.type.toLowerCase() === "application/octet-stream") && HEIC_IMAGE_EXTENSION.test(file.name);
}

interface HeicMetadataBox {
	payloadOffset: number;
	endOffset: number;
}

function findHeicMetadataBox(view: DataView, startOffset: number, endOffset: number, type: number): HeicMetadataBox | null {
	let offset = startOffset;
	while (offset + 8 <= endOffset) {
		let size = view.getUint32(offset);
		let headerSize = 8;
		if (size === 1) {
			if (offset + 16 > endOffset) return null;
			const extendedSize = view.getBigUint64(offset + 8);
			if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
			size = Number(extendedSize);
			headerSize = 16;
		} else if (size === 0) {
			size = endOffset - offset;
		}
		if (size < headerSize || size > endOffset - offset) return null;
		const nextOffset = offset + size;
		if (view.getUint32(offset + 4) === type) return { payloadOffset: offset + headerSize, endOffset: nextOffset };
		offset = nextOffset;
	}
	return null;
}

/** Refuses photos over 64 megapixels from their metadata, before anything is decoded. */
export async function validateHeicImageDimensions(file: Blob): Promise<HeicFailure | null> {
	const metadata = await file.slice(0, MAX_HEIC_METADATA_BYTES).arrayBuffer();
	const view = new DataView(metadata);
	const meta = findHeicMetadataBox(view, 0, view.byteLength, 0x6d657461);
	if (!meta || meta.payloadOffset + 4 > meta.endOffset) return "unreadable";
	const properties = findHeicMetadataBox(view, meta.payloadOffset + 4, meta.endOffset, 0x69707270);
	if (!properties) return "unreadable";
	const containers = findHeicMetadataBox(view, properties.payloadOffset, properties.endOffset, 0x6970636f);
	if (!containers) return "unreadable";
	let offset = containers.payloadOffset;
	let foundImageDimensions = false;
	while (offset < containers.endOffset) {
		const image = findHeicMetadataBox(view, offset, containers.endOffset, 0x69737065);
		if (!image) break;
		if (image.payloadOffset + 12 > image.endOffset) return "unreadable";
		const width = view.getUint32(image.payloadOffset + 4);
		const height = view.getUint32(image.payloadOffset + 8);
		if (width === 0 || height === 0) return "unreadable";
		if (width > MAX_HEIC_DECODE_PIXELS / height) return "too-large";
		foundImageDimensions = true;
		offset = image.endOffset;
	}
	return foundImageDimensions ? null : "unreadable";
}

/** HEIC to JPEG (quality 0.92). The result keeps the original file name so its import path stays
 * `photo.heic`; the server reads the JPEG by its signature. */
export async function convertHeicToJpeg(file: File): Promise<{ ok: true; file: File } | { ok: false; reason: HeicFailure }> {
	try {
		const dimensionError = await validateHeicImageDimensions(file);
		if (dimensionError) return { ok: false, reason: dimensionError };
		const { heicTo } = await import("heic-to/csp");
		const jpeg = await heicTo({ blob: file, type: "image/jpeg", quality: JPEG_QUALITY });
		return { ok: true, file: new File([jpeg], file.name, { type: "image/jpeg", lastModified: file.lastModified }) };
	} catch {
		return { ok: false, reason: "unreadable" };
	}
}

export const heicFailureMessage = (reason: HeicFailure): string =>
	reason === "too-large" ? "This photo is over 64 megapixels, too large to convert." : "Could not convert this HEIC photo.";

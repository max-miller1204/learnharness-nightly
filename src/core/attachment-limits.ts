const MiB = 1024 * 1024;

export const MAX_ATTACHMENTS_PER_MESSAGE = 100;
export const MAX_ATTACHMENT_IMAGE_BYTES = 10 * MiB;
export const MAX_ATTACHMENT_IMAGES_PER_MESSAGE_BYTES = 80 * MiB;
export const MAX_ATTACHMENT_FILE_BYTES = 50 * MiB;
export const MAX_CLAIMED_ATTACHMENT_BYTES = 1024 * MiB;
export const MAX_STAGED_ATTACHMENT_BYTES = 512 * MiB;

export const ATTACHMENT_UNAVAILABLE = "File unavailable. Attach it again to use it.";

const IMAGE_NAME = /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i;

export function isImageAttachment(name: string, mimeType: string): boolean {
	return mimeType.toLowerCase().startsWith("image/") || IMAGE_NAME.test(name);
}

export function attachmentLimitError(files: readonly { name: string; mimeType: string; size: number }[]): string | undefined {
	if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) return "Attach up to 100 files per message.";
	let imageBytes = 0;
	for (const { name, mimeType, size } of files) {
		if (isImageAttachment(name, mimeType)) {
			if (size > MAX_ATTACHMENT_IMAGE_BYTES) return `${name} exceeds the 10 MiB per-image limit.`;
			imageBytes += size;
		} else if (size > MAX_ATTACHMENT_FILE_BYTES) return `${name} exceeds the 50 MiB per-file limit.`;
	}
	if (imageBytes > MAX_ATTACHMENT_IMAGES_PER_MESSAGE_BYTES) return "Images exceed the 80 MiB per-message limit.";
}

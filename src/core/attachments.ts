export interface AttachmentReference {
	id: string;
	name: string;
}

export const ATTACHMENT_PREFIX = "attachment:";

export function isAttachmentId(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}

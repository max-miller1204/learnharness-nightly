import * as path from "node:path";
import { ATTACHMENT_PREFIX, isAttachmentId } from "../../core/attachments.ts";
import { ATTACHMENT_UNAVAILABLE } from "../../core/attachment-limits.ts";
import { resolveClaimedAttachment, resolveSourcePath } from "./fs-shared.ts";

/** Bound by the server to the chat owning this file operation. */
export type ResolveAttachment = (id: string) => { name: string; filename?: string } | undefined;

interface LearnerFile {
	filename: string;
	name: string;
	/** Safe to persist or display. An uploaded copy keeps its opaque reference. */
	source: string;
}

export function resolveLearnerFile(source: string, lookup?: ResolveAttachment): LearnerFile {
	if (!source.startsWith(ATTACHMENT_PREFIX)) {
		const filename = resolveSourcePath(source);
		return { filename, name: path.basename(filename), source: filename };
	}
	const id = source.slice(ATTACHMENT_PREFIX.length);
	const attachment = isAttachmentId(id) ? lookup?.(id) : undefined;
	if (!attachment) throw new Error("Access denied: this attachment is not part of the current chat.");
	if (!attachment.filename) throw new Error(ATTACHMENT_UNAVAILABLE);
	const file = { filename: attachment.filename, name: attachment.name, source };
	try {
		return { ...file, filename: resolveClaimedAttachment(file.filename, file.name, source) };
	} catch (error) {
		throw new Error(learnerFileErrorMessage(error, file));
	}
}

export function learnerFileErrorMessage(error: unknown, { filename, source }: LearnerFile): string {
	const message = error instanceof Error ? error.message : String(error);
	if (filename === source) return message;
	if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return ATTACHMENT_UNAVAILABLE;
	return message.replaceAll(filename, source);
}

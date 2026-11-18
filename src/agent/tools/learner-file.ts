import * as fs from "node:fs";
import * as path from "node:path";
import { ATTACHMENT_PREFIX, isAttachmentId } from "../../core/attachments.ts";
import { ATTACHMENT_UNAVAILABLE } from "../../core/attachment-limits.ts";
import { resolveClaimedAttachment, resolveSourcePath } from "./fs-shared.ts";

/** Bound by the server to the chat owning this file operation. */
export type ResolveAttachment = (id: string) => { name: string; filename?: string; folder?: boolean } | undefined;

interface LearnerFile {
	filename: string;
	name: string;
	/** Safe to persist or display. An uploaded copy keeps its opaque reference. */
	source: string;
	/** An upload's storage root (a file, or a folder's directory) and the
	 * reference that replaces it in anything the agent sees. */
	attachment?: { roots: string[]; ref: string };
}

export function isAttachmentSource(source: string | undefined): source is string {
	return source?.startsWith(ATTACHMENT_PREFIX) === true;
}

/** `attachment:<id>` names an upload; `attachment:<id>/<path>` names an
 * entry inside an uploaded folder. The result may be a file or directory. */
export function resolveLearnerFile(source: string, lookup?: ResolveAttachment): LearnerFile {
	if (!isAttachmentSource(source)) {
		const filename = resolveSourcePath(source);
		return { filename, name: path.basename(filename), source: filename };
	}
	const rest = source.slice(ATTACHMENT_PREFIX.length);
	const slash = rest.indexOf("/");
	const id = slash === -1 ? rest : rest.slice(0, slash);
	const segments = slash === -1 ? [] : rest.slice(slash + 1).split("/").filter((segment, index, all) => segment || index < all.length - 1);
	const attachment = isAttachmentId(id) ? lookup?.(id) : undefined;
	if (!attachment) throw new Error("Access denied: this attachment is not part of the current chat.");
	if (!attachment.filename) throw new Error(ATTACHMENT_UNAVAILABLE);
	const ref = ATTACHMENT_PREFIX + id;
	const file: LearnerFile = { filename: attachment.filename, name: attachment.name, source, attachment: { roots: [attachment.filename], ref } };
	try {
		const root = resolveClaimedAttachment(attachment.filename, attachment.name, ref);
		file.attachment!.roots.unshift(root);
		if (!segments.length) return { ...file, filename: root };
		if (!attachment.folder || segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
			throw new Error(`Path not found: ${source}`);
		}
		const entry = path.join(/* turbopackIgnore: true */ root, ...segments);
		if (!fs.lstatSync(/* turbopackIgnore: true */ entry, { throwIfNoEntry: false })) throw new Error(`Path not found: ${source}`);
		const name = segments.at(-1)!;
		return { ...file, name, filename: resolveClaimedAttachment(entry, name, source, root) };
	} catch (error) {
		throw new Error(learnerFileErrorMessage(error, file));
	}
}

export function learnerFileErrorMessage(error: unknown, { source, attachment }: LearnerFile): string {
	const message = error instanceof Error ? error.message : String(error);
	if (!attachment) return message;
	if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
		// A missing entry inside a folder that still exists is the agent's
		// wrong path, not a collected upload.
		return source !== attachment.ref && attachment.roots.some(root => fs.existsSync(/* turbopackIgnore: true */ root))
			? `Path not found: ${source}`
			: ATTACHMENT_UNAVAILABLE;
	}
	return attachment.roots.reduce((text, root) => text.replaceAll(root, attachment.ref), message);
}

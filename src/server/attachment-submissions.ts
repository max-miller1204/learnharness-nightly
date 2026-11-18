import { createHash } from "node:crypto";
import type { AttachmentTarget } from "../client-protocol/index.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../core/attachment-limits.ts";
import { isAttachmentId } from "../core/attachments.ts";
import type { ChatRecord } from "../core/contracts/chat.ts";
import { AttachmentError, attachmentReferences, claimedAttachmentPath } from "../store/attachments.ts";
import { authenticate, CREDENTIAL_HEADERS } from "./auth.ts";
import { protocolRefusal } from "./server-info.ts";
import { stores } from "./stores.ts";

export function attachmentsForChat(chatId: string) {
	return (id: string) => {
		const current = stores.chatStore.getChat(chatId);
		const ref = current && attachmentReferences(current.messages).find(item => item.id === id);
		return ref ? { name: ref.name, filename: claimedAttachmentPath(id), folder: ref.fileCount !== undefined } : undefined;
	};
}

export function attachmentOwner(request: Request): string {
	const auth = authenticate(request);
	if (!auth.ok) throw new AttachmentError(auth.status, auth.error);
	return auth.session.id;
}

export function assertAttachmentOwner(request: Request, expected: string): void {
	if (attachmentOwner(request) !== expected) throw new AttachmentError(401, "This pairing is no longer active.");
}

export async function attachmentOperation(request: Request, run: (owner: string) => Response | Promise<Response>): Promise<Response> {
	const refusal = protocolRefusal(request);
	if (refusal) return refusal;
	try { return await run(attachmentOwner(request)); }
	catch (error) {
		if (error instanceof AttachmentError) return Response.json({ error: error.message }, { status: error.status, headers: CREDENTIAL_HEADERS });
		console.error("[attachments] Operation failed:", error);
		return Response.json({ error: "The attachment operation failed. Try again." }, { status: 500, headers: CREDENTIAL_HEADERS });
	}
}

export interface AttachmentSubmission {
	ids: string[];
	owner: string;
	target: AttachmentTarget;
	messageId: string;
	currentOwner: () => void;
	opening?: ChatRecord;
}

function scopedId(...parts: string[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function openingAttachmentChatId(owner: string, draftId: string): string {
	return `chat_${scopedId(owner, draftId)}`;
}

export function attachmentSubmission(
	request: Request, owner: string, target: AttachmentTarget, chatId: string, ids: unknown, sendId: unknown,
): AttachmentSubmission {
	if (!Array.isArray(ids) || !ids.length || ids.length > MAX_ATTACHMENTS_PER_MESSAGE || !ids.every(isAttachmentId) ||
		new Set(ids).size !== ids.length || !isAttachmentId(sendId)) {
		throw new AttachmentError(400, "Provide a send ID and between 1 and 100 distinct upload IDs.");
	}
	return {
		ids, owner, target, messageId: `msg_${scopedId(owner, chatId, sendId)}`,
		currentOwner: () => assertAttachmentOwner(request, owner),
	};
}

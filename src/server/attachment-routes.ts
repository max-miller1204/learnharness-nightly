import type { CreateChatResponse } from "../client-protocol/index.ts";
import { isAttachmentId } from "../core/attachments.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import { ChatInputError, parseChatInput } from "../core/input-events.ts";
import { AttachmentError, discardAttachment, receiveAttachment, reserveAttachment } from "../store/attachments.ts";
import { newChatRecord } from "../store/chats.ts";
import { assertAttachmentOwner, attachmentOperation, attachmentSubmission, openingAttachmentChatId } from "./attachment-submissions.ts";
import { initialChatSettings, initialGraphContext } from "./chat-creation.ts";
import { handleChatInput } from "./chat-handler.ts";
import { stores } from "./stores.ts";

export function reserveAttachmentRequest(request: Request) {
	return attachmentOperation(request, async owner => {
		const body = await request.json().catch(() => null);
		assertAttachmentOwner(request, owner);
		const { name, mimeType, size, draftId, chatId } = body ?? {};
		if (typeof name !== "string" || !name.trim() || name.length > 255 || /[\x00-\x1f\x7f]/.test(name) ||
			typeof mimeType !== "string" || mimeType.length > 255 || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
			throw new AttachmentError(400, "Provide a filename, media type and exact file size.");
		}
		if (chatId !== undefined && draftId === undefined && typeof chatId === "string" && /^[\w-]+$/.test(chatId)) {
			if (!stores.chatStore.getChat(chatId)) throw new AttachmentError(404, "Unknown chat.");
			return Response.json(reserveAttachment(owner, { name, mimeType, size, chatId }), { status: 201 });
		}
		if (chatId !== undefined || !isAttachmentId(draftId)) throw new AttachmentError(400, "Provide an opening draft ID or an existing chat ID.");
		return Response.json(reserveAttachment(owner, { name, mimeType, size, draftId }), { status: 201 });
	});
}

export function uploadAttachmentRequest(request: Request) {
	// This route skips Next Proxy body cloning and applies its gates directly.
	return attachmentOperation(request, async owner => {
		const query = new URL(request.url).searchParams;
		await receiveAttachment(query.get("id") ?? "", query.get("grant") ?? "", owner, request, () => assertAttachmentOwner(request, owner));
		return new Response(null, { status: 204 });
	});
}

export function discardAttachmentRequest(request: Request, params: Promise<{ id: string }>) {
	return attachmentOperation(request, async owner => {
		const { id } = await params;
		assertAttachmentOwner(request, owner);
		discardAttachment(id, owner);
		return new Response(null, { status: 204 });
	});
}

export function startAttachmentRequest(request: Request) {
	return attachmentOperation(request, async owner => {
		const body = await request.json().catch(() => null);
		const { draftId, title, kind, graphContext, attachmentUploadIds, sendId } = body ?? {};
		if (!isAttachmentId(draftId) || typeof title !== "string" || !title.trim()) {
			throw new AttachmentError(400, "Provide an opening draft ID and message text.");
		}
		const id = openingAttachmentChatId(owner, draftId);
		const submission = attachmentSubmission(request, owner, { draftId }, id, attachmentUploadIds, sendId);
		const record = newChatRecord(id, titleFromPrompt(title), kind === "practice" ? kind : undefined);
		record.settings = initialChatSettings();
		const context = initialGraphContext(graphContext);
		if (context) record.messages = [context];
		submission.opening = record;
		let input;
		try { input = parseChatInput({ type: "text", text: title }); }
		catch (error) {
			if (error instanceof ChatInputError) throw new AttachmentError(400, error.message);
			throw error;
		}
		const response = await handleChatInput(id, input, undefined, undefined, submission);
		return response.ok ? Response.json({ id, title: record.title } satisfies CreateChatResponse) : response;
	});
}

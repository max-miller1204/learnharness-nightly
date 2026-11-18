import type { CreateChatResponse } from "../client-protocol/index.ts";
import { isAttachmentId } from "../core/attachments.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import { ChatInputError, parseChatInput } from "../core/input-events.ts";
import { MAX_FOLDER_FILES } from "../core/attachment-folders.ts";
import { AttachmentError, discardAttachment, receiveAttachment, renewAttachmentFolder, reserveAttachment, reserveAttachmentFolder } from "../store/attachments.ts";
import { newChatRecord } from "../store/chats.ts";
import { assertAttachmentOwner, attachmentOperation, attachmentSubmission, openingAttachmentChatId } from "./attachment-submissions.ts";
import { initialChatSettings, initialGraphContext } from "./chat-creation.ts";
import { handleChatInput } from "./chat-handler.ts";
import { stores } from "./stores.ts";

export function reserveAttachmentRequest(request: Request) {
	return attachmentOperation(request, async owner => {
		const body = await request.json().catch(() => null);
		assertAttachmentOwner(request, owner);
		const { name, mimeType, size, files, draftId, chatId } = body ?? {};
		const validName = typeof name === "string" && !!name.trim() && name.length <= 255 && !/[\x00-\x1f\x7f]/.test(name);
		const validFile = (type: unknown, bytes: unknown) => typeof type === "string" && type.length <= 255 &&
			typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0;
		let target: { chatId: string } | { draftId: string };
		const folder = files !== undefined;
		if (folder) {
			if (Array.isArray(files) && files.length > MAX_FOLDER_FILES) throw new AttachmentError(413, "Attach up to 100 files per folder.");
			if (!validName || !Array.isArray(files) || !files.every(file => typeof file?.path === "string" && validFile(file.mimeType, file.size))) {
				throw new AttachmentError(400, "Provide a folder name and each file's path, media type and exact size.");
			}
		} else if (!validName || !validFile(mimeType, size)) {
			throw new AttachmentError(400, "Provide a filename, media type and exact file size.");
		}
		if (chatId !== undefined && draftId === undefined && typeof chatId === "string" && /^[\w-]+$/.test(chatId)) {
			if (!stores.chatStore.getChat(chatId)) throw new AttachmentError(404, "Unknown chat.");
			target = { chatId };
		} else if (chatId !== undefined || !isAttachmentId(draftId)) {
			throw new AttachmentError(400, "Provide an opening draft ID or an existing chat ID.");
		} else target = { draftId };
		if (folder) {
			const manifest = (files as { path: string; mimeType: string; size: number }[]).map(({ path, mimeType, size }) => ({ path, mimeType, size }));
			return Response.json(reserveAttachmentFolder(owner, { ...target, name, files: manifest }), { status: 201 });
		}
		return Response.json(reserveAttachment(owner, { ...target, name, mimeType, size }), { status: 201 });
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

export function renewAttachmentFolderRequest(request: Request, params: Promise<{ id: string }>) {
	return attachmentOperation(request, async owner => {
		const { id } = await params;
		assertAttachmentOwner(request, owner);
		return Response.json(renewAttachmentFolder(id, owner));
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

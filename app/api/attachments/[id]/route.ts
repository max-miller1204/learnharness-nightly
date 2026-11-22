import { attachmentStatusRequest, discardAttachmentRequest, renewAttachmentFolderRequest } from "@/src/server";

export function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return attachmentStatusRequest(request, params);
}

export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return renewAttachmentFolderRequest(request, params);
}

export function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return discardAttachmentRequest(request, params);
}

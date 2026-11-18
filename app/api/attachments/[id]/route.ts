import { discardAttachmentRequest, renewAttachmentFolderRequest } from "@/src/server";

export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return renewAttachmentFolderRequest(request, params);
}

export function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return discardAttachmentRequest(request, params);
}

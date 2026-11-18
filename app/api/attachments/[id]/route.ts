import { discardAttachmentRequest } from "@/src/server";

export function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return discardAttachmentRequest(request, params);
}

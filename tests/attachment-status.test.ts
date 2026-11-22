/**
 * Issue #367, server side: `GET /api/attachments/:id?chatId=` says whether a
 * send in that chat could claim a pending file or folder right now, so a
 * restored draft chip can be dropped when its upload is gone.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { issueSession } from "../selfhost/src/auth-store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zz-prove-it-attachment-status-tests-"));
fs.mkdirSync(path.join(root, "home"));
process.env.HOME = path.join(root, "home");
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.LH_SELFHOST = "0";
process.env.LH_IGNORE_ENV_KEYS = "1";

const { PATHS } = await import("../config.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { attachmentStatusRequest, discardAttachmentRequest, reserveAttachmentRequest, uploadAttachmentRequest } = await import("../src/server/attachment-routes.ts");
const { claimAttachments, sweepAttachments } = await import("../src/store/attachments.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { PROTOCOL_ROUTES } = await import("../src/client-protocol/index.ts");

after(() => fs.rmSync(root, { recursive: true, force: true }));

const owner = issueSession(PATHS.data, { method: "pairing", client: { label: "status test device", deviceType: "desktop" } });
const other = issueSession(PATHS.data, { method: "pairing", client: { label: "other status device", deviceType: "desktop" } });
const base = "http://attachment.test:3000";

function request(pathname: string, method: string, body?: string, token = owner.token) {
	return new Request(new URL(pathname, base), { method, body, headers: { Authorization: `Bearer ${token}`, "X-LearnHarness-Protocol": "1" } });
}

const reserve = (body: object) => reserveAttachmentRequest(request("/api/attachments", "POST", JSON.stringify(body)));
const status = (id: string, chatId: string | null, token = owner.token) =>
	attachmentStatusRequest(request(chatId === null ? `/api/attachments/${id}` : PROTOCOL_ROUTES.attachmentStatus(id, chatId), "GET", undefined, token), Promise.resolve({ id }));
const put = (uploadUrl: string, text: string) => uploadAttachmentRequest(request(uploadUrl, "PUT", text));

test("the route is the one the client protocol names", () => {
	assert.equal(PROTOCOL_ROUTES.attachmentStatus("a b", "c/d"), "/api/attachments/a%20b?chatId=c%2Fd");
});

test("a pending file is sendable only once all its bytes arrived, and only in its own chat", async () => {
	const chat = chatStore.createChat("zz-prove-it status chat");
	const elsewhere = chatStore.createChat("zz-prove-it other status chat");
	const grant = await (await reserve({ chatId: chat.id, name: "notes.txt", mimeType: "text/plain", size: 5 })).json();
	assert.equal((await status(grant.id, chat.id)).status, 404, "reserved, nothing uploaded yet");
	assert.equal((await put(grant.uploadUrl, "hello")).status, 204);
	const ok = await status(grant.id, chat.id);
	assert.equal(ok.status, 204);
	assert.equal(await ok.text(), "");
	assert.equal((await status(grant.id, elsewhere.id)).status, 404, "another chat's");
	assert.equal((await status(grant.id, chat.id, other.token)).status, 404, "another pairing's");
	assert.equal((await status(grant.id, null)).status, 400, "the chat is required");
	assert.equal((await status(grant.id, "../x")).status, 400);
	assert.equal((await status(randomUUID(), chat.id)).status, 404, "unknown");
	assert.equal((await status("not-an-id", chat.id)).status, 404, "malformed");
	assert.equal((await attachmentStatusRequest(new Request(new URL(PROTOCOL_ROUTES.attachmentStatus(grant.id, chat.id), base), { headers: { "X-LearnHarness-Protocol": "1" } }), Promise.resolve({ id: grant.id }))).status, 401, "no pairing");
	// Removed: gone.
	assert.equal((await discardAttachmentRequest(request(`/api/attachments/${grant.id}`, "DELETE"), Promise.resolve({ id: grant.id }))).status, 204);
	assert.equal((await status(grant.id, chat.id)).status, 404);
	chatStore.deleteChat(chat.id);
	chatStore.deleteChat(elsewhere.id);
});

test("a sent file, and a file whose pending copy expired and was swept, are no longer sendable", async () => {
	const chat = chatStore.createChat("zz-prove-it sent status chat");
	const sent = await (await reserve({ chatId: chat.id, name: "sent.txt", mimeType: "text/plain", size: 2 })).json();
	const aged = await (await reserve({ chatId: chat.id, name: "aged.txt", mimeType: "text/plain", size: 2 })).json();
	for (const grant of [sent, aged]) assert.equal((await put(grant.uploadUrl, "hi")).status, 204);
	assert.equal((await status(aged.id, chat.id)).status, 204);
	claimAttachments([sent.id], owner.session.id, { chatId: chat.id }, [], attachments => {
		chatStore.saveMessages(chat.id, [{ ...newUserMessage("here"), attachments }]);
	});
	assert.equal((await status(sent.id, chat.id)).status, 404, "its pending copy went with the send");
	const day = 25 * 60 * 60_000;
	sweepAttachments(Date.now() + day);
	assert.equal((await status(aged.id, chat.id)).status, 404, "past the server's 24 hours");
	chatStore.deleteChat(chat.id);
});

test("a folder is sendable once every file arrived", async () => {
	const chat = chatStore.createChat("zz-prove-it folder status chat");
	const files = [{ path: "a.md", mimeType: "text/markdown", size: 1 }, { path: "b/c.md", mimeType: "text/markdown", size: 1 }];
	const grant = await (await reserve({ chatId: chat.id, name: "Notes", files })).json();
	assert.equal((await put(grant.files[0].uploadUrl, "a")).status, 204);
	assert.equal((await status(grant.id, chat.id)).status, 404, "one file still missing");
	assert.equal((await put(grant.files[1].uploadUrl, "b")).status, 204);
	assert.equal((await status(grant.id, chat.id)).status, 204);
	assert.equal((await status(grant.id, chat.id, other.token)).status, 404);
	assert.equal((await discardAttachmentRequest(request(`/api/attachments/${grant.id}`, "DELETE"), Promise.resolve({ id: grant.id }))).status, 204);
	assert.equal((await status(grant.id, chat.id)).status, 404);
	chatStore.deleteChat(chat.id);
});

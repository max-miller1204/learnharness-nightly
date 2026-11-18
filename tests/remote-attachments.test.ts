import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { issueSession, revokeSession } from "../selfhost/src/auth-store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zz-prove-it-attachment-tests-"));
fs.mkdirSync(path.join(root, "home"));
process.env.HOME = path.join(root, "home");
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.LH_SELFHOST = "0";
process.env.LH_IGNORE_ENV_KEYS = "1";

const { PATHS } = await import("../config.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { createReadTool } = await import("../src/agent/tools/read.ts");
const { setFileAccessPolicy } = await import("../src/agent/tools/file-access.ts");
const { claimAttachments, claimedAttachmentPath, scheduleAttachmentRemoval, sweepAttachments } = await import("../src/store/attachments.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { reserveAttachmentRequest, uploadAttachmentRequest, discardAttachmentRequest, startAttachmentRequest } = await import("../src/server/attachment-routes.ts");

after(() => fs.rmSync(root, { recursive: true, force: true }));

const pairing = (label: string) => issueSession(PATHS.data, { method: "pairing", client: { label, deviceType: "desktop" } });
const first = pairing("first attachment test device");
const second = pairing("second attachment test device");
const base = "http://attachment.test:3000";

function request(pathname: string, method: string, body?: string, token = first.token, extra?: Record<string, string>) {
	return new Request(new URL(pathname, base), {
		method,
		body,
		headers: { Authorization: `Bearer ${token}`, "X-LearnHarness-Protocol": "1", ...extra },
	});
}

async function reserve(draftId: string, size: number, name = "fixture.txt") {
	return reserveAttachmentRequest(request("/api/attachments", "POST", JSON.stringify({ draftId, name, mimeType: "", size })));
}

test("upload checks owner, protocol, exact bytes and immutable duplicate retries", async () => {
	const response = await reserve(randomUUID(), 4);
	assert.equal(response.status, 201);
	const { id, uploadUrl } = await response.json();
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "data", second.token))).status, 403);
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "data", first.token, { "X-LearnHarness-Protocol": "2" }))).status, 426);
	const crossSite = new Request(new URL(uploadUrl, base), {
		method: "PUT", body: "data",
		headers: { cookie: `lh_session_${process.env.PORT ?? "3000"}=${first.token}`, host: "attachment.test:3000", origin: "https://foreign.invalid" },
	});
	assert.equal((await uploadAttachmentRequest(crossSite)).status, 403);
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "short"))).status, 400);
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "abc"))).status, 400);
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "data"))).status, 204);
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "data"))).status, 204);
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "else"))).status, 409);
	assert.equal((await discardAttachmentRequest(request(`/api/attachments/${id}`, "DELETE"), Promise.resolve({ id }))).status, 204);
});

test("concurrent reservations share the server cap before receiving bytes", async () => {
	const results = await Promise.all(Array.from({ length: 11 }, () => reserve(randomUUID(), 50 * 1024 * 1024)));
	assert.deepEqual(results.map(result => result.status).sort(), [...Array(10).fill(201), 413]);
	for (const result of results.filter(result => result.ok)) {
		const { id } = await result.json();
		assert.equal((await discardAttachmentRequest(request(`/api/attachments/${id}`, "DELETE"), Promise.resolve({ id }))).status, 204);
	}
});

test("grant expiry and revocation precede publication", async t => {
	const now = Date.now();
	const expired = await (await reserve(randomUUID(), 1)).json();
	t.mock.method(Date, "now", () => now + 11 * 60_000);
	assert.equal((await uploadAttachmentRequest(request(expired.uploadUrl, "PUT", "x"))).status, 403);
	t.mock.restoreAll();
	const disposable = pairing("revoked attachment device");
	const grant = await reserveAttachmentRequest(request("/api/attachments", "POST", JSON.stringify({ draftId: randomUUID(), name: "test.txt", size: 1, mimeType: "text/plain" }), disposable.token));
	assert.equal(grant.status, 201);
	const { uploadUrl } = await grant.json();
	await revokeSession(PATHS.data, disposable.session.id);
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "x", disposable.token))).status, 401);
});

test("a refused opening creates no chat and leaves its bytes reusable", async () => {
	const draftId = randomUUID();
	const upload = await (await reserve(draftId, 4)).json();
	assert.equal((await uploadAttachmentRequest(request(upload.uploadUrl, "PUT", "test"))).status, 204);
	const body = JSON.stringify({ draftId, sendId: randomUUID(), title: "Open with a file", attachmentUploadIds: [upload.id] });
	const before = chatStore.listChats().length;
	for (let attempt = 0; attempt < 2; attempt++) {
		assert.equal((await startAttachmentRequest(request("/api/attachments/start", "POST", body))).status, 503);
	}
	assert.equal(chatStore.listChats().length, before);
	assert.equal((await uploadAttachmentRequest(request(upload.uploadUrl, "PUT", "test"))).status, 204);
});

test("claim scopes, protects the pending source on save failure, and collects only after live references disappear", async () => {
	const draftId = randomUUID();
	const { id, uploadUrl } = await (await reserve(draftId, 4)).json();
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "test"))).status, 204);
	const denied = () => assert.fail("claim must not reach persistence");
	assert.throws(() => claimAttachments([id], second.session.id, { draftId }, [], denied), /unavailable/);
	assert.throws(() => claimAttachments([id], first.session.id, { draftId: randomUUID() }, [], denied), /unavailable/);
	assert.throws(() => claimAttachments([id], first.session.id, { chatId: "chat_other" }, [], denied), /unavailable/);
	assert.throws(() => claimAttachments([id], first.session.id, { draftId }, [], () => { throw new Error("synthetic disk failure"); }), /synthetic disk failure/);
	assert.equal(claimedAttachmentPath(id), undefined);
	const chat = chatStore.createChat("attachment references");
	const other = chatStore.createChat("another live reference");
	claimAttachments([id], first.session.id, { draftId }, [], attachments => {
		chatStore.saveMessages(chat.id, [{ ...newUserMessage("attachment"), attachments }]);
		chatStore.saveMessages(other.id, [{ ...newUserMessage("attachment"), attachments }]);
	});
	const claimed = claimedAttachmentPath(id)!;
	assert.equal(fs.readFileSync(claimed, "utf8"), "test");
	setFileAccessPolicy(() => ({ restricted: true, folders: [] }));
	const tool = createReadTool(undefined, key => key === id ? { name: "fixture.txt", filename: claimed } : undefined);
	const result = await tool.execute("read-test", { path: `attachment:${id}` });
	assert.deepEqual(result.content, [{ type: "text", text: "test" }]);
	await assert.rejects(() => createReadTool().execute("read-test", { path: `attachment:${id}` }), /current chat/);
	await assert.rejects(() => tool.execute("read-test", { path: claimed }), /protected location/);
	await assert.rejects(() => createReadTool(undefined, () => ({ filename: claimed, name: ".env" })).execute("read-test", { path: `attachment:${id}` }), /protected file/);
	scheduleAttachmentRemoval([{ id, name: "fixture.txt" }]);
	chatStore.deleteChat(chat.id);
	sweepAttachments();
	assert.equal(claimedAttachmentPath(id), claimed);
	chatStore.deleteChat(other.id);
	sweepAttachments();
	assert.equal(claimedAttachmentPath(id), undefined);
});

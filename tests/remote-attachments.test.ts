import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PdfResult, VisualResult } from "../src/core/contracts.ts";
import { after, test } from "node:test";
import { issueSession, revokeSession } from "../selfhost/src/auth-store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zz-prove-it-attachment-tests-"));
fs.mkdirSync(path.join(root, "home"));
process.env.HOME = path.join(root, "home");
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.LH_SELFHOST = "0";
process.env.LH_IGNORE_ENV_KEYS = "1";

const { headlessOverride, realHeadless } = await import("../src/agent/subagents/headless.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { jobTools } = await import("../src/agent/tools/jobs.ts");
const { createShowImageTool } = await import("../src/agent/tools/show-image.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { attachmentsForChat } = await import("../src/server/attachment-submissions.ts");
const { PATHS } = await import("../config.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { createReadTool } = await import("../src/agent/tools/read.ts");
const { setFileAccessPolicy } = await import("../src/agent/tools/file-access.ts");
const { claimAttachments, claimedAttachmentPath, scheduleAttachmentRemoval, sweepAttachments } = await import("../src/store/attachments.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const { deleteSources } = await import("../src/server/source-deletion.ts");
const { stores } = await import("../src/server/stores.ts");
const { persistTurn } = await import("../src/server/turn-service.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { reserveAttachmentRequest, uploadAttachmentRequest, discardAttachmentRequest, startAttachmentRequest } = await import("../src/server/attachment-routes.ts");

after(() => fs.rmSync(root, { recursive: true, force: true }));

const pairing = (label: string) => issueSession(PATHS.data, { method: "pairing", client: { label, deviceType: "desktop" } });
const first = pairing("first attachment test device");
const second = pairing("second attachment test device");
const base = "http://attachment.test:3000";

function request(pathname: string, method: string, body?: string | Uint8Array<ArrayBuffer>, token = first.token, extra?: Record<string, string>) {
	return new Request(new URL(pathname, base), {
		method,
		body,
		headers: { Authorization: `Bearer ${token}`, "X-LearnHarness-Protocol": "1", ...extra },
	});
}

function holdUpload(uploadUrl: string, token = first.token) {
	let stream!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start: controller => { stream = controller; } });
	const headers = request(uploadUrl, "PUT", undefined, token).headers;
	const response = uploadAttachmentRequest(new Request(new URL(uploadUrl, base), { method: "PUT", headers, body, duplex: "half" } as RequestInit));
	return { response, finish(text: string) { stream.enqueue(new TextEncoder().encode(text)); stream.close(); } };
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

test("the grant deadline applies at upload start only", async t => {
	const { uploadUrl, expiresAt } = await (await reserve(randomUUID(), 1)).json();
	const upload = holdUpload(uploadUrl);
	t.mock.method(Date, "now", () => expiresAt + 1);
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "x"))).status, 403);
	upload.finish("x");
	assert.equal((await upload.response).status, 204);
});

test("revoking a pairing during an upload prevents publication", async () => {
	const disposable = pairing("revoked attachment device");
	const grant = await reserveAttachmentRequest(request("/api/attachments", "POST", JSON.stringify({ draftId: randomUUID(), name: "test.txt", size: 1, mimeType: "text/plain" }), disposable.token));
	assert.equal(grant.status, 201);
	const { id, uploadUrl } = await grant.json();
	const upload = holdUpload(uploadUrl, disposable.token);
	await revokeSession(PATHS.data, disposable.session.id);
	upload.finish("x");
	assert.equal((await upload.response).status, 401);
	assert.equal(fs.existsSync(path.join(PATHS.attachments, "pending", id + ".body")), false);
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "x", disposable.token))).status, 401);
});

test("a refused opening creates no chat and leaves its bytes reusable", async () => {
	const draftId = randomUUID();
	const upload = await (await reserve(draftId, 4)).json();
	assert.equal((await uploadAttachmentRequest(request(upload.uploadUrl, "PUT", "test"))).status, 204);
	const body = JSON.stringify({ draftId, sendId: randomUUID(), title: "Open with a file", attachmentUploadIds: [upload.id] });
	const before = chatStore.listChats().length;
	for (let attempt = 0; attempt < 2; attempt++) {
		assert.equal((await startAttachmentRequest(request("/api/attachments/start", "POST", body))).status, 422);
	}
	assert.equal(chatStore.listChats().length, before);
	assert.equal((await uploadAttachmentRequest(request(upload.uploadUrl, "PUT", "test"))).status, 204);
});

test("an opening on a saved model the catalog dropped is refused as model_unavailable, even without its key", async () => {
	const { readSettings, writeSettings } = await import("../src/store/settings.ts");
	const before = readSettings();
	const savedKey = process.env.OPENCODE_API_KEY;
	delete process.env.OPENCODE_API_KEY;
	writeSettings({ version: 1, models: { strong: { model: { provider: "opencode-go", id: "minimax-m3.1-flash-free" } } } });
	try {
		const draftId = randomUUID();
		const upload = await (await reserve(draftId, 4)).json();
		assert.equal((await uploadAttachmentRequest(request(upload.uploadUrl, "PUT", "test"))).status, 204);
		const chats = chatStore.listChats().length;
		const refused = await startAttachmentRequest(request("/api/attachments/start", "POST", JSON.stringify({ draftId, sendId: randomUUID(), title: "Open with a file", attachmentUploadIds: [upload.id] })));
		assert.equal(refused.status, 422);
		assert.deepEqual(await refused.json(), {
			error: "The model opencode-go/minimax-m3.1-flash-free is no longer available. Pick another model in Settings.",
			code: "model_unavailable",
		});
		assert.equal(chatStore.listChats().length, chats, "no chat is created");
	} finally {
		writeSettings(before ?? { version: 1 });
		if (savedKey !== undefined) process.env.OPENCODE_API_KEY = savedKey;
	}
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

async function uploadForChat(chatId: string, name: string, mimeType: string, bytes: Uint8Array<ArrayBuffer>) {
	const grant = await reserveAttachmentRequest(request("/api/attachments", "POST", JSON.stringify({ chatId, name, mimeType, size: bytes.byteLength })));
	assert.equal(grant.status, 201);
	const { id, uploadUrl } = await grant.json();
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", bytes))).status, 204);
	claimAttachments([id], first.session.id, { chatId }, [], attachments => {
		chatStore.saveMessages(chatId, [{ ...newUserMessage("Use this file"), attachments }]);
	});
	return { id, source: `attachment:${id}` };
}

function scriptedRunner(steps: FauxResponseStep[], deliver: Parameters<typeof createJobRunner>[0]["deliver"] = async () => {}) {
	const model = createFauxCore({});
	model.setResponses(steps);
	return createJobRunner({
		chatStore, jobStore, attachmentsForChat, deliver,
		engineFor: () => ({ model: model.getModel(), streamFn: model.streamSimple }),
	});
}

test("PDF dispatch and recovery use the current chat's opaque reference for a cited brief", async () => {
	setFileAccessPolicy(() => ({ restricted: true, folders: [] }));
	const chat = chatStore.createChat("Uploaded PDF");
	const other = chatStore.createChat("Other PDF chat");
	const bytes = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf")));
	const { id, source } = await uploadForChat(chat.id, "sample.pdf", "application/pdf", bytes);
	const toolsFor = (chatId: string) => jobTools({ chatId, jobStore, resolveAttachment: attachmentsForChat(chatId), spawn: () => {} });
	const input = { path: source, question: "What does page one say about integration?" };
	await assert.rejects(toolsFor(other.id).pdf!.execute("cross-chat", input), /current chat/);
	await assert.rejects(toolsFor(chat.id).pdf!.execute("absolute", { ...input, path: claimedAttachmentPath(id)! }), /protected location/);
	await toolsFor(chat.id).pdf!.execute("own-pdf", input);
	const job = jobStore.findJobByToolCallId(chat.id, "own-pdf")!;
	assert.deepEqual(job.input, input);
	const backingPath = fs.realpathSync.native(claimedAttachmentPath(id)!);
	let metadata = "";
	await scriptedRunner([
		fauxAssistantMessage([fauxToolCall("pdf_info", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" })], { stopReason: "toolUse" }),
		({ messages }) => {
			const info = messages.find(message => message.role === "toolResult" && message.toolName === "pdf_info");
			metadata = info?.role === "toolResult"
				? info.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n")
				: "";
			const reportedSource = /^File: (.*)$/m.exec(metadata)?.[1];
			return fauxAssistantMessage(`The integral rule appears in ${reportedSource} (p. 1).`);
		},
	], async steer => { persistTurn(chatStore, chat.id, 0, [steer], false); }).runJob(job.id);
	const result = jobStore.getJob(job.id)!.result as PdfResult;
	const transcript = fs.readFileSync(path.join(PATHS.chats, chat.id + ".json"), "utf8");
	const citation = `${source} (p. 1)`;
	assert.ok(metadata.includes(`File: ${source}\n`), "worker metadata must show the opaque reference");
	assert.ok(!metadata.includes(backingPath));
	assert.equal(result.path, source);
	assert.deepEqual(result.pagesRead, [1]);
	assert.ok(result.brief.includes(citation));
	assert.ok(!result.brief.includes(backingPath));
	assert.ok(transcript.includes(citation));
	assert.ok(!transcript.includes(JSON.stringify(backingPath).slice(1, -1)));
	const otherJob = jobStore.createJob({ kind: "pdf", chatId: other.id, toolCallId: "other-pdf", input });
	await scriptedRunner([]).runJob(otherJob.id);
	assert.match((jobStore.getJob(otherJob.id)!.result as PdfResult).brief, /current chat/);
	fs.unlinkSync(claimedAttachmentPath(id)!);
	const missing = jobStore.createJob({ kind: "pdf", chatId: chat.id, toolCallId: "missing-pdf", input });
	await scriptedRunner([]).runJob(missing.id);
	assert.match((jobStore.getJob(missing.id)!.result as PdfResult).brief, /File unavailable\. Attach it again to use it\./);
});

test("show_image and visual save uploaded image snapshots with opaque provenance", async t => {
	setFileAccessPolicy(() => ({ restricted: true, folders: [] }));
	// The annotation uses the real native SVG renderer. Skip the browser
	// availability probe so this test never downloads or requires Electron.
	headlessOverride.current = { ...realHeadless, unavailableReason: () => null };
	t.after(() => { headlessOverride.current = undefined; });
	const chat = chatStore.createChat("Uploaded image");
	const other = chatStore.createChat("Other image chat");
	const { createCanvas } = await import("@napi-rs/canvas");
	const canvas = createCanvas(40, 30);
	const context = canvas.getContext("2d");
	context.fillStyle = "#2244cc";
	context.fillRect(0, 0, 40, 30);
	const { id, source } = await uploadForChat(chat.id, "photo.png", "image/png", new Uint8Array(canvas.toBuffer("image/png")));
	const show = (chatId: string) => createShowImageTool({ chatId, chatStore, resolveAttachment: attachmentsForChat(chatId) });
	await assert.rejects(show(other.id).execute("other-photo", { path: source }), /current chat/);
	await assert.rejects(show(chat.id).execute("raw-photo", { path: claimedAttachmentPath(id)! }), /protected location/);
	const saved = chatStore.getChat(chat.id)!;
	chatStore.saveMessages(chat.id, [{ ...newUserMessage("Protected filename"), attachments: [{ id, name: ".env" }] }]);
	await assert.rejects(show(chat.id).execute("protected-photo", { path: source }), /protected file/);
	chatStore.saveMessages(chat.id, saved.messages);
	const shown = await show(chat.id).execute("show-photo", { path: source, caption: "Synthetic photo" });
	const details = shown.details as { path: string; snapshotId: string };
	const privatePath = JSON.stringify(fs.realpathSync.native(claimedAttachmentPath(id)!)).slice(1, -1);
	assert.ok(!JSON.stringify(shown).includes(privatePath));
	assert.equal(details.path, source);
	assert.ok(chatStore.getChat(chat.id)?.imageSnapshots?.[details.snapshotId]);
	const tools = jobTools({ chatId: chat.id, jobStore, spawn: () => {}, resolveAttachment: attachmentsForChat(chat.id) });
	await tools.visual!.execute("annotate-photo", { brief: "Circle the center", image: source });
	const job = jobStore.findJobByToolCallId(chat.id, "annotate-photo")!;
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" viewBox="0 0 40 30"><image href="learner-image" x="0" y="0" width="40" height="30"/><circle cx="20" cy="15" r="7" fill="none" stroke="white"/></svg>';
	await scriptedRunner([
		fauxAssistantMessage([fauxToolCall("write_svg", { svg }), fauxToolCall("render_svg", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Circled the center.")]),
	]).runJob(job.id);
	const result = jobStore.getJob(job.id)!.result as VisualResult;
	assert.match(result.svg, /<circle/);
	assert.deepEqual(result.image, { path: source, snapshotId: details.snapshotId });
	assert.ok(!JSON.stringify(result).includes(privatePath));
	assert.ok(chatStore.getChat(chat.id)?.imageSnapshots?.[details.snapshotId]?.data);
	fs.unlinkSync(claimedAttachmentPath(id)!);
	await assert.rejects(show(chat.id).execute("missing-photo", { path: source }), /File unavailable\. Attach it again to use it\./);
	const missing = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "missing-visual", input: { brief: "Circle the center", image: source } });
	await scriptedRunner([]).runJob(missing.id);
	assert.match((jobStore.getJob(missing.id)!.result as VisualResult).notes ?? "", /File unavailable\. Attach it again to use it\./);
});

test("overlapping PUTs cannot both hold the same upload ID", async () => {
	const { uploadUrl } = await (await reserve(randomUUID(), 4)).json();
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "test"))).status, 204);
	const firstPut = holdUpload(uploadUrl);
	const secondPut = await uploadAttachmentRequest(request(uploadUrl, "PUT", "test"));
	assert.equal(secondPut.status, 409);
	assert.match((await secondPut.json()).error, /already uploading/);
	firstPut.finish("test");
	assert.equal((await firstPut.response).status, 204);
});

test("discard cleans an interrupted claim without unlinking any live copy", async () => {
	const chat = chatStore.createChat("Claim recovery");
	for (const live of [false, true]) {
		const draftId = randomUUID();
		const { id, uploadUrl } = await (await reserve(draftId, 4)).json();
		assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "test"))).status, 204);
		const copy = path.join(PATHS.attachments, "claimed", id);
		fs.mkdirSync(path.dirname(copy), { recursive: true });
		fs.writeFileSync(copy, "test");
		if (live) chatStore.saveMessages(chat.id, [{ ...newUserMessage("Retained"), attachments: [{ id, name: "fixture.txt" }] }]);
		assert.equal((await discardAttachmentRequest(request(`/api/attachments/${id}`, "DELETE"), Promise.resolve({ id }))).status, 204);
		assert.equal(fs.existsSync(copy), live);
		assert.equal(fs.existsSync(path.join(PATHS.attachments, "pending", id + ".json")), false);
	}
});

test("sweep cleans staging despite corrupt metadata and defers claimed deletion until references are readable", async () => {
	const damagedChat = chatStore.createChat("Damaged chat record");
	const recordPath = path.join(PATHS.chats, damagedChat.id + ".json");
	const original = fs.readFileSync(recordPath, "utf8");
	const draftId = randomUUID();
	const { id, uploadUrl } = await (await reserve(draftId, 4)).json();
	assert.equal((await uploadAttachmentRequest(request(uploadUrl, "PUT", "test"))).status, 204);
	const orphan = path.join(PATHS.attachments, "pending", id + ".body");
	const metadata = path.join(PATHS.attachments, "pending", id + ".json");
	fs.writeFileSync(metadata, "{");
	const claimedId = randomUUID();
	const copy = path.join(PATHS.attachments, "claimed", claimedId);
	fs.mkdirSync(path.dirname(copy), { recursive: true });
	fs.writeFileSync(copy, "claimed");
	scheduleAttachmentRemoval([{ id: claimedId, name: "old.txt" }]);
	fs.writeFileSync(recordPath, "{");
	try {
		assert.equal((await reserve(draftId, 1)).status, 201);
		sweepAttachments(Date.now() + 25 * 60 * 60_000);
		assert.equal(fs.existsSync(orphan), false);
		assert.equal(fs.existsSync(metadata), false);
		assert.equal(fs.existsSync(copy), true);
	} finally {
		fs.writeFileSync(recordPath, original);
	}
	sweepAttachments();
	assert.equal(fs.existsSync(copy), false);
});

test("a cleanup marker failure preserves chat traces for direct and source deletion", async () => {
	const chat = chatStore.createChat("Attachment cleanup unavailable");
	const { id } = await uploadForChat(chat.id, "fixture.txt", "text/plain", new TextEncoder().encode("fixture"));
	const node = { id: "cleanup-marker-node", name: "Cleanup marker", aliases: [], statement: "Synthetic trace", createdAt: "2026-11-18", provenance: [{ chatId: chat.id, messageId: "fixture" }] };
	stores.graphStore.appendNode(node);
	const saved = chatStore.getChat(chat.id);
	const marker = path.join(PATHS.attachments, "cleanup", id);
	fs.mkdirSync(marker, { recursive: true }); // A directory at the marker path forces the write to fail.
	try {
		await assert.rejects(deleteChatSession(chat.id, "delete-nodes"));
		assert.deepEqual(chatStore.getChat(chat.id), saved);
		assert.deepEqual(stores.graphStore.readNodes().find(item => item.id === node.id), node);
		assert.throws(() => deleteSources({ sourceIds: [chat.id], folderIds: [], deleteSessions: true }));
		assert.deepEqual(chatStore.getChat(chat.id), saved);
		assert.deepEqual(stores.graphStore.readNodes().find(item => item.id === node.id), node);
	} finally {
		fs.rmdirSync(marker);
	}
	assert.equal((await deleteChatSession(chat.id, "delete-nodes")).ok, true);
	assert.equal(chatStore.getChat(chat.id), null);
	assert.equal(stores.graphStore.readNodes().some(item => item.id === node.id), false);
});

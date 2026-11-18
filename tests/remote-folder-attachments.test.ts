import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { issueSession } from "../selfhost/src/auth-store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zz-prove-it-folder-attachment-tests-"));
fs.mkdirSync(path.join(root, "home"));
process.env.HOME = path.join(root, "home");
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.LH_SELFHOST = "0";
process.env.LH_IGNORE_ENV_KEYS = "1";

const { PATHS } = await import("../config.ts");
const { folderLimitError, folderPathError, skippedFolderNotice, unsafeFolderPath } = await import("../src/core/attachment-folders.ts");
const { newUserMessage, toLlmMessages } = await import("../src/core/native-messages.ts");
const { attachmentsForChat } = await import("../src/server/attachment-submissions.ts");
const { discardAttachmentRequest, renewAttachmentFolderRequest, reserveAttachmentRequest, uploadAttachmentRequest } = await import("../src/server/attachment-routes.ts");
const { claimAttachments, claimedAttachmentPath, scheduleAttachmentRemoval, sweepAttachments } = await import("../src/store/attachments.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { setFileAccessPolicy } = await import("../src/agent/tools/file-access.ts");
const { createReadTool } = await import("../src/agent/tools/read.ts");
const { createLsTool } = await import("../src/agent/tools/ls.ts");
const { createFindTool } = await import("../src/agent/tools/find.ts");
const { createGrepTool } = await import("../src/agent/tools/grep.ts");
const { droppedAttachments, folderFromFiles, folderFromPick } = await import("../components/attachment-folder.ts");

after(() => fs.rmSync(root, { recursive: true, force: true }));

const owner = issueSession(PATHS.data, { method: "pairing", client: { label: "folder test device", deviceType: "desktop" } });
const other = issueSession(PATHS.data, { method: "pairing", client: { label: "other folder device", deviceType: "desktop" } });
const base = "http://attachment.test:3000";
const MiB = 1024 * 1024;

function request(pathname: string, method: string, body?: string, token = owner.token) {
	return new Request(new URL(pathname, base), { method, body, headers: { Authorization: `Bearer ${token}`, "X-LearnHarness-Protocol": "1" } });
}

const file = (filePath: string, size = 1, mimeType = "text/plain") => ({ path: filePath, mimeType, size });
const pendingEntries = () => fs.existsSync(path.join(PATHS.attachments, "pending")) ? fs.readdirSync(path.join(PATHS.attachments, "pending")) : [];

async function reserveFolder(target: object, name: string, files: { path: string; mimeType: string; size: number }[], token = owner.token) {
	return reserveAttachmentRequest(request("/api/attachments", "POST", JSON.stringify({ ...target, name, files }), token));
}

const renew = (id: string, token = owner.token) => renewAttachmentFolderRequest(request(`/api/attachments/${id}`, "POST", undefined, token), Promise.resolve({ id }));
const put = (uploadUrl: string, text: string) => uploadAttachmentRequest(request(uploadUrl, "PUT", text));

test("unsafe paths reject the whole folder and name the entry", () => {
	for (const unsafe of ["/etc/passwd", "C:/x.txt", "a/../b", "./a", "a\\b", "a//b", "a/", "CON", "sub/nul.txt", "com1.md", "a:b", "what?", "trailing.", "space ", "x\u0001y", "a".repeat(256),
		"CONIN$", "conout$.txt", "CON .txt", "nul. .md", "sub/LPT1 .log", "c1\u0085control", "x\u009f", "\u0080"]) {
		assert.equal(unsafeFolderPath(unsafe), true, unsafe);
	}
	for (const safe of ["notes.md", "sub/deeper/file.txt", ".hidden/ok", "console.log", "a b/c", "..notes.txt", "..config/a.txt", "conin.txt", "com10.md", "caf\u00e9.md"]) {
		assert.equal(unsafeFolderPath(safe), false, safe);
	}
	assert.equal(folderPathError("Notes", [file("a.md"), file("sub/CON.txt")]), "\"Notes/sub/CON.txt\" is not a safe file path. Rename it or attach a different folder.");
	assert.match(folderPathError("Notes", [file("A.md"), file("a.md")])!, /Notes\/a\.md/);
	assert.match(folderPathError("Notes", [file("sub"), file("sub/x.md")])!, /Notes\/sub\/x\.md/);
	assert.match(folderPathError("Notes", [file("SUB/x.md"), file("sub")])!, /Notes\/sub"/);
	assert.equal(folderPathError("Notes", []), "Notes has no files to attach.");
	assert.equal(folderPathError("Notes", [file("a.md"), file("sub/b.md")]), undefined);
});

test("folder limits count every contained file", () => {
	assert.equal(folderLimitError("Big", Array.from({ length: 101 }, (_, index) => file(`f${index}.txt`))), "Attach up to 100 files per folder.");
	assert.equal(folderLimitError("Big", Array.from({ length: 6 }, (_, index) => file(`f${index}.bin`, 45 * MiB))), "Big exceeds the 256 MiB per-folder limit.");
	assert.equal(folderLimitError("Big", [file("huge.bin", 51 * MiB)]), "huge.bin exceeds the 50 MiB per-file limit.");
	assert.equal(folderLimitError("Big", [file("photo.png", 11 * MiB, "image/png")]), "photo.png exceeds the 10 MiB per-image limit.");
	assert.equal(folderLimitError("Big", Array.from({ length: 100 }, (_, index) => file(`f${index}.txt`))), undefined);
});

test("the composer skips hidden and OS junk entries and reports them", () => {
	const blob = (name: string) => new File(["x"], name);
	const picked = ["Notes/a.md", "Notes/.git/HEAD", "Notes/.git/objects/1", "Notes/.DS_Store", "Notes/sub/Thumbs.db", "Notes/sub/b.md", "Notes/__MACOSX/a.md", "Notes/DESKTOP.INI"]
		.map(relativePath => ({ file: blob(relativePath.split("/").at(-1)!), relativePath }));
	const folder = folderFromPick(picked);
	assert.ok(!("error" in folder));
	assert.equal(folder.name, "Notes");
	assert.deepEqual(folder.files.map(entry => entry.path), ["a.md", "sub/b.md"]);
	assert.equal(folder.skippedCount, 6);
	assert.equal(skippedFolderNotice(folder.name, folder.skippedCount, folder.skippedNames),
		"Skipped 6 hidden or system files in Notes: .git/, .DS_Store, sub/Thumbs.db, __MACOSX/, DESKTOP.INI");
	assert.equal(skippedFolderNotice("X", 9, ["1", "2", "3", "4", "5", "6", "7"]), "Skipped 9 hidden or system files in X: 1, 2, 3, 4, 5 and 2 more");
	// Old phone browsers accept the folder input but return plain files.
	assert.deepEqual(folderFromFiles([blob("a.md"), blob("b.md")]), { error: "This browser can't attach folders. Attach individual files instead." });
});

test("a dropped folder is walked to the last empty batch", async () => {
	const fileEntry = (fullPath: string) => ({
		isFile: true, isDirectory: false, name: fullPath.split("/").at(-1)!, fullPath,
		file: (resolve: (value: File) => void) => resolve(new File([fullPath], fullPath.split("/").at(-1)!)),
	});
	const directory = (fullPath: string, batches: object[][]) => ({
		isFile: false, isDirectory: true, name: fullPath.split("/").at(-1)!, fullPath,
		createReader: () => { let call = 0; return { readEntries: (resolve: (value: object[]) => void) => resolve(batches[call++] ?? []) }; },
	});
	const tree = directory("/Notes", [[fileEntry("/Notes/a.md")], [directory("/Notes/sub", [[fileEntry("/Notes/sub/b.md")]]), fileEntry("/Notes/.DS_Store")]]);
	const { files, folders } = await droppedAttachments([tree, fileEntry("/loose.txt")] as unknown as FileSystemEntry[]);
	assert.deepEqual(files.map(entry => entry.name), ["loose.txt"]);
	const [folder] = folders;
	assert.ok(folder && !("error" in folder));
	assert.deepEqual(folder.files.map(entry => entry.path), ["a.md", "sub/b.md"]);
	assert.equal(folder.skippedCount, 1);
});

test("the server validates the whole manifest before creating any upload", async () => {
	const draftId = randomUUID();
	const before = pendingEntries();
	const unsafe = await reserveFolder({ draftId }, "Notes", [file("a.md"), file("../escape.md")]);
	assert.equal(unsafe.status, 400);
	assert.match((await unsafe.json()).error, /"Notes\/\.\.\/escape\.md" is not a safe file path/);
	const many = await reserveFolder({ draftId }, "Notes", Array.from({ length: 101 }, (_, index) => file(`f${index}.txt`)));
	assert.equal(many.status, 413);
	const big = await reserveFolder({ draftId }, "Notes", Array.from({ length: 6 }, (_, index) => file(`f${index}.bin`, 45 * MiB)));
	assert.equal(big.status, 413);
	assert.deepEqual(pendingEntries(), before);
	// Hidden entries from another client are accepted; only unsafe paths are refused.
	const hidden = await reserveFolder({ draftId }, "Notes", [file(".git/HEAD")]);
	assert.equal(hidden.status, 201);
	const { id } = await hidden.json();
	assert.equal((await discardAttachmentRequest(request(`/api/attachments/${id}`, "DELETE"), Promise.resolve({ id }))).status, 204);
	assert.deepEqual(pendingEntries(), before);
});

test("a folder uploads, renews only missing files, keeps its layout and can be browsed", async () => {
	const chat = chatStore.createChat("zz-prove-it folder chat");
	const reserved = await reserveFolder({ chatId: chat.id }, "Course notes", [file("week1/intro.md", 11), file("week1/data/table.csv", 5), file("README.txt", 6)]);
	assert.equal(reserved.status, 201);
	const grant = await reserved.json();
	assert.deepEqual(grant.files.map((entry: { path: string }) => entry.path), ["week1/intro.md", "week1/data/table.csv", "README.txt"]);
	assert.equal((await put(grant.files[0].uploadUrl, "hello world")).status, 204);
	assert.equal((await renew(grant.id, other.token)).status, 404);
	const renewed = await (await renew(grant.id)).json();
	assert.deepEqual(renewed.files.map((entry: { path: string }) => entry.path), ["week1/data/table.csv", "README.txt"]);
	// The old grant for a renewed file is no longer valid.
	assert.equal((await put(grant.files[1].uploadUrl, "a,b,c")).status, 403);
	assert.equal((await put(renewed.files[0].uploadUrl, "a,b,c")).status, 204);
	assert.equal((await put(renewed.files[1].uploadUrl, "readme")).status, 204);

	// A folder's file can't be sent or removed on its own.
	const member = new URL(grant.files[0].uploadUrl, base).searchParams.get("id")!;
	assert.throws(() => claimAttachments([member], owner.session.id, { chatId: chat.id }, [], () => assert.fail("no save")), /unavailable/);
	assert.equal((await discardAttachmentRequest(request(`/api/attachments/${member}`, "DELETE"), Promise.resolve({ id: member }))).status, 404);

	claimAttachments([grant.id], owner.session.id, { chatId: chat.id }, [], attachments => {
		assert.deepEqual(attachments, [{ id: grant.id, name: "Course notes", fileCount: 3 }]);
		chatStore.saveMessages(chat.id, [{ ...newUserMessage("Use my notes"), attachments }]);
	});
	const stored = claimedAttachmentPath(grant.id)!;
	assert.equal(fs.readFileSync(path.join(stored, "week1", "data", "table.csv"), "utf8"), "a,b,c");
	assert.equal(fs.readFileSync(path.join(stored, "README.txt"), "utf8"), "readme");
	assert.ok(!pendingEntries().some(entry => entry.startsWith(grant.id) || entry.startsWith(member)));

	const llm = toLlmMessages(chatStore.getChat(chat.id)!.messages);
	const text = JSON.stringify(llm);
	assert.ok(text.includes(`attachment:${grant.id} \\"Course notes\\" (folder, 3 files. Browse it with ls, find or grep, and open files as attachment:${grant.id}/<path>)`));
	assert.ok(text.includes("Attached files and folders ("));

	setFileAccessPolicy(() => ({ restricted: true, folders: [] }));
	const lookup = attachmentsForChat(chat.id);
	const ref = `attachment:${grant.id}`;
	const run = async (tool: { execute: (id: string, input: never) => Promise<{ content: { type: string; text?: string }[] }> }, input: object) =>
		(await tool.execute("folder-test", input as never)).content.map(part => part.text).join("");
	assert.equal(await run(createLsTool(lookup), { path: ref }), "README.txt\nweek1/");
	assert.equal(await run(createLsTool(lookup), { path: `${ref}/week1/` }), "data/\nintro.md");
	assert.equal(await run(createFindTool(lookup), { path: ref, pattern: "*.csv" }), "week1/data/table.csv");
	assert.equal(await run(createGrepTool(lookup), { path: ref, pattern: "hello" }), "week1/intro.md:1: hello world");
	assert.equal(await run(createGrepTool(lookup), { path: `${ref}/README.txt`, pattern: "read" }), "README.txt:1: readme");
	assert.equal(await run(createReadTool(undefined, lookup), { path: `${ref}/week1/intro.md` }), "hello world");
	for (const tool of [createLsTool(lookup), createFindTool(lookup), createGrepTool(lookup)]) {
		const failure = await tool.execute("folder-test", { path: `${ref}/missing`, pattern: "x" } as never).catch((error: Error) => error);
		assert.ok(failure instanceof Error);
		assert.equal(failure.message, `Path not found: ${ref}/missing`);
		assert.ok(!failure.message.includes(PATHS.attachments));
	}
	await assert.rejects(() => createReadTool(undefined, lookup).execute("folder-test", { path: `${ref}/../${grant.id}/README.txt` }), new RegExp(`Path not found: ${ref}/\\.\\./`));
	await assert.rejects(() => createLsTool().execute("folder-test", { path: ref }), /not part of the current chat/);
	await assert.rejects(() => createLsTool(lookup).execute("folder-test", { path: stored }), /protected location/);
	setFileAccessPolicy(() => ({ restricted: false, folders: [] }));

	// Deleting the chat collects the whole tree.
	scheduleAttachmentRemoval([{ id: grant.id, name: "Course notes" }]);
	chatStore.deleteChat(chat.id);
	sweepAttachments();
	assert.equal(claimedAttachmentPath(grant.id), undefined);
	assert.equal(fs.existsSync(stored), false);
	await assert.rejects(() => createLsTool(lookup).execute("folder-test", { path: ref }), /not part of the current chat/);
});

test("an unsent folder expires with its files and a missing upload blocks the send", async t => {
	const draftId = randomUUID();
	const grant = await (await reserveFolder({ draftId }, "Draft", [file("a.txt", 1), file("b.txt", 1)])).json();
	assert.equal((await put(grant.files[0].uploadUrl, "a")).status, 204);
	assert.throws(() => claimAttachments([grant.id], owner.session.id, { draftId }, [], () => assert.fail("no save")), /unavailable/);
	assert.throws(() => claimAttachments([grant.id], owner.session.id, { draftId: randomUUID() }, [], () => assert.fail("no save")), /unavailable/);
	const now = Date.now();
	t.mock.method(Date, "now", () => now + 25 * 60 * 60_000);
	sweepAttachments(Date.now());
	assert.ok(!pendingEntries().some(entry => entry.startsWith(grant.id)));
	assert.equal((await renew(grant.id)).status, 404);
});

test("names that only start with two dots upload and keep their layout", async () => {
	const chat = chatStore.createChat("zz-prove-it dot-dot names");
	const grant = await (await reserveFolder({ chatId: chat.id }, "Dots", [file("..notes.txt", 2), file("..config/a.txt", 1)])).json();
	assert.equal((await put(grant.files[0].uploadUrl, "nn")).status, 204);
	assert.equal((await put(grant.files[1].uploadUrl, "a")).status, 204);
	claimAttachments([grant.id], owner.session.id, { chatId: chat.id }, [], attachments => {
		chatStore.saveMessages(chat.id, [{ ...newUserMessage("dots"), attachments }]);
	});
	const stored = claimedAttachmentPath(grant.id)!;
	assert.equal(fs.readFileSync(path.join(stored, "..notes.txt"), "utf8"), "nn");
	assert.equal(fs.readFileSync(path.join(stored, "..config", "a.txt"), "utf8"), "a");
	const read = await createReadTool(undefined, attachmentsForChat(chat.id)).execute("dots", { path: `attachment:${grant.id}/..config/a.txt` });
	assert.deepEqual(read.content, [{ type: "text", text: "a" }]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_HEADER, PROTOCOL_ROUTES } from "../../../src/client-protocol/index.ts";
import { AttachmentDraft, convertEach, localDeadline, photoName, photoNames, type PickedFile, type PutFile } from "../src/attachments.ts";
import { apiClient } from "../src/protocol.ts";

const origin = "https://test.learnharness.example";
const MiB = 1024 * 1024;
const photo: PickedFile = { name: "IMG_0042.jpg", uri: "file:///cache/IMG_0042.jpg", mimeType: "image/jpeg", size: 2 * MiB };
const pdf: PickedFile = { name: "notes.pdf", uri: "file:///cache/notes.pdf", mimeType: "application/pdf", size: 3000 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fake server for the attachment routes, plus a fake native PUT. */
function harness({ chatId, putStatus = () => 204, now = () => 1_000_000 }: { chatId?: string; putStatus?: (call: number) => number; now?: () => number } = {}) {
  const calls: { method: string; path: string; body?: unknown; auth?: string }[] = [];
  const puts: { url: string; headers: Record<string, string>; name: string }[] = [];
  let grants = 0;
  let ids = 0;
  const api = apiClient(async (url, init) => {
    const path = url.slice(origin.length);
    calls.push({ method: init.method, path, body: init.body && JSON.parse(init.body), auth: init.headers.Authorization });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    grants++;
    return Response.json({ id: `grant-${grants}`, uploadUrl: `/api/attachments/upload?id=grant-${grants}&grant=sig`, expiresAt: now() + 600_000 },
      { status: 201, headers: { date: new Date(now()).toUTCString() } });
  }, origin, "native-token");
  const put: PutFile = async (file, url, headers, progress) => {
    puts.push({ url, headers, name: file.name });
    progress(file.size / 2);
    const status = putStatus(puts.length);
    return status === 204 ? { status, body: "" } : { status, body: JSON.stringify({ error: "Pairing revoked." }) };
  };
  let redraws = 0;
  const released: string[] = [];
  const draft = new AttachmentDraft({ api, chatId, put, now, newId: () => `id-${++ids}`, changed: () => { redraws++; }, release: (path) => { released.push(path); } });
  return { draft, calls, puts, released, redraws: () => redraws };
}

test("timestamps camera and Android library photos, numbering several from one pick", () => {
  const date = new Date(2026, 10, 18, 9, 5, 7);
  assert.equal(photoName(date), "photo-20261118-090507.jpg");
  assert.deepEqual(photoNames([{ fileName: "0ca5ae69-260b.jpeg", mimeType: "image/jpeg" }], date, false), ["photo-20261118-090507.jpg"]);
  assert.deepEqual(photoNames([{ fileName: "18.jpg", mimeType: "image/jpeg" }, { fileName: "19.png", mimeType: "image/png" }, { mimeType: "image/jpeg" }], date, false),
    ["photo-20261118-090507.jpg", "photo-20261118-090507-2.png", "photo-20261118-090507-3.jpg"]);
});

test("the iPhone library keeps real names, with an extension that matches the bytes", () => {
  const date = new Date(2026, 10, 18, 9, 5, 7);
  assert.deepEqual(photoNames([
    { fileName: "IMG_0042.HEIC", mimeType: "image/jpeg" }, { fileName: "IMG_0043.heic", mimeType: "image/heic" },
    { fileName: "scan.png", mimeType: "image/png" }, { fileName: null, mimeType: "image/jpeg" },
    { fileName: "loop.gif", mimeType: "image/jpeg" }, { fileName: "IMG_0044.JPEG", mimeType: "image/jpeg" },
  ], date, true), ["IMG_0042.jpg", "IMG_0043.heic", "scan.png", "photo-20261118-090507.jpg", "loop.jpg", "IMG_0044.JPEG"]);
});

test("a timestamped name follows the bytes, so a re-encoded WebP is a .jpg", () => {
  const date = new Date(2026, 10, 18, 9, 5, 7);
  assert.deepEqual(photoNames([{ fileName: "21.webp", mimeType: "image/jpeg" }], date, false), ["photo-20261118-090507.jpg"]);
});

test("one photo the phone can't convert is skipped with a note, and the rest still attach", async () => {
  const picked = [
    { uri: "file:///cache/ImagePicker/a.jpg", fileName: "18.jpg", mimeType: "image/jpeg" },
    { uri: "file:///cache/ImagePicker/b.heic", fileName: "19.heic", mimeType: "image/heic" },
    { uri: "file:///cache/ImagePicker/c.gif", fileName: "20.gif", mimeType: "image/gif" },
    { uri: "file:///cache/ImagePicker/d.heic", fileName: null, mimeType: "image/heic" },
  ];
  const released: string[] = [];
  // The 12-bit HEICs fail to decode, as on the Pixel 6a emulator.
  const { converted, notice } = await convertEach(picked, async ({ uri }) => {
    if (uri.endsWith(".heic")) throw new Error("Uri lacks 'file' scheme");
    return uri.replace("ImagePicker", "ImageManipulator").replace(/\.\w+$/, ".jpg");
  }, (uri) => { released.push(uri); });
  assert.deepEqual(converted.map(({ uri, fileName }) => [uri, fileName]),
    [["file:///cache/ImageManipulator/a.jpg", "18.jpg"], ["file:///cache/ImageManipulator/c.jpg", "20.gif"]]);
  assert.equal(notice, "19.heic couldn't be converted on this phone. Attach it from Files instead.\n" +
    "A photo couldn't be converted on this phone. Attach it from Files instead.");
  assert.deepEqual(released, picked.map(({ uri }) => uri), "every original copy is deleted");
  assert.deepEqual(await convertEach(picked.slice(0, 1), async () => "file:///cache/x.jpg", () => {}),
    { converted: [{ ...picked[0], uri: "file:///cache/x.jpg" }] }, "no note when everything converts");
});

test("reads a grant deadline against the server's clock", () => {
  const now = 5_000_000;
  // The phone runs 60 s ahead of the server.
  assert.equal(localDeadline(1_000_000, new Date(now - 60_000).toUTCString(), now), 1_000_000 - 1000 + 60_000);
  assert.equal(localDeadline(1_000_000, null, now), 999_000);
});

test("reserves for the chat and PUTs each file with this pairing's credential", async () => {
  const { draft, calls, puts } = harness({ chatId: "chat-1" });
  assert.equal(draft.add([photo, pdf]), true);
  assert.equal(draft.rows.length, 2);
  await settle(); await settle();
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [["POST", PROTOCOL_ROUTES.attachments], ["POST", PROTOCOL_ROUTES.attachments]]);
  assert.deepEqual(calls[0]!.body, { chatId: "chat-1", name: "IMG_0042.jpg", mimeType: "image/jpeg", size: 2 * MiB });
  assert.equal(calls[0]!.auth, "Bearer native-token");
  assert.equal(puts[0]!.url, `${origin}/api/attachments/upload?id=grant-1&grant=sig`);
  assert.equal(puts[0]!.headers.Authorization, "Bearer native-token");
  assert.equal(puts[0]!.headers[PROTOCOL_HEADER], "1");
  assert.ok(draft.rows.every((row) => row.ready && !row.error));
  assert.equal(draft.rows[0]!.progress, 50);
});

test("refuses a pick over the shared limits before any upload", () => {
  const { draft, calls } = harness({ chatId: "chat-1" });
  assert.equal(draft.add([{ ...photo, size: 11 * MiB }]), false);
  assert.equal(draft.notice, "IMG_0042.jpg exceeds the 10 MiB per-image limit.");
  assert.equal(draft.add(Array.from({ length: 101 }, (_, index) => ({ ...pdf, name: `${index}.pdf` }))), false);
  assert.equal(draft.notice, "Attach up to 100 files per message.");
  assert.equal(draft.rows.length, 0);
  assert.equal(calls.length, 0);
});

test("a failed upload keeps its grant for Retry, and a lapsed grant is replaced", async () => {
  let clock = 1_000_000;
  const { draft, calls, puts } = harness({ chatId: "chat-1", putStatus: (call) => call === 1 ? 401 : 204, now: () => clock });
  draft.add([photo]);
  await settle(); await settle();
  const [row] = draft.rows;
  assert.equal(row!.error, "Pairing revoked.");
  assert.equal(row!.ready, false);
  assert.equal(await draft.prepare("message"), null);
  assert.equal(draft.notice, "Some files didn't upload. Retry or remove them, then send again.");

  draft.retry(row!);
  await settle(); await settle();
  assert.equal(row!.ready, true);
  assert.equal(calls.filter(({ method }) => method === "POST").length, 1, "an unexpired grant is reused");
  assert.equal(puts.length, 2);

  // Past the start deadline: release the old reservation and reserve again.
  row!.ready = false;
  clock += 700_000;
  draft.retry(row!);
  await settle(); await settle(); await settle();
  assert.deepEqual(calls.slice(1).map(({ method, path }) => [method, path]),
    [["DELETE", PROTOCOL_ROUTES.removeAttachment("grant-1")], ["POST", PROTOCOL_ROUTES.attachments]]);
  assert.equal(row!.grant!.id, "grant-2");
});

test("Remove releases the reservation once its step settles", async () => {
  const { draft, calls } = harness({ chatId: "chat-1" });
  draft.add([photo]);
  await settle(); await settle();
  draft.remove(draft.rows[0]!);
  assert.equal(draft.rows.length, 0);
  await settle(); await settle();
  assert.deepEqual(calls.at(-1), { method: "DELETE", path: PROTOCOL_ROUTES.removeAttachment("grant-1"), body: undefined, auth: "Bearer native-token" });
});

test("Remove during an upload lets the PUT finish before releasing it", async () => {
  let finish!: () => void;
  const order: string[] = [];
  const api = apiClient(async (url, init) => {
    order.push(init.method);
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ id: "grant-1", uploadUrl: "/api/attachments/upload?id=grant-1&grant=sig", expiresAt: Date.now() + 600_000 }, { status: 201 });
  }, origin, "native-token");
  let putSignal: AbortSignal | undefined;
  const put: PutFile = (_file, _url, _headers, _progress, signal) => {
    putSignal = signal;
    order.push("PUT");
    return new Promise((resolve) => { finish = () => { order.push("PUT done"); resolve({ status: 204, body: "" }); }; });
  };
  const draft = new AttachmentDraft({ api, chatId: "chat-1", put, newId: () => "id", changed: () => {} });
  draft.add([photo]);
  await settle(); await settle();
  draft.remove(draft.rows[0]!);
  await settle();
  assert.equal(putSignal!.aborted, false);
  assert.deepEqual(order, ["POST", "PUT"]);
  finish();
  await settle(); await settle();
  assert.deepEqual(order, ["POST", "PUT", "PUT done", "DELETE"]);
});

test("the app's copies are deleted when a file is refused, removed, sent, or the composer closes", async () => {
  const copy = (name: string): PickedFile => ({ ...pdf, name, cleanup: `file:///cache/attachments/${name}/` });
  const { draft, released } = harness({ chatId: "chat-1" });
  assert.equal(draft.add([{ ...copy("huge"), size: 60 * MiB }]), false);
  assert.deepEqual(released, ["file:///cache/attachments/huge/"]);

  draft.add([copy("removed"), copy("sent"), copy("kept"), pdf]);
  await settle(); await settle();
  draft.remove(draft.rows[0]!);
  await settle();
  assert.deepEqual(released.at(-1), "file:///cache/attachments/removed/");

  const sent = draft.rows[0]!;
  draft.accept({ attachmentUploadIds: [sent.grant!.id], sendId: "send" });
  assert.deepEqual(released.at(-1), "file:///cache/attachments/sent/");

  draft.dispose();
  await settle();
  assert.equal(draft.rows.length, 0);
  assert.deepEqual(released, ["file:///cache/attachments/huge/", "file:///cache/attachments/removed/",
    "file:///cache/attachments/sent/", "file:///cache/attachments/kept/"], "a pick with no copy of its own deletes nothing");
});

test("a send waits for uploads and reuses its send ID for the same message", async () => {
  const { draft } = harness({ chatId: "chat-1" });
  draft.add([photo, pdf]);
  const first = await draft.prepare("hello");
  assert.deepEqual(first, { attachmentUploadIds: ["grant-1", "grant-2"], sendId: "id-3" });
  assert.deepEqual(await draft.prepare("hello"), first);
  const edited = await draft.prepare("hello again");
  assert.notEqual(edited!.sendId, first!.sendId);
  draft.accept(first!);
  assert.equal(draft.rows.length, 0);
});

test("an opening draft reserves every file under one draft ID", async () => {
  const { draft, calls } = harness();
  draft.add([photo]);
  draft.add([pdf]);
  await settle(); await settle();
  const targets = calls.map(({ body }) => (body as { draftId?: string; chatId?: string }));
  assert.deepEqual(targets.map(({ draftId, chatId }) => [draftId, chatId]), [[draft.draftId(), undefined], [draft.draftId(), undefined]]);
});

test("upload routes stay on the paired origin", () => {
  const api = apiClient(async () => Response.json({}), origin, "native-token");
  assert.throws(() => api.upload("https://other.example/api/attachments/upload"), /Invalid LearnHarness route/);
  assert.throws(() => api.upload("//other.example/x"), /Invalid LearnHarness route/);
});

test("retired opening keeps picks and uploads them under a fresh draft", async () => {
  const { draft, calls, puts } = harness({});
  draft.add([photo, pdf]);
  await settle(); await settle();
  const old = draft.draftId();
  const before = await draft.prepare("prompt");
  draft.resetOpening();
  await settle(); await settle(); await settle();
  assert.notEqual(draft.draftId(), old);
  assert.equal(draft.rows.length, 2);
  assert.equal(puts.length, 4);
  const reservations = calls.filter(call => call.method === "POST").map(call => call.body as { draftId: string });
  assert.equal(reservations[2]!.draftId, reservations[3]!.draftId);
  assert.notEqual(reservations[2]!.draftId, old);
  assert.notEqual((await draft.prepare("prompt"))!.sendId, before!.sendId);
  draft.dispose();
});

test("a late PUT 404 rechecks the opening and re-uploads after deletion", async () => {
  let ids = 0, grants = 0, puts = 0;
  let finish!: (value: { status: number; body: string }) => void;
  const held = new Promise<{ status: number; body: string }>(resolve => { finish = resolve; });
  const api = apiClient(async (url, init) => {
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    assert.equal(url.slice(origin.length), PROTOCOL_ROUTES.attachments);
    grants++;
    if (grants === 2) return Response.json({ code: "opening-deleted", error: "Deleted" }, { status: 404 });
    return Response.json({ id: `grant-${grants}`, uploadUrl: `/upload?id=${grants}`, expiresAt: Date.now() + 600_000 }, { status: 201 });
  }, origin, "token");
  const put: PutFile = async () => ++puts === 1 ? held : { status: 204, body: "" };
  const draft = new AttachmentDraft({ api, put, newId: () => `id-${++ids}`, changed: () => {} });
  draft.add([pdf]);
  await settle();
  const before = draft.draftId();
  finish({ status: 404, body: JSON.stringify({ error: "Pending attachment not found." }) });
  for (let i = 0; i < 8; i++) await settle();
  assert.notEqual(draft.draftId(), before);
  assert.equal(grants, 3);
  assert.equal(puts, 2);
  assert.equal(draft.rows[0]?.ready, true);
  assert.equal(draft.rows[0]?.name, pdf.name);
  draft.dispose();
});

test("an ordinary 404 during re-reservation stops without rotating", async () => {
  let ids = 0, reservations = 0, puts = 0;
  const api = apiClient(async () => {
    reservations++;
    return reservations === 1
      ? Response.json({ id: "grant", uploadUrl: "/upload", expiresAt: Date.now() + 600_000 }, { status: 201 })
      : Response.json({ error: "Not found" }, { status: 404 });
  }, origin, "token");
  const draft = new AttachmentDraft({ api, put: async () => { puts++; return { status: 404, body: "Not found" }; }, newId: () => `id-${++ids}`, changed: () => {} });
  draft.add([pdf]);
  const before = draft.draftId();
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(reservations, 2);
  assert.equal(puts, 1);
  assert.equal(draft.draftId(), before);
  assert.ok(draft.rows[0]?.error);
  draft.dispose();
});

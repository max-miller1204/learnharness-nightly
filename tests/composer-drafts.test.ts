/**
 * Issue #347: a composer draft is kept per session (lib/composer-drafts.ts,
 * after T3 Code's composerDraftStore.ts), so it survives navigating away and
 * back. Stored data is read tolerantly: anything missing, corrupt or of
 * another shape gives an empty draft, never an error. A sent message's draft
 * and a deleted session's draft are cleared.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

class FakeStorage {
	map = new Map<string, string>();
	failGet = false;
	failSet = false;
	getItem(key: string) { if (this.failGet) throw new Error("SecurityError"); return this.map.get(key) ?? null; }
	setItem(key: string, value: string) { if (this.failSet) throw new Error("QuotaExceededError"); this.map.set(key, value); }
	removeItem(key: string) { this.map.delete(key); }
}
const storage = new FakeStorage();
const listeners = new Map<string, () => void>();
(globalThis as Record<string, unknown>).window = {
	localStorage: storage,
	addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
	dispatchEvent: () => true,
};

const drafts = await import("../lib/composer-drafts.ts");
const { COMPOSER_DRAFTS_KEY, MAX_COMPOSER_DRAFTS, clearComposerDraft, flushComposerDrafts, readComposerDraft, writeComposerDraft } = drafts;
const { beginSessionDelete, beginSessionDeletes } = await import("../components/session-deletion.ts");

const stored = () => storage.map.get(COMPOSER_DRAFTS_KEY);
const storedDrafts = () => (JSON.parse(stored() ?? "{}") as { drafts?: Record<string, { text: string }> }).drafts ?? {};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => { flushComposerDrafts(); storage.map.clear(); storage.failGet = false; storage.failSet = false; });
afterEach(() => flushComposerDrafts());

describe("composer drafts per session", () => {
	it("keep each session's draft apart and bring it back", () => {
		writeComposerDraft("chat_a", "half a thought about A");
		writeComposerDraft("chat_b", "B's draft");
		flushComposerDrafts();
		assert.equal(readComposerDraft("chat_a"), "half a thought about A");
		assert.equal(readComposerDraft("chat_b"), "B's draft");
		assert.equal(readComposerDraft("chat_c"), "");
		assert.deepEqual(Object.keys(storedDrafts()).sort(), ["chat_a", "chat_b"]);
		assert.equal((JSON.parse(stored()!) as { version: number }).version, 1);
	});

	it("save typing within 300 ms, and at once when flushed (leaving the session, page hide)", async () => {
		writeComposerDraft("chat_a", "typing");
		assert.equal(stored(), undefined, "not on every keystroke");
		assert.equal(readComposerDraft("chat_a"), "typing", "a pending write still reads back");
		await wait(350);
		assert.equal(storedDrafts().chat_a?.text, "typing");
		writeComposerDraft("chat_a", "typing more");
		listeners.get("pagehide")!();
		assert.equal(storedDrafts().chat_a?.text, "typing more", "page hide flushes");
		writeComposerDraft("chat_a", "and more");
		listeners.get("beforeunload")!();
		assert.equal(storedDrafts().chat_a?.text, "and more", "beforeunload flushes (T3's)");
	});

	it("clear a draft at once when the composer empties (its message was sent)", () => {
		writeComposerDraft("chat_a", "about to send");
		writeComposerDraft("chat_b", "keep me");
		flushComposerDrafts();
		writeComposerDraft("chat_a", "");
		assert.equal(readComposerDraft("chat_a"), "", "no debounce: a sent draft can't come back");
		assert.equal(storedDrafts().chat_a, undefined);
		writeComposerDraft("chat_b", "   \n");
		assert.equal(readComposerDraft("chat_b"), "", "whitespace only counts as empty");
		assert.equal(stored(), undefined, "nothing left: the key goes");
	});

	it("read anything missing, corrupt or of another shape as an empty draft, keeping the good entries", () => {
		const cases: [string, string | null][] = [
			["missing", null],
			["corrupt JSON", "{not json"],
			["not an object", '"a string"'],
			["no version", JSON.stringify({ drafts: { chat_a: { text: "x", at: 1 } } })],
			["another version", JSON.stringify({ version: 2, drafts: { chat_a: { text: "x", at: 1 } } })],
			["drafts an array", JSON.stringify({ version: 1, drafts: [{ text: "x", at: 1 }] })],
			["drafts null", JSON.stringify({ version: 1, drafts: null })],
			["an old shape (id to string)", JSON.stringify({ version: 1, drafts: { chat_a: "x" } })],
		];
		for (const [what, raw] of cases) {
			storage.map.clear();
			if (raw !== null) storage.map.set(COMPOSER_DRAFTS_KEY, raw);
			assert.doesNotThrow(() => readComposerDraft("chat_a"), what);
			assert.equal(readComposerDraft("chat_a"), "", what);
		}
		storage.map.set(COMPOSER_DRAFTS_KEY, JSON.stringify({ version: 1, drafts: {
			good: { text: "kept", at: 5 },
			numberText: { text: 42, at: 5 },
			emptyText: { text: "", at: 5 },
			noTime: { text: "x" },
			badTime: { text: "x", at: "soon" },
			nothing: null,
		} }));
		assert.equal(readComposerDraft("good"), "kept");
		for (const id of ["numberText", "emptyText", "noTime", "badTime", "nothing"]) assert.equal(readComposerDraft(id), "", id);
		// Writing over a corrupt value starts clean, never throws.
		storage.map.set(COMPOSER_DRAFTS_KEY, "{not json");
		writeComposerDraft("chat_a", "fresh");
		flushComposerDrafts();
		assert.equal(readComposerDraft("chat_a"), "fresh");
	});

	it("never throw when storage does (blocked or full): the draft just isn't saved", () => {
		storage.failGet = true;
		assert.equal(readComposerDraft("chat_a"), "");
		assert.doesNotThrow(() => { writeComposerDraft("chat_a", "x"); flushComposerDrafts(); });
		storage.failGet = false;
		storage.failSet = true;
		assert.doesNotThrow(() => { writeComposerDraft("chat_a", "y"); flushComposerDrafts(); });
		assert.doesNotThrow(() => clearComposerDraft("chat_a"));
	});

	it(`keep at most ${MAX_COMPOSER_DRAFTS} drafts, the newest`, async () => {
		for (let i = 0; i < MAX_COMPOSER_DRAFTS + 5; i++) {
			writeComposerDraft(`chat_${i}`, `draft ${i}`);
			flushComposerDrafts();
			await wait(1); // distinct times
		}
		const ids = Object.keys(storedDrafts());
		assert.equal(ids.length, MAX_COMPOSER_DRAFTS);
		assert.ok(!ids.includes("chat_0") && ids.includes(`chat_${MAX_COMPOSER_DRAFTS + 4}`), "the oldest went");
	});

	it("keep drafts another tab saved meanwhile", () => {
		writeComposerDraft("chat_a", "this tab");
		storage.map.set(COMPOSER_DRAFTS_KEY, JSON.stringify({ version: 1, drafts: { chat_other: { text: "other tab", at: Date.now() } } }));
		flushComposerDrafts();
		assert.equal(readComposerDraft("chat_other"), "other tab");
		assert.equal(readComposerDraft("chat_a"), "this tab");
	});

	it("clear a session's draft when its delete is confirmed, and keep it when the delete is refused", () => {
		for (const id of ["chat_gone", "chat_kept", "batch_gone", "batch_kept"]) writeComposerDraft(id, `${id} draft`);
		flushComposerDrafts();
		beginSessionDelete("chat_gone")(true);
		beginSessionDelete("chat_kept")(false);
		beginSessionDeletes(["batch_gone", "batch_kept"])(["batch_gone"]);
		assert.equal(readComposerDraft("chat_gone"), "");
		assert.equal(readComposerDraft("batch_gone"), "", "a folder or source delete's sessions too");
		assert.equal(readComposerDraft("chat_kept"), "chat_kept draft");
		assert.equal(readComposerDraft("batch_kept"), "batch_kept draft");
	});
});

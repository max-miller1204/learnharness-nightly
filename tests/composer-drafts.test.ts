/**
 * Issue #347: a composer draft is kept per session (lib/composer-drafts.ts,
 * after T3 Code's composerDraftStore.ts), so it survives navigating away and
 * back. Stored data is read tolerantly: anything missing, corrupt or of
 * another shape gives an empty draft, never an error. A sent message's draft
 * and a deleted session's draft are cleared, and another tab's drafts for
 * other sessions are never lost.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

/** localStorage as one tab sees it. The browser keeps it per key; a tab's
 *  view can lag behind another tab's writes until `catchUp()` (a storage
 *  event's delivery). Writes go through to the shared store per key. */
class TabStorage {
	view = new Map<string, string>();
	failGet = false;
	failSet = false;
	constructor(readonly shared: Map<string, string>) { this.catchUp(); }
	catchUp() { this.view = new Map(this.shared); }
	get length() { return this.view.size; }
	key(i: number) { return [...this.view.keys()][i] ?? null; }
	getItem(key: string) { if (this.failGet) throw new Error("SecurityError"); return this.view.get(key) ?? null; }
	setItem(key: string, value: string) { if (this.failSet) throw new Error("QuotaExceededError"); this.view.set(key, value); this.shared.set(key, value); }
	removeItem(key: string) { if (this.failSet) throw new Error("SecurityError"); this.view.delete(key); this.shared.delete(key); }
}
const shared = new Map<string, string>();
const tabA = new TabStorage(shared);
const listeners = new Map<string, (() => void)[]>();
const fire = (type: string) => { for (const listener of listeners.get(type) ?? []) listener(); };
const win = {
	localStorage: tabA as unknown as Storage,
	addEventListener: (type: string, listener: () => void) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
	dispatchEvent: () => true,
};
(globalThis as Record<string, unknown>).window = win;

const drafts = await import("../lib/composer-drafts.ts");
const { COMPOSER_DRAFT_KEY_PREFIX, MAX_COMPOSER_DRAFTS, clearComposerDraftIfSent, flushComposerDrafts, readComposerDraft, writeComposerDraft } = drafts;
// A second tab: its own copy of the module (its own unsaved drafts and timer).
const secondCopy: string = "../lib/composer-drafts.ts?tab=b"; // a query string loads a separate module instance
const otherTab = (await import(secondCopy)) as typeof drafts;
const { beginSessionDelete, beginSessionDeletes } = await import("../components/session-deletion.ts");

const keyOf = (id: string) => COMPOSER_DRAFT_KEY_PREFIX + id;
const stored = (id: string) => { const raw = shared.get(keyOf(id)); return raw === undefined ? undefined : (JSON.parse(raw) as { text: string; at: number }); };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Run `fn` as the tab whose storage view is `tab`. */
function asTab<T>(tab: TabStorage, fn: () => T): T {
	const before = win.localStorage;
	win.localStorage = tab as unknown as Storage;
	try { return fn(); } finally { win.localStorage = before; }
}

beforeEach(() => {
	tabA.failGet = false; tabA.failSet = false;
	flushComposerDrafts();
	shared.clear(); tabA.catchUp();
});
afterEach(() => { tabA.failGet = false; tabA.failSet = false; flushComposerDrafts(); });

describe("composer drafts per session", () => {
	it("keep each session's draft apart, under its own key, and bring it back", () => {
		writeComposerDraft("chat_a", "half a thought about A");
		writeComposerDraft("chat_b", "B's draft");
		flushComposerDrafts();
		assert.equal(readComposerDraft("chat_a"), "half a thought about A");
		assert.equal(readComposerDraft("chat_b"), "B's draft");
		assert.equal(readComposerDraft("chat_c"), "");
		assert.deepEqual([...shared.keys()].sort(), [keyOf("chat_a"), keyOf("chat_b")]);
		assert.equal(stored("chat_a")?.text, "half a thought about A");
	});

	it("save 300 ms after the last edit (a trailing debounce, T3's), and at once on page hide or unload", async () => {
		writeComposerDraft("chat_a", "t");
		await wait(200);
		writeComposerDraft("chat_a", "ty");
		await wait(200);
		assert.equal(stored("chat_a"), undefined, "still typing: not saved yet");
		assert.equal(readComposerDraft("chat_a"), "ty", "this tab reads its unsaved edit");
		await wait(150);
		assert.equal(stored("chat_a")?.text, "ty", "saved once the edits paused");
		writeComposerDraft("chat_a", "typing more");
		fire("pagehide");
		assert.equal(stored("chat_a")?.text, "typing more", "page hide flushes");
		writeComposerDraft("chat_a", "and more");
		fire("beforeunload");
		assert.equal(stored("chat_a")?.text, "and more", "beforeunload flushes (T3's)");
	});

	it("clear a draft at once when the composer empties (its message was sent)", () => {
		writeComposerDraft("chat_a", "about to send");
		writeComposerDraft("chat_b", "keep me");
		flushComposerDrafts();
		writeComposerDraft("chat_a", "");
		assert.equal(readComposerDraft("chat_a"), "");
		assert.equal(stored("chat_a"), undefined, "no debounce: a sent draft can't come back");
		writeComposerDraft("chat_b", "   \n");
		assert.equal(readComposerDraft("chat_b"), "", "whitespace only counts as empty");
		assert.equal(shared.size, 0);
	});

	it("clear a draft sent after its Chat unmounted only if it is still the sent text", () => {
		writeComposerDraft("chat_a", "the sent text");
		clearComposerDraftIfSent("chat_a", "the sent text ");
		assert.equal(readComposerDraft("chat_a"), "");
		writeComposerDraft("chat_b", "the sent text, and more typed after");
		clearComposerDraftIfSent("chat_b", "the sent text");
		assert.equal(readComposerDraft("chat_b"), "the sent text, and more typed after", "a newer draft stays");
	});

	it("read anything missing, corrupt or of another shape as an empty draft", () => {
		const cases: [string, string | null][] = [
			["missing", null],
			["corrupt JSON", "{not json"],
			["not an object", '"a string"'],
			["null", "null"],
			["text not a string", JSON.stringify({ text: 42, at: 1 })],
			["whitespace text", JSON.stringify({ text: "  \n", at: 1 })],
			["no time", JSON.stringify({ text: "x" })],
			["a time that isn't a number", JSON.stringify({ text: "x", at: "soon" })],
		];
		for (const [what, raw] of cases) {
			shared.clear();
			if (raw !== null) shared.set(keyOf("chat_a"), raw);
			tabA.catchUp();
			assert.equal(readComposerDraft("chat_a"), "", what);
		}
		// Ids that are Object.prototype's names are just keys.
		for (const id of ["__proto__", "constructor"]) writeComposerDraft(id, `draft for ${id}`);
		flushComposerDrafts();
		assert.equal(readComposerDraft("__proto__"), "draft for __proto__");
		assert.equal(readComposerDraft("constructor"), "draft for constructor");
		assert.equal(Object.getPrototypeOf({}), Object.prototype);
		// Writing over a corrupt value starts clean.
		shared.set(keyOf("chat_a"), "{not json"); tabA.catchUp();
		writeComposerDraft("chat_a", "fresh");
		flushComposerDrafts();
		assert.equal(stored("chat_a")?.text, "fresh");
	});

	it("keep this tab's drafts in memory while storage is blocked or full, and save them when it works again", () => {
		writeComposerDraft("chat_old", "an old draft");
		flushComposerDrafts();
		tabA.failGet = true;
		tabA.failSet = true;
		assert.equal(readComposerDraft("chat_new"), "", "an unreadable draft reads as none");
		writeComposerDraft("chat_new", "typed while storage is blocked");
		flushComposerDrafts();
		assert.equal(readComposerDraft("chat_new"), "typed while storage is blocked", "not dropped");
		writeComposerDraft("chat_old", "");
		assert.equal(readComposerDraft("chat_old"), "", "a clear wins in memory though storage still holds it");
		assert.equal(stored("chat_old")?.text, "an old draft");
		tabA.failGet = false;
		tabA.failSet = false;
		flushComposerDrafts();
		assert.equal(stored("chat_new")?.text, "typed while storage is blocked");
		assert.equal(stored("chat_old"), undefined, "the clear is saved too");
	});

	it(`keep at most ${MAX_COMPOSER_DRAFTS} drafts, never evicting the newest, even with a stopped or stepped-back clock`, () => {
		const realNow = Date.now;
		try {
			Date.now = () => 1_000; // every write in the same millisecond
			for (let i = 0; i < MAX_COMPOSER_DRAFTS + 5; i++) { writeComposerDraft(`chat_${i}`, `draft ${i}`); flushComposerDrafts(); }
			let ids = [...shared.keys()].map((key) => key.slice(COMPOSER_DRAFT_KEY_PREFIX.length));
			assert.equal(ids.length, MAX_COMPOSER_DRAFTS);
			assert.ok(!ids.includes("chat_0") && ids.includes(`chat_${MAX_COMPOSER_DRAFTS + 4}`), "the oldest went, the newest stayed");
			Date.now = () => 5; // the clock stepped back
			writeComposerDraft("chat_late", "written after the clock stepped back");
			flushComposerDrafts();
			ids = [...shared.keys()].map((key) => key.slice(COMPOSER_DRAFT_KEY_PREFIX.length));
			assert.ok(ids.includes("chat_late"), "still the newest");
			assert.equal(ids.length, MAX_COMPOSER_DRAFTS);
		} finally {
			Date.now = realNow;
		}
	});

	it("never lose another tab's draft for another session, even when this tab's view of storage is behind", () => {
		const tabB = new TabStorage(shared);
		// Tab A saves session a's draft; tab B hasn't seen it yet.
		writeComposerDraft("chat_a", "typed in tab A");
		flushComposerDrafts();
		asTab(tabB, () => {
			otherTab.writeComposerDraft("chat_b", "typed in tab B");
			otherTab.flushComposerDrafts();
		});
		tabA.catchUp(); tabB.catchUp();
		assert.equal(stored("chat_a")?.text, "typed in tab A", "B's save kept A's draft");
		assert.equal(stored("chat_b")?.text, "typed in tab B");
		assert.equal(asTab(tabB, () => otherTab.readComposerDraft("chat_a")), "typed in tab A");
		// The same session from both tabs: the last writer wins.
		writeComposerDraft("chat_c", "A's version");
		asTab(tabB, () => otherTab.writeComposerDraft("chat_c", "B's version"));
		flushComposerDrafts();
		asTab(tabB, () => otherTab.flushComposerDrafts());
		assert.equal(stored("chat_c")?.text, "B's version");
	});

	it("never write back a draft a tab only read: a send in another tab stays cleared", () => {
		const tabB = new TabStorage(shared);
		writeComposerDraft("chat_a", "old");
		flushComposerDrafts();
		tabB.catchUp();
		assert.equal(asTab(tabB, () => otherTab.readComposerDraft("chat_a")), "old", "tab B shows it");
		writeComposerDraft("chat_a", ""); // tab A sends it
		asTab(tabB, () => otherTab.flushComposerDrafts()); // tab B leaves the session
		assert.equal(stored("chat_a"), undefined);
	});

	it("clear a deleted session's draft for good, and keep it when the delete is refused", () => {
		for (const id of ["chat_gone", "chat_kept", "batch_gone", "batch_kept"]) writeComposerDraft(id, `${id} draft`);
		flushComposerDrafts();
		beginSessionDelete("chat_gone")(true);
		beginSessionDelete("chat_kept")(false);
		beginSessionDeletes(["batch_gone", "batch_kept"])(["batch_gone"]);
		assert.equal(readComposerDraft("chat_gone"), "");
		assert.equal(stored("chat_gone"), undefined);
		assert.equal(readComposerDraft("batch_gone"), "", "a folder or source delete's sessions too");
		assert.equal(readComposerDraft("chat_kept"), "chat_kept draft");
		assert.equal(readComposerDraft("batch_kept"), "batch_kept draft");
		writeComposerDraft("chat_gone", "a late dictation chunk");
		flushComposerDrafts();
		assert.equal(readComposerDraft("chat_gone"), "", "a deleted session's draft doesn't come back");
		assert.equal(stored("chat_gone"), undefined);
	});
});

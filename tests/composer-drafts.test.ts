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
	/** Keys whose reads throw. */
	failKeys = new Set<string>();
	/** Storage's quota, in characters of keys and values: a write that needs more is refused. */
	quota: number | null = null;
	/** Runs before each read (another tab writing in between). */
	beforeGet: ((key: string) => void) | null = null;
	constructor(readonly shared: Map<string, string>) { this.catchUp(); }
	catchUp() { this.view = new Map(this.shared); }
	get length() { return this.view.size; }
	key(i: number) { return [...this.view.keys()][i] ?? null; }
	getItem(key: string) { this.beforeGet?.(key); if (this.failGet || this.failKeys.has(key)) throw new Error("SecurityError"); return this.view.get(key) ?? null; }
	used() { let total = 0; for (const [key, value] of this.view) total += key.length + value.length; return total; }
	setItem(key: string, value: string) {
		const after = this.used() - (this.view.has(key) ? key.length + this.view.get(key)!.length : 0) + key.length + value.length;
		if (this.failSet || (this.quota !== null && after > this.quota)) throw new Error("QuotaExceededError");
		this.view.set(key, value); this.shared.set(key, value);
	}
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
	tabA.failGet = false; tabA.failSet = false; tabA.failKeys.clear(); tabA.quota = null; tabA.beforeGet = null;
	flushComposerDrafts();
	shared.clear(); tabA.catchUp();
});
afterEach(() => { tabA.failGet = false; tabA.failSet = false; tabA.failKeys.clear(); tabA.quota = null; tabA.beforeGet = null; flushComposerDrafts(); });
const ids = () => [...shared.keys()].filter((key) => key.startsWith(COMPOSER_DRAFT_KEY_PREFIX)).map((key) => key.slice(COMPOSER_DRAFT_KEY_PREFIX.length));
const put = (id: string, text: string, at: number) => { shared.set(keyOf(id), JSON.stringify({ text, at })); };

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

	it("clear a sent draft whose read failed at that moment once storage can be read again, unless it changed (#362 round 2)", () => {
		put("chat_a", "the sent text", 1);
		put("chat_b", "the sent text", 1);
		put("chat_c", "the sent text", 1);
		tabA.catchUp();
		for (const id of ["chat_a", "chat_b", "chat_c"]) tabA.failKeys.add(keyOf(id));
		for (const id of ["chat_a", "chat_b", "chat_c"]) assert.doesNotThrow(() => clearComposerDraftIfSent(id, "the sent text"));
		assert.equal(stored("chat_a")?.text, "the sent text", "nothing could be done yet");
		tabA.failKeys.clear();
		assert.equal(readComposerDraft("chat_a"), "", "the next read applies the waiting clear");
		assert.equal(stored("chat_a"), undefined);
		put("chat_b", "edited in another tab since", 2); tabA.catchUp();
		flushComposerDrafts();
		assert.equal(stored("chat_b")?.text, "edited in another tab since", "a draft that changed stays");
		writeComposerDraft("chat_c", "typed here since");
		flushComposerDrafts();
		assert.equal(stored("chat_c")?.text, "typed here since", "a newer edit replaces the waiting clear");
		put("chat_d", "the sent text", 1); tabA.catchUp();
		tabA.failKeys.add(keyOf("chat_d"));
		clearComposerDraftIfSent("chat_d", "the sent text");
		tabA.failKeys.clear();
		flushComposerDrafts();
		assert.equal(stored("chat_d"), undefined, "a flush applies it too");
	});

	it("save a re-edited draft as the newest when storage comes back, keep at most the cap unsaved, and keep no clear with no storage at all (#362 round 2)", () => {
		tabA.failSet = true;
		writeComposerDraft("chat_a", "first");
		writeComposerDraft("chat_b", "second");
		writeComposerDraft("chat_a", "first, edited last");
		flushComposerDrafts();
		tabA.failSet = false;
		flushComposerDrafts();
		assert.ok(stored("chat_a")!.at > stored("chat_b")!.at, "the last edit is stamped newest");
		shared.clear(); tabA.catchUp();
		tabA.failSet = true;
		for (let i = 0; i < MAX_COMPOSER_DRAFTS + 5; i++) writeComposerDraft(`unsaved_${i}`, `draft ${i}`);
		tabA.failSet = false;
		flushComposerDrafts();
		assert.equal(ids().length, MAX_COMPOSER_DRAFTS);
		assert.ok(!ids().includes("unsaved_0") && ids().includes(`unsaved_${MAX_COMPOSER_DRAFTS + 4}`), "the newest unsaved drafts were kept");
		shared.clear(); tabA.catchUp();
		win.localStorage = null as unknown as Storage; // no storage at all
		writeComposerDraft("chat_x", "");
		put("chat_x", "saved by another tab meanwhile", 1); tabA.catchUp();
		win.localStorage = tabA as unknown as Storage;
		flushComposerDrafts();
		assert.equal(stored("chat_x")?.text, "saved by another tab meanwhile", "no stale clear was kept to remove it");
	});

	it("keep the cap by evicting the oldest after a new draft is saved", () => {
		for (let i = 0; i < MAX_COMPOSER_DRAFTS; i++) put(`old_${i}`, `old ${i}`, 100 + i);
		tabA.catchUp();
		writeComposerDraft("chat_new", "the new draft");
		flushComposerDrafts();
		assert.equal(stored("chat_new")?.text, "the new draft");
		assert.equal(ids().length, MAX_COMPOSER_DRAFTS);
		assert.ok(!ids().includes("old_0"), "the oldest went");
	});

	it("never delete another saved draft when storage refuses a write: the new draft waits in memory (#362 prove)", () => {
		put("chat_b", "B's saved draft", 1);
		shared.set("some-other-app-key", "x".repeat(200));
		tabA.catchUp();
		tabA.quota = tabA.used() + 20; // full: no new draft fits
		const long = "a long draft typed in A ".repeat(20);
		writeComposerDraft("chat_a", long);
		flushComposerDrafts();
		assert.equal(stored("chat_b")?.text, "B's saved draft", "B survives a quota refusal");
		assert.equal(stored("chat_a"), undefined);
		assert.equal(readComposerDraft("chat_a"), long, "A's draft waits in memory");
		tabA.quota = null;
		tabA.failSet = true; // a SecurityError on every write
		writeComposerDraft("chat_a", `${long}, more`);
		flushComposerDrafts();
		assert.equal(stored("chat_b")?.text, "B's saved draft", "B survives a refused write of any kind");
		tabA.failSet = false;
		flushComposerDrafts();
		assert.equal(stored("chat_a")?.text, `${long}, more`, "saved once storage takes it");
		assert.equal(stored("chat_b")?.text, "B's saved draft");
	});

	it("evict unreadable drafts first, and never a draft another tab changed since the scan (#362 round 2)", () => {
		for (let i = 0; i < MAX_COMPOSER_DRAFTS - 1; i++) put(`old_${i}`, `old ${i}`, 100 + i);
		shared.set(keyOf("corrupt_1"), "{bad");
		shared.set(keyOf("corrupt_2"), JSON.stringify({ text: "x", at: "soon" }));
		tabA.catchUp();
		writeComposerDraft("chat_new", "the new draft");
		flushComposerDrafts();
		assert.ok(!ids().includes("corrupt_1") && !ids().includes("corrupt_2"), "unreadable ones count as oldest");
		assert.ok(ids().includes("old_0") && ids().includes("chat_new"));
		assert.equal(ids().length, MAX_COMPOSER_DRAFTS);
		// old_0 is the oldest, but another tab saves it again between the scan and the eviction.
		let reads = 0;
		tabA.beforeGet = (key) => {
			if (key !== keyOf("old_0") || ++reads !== 3) return; // after both scans: right before its eviction
			put("old_0", "saved again in another tab", 999_999_999_999_999); tabA.catchUp();
		};
		writeComposerDraft("chat_newer", "one more");
		flushComposerDrafts();
		assert.equal(stored("old_0")?.text, "saved again in another tab", "skipped: it changed since it was looked at");
		assert.ok(ids().includes("chat_newer"));
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

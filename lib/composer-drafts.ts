/**
 * The composer's unsent draft, per session (issue #347), after T3 Code's
 * composer drafts (pingdotgg/t3code, MIT, at f9b19a7f):
 * apps/web/src/composerDraftStore.ts saves drafts by thread in versioned
 * localStorage, 300 ms after the last change (:127, :218 through
 * createDeferredStorage, apps/web/src/lib/storage.ts:45-73, a trailing
 * debounce), flushed when the page goes away (:248-252), reading a value it
 * can't parse as no drafts (:146-156), and writing only what this tab changed
 * over what other tabs saved (mergeComposerDraftStates, :173-203).
 *
 * Unlike T3's one value for every thread, each session has its own key. The
 * browser keeps localStorage per key, so a tab whose view of storage is
 * behind another tab's can only overwrite the session it wrote (the last
 * writer wins), never another session's draft. The cap on stored drafts is
 * best effort across tabs: two tabs saving at once can briefly keep a few
 * more, and an eviction skips a draft that changed since it was looked at.
 *
 * A restored draft is shown without being saved back: only edits are saved,
 * as T3 hydrates without writing. Sending empties the composer, which clears
 * the draft at once; deleting the session clears it for good. Reads are
 * tolerant (AGENTS.md): a missing, unparsable or other-shape value, or
 * storage that throws, reads as no draft. Storage that is blocked or full
 * keeps this page's unsaved drafts in its memory (lost if the page is
 * reloaded or closed), and they are saved at a later flush if storage works
 * again; a refused write deletes no other draft. Text only: attachments are not part of it.
 */

export const COMPOSER_DRAFT_KEY_PREFIX = "lh:composer-draft:v1:";
const WRITE_DEBOUNCE_MS = 300;
/** Drafts kept at most, newest first: a draft whose session was deleted in
 *  another window is never read again (ids aren't reused), so this bounds it.
 *  This tab's unsaved drafts are bounded the same way. */
export const MAX_COMPOSER_DRAFTS = 50;
/** The time an unreadable stored draft counts as: older than any real one. */
const OLDEST = -Number.MAX_VALUE;

type Entry = { text: string; at: number };

function storage(): Storage | null {
	try { return typeof window !== "undefined" && window.localStorage ? window.localStorage : null; } catch { return null; }
}

/** A stored draft, or null for anything that isn't one. */
function parseEntry(raw: string | null): Entry | null {
	if (!raw) return null;
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { return null; }
	if (!parsed || typeof parsed !== "object") return null;
	const { text, at } = parsed as { text?: unknown; at?: unknown };
	return typeof text === "string" && text.trim() !== "" && typeof at === "number" && Number.isFinite(at) ? { text, at } : null;
}

/** The stored draft (null for none), or undefined when storage can't be read. */
function readStored(chatId: string): Entry | null | undefined {
	const store = storage();
	if (!store) return undefined;
	try { return parseEntry(store.getItem(COMPOSER_DRAFT_KEY_PREFIX + chatId)); } catch { return undefined; }
}

const storedAt = (store: Storage, key: string): number => parseEntry(store.getItem(key))?.at ?? OLDEST;
const newestFirst = (a: { at: number }, b: { at: number }) => (a.at === b.at ? 0 : b.at - a.at);

/** Every stored draft's key and time. */
function storedDrafts(store: Storage): Map<string, number> {
	const out = new Map<string, number>();
	for (let i = 0; i < store.length; i++) {
		const key = store.key(i);
		if (key?.startsWith(COMPOSER_DRAFT_KEY_PREFIX)) out.set(key, storedAt(store, key));
	}
	return out;
}

/** Remove a stored draft unless it changed since it was looked at (another
 *  tab saved it meanwhile). */
function evict(store: Storage, key: string, seenAt: number): boolean {
	try {
		if (storedAt(store, key) !== seenAt) return false;
		store.removeItem(key);
		return true;
	} catch { return false; }
}

/** This tab's drafts not yet saved: edits and clears (""), oldest edit first,
 *  each kept until its own write succeeds. This tab's reads prefer them. */
const unsaved = new Map<string, string>();
/** Sends accepted after their Chat unmounted, while storage couldn't be read:
 *  the stored draft is cleared once it can be, if it is still the sent text. */
const sentClears = new Map<string, string>();
/** Sessions this window deleted: never saved again (ids are never reused). */
const forgotten = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let lastAt = 0;

/** Apply a waiting sent-clear now that the stored `entry` could be read. */
function settleSentClear(chatId: string, entry: Entry | null): Entry | null {
	const sent = sentClears.get(chatId);
	if (sent === undefined) return entry;
	sentClears.delete(chatId);
	if (!entry || entry.text.trim() !== sent.trim()) return entry;
	writeComposerDraft(chatId, "");
	return null;
}

/** Save every unsaved draft now (leaving a session, page hide). */
export function flushComposerDrafts(): void {
	if (timer !== null) { clearTimeout(timer); timer = null; }
	const store = storage();
	if (!store) {
		// No storage at all: a clear has nothing to clear.
		for (const [id, text] of [...unsaved]) if (text.trim() === "") unsaved.delete(id);
		return;
	}
	for (const id of [...sentClears.keys()]) {
		const entry = readStored(id);
		if (entry !== undefined) settleSentClear(id, entry);
	}
	if (unsaved.size === 0) return;
	try {
		// Later than every stored draft, so the newest write is never the one
		// evicted, however the clock moved or whatever another tab stamped.
		let at = Math.max(Date.now(), lastAt + 1);
		for (const seen of storedDrafts(store).values()) at = Math.max(at, seen + 1);
		const writes = [...unsaved].map(([id, text]) => ({ id, key: COMPOSER_DRAFT_KEY_PREFIX + id, text, at: text.trim() === "" ? null : at++ }));
		lastAt = at;
		for (const write of writes) {
			try {
				if (write.at === null) store.removeItem(write.key);
				else store.setItem(write.key, JSON.stringify({ text: write.text, at: write.at } satisfies Entry));
				unsaved.delete(write.id);
			} catch { /* full or blocked: it stays in memory and is tried again at the next flush; nothing else is touched */ }
		}
		// Then the cap, over what is stored now: only the oldest beyond it go.
		// Never a recovery step for a refused write, so that never deletes another draft.
		const order = [...storedDrafts(store)].map(([key, seenAt]) => ({ key, at: seenAt })).sort(newestFirst);
		for (const { key, at: seenAt } of order.slice(MAX_COMPOSER_DRAFTS)) evict(store, key, seenAt);
	} catch { /* storage refused a read: what is unsaved stays in memory */ }
}

/** The draft for a session, or "" when there is none or it can't be read. */
export function readComposerDraft(chatId: string): string {
	if (forgotten.has(chatId)) return "";
	const mine = unsaved.get(chatId);
	if (mine !== undefined) return mine.trim() === "" ? "" : mine;
	const entry = readStored(chatId);
	if (entry === undefined) return "";
	return settleSentClear(chatId, entry)?.text ?? "";
}

/** Record an edit of a session's composer text. An empty text clears the
 *  draft at once (a sent message's draft must not come back); other text is
 *  saved once the edits pause for WRITE_DEBOUNCE_MS. */
export function writeComposerDraft(chatId: string, text: string): void {
	if (forgotten.has(chatId)) return; // a late dictation chunk can't bring a deleted session's draft back
	sentClears.delete(chatId); // a newer edit replaces a waiting sent-clear
	unsaved.delete(chatId); // set again below, as the newest edit
	unsaved.set(chatId, text);
	while (unsaved.size > MAX_COMPOSER_DRAFTS) unsaved.delete(unsaved.keys().next().value!);
	if (timer !== null) clearTimeout(timer);
	timer = null;
	if (text.trim() === "") flushComposerDrafts();
	else timer = setTimeout(flushComposerDrafts, WRITE_DEBOUNCE_MS);
}

/** Clear a session's draft if it is still `sent` (a message sent after its
 *  Chat unmounted): a newer draft typed since then stays. When storage can't
 *  be read now, the clear waits for the next read or flush that can. */
export function clearComposerDraftIfSent(chatId: string, sent: string): void {
	if (forgotten.has(chatId)) return;
	const mine = unsaved.get(chatId);
	if (mine !== undefined) {
		if (mine.trim() === sent.trim()) writeComposerDraft(chatId, "");
		return;
	}
	const entry = readStored(chatId);
	if (entry === undefined) sentClears.set(chatId, sent);
	else if (entry && entry.text.trim() === sent.trim()) writeComposerDraft(chatId, "");
}

/** Its session was deleted: clear the draft, and ignore later writes. */
export function forgetComposerDraft(chatId: string): void {
	writeComposerDraft(chatId, "");
	sentClears.delete(chatId);
	forgotten.add(chatId);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	// T3 flushes on beforeunload; pagehide also fires where beforeunload doesn't (mobile Safari, bfcache).
	window.addEventListener("beforeunload", flushComposerDrafts);
	window.addEventListener("pagehide", flushComposerDrafts);
}

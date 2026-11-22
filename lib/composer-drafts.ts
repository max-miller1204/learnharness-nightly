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
 * writer wins), never another session's draft.
 *
 * A restored draft is shown without being saved back: only edits are saved,
 * as T3 hydrates without writing. Sending empties the composer, which clears
 * the draft at once; deleting the session clears it for good. Reads are
 * tolerant (AGENTS.md): a missing, unparsable or other-shape value, or
 * storage that throws, reads as no draft. Storage that is blocked or full
 * keeps this tab's drafts in memory, for this tab only, and they are saved
 * at a later flush if storage works again. Text only: attachments are not
 * part of it.
 */

export const COMPOSER_DRAFT_KEY_PREFIX = "lh:composer-draft:v1:";
const WRITE_DEBOUNCE_MS = 300;
/** Drafts kept at most, newest first: a draft whose session was deleted in
 *  another window is never read again (ids aren't reused), so this bounds it. */
export const MAX_COMPOSER_DRAFTS = 50;

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

function readStored(chatId: string): Entry | null {
	try { return parseEntry(storage()?.getItem(COMPOSER_DRAFT_KEY_PREFIX + chatId) ?? null); } catch { return null; }
}

/** Every stored draft's key and time; one that can't be read counts as oldest. */
function storedDrafts(store: Storage): { key: string; at: number }[] {
	const out: { key: string; at: number }[] = [];
	for (let i = 0; i < store.length; i++) {
		const key = store.key(i);
		if (key?.startsWith(COMPOSER_DRAFT_KEY_PREFIX)) out.push({ key, at: parseEntry(store.getItem(key))?.at ?? -Infinity });
	}
	return out;
}

/** This tab's drafts not yet saved: edits, clears ("") and writes storage
 *  refused. This tab's reads prefer it. */
const unsaved = new Map<string, string>();
/** Sessions this window deleted: never saved again (ids are never reused). */
const forgotten = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let lastAt = 0;

/** Save every unsaved draft now (leaving a session, page hide). */
export function flushComposerDrafts(): void {
	if (timer !== null) { clearTimeout(timer); timer = null; }
	if (unsaved.size === 0) return;
	const store = storage();
	if (!store) return; // no storage: drafts stay in memory
	try {
		// Later than every stored draft, so the newest write is never the one
		// evicted, however the clock moved or whatever another tab stamped.
		let at = Date.now();
		for (const stored of storedDrafts(store)) at = Math.max(at, stored.at + 1);
		at = Math.max(at, lastAt + 1);
		for (const [id, text] of [...unsaved]) {
			const key = COMPOSER_DRAFT_KEY_PREFIX + id;
			try {
				if (text.trim() === "") store.removeItem(key);
				else store.setItem(key, JSON.stringify({ text, at: at++ } satisfies Entry));
				unsaved.delete(id);
			} catch { /* full or blocked: it stays in memory and is tried again at the next flush */ }
		}
		lastAt = at;
		const all = storedDrafts(store);
		if (all.length > MAX_COMPOSER_DRAFTS) {
			all.sort((a, b) => b.at - a.at);
			for (const { key } of all.slice(MAX_COMPOSER_DRAFTS)) store.removeItem(key);
		}
	} catch { /* storage refused a read: what is unsaved stays in memory */ }
}

/** The draft for a session, or "" when there is none or it can't be read. */
export function readComposerDraft(chatId: string): string {
	if (forgotten.has(chatId)) return "";
	const mine = unsaved.get(chatId);
	if (mine !== undefined) return mine.trim() === "" ? "" : mine;
	return readStored(chatId)?.text ?? "";
}

/** Record an edit of a session's composer text. An empty text clears the
 *  draft at once (a sent message's draft must not come back); other text is
 *  saved once the edits pause for WRITE_DEBOUNCE_MS. */
export function writeComposerDraft(chatId: string, text: string): void {
	if (forgotten.has(chatId)) return; // a late dictation chunk can't bring a deleted session's draft back
	unsaved.set(chatId, text);
	if (timer !== null) clearTimeout(timer);
	timer = null;
	if (text.trim() === "") flushComposerDrafts();
	else timer = setTimeout(flushComposerDrafts, WRITE_DEBOUNCE_MS);
}

/** Clear a session's draft if it is still `sent` (a message sent after its
 *  Chat unmounted): a newer draft typed since then stays. */
export function clearComposerDraftIfSent(chatId: string, sent: string): void {
	if (readComposerDraft(chatId).trim() === sent.trim()) writeComposerDraft(chatId, "");
}

/** Its session was deleted: clear the draft, and ignore later writes. */
export function forgetComposerDraft(chatId: string): void {
	writeComposerDraft(chatId, "");
	forgotten.add(chatId);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	// T3 flushes on beforeunload; pagehide also fires where beforeunload doesn't (mobile Safari, bfcache).
	window.addEventListener("beforeunload", flushComposerDrafts);
	window.addEventListener("pagehide", flushComposerDrafts);
}

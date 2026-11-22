/**
 * The composer's unsent draft, per session (issue #347), after T3 Code's
 * composer drafts (pingdotgg/t3code, MIT, apps/web/src/composerDraftStore.ts
 * at f9b19a7f): one versioned localStorage value keyed by thread
 * (`t3code:composer-drafts:v1`, :119), writes debounced by 300 ms (:127) and
 * flushed when the page goes away (:248-252), and a read that treats an
 * unparsable or other-version value as no drafts (:146-156). A draft
 * survives navigating away and back, and a reload. It is cleared when its
 * message is sent (the composer empties) and when its session is deleted
 * (components/session-deletion.ts).
 *
 * Stored data needs tolerant reads (AGENTS.md): a missing, corrupt or
 * old-shape value, a malformed entry, or storage that throws gives an empty
 * draft, never an error. Text only: attachments are not part of it.
 */

export const COMPOSER_DRAFTS_KEY = "lh:composer-drafts:v1";
const VERSION = 1;
const WRITE_DEBOUNCE_MS = 300;
/** Drafts kept at most, newest first: a draft whose session was deleted in
 *  another window is never read again (ids aren't reused), so this bounds it. */
export const MAX_COMPOSER_DRAFTS = 50;

type Entry = { text: string; at: number };

function storage(): Storage | null {
	try { return typeof window !== "undefined" && window.localStorage ? window.localStorage : null; } catch { return null; }
}

/** Every stored draft that is well formed; anything else reads as none. */
function load(): Record<string, Entry> {
	const out: Record<string, Entry> = {};
	let raw: string | null = null;
	try { raw = storage()?.getItem(COMPOSER_DRAFTS_KEY) ?? null; } catch { return out; }
	if (!raw) return out;
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { return out; }
	if (!parsed || typeof parsed !== "object") return out;
	const { version, drafts } = parsed as { version?: unknown; drafts?: unknown };
	if (version !== VERSION || !drafts || typeof drafts !== "object" || Array.isArray(drafts)) return out;
	for (const [id, entry] of Object.entries(drafts as Record<string, unknown>)) {
		const { text, at } = (entry ?? {}) as { text?: unknown; at?: unknown };
		if (typeof text === "string" && text !== "" && typeof at === "number" && Number.isFinite(at)) out[id] = { text, at };
	}
	return out;
}

function save(drafts: Record<string, Entry>): void {
	const kept = Object.entries(drafts).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_COMPOSER_DRAFTS);
	try {
		const store = storage();
		if (!store) return;
		if (kept.length === 0) store.removeItem(COMPOSER_DRAFTS_KEY);
		else store.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify({ version: VERSION, drafts: Object.fromEntries(kept) }));
	} catch { /* full or blocked storage: the draft stays in memory only */ }
}

/** Writes not yet saved, by session; the newest text wins. */
const pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Save every pending write now (navigation, page hide, unmount). */
export function flushComposerDrafts(): void {
	if (timer !== null) { clearTimeout(timer); timer = null; }
	if (pending.size === 0) return;
	// Read fresh, so drafts another tab saved meanwhile are kept.
	const drafts = load();
	const now = Date.now();
	for (const [id, text] of pending) {
		if (text.trim() === "") delete drafts[id];
		else drafts[id] = { text, at: now };
	}
	pending.clear();
	save(drafts);
}

/** The saved draft for a session, or "" when there is none or it can't be read. */
export function readComposerDraft(chatId: string): string {
	if (pending.has(chatId)) return pending.get(chatId)!;
	return load()[chatId]?.text ?? "";
}

/** Record the composer's text for a session. An empty text clears the draft
 *  at once (a sent message's draft must not come back); other text is saved
 *  within WRITE_DEBOUNCE_MS. */
export function writeComposerDraft(chatId: string, text: string): void {
	pending.set(chatId, text);
	if (text.trim() === "") { flushComposerDrafts(); return; }
	if (timer === null) timer = setTimeout(flushComposerDrafts, WRITE_DEBOUNCE_MS);
}

/** Forget a session's draft (its session was deleted). */
export function clearComposerDraft(chatId: string): void {
	pending.set(chatId, "");
	flushComposerDrafts();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	// T3 flushes on beforeunload; pagehide also fires where beforeunload doesn't (mobile Safari, bfcache).
	window.addEventListener("beforeunload", flushComposerDrafts);
	window.addEventListener("pagehide", flushComposerDrafts);
}

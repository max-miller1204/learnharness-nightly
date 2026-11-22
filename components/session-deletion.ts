/**
 * Sessions being deleted from this window (first-load polish,
 * docs/specs/polish-first-load.md, item 4).
 *
 * The delete dialog marks a session BEFORE it sends the DELETE: the server
 * removes the record before the browser hears back, and a read timer of the
 * session's view (the turn-start re-reads, the side-chat list, ...) could
 * fire in that gap and 404. The view's own reads of that session check
 * sessionReadHold() first and await it when it returns one, so they HOLD
 * while the delete is in flight (and keep their exact timing otherwise):
 *   - deleted: they never run (the view unmounts right after; nothing to adopt)
 *   - refused or failed: they run as normal, so nothing is lost.
 */

const inFlight = new Map<string, Promise<boolean>>(); // resolves true = deleted
const deleted = new Set<string>(); // ids are never reused

/** A fresh promise that never settles: a held read of a deleted session.
 *  Fresh per read, so nothing long-lived keeps the unmounted view alive. */
const never = () => new Promise<never>(() => {});

/** Mark a session as being deleted; call the returned function with the
 *  outcome (true = the server deleted it) once the DELETE settles. */
export function beginSessionDelete(chatId: string): (wasDeleted: boolean) => void {
	let settle!: (wasDeleted: boolean) => void;
	const pending = new Promise<boolean>((resolve) => { settle = resolve; });
	inFlight.set(chatId, pending);
	let done = false;
	return (wasDeleted) => {
		if (done) return; // the first outcome stands
		done = true;
		if (wasDeleted) deleted.add(chatId);
		if (inFlight.get(chatId) === pending) inFlight.delete(chatId); // never a newer delete's mark
		settle(wasDeleted);
	};
}

/** Mark a batch of sessions as being deleted; call the returned function with
 *  the ids the server actually removed once the DELETE settles. */
export function beginSessionDeletes(chatIds: readonly string[]): (deletedIds: readonly string[]) => void {
	const settles = chatIds.map((id) => [id, beginSessionDelete(id)] as const);
	return (deletedIds) => {
		const gone = new Set(deletedIds);
		for (const [id, done] of settles) done(gone.has(id));
	};
}

/** Whether this window already confirmed the session was deleted. */
export function isSessionDeleted(chatId: string): boolean {
	return deleted.has(chatId);
}

/** Window event carrying session ids deleted outside the sidebar (for example,
 *  the graph source table's deleteSessions flow) so the sidebar patches its
 *  list and refreshes the client router cache through the same helper. */
export const SESSIONS_DELETED_EVENT = "lh:sessions-deleted";

export function notifySessionsDeleted(ids: readonly string[]): void {
	if (ids.length === 0 || typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent<{ ids: string[] }>(SESSIONS_DELETED_EVENT, { detail: { ids: [...ids] } }));
}

/** null for a session nobody is deleting (read now, no extra tick).
 *  Otherwise a promise to await before the read: it resolves once a delete
 *  in flight is refused or fails, and never if the session was deleted. */
export function sessionReadHold(chatId: string): Promise<void> | null {
	if (deleted.has(chatId)) return never();
	const pending = inFlight.get(chatId);
	if (!pending) return null;
	return pending.then((wasDeleted) => (wasDeleted ? never() : undefined));
}

/** After a delete: when the open session (`pathname`) is one of `deletedIds`,
 *  drop its view at once (`drop`, before the navigation commits, so its
 *  timers can't fetch it) and leave with `replace`, never push: Back must not
 *  lead to a session that no longer exists (T3 Code's rule). Always refresh
 *  the router when provided so Next.js drops deleted sessions from its client
 *  back/forward cache before an older history entry can be revisited. */
export function leaveDeletedSession(
	pathname: string,
	deletedIds: Iterable<string>,
	drop: (id: string) => void,
	replace: (href: string) => void,
	refresh?: () => void,
): void {
	const gone = new Set(deletedIds);
	if (gone.size === 0) return;
	const openId = pathname.startsWith("/chat/") ? pathname.slice("/chat/".length) : null;
	if (openId !== null && gone.has(openId)) {
		drop(openId);
		replace("/");
	}
	refresh?.();
}

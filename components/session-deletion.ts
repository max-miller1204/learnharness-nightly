/**
 * Sessions being deleted from this window (first-load polish,
 * docs/specs/polish-first-load.md, item 4).
 *
 * The delete dialog marks a session BEFORE it sends the DELETE: the server
 * removes the record before the browser hears back, and a read timer of the
 * session's view (the turn-start re-reads, the side-chat list, ...) could
 * fire in that gap and 404. The view's own reads of that session check the
 * mark and skip. A refused or failed delete clears it; a successful one
 * keeps it (ids are never reused, and the view unmounts right after).
 */

const deleting = new Set<string>();

export function markSessionDeleting(chatId: string): void {
	deleting.add(chatId);
}

export function clearSessionDeleting(chatId: string): void {
	deleting.delete(chatId);
}

export function isSessionDeleting(chatId: string): boolean {
	return deleting.has(chatId);
}

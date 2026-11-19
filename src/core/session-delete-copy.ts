/** The delete-session box's words, shared by the web dialog
 * (components/delete-session-dialog.tsx) and the phone's box, which shows
 * them word for word (docs/specs/mobile-session-basics.md). */
export const DELETE_SESSION_COPY = {
	title: "Delete session?",
	body: "This permanently removes the session — its messages, background jobs, and extraction records. Everything it added to the graph stays unless you check below. This cannot be undone.",
	tracesTitle: "Also remove its graph traces",
	tracesBody: "This session’s topics, links, and events leave the graph too. Topics other sessions or imported notes also cover survive; topics only this session created are removed entirely.",
	retry: "Try again",
	cancel: "Cancel",
	confirm: "Delete",
	busy: "Deleting…",
} as const;

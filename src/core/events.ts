/**
 * Live-only app notifications (not a durable replay log); consumers refetch
 * authoritative state after receiving an event or reconnecting.
 */

export interface ServerEvents {
	"turn-started": { chatId: string };
	"turn-settled": { chatId: string };
	"jobs-changed": { chatId?: string };
	"activity-changed": Record<string, never>;
	"chats-changed": Record<string, never>;
	"sources-changed": Record<string, never>;
	/** No account or credential data on the bus. */
	"subscriptions-changed": Record<string, never>;
	"record-changed": { chatId: string };
	"compaction-changed": { chatId: string; running: boolean };
	"side-chats-changed": { chatId: string };
	"plugins-changed": Record<string, never>;
	"plugin-message": { pluginId: string; topic: string; data?: unknown };
	"update-changed": Record<string, never>;
	"whats-new-changed": Record<string, never>;
}

export type ServerEventType = keyof ServerEvents;

export const SERVER_EVENT_TYPES = [
	"turn-started",
	"turn-settled",
	"jobs-changed",
	"activity-changed",
	"chats-changed",
	"sources-changed",
	"subscriptions-changed",
	"record-changed",
	"compaction-changed",
	"side-chats-changed",
	"plugins-changed",
	"plugin-message",
	"update-changed",
	"whats-new-changed",
] as const satisfies readonly ServerEventType[];

export type ServerEvent<K extends ServerEventType = ServerEventType> = {
	[T in K]: { type: T } & ServerEvents[T];
}[K];

export type ServerEventListener = (event: ServerEvent) => void;

interface LhEventsGlobal {
	__lhEventBus?: Set<ServerEventListener>;
}

/** Stored on globalThis so separate Next.js route entries share one bus. */
function listeners(): Set<ServerEventListener> {
	const g = globalThis as typeof globalThis & LhEventsGlobal;
	return (g.__lhEventBus ??= new Set());
}

export function subscribe(listener: ServerEventListener): () => void {
	const set = listeners();
	set.add(listener);
	return () => set.delete(listener);
}

export function emit<K extends ServerEventType>(type: K, payload: ServerEvents[K]): void {
	for (const listener of [...listeners()]) {
		try {
			listener({ type, ...payload } as ServerEvent);
		} catch (err) {
			console.error(`[events] listener failed on ${type}:`, err);
		}
	}
}

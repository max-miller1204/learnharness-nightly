import { randomUuid } from "./random-uuid.ts";

/** The app-wide message id format persisted in chat records. */
export function newMessageId(): string {
	return `msg_${Date.now().toString(36)}_${randomUuid().slice(0, 8)}`;
}

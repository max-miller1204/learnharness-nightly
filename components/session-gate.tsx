"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { isSessionDeleted } from "@/components/session-deletion";

/** Guards a session view restored from Next.js's client back/forward cache
 *  after the session was deleted in this window. Returning null keeps the
 *  stale transcript and its API reads from mounting while router.refresh()
 *  asks the server to render the route's normal not-found state. */
export function SessionGate({ chatId, children }: { chatId: string; children: ReactNode }) {
	const router = useRouter();
	const [deleted] = useState(() => isSessionDeleted(chatId));
	useEffect(() => {
		if (deleted) router.refresh();
	}, [deleted, router]);
	return deleted ? null : children;
}

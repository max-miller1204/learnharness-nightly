import { useEffect, useRef, useState, type RefObject } from "react";
import { LESSON_VIEW_ROUTES, type JobRecord, type JobsResponse } from "../../../src/client-protocol/index.ts";
import type { MobileApi } from "./protocol";
import { jobSettled } from "./lesson";

const NONE: JobRecord[] = [];

/** lesson-view-v1: the session's background helpers, read on open, on every
 * `jobs-changed` for this chat (coalesced like the web's 250 ms debounce) and
 * on reconnect. A helper that stops running re-reads the record, because its
 * result is about to land in the transcript. */
export function useJobs(api: MobileApi, chatId: string, enabled: boolean, reloadRef: RefObject<(() => void) | null>,
  settled: () => void, connectionFault: (error: unknown) => boolean) {
  const [jobs, setJobs] = useState<JobRecord[]>(NONE);
  const [now, setNow] = useState(() => Date.now());
  const onSettle = useRef(settled);
  useEffect(() => { onSettle.current = settled; }, [settled]);

  useEffect(() => {
    if (!enabled) return;
    const lifetime = new AbortController();
    const statuses = new Map<string, string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const { jobs: list } = await api.get<JobsResponse>(LESSON_VIEW_ROUTES.jobs(chatId), lifetime.signal);
        if (lifetime.signal.aborted || !Array.isArray(list)) return;
        const stopped = jobSettled(statuses, list);
        statuses.clear();
        for (const job of list) statuses.set(job.id, job.status);
        setJobs(list);
        if (stopped) onSettle.current();
      } catch (error) {
        // A transient failure waits for the next announcement, as on the web.
        if (!lifetime.signal.aborted) connectionFault(error);
      }
    }
    reloadRef.current = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void read(), 250);
    };
    void read();
    return () => { lifetime.abort(); clearTimeout(timer); reloadRef.current = null; };
  }, [api, chatId, connectionFault, enabled, reloadRef]);

  // The running card's elapsed seconds keep counting between announcements.
  const running = jobs.some((job) => job.status === "running");
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [running]);

  return { jobs: enabled ? jobs : NONE, now };
}

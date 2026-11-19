import { useCallback, useEffect, useRef, useState } from "react";
import {
  LESSON_VIEW_ROUTES, PRACTICE_CONTROL_ROUTES, PROTOCOL_ROUTES,
  type AbortTurnResponse, type AttachmentSend, type ChatResponse, type LhMessage, type SendResponse, type TurnStreamEvent,
} from "../../../src/client-protocol/index.ts";
import { ApiError, type MobileApi } from "./protocol";
import { consumeSse } from "./sse";
import { inputWasSaved, turnReplay, type SessionInput } from "./live-turn";

export const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong.";

interface UnconfirmedInput {
  input: SessionInput;
  priorIds: ReadonlySet<string>;
  failure: string;
  accepted: (result?: unknown) => void;
}

export function useSession(api: MobileApi, id: string, active: boolean, connectionFault: (error: unknown) => boolean) {
  const [record, setRecord] = useState<ChatResponse>();
  const [tail, setTail] = useState<LhMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState("");
  const [deleted, setDeleted] = useState(false);
  const [writeError, setWriteError] = useState("");
  const [streamError, setStreamError] = useState("");
  const [writing, setWriting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const write = useRef(new AbortController());
  const pending = useRef<UnconfirmedInput | null>(null);
  const writingNow = useRef(false);
  const writeRevision = useRef(0);
  const refreshingAfterWrite = useRef(false);
  const stoppingNow = useRef(false);
  const latest = useRef<ChatResponse | undefined>(undefined);
  const refreshAction = useRef<(reconnect?: boolean) => void>(() => {});
  const refresh = useCallback((reconnect?: boolean) => refreshAction.current(reconnect), []);

  useEffect(() => {
    const lifetime = new AbortController();
    write.current = lifetime;
    return () => lifetime.abort();
  }, []);

  useEffect(() => {
    if (!active) return;
    const lifetime = new AbortController();
    const signal = lifetime.signal;
    let turn: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    let refreshAgain = false;
    let pausedUntil = 0;

    function dropTurn() {
      turn?.abort();
      turn = undefined;
    }

    function retry() {
      if (timer === undefined && !signal.aborted) {
        timer = setTimeout(() => {
          timer = undefined;
          refresh();
        }, 1500);
      }
    }

    function attach() {
      if (turn || Date.now() < pausedUntil) return;
      const scope = new AbortController();
      turn = scope;
      const isCurrent = () => turn === scope && !signal.aborted;
      const replay = turnReplay();
      setTail([]);
      void (async () => {
        let done = false;
        try {
          const body = await api.stream(PROTOCOL_ROUTES.turnStream(id), scope.signal);
          await consumeSse(body, (_event, data) => {
            if (!isCurrent()) return false;
            if (data === "[DONE]") { done = true; return false; }
            const event = JSON.parse(data) as TurnStreamEvent;
            if (event.type === "agent_start") setStreamError("");
            if (event.type === "error") setStreamError(event.errorText);
            const messages = replay(event);
            if (messages) setTail(messages);
          });
        } catch (error) {
          if (!isCurrent() || connectionFault(error)) return;
        } finally {
          if (isCurrent()) {
            // Keep partial text visible until either a fresh replay or the
            // authoritative record arrives.
            turn = undefined;
            if (!done) { pausedUntil = Date.now() + 1500; retry(); }
            void readRecord();
          }
        }
      })();
    }

    async function readRecord() {
      if (signal.aborted) return;
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      try {
        do {
          refreshAgain = false;
          const startedAtRevision = writeRevision.current;
          const fresh = await api.get<ChatResponse>(PROTOCOL_ROUTES.chat(id), signal);
          if (signal.aborted) return;
          if (startedAtRevision !== writeRevision.current) {
            refreshAgain = true;
            continue;
          }
          latest.current = fresh;
          setRecord(fresh);
          setRefreshError("");
          setDeleted(false);
          const outstanding = pending.current;
          if (outstanding && inputWasSaved(fresh.messages, outstanding.priorIds, outstanding.input)) {
            pending.current = null;
            outstanding.accepted();
            setUnconfirmed(false);
            setWriteError("");
          } else if (outstanding && !fresh.turnInFlight) {
            pending.current = null;
            setUnconfirmed(false);
            setWriteError(outstanding.failure + " Check the transcript before trying again.");
          }
          if (refreshingAfterWrite.current) {
            refreshingAfterWrite.current = false;
            writingNow.current = false;
            setWriting(false);
          }
          if (fresh.turnInFlight) {
            attach();
            if (!turn) retry();
          } else {
            dropTurn();
            setTail([]);
          }
        } while (refreshAgain && !signal.aborted);
      } catch (error) {
        if (!signal.aborted && !connectionFault(error)) {
          setRefreshError(errorText(error));
          const gone = error instanceof ApiError && error.status === 404;
          setDeleted(gone);
          if (!gone) retry();
        }
      } finally {
        if (!signal.aborted) setLoading(false);
        refreshing = false;
      }
    }

    refreshAction.current = (reconnect) => {
      if (reconnect) {
        dropTurn();
        pausedUntil = 0;
      }
      void readRecord();
    };
    void readRecord();
    return () => {
      lifetime.abort();
      dropTurn();
      clearTimeout(timer);
      refreshAction.current = () => {};
    };
  }, [active, api, connectionFault, id, refresh]);

  /** `accepted` receives the server's answer body (absent when a lost response is confirmed from the record).
   *  `attachment` rides a text send: its uploaded files and the send ID that makes a retry safe. */
  async function submit(input: SessionInput, accepted: (result?: unknown) => void = () => {}, attachment?: AttachmentSend) {
    const before = latest.current;
    if (!active || !before || writingNow.current || pending.current || refreshError || before.compacting) return;
    // Discards and skips may land mid-turn: the server parks them for the settle.
    if (before.turnInFlight && input.type !== "dismiss-problem" && input.type !== "dismiss") return;
    const signal = write.current.signal;
    writingNow.current = true;
    setWriting(true);
    setWriteError("");
    setStreamError("");
    try {
      let result: unknown;
      if (input.type === "dismiss-problem") {
        result = await api.post(PRACTICE_CONTROL_ROUTES.dismiss(id), { input }, signal);
      } else if (input.type === "dismiss") {
        result = await api.post(LESSON_VIEW_ROUTES.dismiss(id), { input }, signal);
      } else {
        result = await api.post<SendResponse>(PROTOCOL_ROUTES.send, { chatId: id, input, ...attachment }, signal);
      }
      if (!signal.aborted) accepted(result);
    } catch (error) {
      if (signal.aborted || connectionFault(error)) return;
      if (!(error instanceof ApiError) || error.status >= 500) {
        pending.current = { input, priorIds: new Set(before.messages.map(({ id }) => id)), failure: errorText(error), accepted };
        setUnconfirmed(true);
        setWriteError("Confirming the request with the server…");
      } else {
        setWriteError(errorText(error));
      }
    } finally {
      if (!signal.aborted) {
        // Keep the input guard up until the post-write record is read. A
        // terminal on the stream is followed by the same reconciliation.
        writeRevision.current++;
        refreshingAfterWrite.current = true;
        refresh();
      }
    }
  }

  /** `quiet` keeps a failed stop off the screen (the follow-up stop after a skip). */
  async function stop(quiet = false) {
    if (stoppingNow.current) return;
    const signal = write.current.signal;
    stoppingNow.current = true;
    setStopping(true);
    try {
      await api.post<AbortTurnResponse>(PROTOCOL_ROUTES.abort, { kind: "turn", id }, signal);
    } catch (error) {
      if (!signal.aborted && !connectionFault(error) && !quiet) setWriteError(errorText(error));
    } finally {
      if (!signal.aborted) {
        refresh();
        setStopping(false);
        stoppingNow.current = false;
      }
    }
  }

  return { record, tail, loading, refreshError, deleted, writeError, streamError, writing, stopping, unconfirmed, refresh, submit, stop };
}

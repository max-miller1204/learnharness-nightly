import { useEffect, useRef } from "react";
import { PROTOCOL_ROUTES, type EventFrame, type ServerInfo } from "../../../src/client-protocol/index.ts";
import { nativeApi } from "./native-api";
import { type MobileApi } from "./protocol";
import { consumeSse } from "./sse";

export function useEvents(
  api: MobileApi,
  active: boolean,
  refresh: (event?: EventFrame) => void,
  connectionFault: (error: unknown) => boolean,
  setOffline: (offline: boolean) => void,
  setInfo: (info: ServerInfo) => void,
) {
  const listener = useRef(refresh);
  useEffect(() => { listener.current = refresh; }, [refresh]);

  useEffect(() => {
    if (!active) return;
    const scope = new AbortController();
    const signal = scope.signal;
    let timer: ReturnType<typeof setTimeout>;

    async function listen() {
      const subscription = new AbortController();
      const abort = () => subscription.abort();
      signal.addEventListener("abort", abort, { once: true });
      let heartbeat: ReturnType<typeof setTimeout> | undefined;
      function expectTraffic() {
        clearTimeout(heartbeat);
        // The server sends a ping every 25 s, even when no turn runs.
        heartbeat = setTimeout(abort, 55_000);
      }

      try {
        const descriptor = await nativeApi(api.origin).descriptor(signal);
        if (signal.aborted) return;
        setInfo(descriptor);
        expectTraffic();
        const stream = await api.stream(PROTOCOL_ROUTES.events, subscription.signal);
        if (signal.aborted) return;
        setOffline(false);
        listener.current();
        await consumeSse(stream, (event, data) => {
          if (signal.aborted) return false;
          listener.current({ event, data: JSON.parse(data) } as EventFrame);
        }, expectTraffic);
      } catch (error) {
        if (signal.aborted || connectionFault(error)) return;
      } finally {
        clearTimeout(heartbeat);
        signal.removeEventListener("abort", abort);
        abort();
      }

      if (!signal.aborted) {
        setOffline(true);
        timer = setTimeout(() => void listen(), 1500);
      }
    }

    void listen();
    return () => { scope.abort(); clearTimeout(timer); };
  }, [active, api, connectionFault, setInfo, setOffline]);
}

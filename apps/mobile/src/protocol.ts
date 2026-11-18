import {
  BROWSER_HANDOFF_ROUTES, CLIENT_PROTOCOL_VERSION, PROTOCOL_HEADER, PROTOCOL_ROUTES,
  protocolMismatch, type ServerInfo, type TokenExchangeRequest, type TokenExchangeResponse,
} from "../../../src/client-protocol/index.ts";

export function httpsOrigin(text: string): string {
  const value = text.trim();
  const url = new URL(value);
  if (!/^https:\/\/[^/?#\\]+\/?$/i.test(value) ||
      url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password ||
      !url.hostname || /[\s@]/.test(value)) {
    throw new Error("Enter the server's HTTPS address without a path.");
  }
  return url.origin;
}

export function pairingCode(value: string): string {
  const code = value.replace(/[\s-]+/g, "").toUpperCase();
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/.test(code)) {
    throw new Error("Enter a valid 12-character pairing code.");
  }
  return code;
}

export function readPairingLink(text: string): { origin: string; code: string } {
  const url = new URL(text.trim());
  if (url.username || url.password || url.pathname !== "/pair" || url.search) {
    throw new Error("This isn't a LearnHarness pairing link.");
  }
  return { origin: httpsOrigin(url.origin), code: pairingCode(new URLSearchParams(url.hash.slice(1)).get("token") ?? "") };
}

export function bearerKey(origin: string): string {
  // SecureStore keys allow a limited alphabet. An injective key keeps servers
  // with different hostnames or ports in distinct slots.
  return "bearer." + Array.from(httpsOrigin(origin), (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

type Transport = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  credentials: "omit";
  redirect: "error";
}) => Promise<Pick<Response, "ok" | "status" | "headers" | "json" | "text" | "body">>;

export function apiClient(transport: Transport, address: string, bearer?: string) {
  const origin = httpsOrigin(address);

  async function request(path: string, options: { signal: AbortSignal; body?: string; contentType?: string; stream?: boolean }) {
    const url = new URL(path, origin);
    if (url.origin !== origin || !path.startsWith("/") || path.startsWith("//")) {
      throw new Error("Invalid LearnHarness route.");
    }

    const headers: Record<string, string> = {
      [PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION),
      Accept: options.stream ? "text/event-stream" : "application/json",
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (options.body !== undefined) headers["Content-Type"] = options.contentType ?? "application/json";

    const deadline = new AbortController();
    const abort = () => deadline.abort();
    if (options.signal.aborted) abort();
    options.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 20_000);
    try {
      let response;
      try {
        response = await transport(url.href, {
          method: options.body === undefined ? "GET" : "POST",
          headers,
          body: options.body,
          signal: options.stream ? options.signal : deadline.signal,
          credentials: "omit",
          redirect: "error",
        });
      } catch {
        throw new Error("Couldn't reach the LearnHarness server.");
      }
      if (!response.ok) {
        const type = response.headers.get("content-type");
        const error = type?.includes("application/json")
          ? await response.json().catch(() => null) as { error?: string; error_description?: string; code?: string; protocolVersion?: number } | null
          : null;
        const body = type?.includes("text/plain") ? await response.text().catch(() => "") : "";
        const mismatch = response.status === 426 && typeof error?.protocolVersion === "number"
          ? protocolMismatch({ name: new URL(origin).hostname, protocolVersion: error.protocolVersion })
          : null;
        throw new ApiError(mismatch?.message ?? error?.error_description ?? error?.error ?? (body || `Server request failed (${response.status}).`),
          response.status, error?.code);
      }
      if (options.stream) return response.body;
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        // A sibling built-in question can keep the turn from starting.
        await response.body?.cancel();
        return { ok: true };
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
    }
  }

  function get<T>(path: string, signal: AbortSignal): Promise<T> {
    return request(path, { signal }) as Promise<T>;
  }

  return {
    origin,
    get,
    post<T>(path: string, body: object, signal: AbortSignal): Promise<T> {
      return request(path, { body: JSON.stringify(body), signal }) as Promise<T>;
    },
    stream(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
      return request(path, { signal, stream: true }) as Promise<ReadableStream<Uint8Array>>;
    },
    async descriptor(signal: AbortSignal): Promise<ServerInfo> {
      const info = await get<ServerInfo>(PROTOCOL_ROUTES.serverInfo, signal);
      if (typeof info?.name !== "string" || !Number.isSafeInteger(info.protocolVersion)) {
        throw new Error("This address did not return a LearnHarness server descriptor.");
      }
      const mismatch = protocolMismatch(info);
      if (mismatch) throw new ApiError(mismatch.message, 426);
      if (!Array.isArray(info.capabilities) || info.auth?.required !== true ||
          !info.auth.bootstrapMethods?.includes("one-time-token") ||
          !info.auth.sessionMethods?.includes("bearer-access-token") ||
          info.auth.tokenEndpoint !== PROTOCOL_ROUTES.token) {
        throw new Error("This server doesn't support LearnHarness mobile pairing.");
      }
      return info;
    },
    async exchange(code: string, os: string, signal: AbortSignal): Promise<string> {
      const fields: TokenExchangeRequest = {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "urn:learnharness:params:oauth:token-type:pairing-code",
        subject_token: pairingCode(code),
        client_label: "LearnHarness Nightly",
        client_device_type: "mobile",
        client_os: os,
      };
      const response = await request(PROTOCOL_ROUTES.token, {
        signal,
        body: new URLSearchParams(Object.entries(fields)).toString(),
        contentType: "application/x-www-form-urlencoded",
      }) as TokenExchangeResponse;
      if (response?.token_type !== "Bearer" || !response.access_token) throw new Error("The server didn't issue a device credential.");
      return response.access_token;
    },
  };
}

export type MobileApi = ReturnType<typeof apiClient>;

export function browserDestination(origin: string, chatId: string, credential?: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error("Invalid LearnHarness session ID.");
  return httpsOrigin(origin) + (credential ? BROWSER_HANDOFF_ROUTES.pair(chatId, credential) : BROWSER_HANDOFF_ROUTES.chat(chatId));
}

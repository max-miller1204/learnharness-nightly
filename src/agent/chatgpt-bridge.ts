import type { Model } from "@earendil-works/pi-ai";
import { onWebSubscriptionPacket, webSubscriptionRequest, webSubscriptionsEnabled } from "./subscription-runtime.ts";
import type { ChatGPTStatus } from "../core/contracts/chatgpt.ts";
import type { AdmissionScope, NoDispatchKind } from "./chatgpt-request-cycle.ts";
export type { ChatGPTStatus } from "../core/contracts/chatgpt.ts";
export interface Stamp { epoch: number; authorityRevision: number; revision: number }
interface StatusValue extends Stamp { status: ChatGPTStatus }
/** Account metadata is unvalidated input: only accountModel() reads it. */
interface AccountModelEntry { id: string; name: string; contextWindow?: unknown; input?: unknown; reasoningLevels?: unknown }
interface ModelsValue extends StatusValue { accountId: string | null; models: AccountModelEntry[] }
interface LeaseValue extends Stamp { accessToken: string; accountId: string }
interface Pending { op: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
interface BridgeState {
 status: ChatGPTStatus; stamp: Stamp; models: Model<"openai-responses">[]; catalogAccount: string | null;
 pending: Map<string, Pending>; controllers: Map<AbortController, boolean>; listeners: Set<() => void>; counter: number; catalogRequest: number;
 /** Status and catalog checks, numbered when they start (see settleCheck). */
 checks: number; lastCheck: number; unreachable: boolean;
}
const key = Symbol.for("lh.chatgpt.bridge");
const unavailable = (): ChatGPTStatus => ({ available: false, pending: false, allowBackgroundUse: true, activeId: null, accounts: [], error: null });
const validStamp = (s: Stamp) => s && [s.epoch, s.authorityRevision, s.revision].every((v) => Number.isSafeInteger(v) && v >= 0);
/** Next dev also uses parent/child IPC. IPC alone is not our desktop
 * transport: require the same launch markers set by Electron startServer.
 * These identify the transport, not a substitute for admission/lease checks. */
function desktopIPCConnected(): boolean {
 return process.env.LH_DESKTOP_SERVER === "1" && (process.env.LH_DESKTOP_API_SECRET?.length ?? 0) >= 64 && typeof process.send === "function" && process.connected === true;
}
function runtimeConnected(): boolean { return desktopIPCConnected() || webSubscriptionsEnabled(); }
function bridge(): BridgeState {
 const global = globalThis as typeof globalThis & { [key]?: BridgeState };
 if (!global[key]) {
  const state: BridgeState = { status: unavailable(), stamp: { epoch: 0, authorityRevision: 0, revision: 0 }, models: [], catalogAccount: null, pending: new Map(), controllers: new Map(), listeners: new Set(), counter: 0, catalogRequest: 0, checks: 0, lastCheck: 0, unreachable: false };
  global[key] = state;
  const receive = (raw: unknown) => {
   const m = raw as { channel?: string; kind?: string; id?: string; op?: string; ok?: boolean; value?: unknown; stamp: Stamp; status: ChatGPTStatus; invalidate?: string; error?: string };
   if (m?.channel !== "lh:chatgpt") return;
   if (m.kind === "state" && validStamp(m.stamp) && m.stamp.revision >= state.stamp.revision) {
    acceptStatus(state, { ...m.stamp, status: m.status });
    settleCheck(state, ++state.checks, !!m.status?.catalogError);
    if (m.invalidate === "all") { state.catalogRequest++; clearCatalog(state); }
    if (m.invalidate === "all" || m.invalidate === "background") {
     for (const [controller, background] of state.controllers) if (m.invalidate === "all" || background) controller.abort(m.invalidate === "all" ? "all" : "background");
    }
    for (const listener of state.listeners) listener();
   }
   if (m.id) {
    const call = state.pending.get(m.id);
    if (!call || call.op !== m.op) return;
    clearTimeout(call.timer); state.pending.delete(m.id);
    if (m.ok === true) call.resolve(m.value);
    else call.reject(new Error(m.error ?? "ChatGPT connection failed."));
   }
  };
  process.on("message", (raw: unknown) => { if (desktopIPCConnected()) receive(raw); });
  onWebSubscriptionPacket("lh:chatgpt", (packet) => { if (webSubscriptionsEnabled()) receive(packet); });
  process.on("disconnect", () => {
   if (webSubscriptionsEnabled()) return;
   state.status = unavailable(); clearCatalog(state); state.catalogRequest++;
   for (const controller of state.controllers.keys()) controller.abort("all");
   for (const call of state.pending.values()) { clearTimeout(call.timer); call.reject(new Error("The desktop connection closed.")); }
   state.pending.clear();
   for (const listener of state.listeners) listener();
  });
 }
 return global[key];
}
function clearCatalog(state: BridgeState) { state.models = []; state.catalogAccount = null; }
/** The one rule for "unreachable": the latest completed check, ordered by when
 * it started, failed or answered with a catalog error. An older answer never
 * overwrites a newer one. Listeners hear when the answer changes. */
function settleCheck(state: BridgeState, started: number, unreachable: boolean) {
 if (started <= state.lastCheck) return;
 state.lastCheck = started;
 if (state.unreachable === unreachable) return;
 state.unreachable = unreachable;
 for (const listener of state.listeners) listener();
}
/** Runs one status or catalog request as a check. */
async function checked<T extends StatusValue>(state: BridgeState, request: Promise<T>): Promise<T> {
 const started = ++state.checks;
 try {
  const value = await request;
  settleCheck(state, started, !validStamp(value) || !!value.status?.catalogError);
  return value;
 } catch (error) { settleCheck(state, started, true); throw error; }
}
function acceptStatus(state: BridgeState, value: StatusValue) {
 if (!validStamp(value) || value.revision < state.stamp.revision) return;
 if (value.epoch !== state.stamp.epoch || value.authorityRevision !== state.stamp.authorityRevision || value.status.activeId !== state.status.activeId) clearCatalog(state);
 state.status = value.status; state.stamp = { epoch: value.epoch, authorityRevision: value.authorityRevision, revision: value.revision };
}
/** Runtime-only: inherited desktop IPC or direct web owner. Never HTTP leases. */
export function chatGPTRequest<T>(op: "status" | "models" | "lease", fields: Record<string, unknown> = {}): Promise<T> {
 const state = bridge();
 if (webSubscriptionsEnabled()) return webSubscriptionRequest<T>("lh:chatgpt", op, fields);
 if (!desktopIPCConnected()) return Promise.reject(new Error("ChatGPT sign-in is available only in the desktop app with a private server connection."));
 return new Promise<T>((resolve, reject) => {
  const id = `${process.pid}:${++state.counter}`;
  const timer = setTimeout(() => { state.pending.delete(id); reject(new Error("The ChatGPT desktop connection timed out.")); }, 45000);
  state.pending.set(id, { op, resolve: (v) => resolve(v as T), reject, timer });
  process.send!({ ...fields, channel: "lh:chatgpt", id, op }, (error) => {
   if (error) { clearTimeout(timer); state.pending.delete(id); reject(new Error("The ChatGPT desktop connection closed.")); }
  });
 });
}
export function chatGPTStatus(): ChatGPTStatus { return bridge().status; }
export async function refreshChatGPTStatus(): Promise<void> {
 if (!runtimeConnected()) return;
 const state = bridge();
 acceptStatus(state, await checked(state, chatGPTRequest<StatusValue>("status")));
}
/** The latest check failed while the runtime is still connected. A lost
 * runtime is not connected, never unreachable. */
export function chatGPTUnreachable(): boolean { return runtimeConnected() && bridge().unreachable; }
export function chatGPTConnected(): boolean { const s = chatGPTStatus(); return runtimeConnected() && s.available && s.accounts.some((a) => a.id === s.activeId && a.connected && a.planEnabled === true); }
export function chatGPTBackgroundAllowed(): boolean { const s = chatGPTStatus(); return chatGPTConnected() && s.allowBackgroundUse === true; }
export function onChatGPTChange(listener: () => void): () => void { bridge().listeners.add(listener); return () => { bridge().listeners.delete(listener); }; }
export function chatGPTModels(): Model<"openai-responses">[] { return bridge().models; }
export function chatGPTModel(id: string): Model<"openai-responses"> | undefined { return chatGPTModels().find((m) => m.id === id); }
export function chatGPTScope(selectedModelId: string): AdmissionScope {
 const state = bridge();
 if (!chatGPTConnected() || !state.catalogAccount || state.catalogAccount !== state.status.activeId || !chatGPTModel(selectedModelId)) throw new Error("ChatGPT account model catalog is unavailable");
 return { accountId: state.catalogAccount, epoch: state.stamp.epoch, authorityRevision: state.stamp.authorityRevision, selectedModelId };
}
export function chatGPTScopeCurrent(scope: AdmissionScope): boolean {
 const s = bridge();
 return runtimeConnected() && chatGPTConnected() && scope.accountId === s.catalogAccount && scope.accountId === s.status.activeId && scope.epoch === s.stamp.epoch && scope.authorityRevision === s.stamp.authorityRevision && !!chatGPTModel(scope.selectedModelId);
}
export async function chatGPTLease(scope: AdmissionScope, background: boolean): Promise<LeaseValue> {
 if (!chatGPTScopeCurrent(scope)) throw new Error("ChatGPT catalog authority changed");
 const value = await chatGPTRequest<LeaseValue>("lease", { background, expectedAccountId: scope.accountId, expectedAuthorityRevision: scope.authorityRevision, selectedModelId: scope.selectedModelId });
 if (!validStamp(value) || !chatGPTScopeCurrent(scope) || value.epoch !== scope.epoch || value.authorityRevision !== scope.authorityRevision || value.accountId !== scope.accountId || typeof value.accessToken !== "string" || !value.accessToken || value.accessToken.startsWith("sk-")) throw new Error("ChatGPT lease is stale");
 return value;
}
/** Safe status confirmation can establish consent-only denial, never parse error text. */
export async function chatGPTDenial(scope: AdmissionScope | undefined, controller: AbortController, callerAborted: boolean, background: boolean): Promise<NoDispatchKind> {
 if (callerAborted || controller.signal.reason === "all") return "all";
 if (!scope || !chatGPTScopeCurrent(scope)) return "other";
 if (controller.signal.reason === "background") return "background";
 if (!background) return "other";
 try { const state = bridge(); acceptStatus(state, await checked(state, chatGPTRequest<StatusValue>("status"))); }
 catch { return "other"; }
 if (controller.signal.reason === "all" || !chatGPTScopeCurrent(scope)) return "all";
 return !chatGPTBackgroundAllowed() ? "background" : "other";
}
const ACCOUNT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** A model Pi's catalog doesn't know yet: the account supplies its identity,
 * window, input and effort levels; the first Pi-known account model supplies
 * the transport shape (api, compat, input limits, output cap). */
function accountModel(entry: AccountModelEntry, template: Model<"openai-responses">): Model<"openai-responses"> | undefined {
 // Limits are never borrowed from another model: without the account's own
 // window and input list, the model stays unavailable.
 const window = entry.contextWindow;
 if (typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0 || !Array.isArray(entry.input)) return undefined;
 const input = (["text", "image"] as const).filter((modality) => (entry.input as unknown[]).includes(modality));
 if (!input.includes("text")) return undefined;
 const levels = Array.isArray(entry.reasoningLevels) ? ACCOUNT_EFFORTS.filter((effort) => (entry.reasoningLevels as unknown[]).includes(effort)) : [];
 return {
  ...template,
  id: entry.id,
  name: entry.name,
  input: [...input],
  contextWindow: window,
  reasoning: levels.length > 0,
  thinkingLevelMap: { off: null, minimal: null, ...Object.fromEntries(ACCOUNT_EFFORTS.map((effort) => [effort, levels.includes(effort) ? effort : null])) },
 };
}
/** Preserve account order. Pi-known models keep Pi's capabilities; others are
 * built by accountModel() when an account model Pi knows can serve as template. */
export async function refreshChatGPTModels(supported: Model<"openai-responses">[]): Promise<void> {
 const state = bridge();
 if (!runtimeConnected()) { clearCatalog(state); return; }
 const sequence = ++state.catalogRequest;
 try {
  const value = await checked(state, chatGPTRequest<ModelsValue>("models"));
  if (sequence !== state.catalogRequest || !validStamp(value)) return;
  acceptStatus(state, value);
  if (value.epoch !== state.stamp.epoch || value.authorityRevision !== state.stamp.authorityRevision || value.accountId !== state.status.activeId || !chatGPTConnected()) return;
  state.catalogAccount = value.accountId;
  const known = (entry: AccountModelEntry) => supported.find((m) => m.id === entry.id && m.api === "openai-responses");
  const template = value.models.map(known).find((m) => m !== undefined);
  state.models = value.models.flatMap((entry) => {
   const base = known(entry) ?? (template && accountModel(entry, template));
   return base ? [{ ...base, provider: "chatgpt", name: entry.name, headers: undefined, samplingParams: undefined, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] : [];
  });
 } catch { if (sequence === state.catalogRequest) clearCatalog(state); }
}
export function chatGPTAbortController(background = true): { controller: AbortController; release: () => void } {
 const state = bridge(); const controller = new AbortController(); state.controllers.set(controller, background);
 return { controller, release: () => { state.controllers.delete(controller); } };
}

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { createRequire } from "node:module";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { ChatGPTBackgroundAccess, ChatGPTConnection, ChatGPTUIProvider, CHATGPT_NOTICE, CHATGPT_DISCONNECT_COPY, CHATGPT_PASTE_COPY, chatGPTNotice, loopbackHost } from "../components/settings/chatgpt-connection.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { ModelControl } from "../components/model-picker.tsx";
import type { ChatGPTStatus, ChatGPTControlBridge } from "../src/core/index.ts";
import { completedWithin } from "./completion.ts";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { installModalDom } from "./modal-dom.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() {} } });
installModalDom(dom);
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const account = (id = "private-registration-id", email = "learner@example.invalid", connected = true) => ({ id, email, registration: "private-issued-client", connected, planEnabled: connected, canSignInAgain: !connected });
const disconnected = (allowBackgroundUse = true): ChatGPTStatus => ({ available: true, pending: false, allowBackgroundUse, activeId: null, accounts: [account("signed-out-record", "signed-out@example.invalid", false)], error: null });
const connected = (allowBackgroundUse = true): ChatGPTStatus => ({ ...disconnected(allowBackgroundUse), activeId: "private-registration-id", accounts: [account(), ...disconnected().accounts] });
const storageError = "ChatGPT credentials could not be read or saved. Check local file access, then reconnect before making requests.";
const warning = "Account disconnected locally. Remote revocation could not be confirmed.";
const errorReply = () => ({ error: storageError } as ChatGPTStatus);
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function fixture(initial = disconnected(), overrides: Partial<ChatGPTControlBridge> = {}) {
 let status = initial;
 const calls = { login: [] as (string | undefined)[], complete: [] as string[], cancel: 0, consent: [] as boolean[], disconnect: [] as string[], select: [] as string[], logout: 0 };
 const listeners = new Set<() => void>();
 function push(next: ChatGPTStatus) { status = next; for (const cb of listeners) cb(); }
 const bridge: ChatGPTControlBridge = {
  status: async () => status,
  login: async (id) => { calls.login.push(id); push({ ...status, pending: true, error: null }); return status; },
  cancel: async () => { calls.cancel++; push({ ...status, pending: false, error: null }); return status; },
  complete: async (url) => { calls.complete.push(url); push({ ...connected(status.allowBackgroundUse), pending: false }); return status; },
  select: async (id) => { calls.select.push(id); push({ ...status, activeId: id }); return status; },
  disconnect: async (id) => { calls.disconnect.push(id); push({ ...status, activeId: status.activeId === id ? null : status.activeId, accounts: status.accounts.filter((a) => a.id !== id) }); return status; },
  logout: async () => { calls.logout++; return status; },
  consent: async (enabled) => { calls.consent.push(enabled); push({ ...status, allowBackgroundUse: enabled }); return status; },
  onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }, ...overrides,
 };
 window.lh = { expandWindow() {}, chatgpt: bridge };
 return { calls, bridge, push, get status() { return status; }, complete() { push({ ...connected(status.allowBackgroundUse), pending: false }); } };
}
function recoveryController({ writeFails = false, tokens = "valid" }: { writeFails?: boolean; tokens?: "valid" | "missing" | "restricted" | "scope" | "expired" } = {}) {
 const require = createRequire(import.meta.url); const { createChatGPT, SCOPES } = require("../electron/chatgpt.cjs"); const { chatGPTControl } = require("../electron/chatgpt-ipc.cjs");
 const registration: any = { id: "fixture", clientId: "oaiapp_fixture", issuer: "https://auth.openai.com", subject: "fixture", email: "fixture@example.invalid", tokens: { accessToken: "fake-access", refreshToken: "fake-refresh", idToken: "fake-id", expiresAt: tokens === "expired" ? 0 : Date.now() + 3600000, scopes: tokens === "scope" ? ["openid"] : [...SCOPES] } };
 if (tokens === "missing") delete registration.tokens; if (tokens === "restricted") registration.reconnectRequired = true;
 let saved = { version: 1, hostId: "urn:uuid:offline-recovery", activeId: "fixture", allowBackgroundUse: true, registrations: [registration] };
 let browserAttempts = 0, tokenRequests = 0; const listeners = new Set<() => void>();
 const service = createChatGPT({ store: { read: async () => structuredClone(saved), write: async (next: typeof saved) => { if (writeFails) throw Object.assign(new Error("fake-storage-failure"), { code: "storage" }); saved = structuredClone(next); } }, openExternal: () => { browserAttempts++; throw new Error("No real browser"); }, fetch: async (url: string) => { tokenRequests++; assert.equal(tokens, "expired"); assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token"); return Response.json({ error: "invalid_grant" }, { status: 401 }); }, onChange: () => { for (const cb of listeners) cb(); } });
 window.lh = { expandWindow() {}, chatgpt: { status: () => chatGPTControl({ op: "status" }, service), consent: (enabled) => chatGPTControl({ op: "consent", enabled }, service), login: (id) => chatGPTControl({ op: "login", id }, service), cancel: () => chatGPTControl({ op: "cancel" }, service), complete: (url) => chatGPTControl({ op: "complete", url }, service), select: (id) => chatGPTControl({ op: "select", id }, service), disconnect: (id) => chatGPTControl({ op: "disconnect", id }, service), logout: (id) => chatGPTControl({ op: "logout", id }, service), onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); } } };
 return { service, get saved() { return saved; }, get browserAttempts() { return browserAttempts; }, get tokenRequests() { return tokenRequests; } };
}
async function mount(children: React.ReactNode = <ChatGPTConnection />) {
 host = document.createElement("div"); document.body.append(host); root = createRoot(host);
 await act(async () => root!.render(<InteractionLayersProvider><ChatGPTUIProvider>{children}</ChatGPTUIProvider></InteractionLayersProvider>));
}
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
async function click(element: HTMLElement) { assert(element); await act(async () => element.click()); }
function button(text: string, scope: ParentNode = document) { return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === text)!; }
const toggle = () => document.querySelector<HTMLElement>('[data-testid="chatgpt-account-dialog"] [role="switch"]')!;
async function selectAccount(label: string, id: string) {
 const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; assert(select);
 await act(async () => { Object.defineProperty(select, "value", { configurable: true, writable: true, value: id }); select.dispatchEvent(new window.Event("change", { bubbles: true })); });
}
async function begin() { await click(byTest("chatgpt-login")); await click(byTest("chatgpt-proceed")); }
async function confirmDisconnect() { await click(byTest("chatgpt-disconnect")); await click(byTest("chatgpt-confirm-disconnect")); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; delete window.lh; globalThis.fetch = originalFetch; });

test("Providers is the first/default page; General and Devices close the native group before Core/Community plugins", () => {
 const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
 const ids = [...html.matchAll(/data-testid="settings-nav-([^"]+)"/g)].map((m) => m[1]);
 assert.deepEqual(ids, ["keys", "agent", "appearance", "graph", "keyboard", "general", "devices", "core-plugins", "plugins"]);
 assert.match(html, /settings-nav-keys[^>]*aria-current="true"/);
 assert.equal(parseHTML(html).document.querySelector('[data-testid="settings-nav-keys"]')?.textContent, "Providers");
});

test("Providers has five ordered sections including External CLI; unknown variables stay masked/read-only at the end of Model API keys", async () => {
 globalThis.fetch = async (url) => {
  if (url === "/api/claude-code") return Response.json({ state: "not-found", version: null, minimumVersion: "2.1.259" });
  assert.equal(url, "/api/keys");
  return Response.json({ providers: [{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" }], keys: [{ id: "FUTURE_VAR", info: null, present: true, masked: "…abcd", source: "file", shadowedByEnv: false }] });
 };
 fixture(); await mount(<KeysSection />);
 const headings = [...document.querySelectorAll('[data-testid^="group-"] > p')].map((el) => el.textContent);
 assert.deepEqual(headings, ["Model API keys", "Subscriptions", "External CLI", "Dictation", "Search"]);
 assert(byTest("claude-code-installation").closest('[data-testid="group-external-cli"]'));
 assert(byTest("key-deepgram_api_key").closest('[data-testid="group-dictation"]'));
 assert(byTest("key-tavily_api_key").closest('[data-testid="group-search"]'));
 assert(byTest("key-brave_api_key").closest('[data-testid="group-search"]'));
 assert(byTest("key-exa_api_key").closest('[data-testid="group-search"]'));
 assert(byTest("key-firecrawl_api_key").closest('[data-testid="group-search"]'));
 assert(byTest("key-ollama_api_key").closest('[data-testid="group-search"]'));
 assert(!document.querySelector('[data-testid="key-ollama_base_url"]'));
 assert(byTest("unknown-FUTURE_VAR").closest('[data-testid="group-provider-keys"]'));
 assert(byTest("group-unknown-keys").parentElement?.lastElementChild === byTest("group-unknown-keys"));
 assert.equal(byTest("unknown-FUTURE_VAR").textContent, "FUTURE_VAR…abcd"); assert(!byTest("unknown-FUTURE_VAR").querySelector("input, button"));
});

test("disconnected row uses shared Connect action; initial default is ON; cancel discards draft without OAuth/global mutation", async () => {
 const f = fixture(); await mount(<ChatGPTConnection setup />);
 assert.equal(byTest("chatgpt-connection").textContent, "ChatGPTConnect");
 assert(!document.body.textContent?.includes(CHATGPT_NOTICE)); const trigger = byTest("chatgpt-login");
 assert.match(trigger.className, /cursor-pointer/); assert.match(trigger.className, /hover:bg-accent/); assert.match(trigger.className, /focus-visible:ring/);
 await click(trigger); assert.equal(f.calls.login.length, 0); assert(document.body.textContent?.includes(CHATGPT_NOTICE));
 assert.equal(byTest("chatgpt-account-dialog").querySelector("h2")?.textContent, "ChatGPT");
 assert.equal(byTest("chatgpt-proceed").textContent, "Continue with ChatGPT"); assert(byTest("chatgpt-proceed").querySelector('img[src="/siwc/chatgpt-logo-white.svg"]'));
 assert(!button("Continue", byTest("chatgpt-account-dialog")), "ChatGPT remains one step, with disclosure and toggle together");
 assert.equal(toggle().getAttribute("aria-checked"), "true");
 assert.equal(toggle().getAttribute("aria-label"), "Allow background use for all ChatGPT accounts");
 assert(byTest("chatgpt-global-background").textContent?.includes("Background work counts toward your ChatGPT plan usage."));
 await click(toggle());
 await click(button("Cancel", byTest("chatgpt-account-dialog")));
 assert.equal(f.calls.login.length, 0); assert.deepEqual(f.calls.consent, []); assert.equal(f.calls.cancel, 0);
 await click(byTest("chatgpt-login")); assert.equal(toggle().getAttribute("aria-checked"), "true");
});

for (const value of [true, false]) test(`untouched initial sign-in preserves existing global ${value} through verified completion`, async () => {
 const f = fixture(disconnected(value)); await mount(); await click(byTest("chatgpt-login"));
 assert.equal(toggle().getAttribute("aria-checked"), String(value)); await click(byTest("chatgpt-proceed"));
 assert(document.body.textContent?.includes("Waiting for browser sign-in")); assert.deepEqual(f.calls.consent, []);
 await act(async () => f.complete()); assert.deepEqual(f.calls.consent, []); assert.equal(f.status.allowBackgroundUse, value);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]')); assert(button("Manage…"));
});

for (const value of [true, false]) test(`explicit global draft ${!value} is applied only after actual pending/onChange verified completion`, async () => {
 const f = fixture(disconnected(value)); await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
 assert.deepEqual(f.calls.consent, []); assert((byTest("chatgpt-proceed") as HTMLButtonElement).disabled);
 await act(async () => f.complete()); assert.deepEqual(f.calls.consent, [!value]); assert.equal(f.status.allowBackgroundUse, !value);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 await act(async () => f.push(f.status)); assert.deepEqual(f.calls.consent, [!value]);
});

test("Cancel after initial IPC promise ends cancels actual OAuth; late completion cannot apply draft or close another dialog", async () => {
 const f = fixture(); await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
 await click(button("Cancel", byTest("chatgpt-account-dialog"))); assert.equal(f.calls.cancel, 1);
 await click(byTest("chatgpt-login")); const dialog = byTest("chatgpt-account-dialog");
 await act(async () => f.complete()); assert.deepEqual(f.calls.consent, []); assert(byTest("chatgpt-account-dialog") === dialog); assert.equal(f.calls.login.length, 1);
});

test("review: late cancel acknowledgement must not roll back newer global authority", async () => {
 const held = deferred<ChatGPTStatus>();
 const f = fixture(disconnected(true), { cancel: async () => { f.calls.cancel++; return held.promise; } });
 await mount(); await begin(); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await act(async () => f.push(disconnected(false)));
 await act(async () => held.resolve(disconnected(true)));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 assert.equal(f.status.allowBackgroundUse, false, "backend truth remains OFF");
 await click(byTest("chatgpt-login"));
 assert.equal(toggle().getAttribute("aria-checked"), "false", "new disclosure must use the newer authoritative global OFF, not the old cancellation snapshot");
});

test("late cancel acknowledgement cannot roll newer global ON back to OFF", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(disconnected(false), { cancel: () => held.promise });
 await mount(); await begin(); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await act(async () => f.push(disconnected(true))); await act(async () => held.resolve(disconnected(false)));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]')); assert.equal(f.status.allowBackgroundUse, true);
 await click(byTest("chatgpt-login")); assert.equal(toggle().getAttribute("aria-checked"), "true"); assert.deepEqual(f.calls.consent, []);
});

test("cancel reconciliation read is itself fenced when a newer status arrives before that read returns", async () => {
 const held = deferred<ChatGPTStatus>(), current = deferred<ChatGPTStatus>();
 const f = fixture(disconnected(), { cancel: () => held.promise }); let reads = 0;
 await mount(); await begin(); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await act(async () => f.push(disconnected(false)));
 f.bridge.status = () => { reads++; return current.promise; };
 await act(async () => held.resolve(disconnected(true))); assert.equal(reads, 1);
 f.bridge.status = async () => f.status;
 await act(async () => f.push(disconnected(true))); await act(async () => current.resolve(disconnected(false)));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 await click(byTest("chatgpt-login")); assert.equal(toggle().getAttribute("aria-checked"), "true"); assert.deepEqual(f.calls.consent, []);
});

test("late cancellation preserves newer availability and error instead of dismissing an unrelated failure", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(disconnected(), { cancel: () => held.promise });
 await mount(); await begin(); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await act(async () => f.push({ ...disconnected(false), available: false, error: storageError }));
 await act(async () => held.resolve(disconnected(true)));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError); assert((byTest("chatgpt-login") as HTMLButtonElement).disabled);
});

test("error-only cancellation reconciliation keeps last valid authority and leaves cancellation recoverable", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(disconnected(), { cancel: () => held.promise });
 await mount(); await begin(); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await act(async () => f.push(disconnected(false)));
 f.bridge.status = async () => errorReply(); await act(async () => held.resolve(disconnected(true)));
 assert(byTest("chatgpt-account-dialog")); assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError);
 assert.equal((button("Cancel", byTest("chatgpt-account-dialog")) as HTMLButtonElement).disabled, false);
 f.bridge.status = async () => f.status; f.bridge.cancel = async () => f.status;
 await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await click(byTest("chatgpt-login")); assert.equal(toggle().getAttribute("aria-checked"), "false"); assert.deepEqual(f.calls.consent, []);
});

test("email-only connected selector and Manage remain responsive; account selection never changes global OFF", async () => {
 const initial = connected(false); initial.accounts.push(account("second", "second@example.invalid"), account("missing", ""));
 const f = fixture(initial); await mount();
 assert.deepEqual([...document.querySelectorAll('select[aria-label="ChatGPT account"] option')].map((o) => o.textContent), ["learner@example.invalid", "second@example.invalid", "ChatGPT account"]);
 assert.doesNotMatch(byTest("chatgpt-connection").textContent!, /private-registration|private-issued| · active|signed-out/);
 assert.match(byTest("chatgpt-connection").firstElementChild!.className, /items-center/);
 const row = byTest("chatgpt-connection").firstElementChild!;
 assert.equal(row.children[0]!.textContent, "ChatGPT"); assert.equal(row.children[1]!.tagName, "SELECT"); assert.equal(row.children[2]!.textContent, "Manage…");
 assert.match(row.children[2]!.className, /text-muted-foreground/); assert(!row.textContent?.includes("Connected"));
 await selectAccount("ChatGPT account", "second"); assert.deepEqual(f.calls.select, ["second"]); assert.equal(f.status.allowBackgroundUse, false);
 await click(button("Manage…")); assert(byTest("chatgpt-managed-identity").textContent?.includes("second@example.invalid"));
 assert.deepEqual([...byTest("chatgpt-account-footer").querySelectorAll("button")].map((b) => b.textContent), ["Disconnect", "Close"]);
 const dialog = byTest("chatgpt-account-dialog").innerHTML;
 assert(dialog.indexOf('data-testid="chatgpt-managed-identity"') < dialog.indexOf('data-testid="chatgpt-account-actions"'));
 assert(dialog.indexOf('data-testid="chatgpt-global-background"') < dialog.indexOf('data-testid="chatgpt-managed-identity"'));
 assert(!byTest("chatgpt-account-dialog").querySelector('[data-testid="chatgpt-privacy-notice"]'));
 assert.equal(byTest("chatgpt-account-dialog").querySelector("h2")?.textContent, "ChatGPT");
 assert(byTest("chatgpt-account-dialog").querySelector('a[href="https://openai.com/policies/privacy-policy/"]'));
 assert(byTest("chatgpt-account-dialog").querySelector('a[href="https://chatgpt.com/settings/usage"]'));
 await click(toggle()); assert.deepEqual(f.calls.consent, [true]); assert.equal(toggle().getAttribute("aria-checked"), "true");
 await click(button("Close")); await selectAccount("ChatGPT account", "private-registration-id"); assert.equal(f.status.allowBackgroundUse, true);
 assert.equal(f.calls.logout, 0);
});

test("Disconnect is the quiet red left-footer action below identity; confirmation Cancel never forgets", async () => {
 assert.deepEqual(CHATGPT_DISCONNECT_COPY, { title: "Disconnect account?", body: "This removes the saved account and its credentials from this device." });
 const f = fixture(connected()); await mount(); await click(button("Manage…"));
 assert.equal(byTest("chatgpt-account-actions").textContent, "Disconnect"); assert.match(byTest("chatgpt-disconnect").className, /text-error/);
 assert.equal(byTest("chatgpt-account-footer").firstElementChild, byTest("chatgpt-account-actions"));
 assert.equal(byTest("chatgpt-account-footer").lastElementChild?.lastElementChild, button("Close"));
 assert(!byTest("chatgpt-account-footer").contains(byTest("chatgpt-add-accounts")));
 await click(byTest("chatgpt-disconnect")); assert.equal(f.calls.disconnect.length, 0);
 assert.equal(byTest("chatgpt-account-dialog").querySelector("h2")?.textContent, "ChatGPT");
 assert(byTest("chatgpt-disconnect-confirmation").textContent?.includes(CHATGPT_DISCONNECT_COPY.title));
 assert(byTest("chatgpt-disconnect-confirmation").textContent?.includes(CHATGPT_DISCONNECT_COPY.body));
 assert(!document.body.textContent?.includes("delete your OpenAI"));
 await click(button("Cancel", byTest("chatgpt-disconnect-confirmation"))); assert(byTest("chatgpt-disconnect")); assert.deepEqual(f.calls.disconnect, []);
 await click(button("Close")); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

for (const count of [1, 3]) test(`Add accounts reuses the actual add flow with ${count} saved accounts; opening and cancelling preserve the connection`, async () => {
 const initial = connected(count === 3);
 initial.accounts = [account(), ...Array.from({ length: count - 1 }, (_, i) => account(`saved-${i}`, `saved-${i}@example.invalid`))];
 const f = fixture(initial); const before = structuredClone(initial); await mount(); await click(button("Manage…"));
 assert.deepEqual([...byTest("chatgpt-account-footer").querySelectorAll("button")].map((b) => b.textContent), ["Disconnect", "Close"]);
 assert.equal(byTest("chatgpt-add-accounts").getAttribute("data-variant"), "ghost");
 assert.equal(byTest("chatgpt-add-accounts").parentElement, byTest("chatgpt-account-strip"));
 assert.match(byTest("chatgpt-add-accounts").className, /cursor-pointer/);
 await click(byTest("chatgpt-add-accounts"));
 assert(byTest("chatgpt-privacy-notice").textContent?.includes(CHATGPT_NOTICE)); assert(byTest("chatgpt-proceed"));
 assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Saved ChatGPT account"]')?.value, "");
 assert.equal(toggle().getAttribute("aria-checked"), String(before.allowBackgroundUse));
 assert.deepEqual(f.status, before); assert.deepEqual(f.calls.login, []); assert.deepEqual(f.calls.select, []); assert.deepEqual(f.calls.disconnect, []);
 await click(toggle()); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 assert.deepEqual(f.status, before); assert.deepEqual(f.calls.consent, []); assert.equal(f.calls.cancel, 0);
 await click(button("Manage…")); await click(byTest("chatgpt-add-accounts"));
 assert.equal(toggle().getAttribute("aria-checked"), String(before.allowBackgroundUse));
 await click(byTest("chatgpt-proceed")); assert.deepEqual(f.calls.login, [undefined], "existing login machinery receives no saved/current account ID");
 assert.equal(f.status.activeId, before.activeId); assert.deepEqual(f.status.accounts, before.accounts);
 await click(button("Cancel", byTest("chatgpt-account-dialog")));
 assert.deepEqual(f.status, before); assert.equal(f.calls.cancel, 1); assert.deepEqual(f.calls.consent, []); assert.deepEqual(f.calls.disconnect, []);
});

test("ChatGPT Sign in again is reserved for a saved disconnected account and keeps its existing registration flow", async () => {
 const f = fixture(connected(false)); await mount(); await click(button("Manage…"));
 assert(!button("Sign in again")); await selectAccount("Manage ChatGPT account", "signed-out-record"); assert(button("Sign in again"));
 await click(button("Sign in again")); assert.equal(byTest("chatgpt-account-dialog").querySelector("h2")?.textContent, "ChatGPT");
 assert(byTest("chatgpt-privacy-notice")); assert(toggle()); assert.equal(toggle().getAttribute("aria-checked"), "false");
 assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Saved ChatGPT account"]')?.value, "signed-out-record"); assert.deepEqual(f.calls.login, []);
 await click(byTest("chatgpt-proceed")); assert.deepEqual(f.calls.login, ["signed-out-record"]); assert.equal(f.status.activeId, "private-registration-id");
 await click(button("Cancel", byTest("chatgpt-account-dialog"))); assert.equal(f.calls.cancel, 1); assert.deepEqual(f.calls.disconnect, []); assert.deepEqual(f.calls.consent, []);
});
test("actual controller storage-write failure is not ChatGPT authorization recovery even while available stays true", async () => {
 const f = recoveryController({ writeFails: true });
 try {
  await mount(); await click(button("Manage…")); assert(!button("Sign in again")); await click(toggle());
  const status = await f.service.status(); assert.equal(status.available, true); assert.equal(status.pending, false); assert.equal(status.accounts[0].connected, false); assert.equal(status.accounts[0].planEnabled, false); assert.equal(status.error, storageError);
  assert(!button("Sign in again"), "a failed credential write must not offer reauthorization");
  assert.equal(status.accounts[0].canSignInAgain, false); assert.equal(f.browserAttempts, 0); assert.equal(f.tokenRequests, 0);
 } finally { await act(async () => f.service.close()); }
});
for (const tokens of ["missing", "restricted", "scope"] as const) test(`actual controller ${tokens} authorization permits recovery, but paused/closed state does not`, async () => {
 const f = recoveryController({ tokens });
 try {
  await mount(); await click(byTest("chatgpt-login")); await selectAccount("Saved ChatGPT account", "fixture"); await click(button("Manage…"));
  assert.equal((await f.service.status()).accounts[0].canSignInAgain, true); assert(button("Sign in again"));
  assert.equal(f.saved.registrations[0].canSignInAgain, undefined, "eligibility is projected, never persisted");
  await act(async () => f.service.pause()); assert.equal((await f.service.status()).accounts[0].canSignInAgain, false); assert(!button("Sign in again"));
  await act(async () => f.service.resume()); assert.equal((await f.service.status()).accounts[0].canSignInAgain, true); assert(button("Sign in again"));
  await act(async () => f.service.close()); assert.equal((await f.service.status()).accounts[0].canSignInAgain, false); assert(!button("Sign in again"));
  assert.equal(f.browserAttempts, 0); assert.equal(f.tokenRequests, 0);
 } finally { await act(async () => f.service.close()); }
});
test("storage denial overrides an otherwise eligible remembered ChatGPT authorization recovery", async () => {
 const f = recoveryController({ tokens: "missing", writeFails: true });
 try {
  await mount(); await click(byTest("chatgpt-login")); await selectAccount("Saved ChatGPT account", "fixture"); await click(button("Manage…")); assert(button("Sign in again"));
  await click(toggle()); const status = await f.service.status(); assert.equal(status.available, true); assert.equal(status.error, storageError); assert.equal(status.accounts[0].canSignInAgain, false); assert(!button("Sign in again"));
  assert.equal(f.browserAttempts, 0); assert.equal(f.tokenRequests, 0);
 } finally { await act(async () => f.service.close()); }
});
test("actual invalid_grant recovery preserves remembered identity and stages the existing registration flow", async () => {
 const f = recoveryController({ tokens: "expired" });
 try {
  await mount(); await click(button("Manage…")); assert.equal((await f.service.status()).accounts[0].canSignInAgain, false); assert(!button("Sign in again"));
  await act(async () => { await f.service.models(); });
  const status = await f.service.status(); assert.equal(status.available, true); assert.equal(status.accounts[0].connected, false); assert.equal(status.accounts[0].canSignInAgain, true);
  assert.equal(status.accounts[0].id, "fixture"); assert.equal(status.accounts[0].registration, "oaiapp_fixture"); assert.equal(f.saved.registrations[0].tokens, undefined);
  await click(button("Sign in again")); assert(byTest("chatgpt-privacy-notice")); assert(toggle()); assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Saved ChatGPT account"]')?.value, "fixture");
  assert.equal(f.tokenRequests, 1, "only the injected refresh response was requested"); assert.equal(f.browserAttempts, 0, "staging recovery never starts OAuth");
 } finally { await act(async () => f.service.close()); }
});
test("missing eligibility remains compatible but never implies authorization recovery; malformed eligibility is rejected", async () => {
 const initial = connected(); initial.accounts = [account()]; const f = fixture(initial); await mount(); await click(button("Manage…"));
 const legacy: ChatGPTStatus = { ...initial, accounts: initial.accounts.map(({ canSignInAgain: _ignored, ...a }) => ({ ...a, connected: false, planEnabled: false })) };
 await act(async () => f.push(legacy)); assert(!button("Sign in again")); assert(!document.querySelector('[role="alert"]'));
 for (const value of [null, "true", 1]) {
  await act(async () => f.push({ ...legacy, accounts: legacy.accounts.map((a) => ({ ...a, canSignInAgain: value })) } as unknown as ChatGPTStatus));
  assert(!button("Sign in again")); assert.equal(document.querySelector('[role="alert"]')?.textContent, "The ChatGPT connection could not be changed. Try again.");
 }
});
test("connected setup row retains the email dropdown before muted Manage", async () => {
 fixture(connected()); await mount(<ChatGPTConnection setup />);
 const row = byTest("chatgpt-connection").firstElementChild!; assert.equal(row.children[1]!.tagName, "SELECT"); assert.equal(row.children[2]!.textContent, "Manage…"); assert.match(row.children[2]!.className, /text-muted-foreground/);
});
test("Add accounts applies heading default focus for the pre-auth transition", async () => {
 const previous = HTMLElement.prototype.focus; const focused: HTMLElement[] = [];
 HTMLElement.prototype.focus = function () { focused.push(this); };
 try {
  fixture(connected()); await mount(); await click(button("Manage…")); await click(byTest("chatgpt-add-accounts"));
  assert(focused.at(-1) === byTest("chatgpt-account-dialog").querySelector("h2"));
 } finally { HTMLElement.prototype.focus = previous; }
});

test("Add accounts respects existing busy, pending and unavailable guards", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(connected(), { consent: () => held.promise });
 await mount(); await click(button("Manage…")); await click(toggle());
 assert((byTest("chatgpt-add-accounts") as HTMLButtonElement).disabled);
 await click(byTest("chatgpt-add-accounts")); assert(byTest("chatgpt-managed-identity")); assert(!document.querySelector('[data-testid="chatgpt-proceed"]'));
 await act(async () => held.resolve(f.status)); assert.equal((byTest("chatgpt-add-accounts") as HTMLButtonElement).disabled, false);
 await act(async () => f.push({ ...f.status, pending: true })); assert((byTest("chatgpt-add-accounts") as HTMLButtonElement).disabled);
 await act(async () => f.push({ ...f.status, pending: false, available: false })); assert((byTest("chatgpt-add-accounts") as HTMLButtonElement).disabled);
 assert.deepEqual(f.calls.login, []);
});

test("confirmed disconnect preserves identity/pending content until outcome, prevents duplicate clicks, then closes without selecting another account", async () => {
 const done = deferred<ChatGPTStatus>();
 const f = fixture(connected(false), { disconnect: (id) => { f.calls.disconnect.push(id); return done.promise; } });
 await mount(); await click(button("Manage…")); await confirmDisconnect();
 await click(byTest("chatgpt-confirm-disconnect")); assert.deepEqual(f.calls.disconnect, ["private-registration-id"]);
 const final = { ...disconnected(false), accounts: [account("other", "other@example.invalid")] };
 await act(async () => f.push(final));
 assert(byTest("chatgpt-disconnect-confirmation").textContent?.includes("learner@example.invalid"));
 assert((byTest("chatgpt-confirm-disconnect") as HTMLButtonElement).disabled); assert.equal(byTest("chatgpt-account-dialog").getAttribute("aria-busy"), "true");
 await act(async () => done.resolve(final));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]')); assert(byTest("chatgpt-login")); assert.equal(f.status.activeId, null);
 assert.equal(f.status.allowBackgroundUse, false); assert.equal(f.calls.logout, 0);
});

test("signed-out legacy accounts remain manageable/forgettable without pretending selection is a usable connection", async () => {
 const f = fixture(); await mount(); assert.equal(byTest("chatgpt-connection").textContent, "ChatGPTConnect");
 await click(byTest("chatgpt-login")); await selectAccount("Saved ChatGPT account", "signed-out-record"); await click(button("Manage…"));
 assert(byTest("chatgpt-managed-identity").textContent?.includes("signed-out@example.invalid"));
 assert.deepEqual(f.calls.select, []); assert.equal(f.calls.login.length, 0); await confirmDisconnect();
 assert.deepEqual(f.calls.disconnect, ["signed-out-record"]); assert.equal(f.status.accounts.length, 0); assert.equal(f.status.allowBackgroundUse, true);
});

test("unconfirmed provider outcome is exactly the approved concise dismissible warning, never permanent red success/navigation advice", async () => {
 const f = fixture(connected(), { disconnect: async () => { const result = { ...disconnected(), accounts: [], error: warning }; f.push(result); return result; } });
 await mount(); await click(button("Manage…")); await confirmDisconnect();
 const alert = byTest("chatgpt-revocation-warning"); assert.equal(alert.textContent, warning); assert.doesNotMatch(alert.className, /text-error/);
 assert(!document.querySelector('[data-testid="chatgpt-disconnect"]')); assert(byTest("chatgpt-login"));
 await click(button("Dismiss", byTest("chatgpt-account-dialog"))); assert(!document.querySelector('[role="alert"]'));
 assert(!document.body.textContent?.includes("ChatGPT Settings"));
});

test("dismissed revocation warning stays dismissed across global setting changes but a new unconfirmed disconnect is shown", async () => {
 const initial = connected(); initial.error = warning;
 const f = fixture(initial, { disconnect: async () => { const next = { ...disconnected(false), accounts: [], error: warning }; f.push(next); return next; } });
 await mount(); await click(button("Dismiss")); await click(button("Manage…")); await click(toggle());
 assert.equal(toggle().getAttribute("aria-checked"), "false"); assert(!document.querySelector('[role="alert"]'));
 await confirmDisconnect(); assert.equal(byTest("chatgpt-revocation-warning").textContent, warning);
});

test("contextual Enable action opens the same global control without silently enabling; no foreground/provider clutter", async () => {
 const f = fixture(connected(false)); await mount(<><ChatGPTBackgroundAccess provider="chatgpt" /><ChatGPTBackgroundAccess provider="openai" /><ChatGPTConnection /></>);
 assert.equal([...document.querySelectorAll("button")].filter((b) => b.textContent === "Enable background use").length, 1);
 await click(button("Enable background use")); assert.deepEqual(f.calls.consent, []);
 assert.equal(toggle().getAttribute("aria-checked"), "false"); await click(toggle()); assert.deepEqual(f.calls.consent, [true]); assert(!button("Enable background use"));
 await act(async () => f.push(disconnected(false))); assert(!button("Enable background use"));
});

test("error-only disconnect reply preserves coherent status/confirmation and permits explicit retry, not false forgotten/connected success", async () => {
 const f = fixture(connected(), { disconnect: async () => errorReply() }); await mount(); await click(button("Manage…"));
 await assert.doesNotReject(confirmDisconnect); assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError);
 assert.equal((byTest("chatgpt-confirm-disconnect") as HTMLButtonElement).disabled, false); assert(byTest("chatgpt-disconnect-confirmation"));
 f.bridge.disconnect = async () => { const next = { ...disconnected(), accounts: [] }; f.push(next); return next; };
 await click(byTest("chatgpt-confirm-disconnect")); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]')); assert(byTest("chatgpt-login"));
});

for (const value of [true, false]) test(`global toggle keeps its normal cursor while saving ${!value}, without accepting duplicate clicks`, async () => {
 const held = deferred<ChatGPTStatus>();
 const f = fixture(connected(value), { consent: (enabled) => { f.calls.consent.push(enabled); return held.promise; } });
 await mount(); await click(button("Manage…")); await click(toggle());
 await act(async () => f.push(connected(!value)));
 assert((toggle() as HTMLButtonElement).disabled);
 assert(byTest("chatgpt-global-background").className.includes("[&>button:disabled]:cursor-auto"));
 assert.equal(toggle().getAttribute("aria-checked"), String(!value));
 await click(toggle()); assert.deepEqual(f.calls.consent, [!value]);
 await act(async () => held.resolve(connected(!value)));
 assert.equal((toggle() as HTMLButtonElement).disabled, false);
 assert(!byTest("chatgpt-global-background").className.includes("cursor-auto"));
});

test("global toggle retains the unavailable cursor if secure availability is lost during a save", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(connected(), { consent: () => held.promise });
 await mount(); await click(button("Manage…")); await click(toggle());
 const denied = connected(false); denied.available = false; denied.error = storageError;
 denied.accounts = denied.accounts.map((a) => ({ ...a, connected: false, planEnabled: false }));
 await act(async () => f.push(denied));
 assert((toggle() as HTMLButtonElement).disabled); assert.match(toggle().className, /cursor-not-allowed/);
 assert(!byTest("chatgpt-global-background").className.includes("cursor-auto"));
 await act(async () => held.resolve(connected(false)));
 assert((toggle() as HTMLButtonElement).disabled); assert(!byTest("chatgpt-global-background").className.includes("cursor-auto"));
});

test("error-only global consent reply keeps saved state visible and a recoverable error", async () => {
 fixture(connected(), { consent: async () => errorReply() }); await mount(); await click(button("Manage…"));
 await assert.doesNotReject(() => click(toggle())); assert.equal(toggle().getAttribute("aria-checked"), "true"); assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError);
 assert.equal((toggle() as HTMLButtonElement).disabled, false);
});

test("error-only login reply releases its operation without corrupting status or auto-retrying", async () => {
 let calls = 0; fixture(disconnected(), { login: async () => { calls++; return errorReply(); } }); await mount(); await assert.doesNotReject(begin);
 assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError); assert.equal((byTest("chatgpt-proceed") as HTMLButtonElement).disabled, false); assert.equal(calls, 1);
});

test("error-only initial global draft save leaves disclosure/error and duplicate completion cannot retry the setting", async () => {
 let calls = 0; const f = fixture(disconnected(), { consent: async () => { calls++; return errorReply(); } });
 await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed")); await act(async () => f.complete());
 assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError); assert(byTest("chatgpt-account-dialog"));
 await act(async () => f.push(f.status)); assert.equal(calls, 1); assert.equal(f.calls.login.length, 1);
});

test("error-only pending cancellation remains retryable and cannot apply a global draft", async () => {
 const f = fixture(disconnected(), { cancel: async () => { f.calls.cancel++; return errorReply(); } });
 await mount(); await begin(); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError); assert(byTest("chatgpt-account-dialog"));
 f.bridge.cancel = async () => { f.calls.cancel++; const next = { ...f.status, pending: false }; f.push(next); return next; };
 await click(button("Cancel", byTest("chatgpt-account-dialog"))); assert.equal(f.calls.cancel, 2); assert.deepEqual(f.calls.consent, []);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

test("failed pending verification never applies draft/starts login/closes disclosure on a later clean status", async () => {
 const f = fixture(); await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
 await act(async () => f.push({ ...connected(), error: "ChatGPT sign-in could not be verified." }));
 await act(async () => f.push(connected())); assert.deepEqual(f.calls.consent, []); assert.equal(f.calls.login.length, 1); assert(byTest("chatgpt-account-dialog"));
});

test("saved-registration mismatch cannot complete the attempt or apply its global draft", async () => {
 const f = fixture(); await mount(); await click(byTest("chatgpt-login")); await selectAccount("Saved ChatGPT account", "signed-out-record");
 await click(toggle()); await click(byTest("chatgpt-proceed")); await act(async () => f.complete());
 assert.deepEqual(f.calls.consent, []); assert.deepEqual(f.calls.login, ["signed-out-record"]); assert(document.querySelector('[role="alert"]')); assert(byTest("chatgpt-account-dialog"));
});

test("account invalidation while initial global consent awaits IPC fences stale reply and preserves an unrelated later dialog", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(disconnected(), { consent: () => held.promise });
 await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed")); await act(async () => f.complete());
 const other = { ...connected(), activeId: "other", accounts: [account("other", "other@example.invalid")] }; await act(async () => f.push(other));
 await click(button("Cancel", byTest("chatgpt-account-dialog"))); await click(button("Manage…")); const dialog = byTest("chatgpt-account-dialog");
 await act(async () => held.resolve(connected(false))); assert(byTest("chatgpt-account-dialog") === dialog);
 assert(dialog.textContent?.includes("other@example.invalid")); assert.equal(toggle().getAttribute("aria-checked"), "true");
});

test("late global-control reply cannot overwrite a newer authoritative global value or leave control stuck", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(connected(), { consent: () => held.promise });
 await mount(); await click(button("Manage…")); await click(toggle());
 await act(async () => { f.push(connected(false)); f.push(connected(true)); });
 await act(async () => held.resolve(connected(false)));
 assert.equal(toggle().getAttribute("aria-checked"), "true"); assert.equal((toggle() as HTMLButtonElement).disabled, false);
 await click(button("Close")); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

test("late initial global draft reply cannot resurrect an older global value after a newer authoritative setting", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(disconnected(), { consent: () => held.promise });
 await mount(<><ChatGPTConnection /><ChatGPTBackgroundAccess provider="chatgpt" /></>);
 await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed")); await act(async () => f.complete());
 await act(async () => { f.push(connected(false)); f.push(connected(true)); });
 await act(async () => held.resolve(connected(false)));
 assert(!button("Enable background use")); assert(document.querySelector('[role="alert"]')); assert.equal((byTest("chatgpt-proceed") as HTMLButtonElement).disabled, false);
});

test("coalesced verified completion before late pending acknowledgement is reconciled once from fresh status", async () => {
 const ack = deferred<ChatGPTStatus>(); const f = fixture(disconnected(), { login: () => { f.calls.login.push(undefined); return ack.promise; } });
 await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
 await act(async () => f.complete()); assert.deepEqual(f.calls.consent, []);
 await act(async () => ack.resolve({ ...disconnected(), pending: true })); assert.deepEqual(f.calls.consent, [false]); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

test("canceled attempt's late reply cannot release a newer pending attempt or apply its old draft", async () => {
 const old = deferred<ChatGPTStatus>(); const f = fixture(disconnected(), { login: async () => { f.calls.login.push(undefined); if (f.calls.login.length === 1) return old.promise; f.push({ ...f.status, pending: true }); return f.status; } });
 await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
 await click(button("Cancel", byTest("chatgpt-account-dialog"))); await begin(); await act(async () => old.resolve(connected(false)));
 assert((byTest("chatgpt-proceed") as HTMLButtonElement).disabled); assert.deepEqual(f.calls.consent, []);
 await act(async () => f.complete()); assert.deepEqual(f.calls.consent, []); assert.equal(f.status.allowBackgroundUse, true); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

for (const holdSave of [false, true]) test(`real main/control bridge: immediate pending, actual cancellation, verified callback, then explicit global draft persistence${holdSave ? " (completion held beyond old wait budget)" : ""}`, async () => {
 const require = createRequire(import.meta.url); const { createChatGPT, SCOPES } = require("../electron/chatgpt.cjs"); const { chatGPTControl } = require("../electron/chatgpt-ipc.cjs");
 const { privateKey, publicKey } = await generateKeyPair("RS256"); const jwk = { ...await exportJWK(publicKey), kid: "ui-fixture", alg: "RS256", use: "sig" };
 const consentCompleted = deferred<ChatGPTStatus>(), saveEntered = deferred<void>(), releaseSave = deferred<void>();
 let saved: any = null, authorize!: URL, tokenCalls = 0, completionArmed = false; const listeners = new Set<() => void>();
 const service = createChatGPT({ store: { secure() {}, async read() { return saved; }, async write(s: any) {
  if (holdSave && s.allowBackgroundUse === false) { saveEntered.resolve(); await releaseSave.promise; }
  saved = structuredClone(s);
 } }, openExternal: async (url: string) => { authorize = new URL(url); }, onChange: ({ status }: { status: ChatGPTStatus }) => {
  if (completionArmed && !status.pending && status.error) consentCompleted.reject(new Error(`Fixture sign-in failed: ${status.error}`));
  for (const cb of listeners) cb();
 }, fetch: async (url: string, init: RequestInit) => {
  if (url.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
  assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token"); tokenCalls++;
  const form = init.body as URLSearchParams;
  const jwt = await new SignJWT({ nonce: authorize.searchParams.get("nonce"), email: "fixture@example.invalid" }).setProtectedHeader({ alg: "RS256", kid: "ui-fixture" }).setIssuer("https://auth.openai.com").setSubject("fixture-subject").setAudience(form.get("client_id")!).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: jwt, token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") });
 } });
 window.lh = { expandWindow() {}, chatgpt: { status: () => chatGPTControl({ op: "status" }, service), login: (id) => chatGPTControl({ op: "login", id }, service), cancel: () => chatGPTControl({ op: "cancel" }, service), complete: (url) => chatGPTControl({ op: "complete", url }, service), select: (id) => chatGPTControl({ op: "select", id }, service), disconnect: (id) => chatGPTControl({ op: "disconnect", id }, service), logout: (id) => chatGPTControl({ op: "logout", id }, service), consent: (enabled) => {
  const reply = chatGPTControl({ op: "consent", enabled }, service);
  void reply.then(consentCompleted.resolve, consentCompleted.reject);
  return reply;
 }, onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); } } };
 try {
  await mount(); await begin(); assert.equal((await service.status()).pending, true); await click(button("Cancel", byTest("chatgpt-account-dialog"))); assert.equal((await service.status()).pending, false); assert.equal(tokenCalls, 0);
  await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
  const callback = new URL(authorize.searchParams.get("redirect_uri")!); callback.search = new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "fixture-code", client_id: "oaiapp_ui_fixture" }).toString();
  await act(async () => {
   completionArmed = true;
   // Callback acknowledgment is not verified login, nor is login completion
   // the subsequent consent save. Wait for the actual control reply.
   const waiting = completedWithin(consentCompleted.promise, "verified sign-in and global draft persistence");
   let settled = false; void waiting.then(() => { settled = true; }, () => { settled = true; });
   const response = await originalFetch(callback); assert.equal(response.status, 200); await response.text();
   if (holdSave) {
    await completedWithin(saveEntered.promise, "held global draft save");
    // Regression only: the OLD loop returns with the save still held.
    for (let i = 0; i < 100 && (saved.allowBackgroundUse !== false || (await service.status()).pending); i++) await new Promise((r) => setImmediate(r));
    assert.equal((await service.status()).pending, false, "verification finished before the consent save");
    assert.equal(saved.allowBackgroundUse, undefined, "the old assertion would run before the global draft was saved");
    assert.equal(settled, false, "the corrected wait must still await persistence");
    releaseSave.resolve();
   }
   const status = await waiting;
   assert.equal(status.error, null); assert.equal(status.pending, false);
   assert.equal(status.allowBackgroundUse, false); assert.equal(status.accounts[0]!.connected, true);
  });
  assert.equal(tokenCalls, 1); assert.equal(saved.allowBackgroundUse, false); assert.equal(saved.registrations[0].background, undefined);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]')); assert(button("Manage…"));
 } finally { releaseSave.resolve(); await act(async () => service.close()); }
});

test("browser-only sign-in is disabled; foreground toolbar has no plan badge or background action", async () => {
 await mount(); assert((byTest("chatgpt-login") as HTMLButtonElement).disabled); await click(byTest("chatgpt-login")); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 await act(async () => root!.unmount()); host?.remove(); root = undefined;
 globalThis.fetch = async (input) => {
  if (input === "/api/models") return Response.json({ models: [], providers: [], slots: {}, defaults: {} });
  if (input === "/api/settings") return Response.json({ settings: { models: { strong: { model: { provider: "chatgpt", id: "gpt-5" } } } } });
  throw new Error(`unexpected fixture request ${input}`);
 };
 fixture(connected(false)); await mount(<ModelControl />); assert.match(byTest("stats-model").textContent!, /gpt/i);
 assert(!document.body.textContent?.includes("Using ChatGPT plan")); assert(!document.body.textContent?.includes("Enable background use"));
});

// Paste-back (docs/specs/chatgpt-remote-signin.md).
// React loads before this DOM exists, so its legacy input fallback reads the focused field on keyup.
async function typeInto(input: HTMLInputElement, value: string) {
 const view = window as unknown as { getSelection?: () => unknown }, original = view.getSelection;
 view.getSelection = () => ({ anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 });
 try { await act(async () => { input.focus(); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new window.Event("keyup", { bubbles: true })); }); }
 finally { view.getSelection = original; }
}
async function submitPaste() { await act(async () => { byTest("chatgpt-paste").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); }); }
const pasteField = () => document.querySelector<HTMLInputElement>(`input[aria-label="${CHATGPT_PASTE_COPY.label}"]`)!;
const wrongAddress = "This address does not belong to the current ChatGPT sign-in. Copy the full address from the sign-in tab and try again.";

test("loopback host rule decides only where paste-back starts open", () => {
 for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.8.9.10", "[::1]", "LOCALHOST"]) assert.equal(loopbackHost(host), true, host);
 for (const host of ["100.64.0.5", "192.168.1.10", "desktop.tail1234.ts.net", "localhost.example.com", "127.0.0.1.nip.io", "", "[::2]"]) assert.equal(loopbackHost(host), false, host);
 assert.equal(chatGPTNotice(true), CHATGPT_NOTICE.replace("on this device", "on the machine running LearnHarness"));
 assert(!chatGPTNotice(true).includes("same machine"));
});

test("desktop sign-in folds paste-back; a wrong address keeps the attempt pending and a right one completes", async () => {
 let reject = true;
 const f = fixture(disconnected(), { complete: async (url) => { f.calls.complete.push(url); if (reject) return { error: wrongAddress } as unknown as ChatGPTStatus; f.complete(); return f.status; } });
 await mount();
 assert(!document.querySelector('[data-testid="chatgpt-paste-reveal"]'), "no paste control before sign-in starts");
 await begin();
 assert(document.body.textContent?.includes("Waiting for browser sign-in"));
 assert.equal(byTest("chatgpt-paste-reveal").textContent, CHATGPT_PASTE_COPY.reveal);
 assert(!document.querySelector('[data-testid="chatgpt-paste"]'));
 await click(byTest("chatgpt-paste-reveal"));
 assert(byTest("chatgpt-paste").textContent?.includes(CHATGPT_PASTE_COPY.remote));
 const field = pasteField();
 assert.equal(field.getAttribute("type"), "text", "plain text: no password-manager save prompt"); assert.equal(field.getAttribute("autocomplete"), "off");
 assert.equal((byTest("chatgpt-paste-submit") as HTMLButtonElement).disabled, true);
 await typeInto(field, "http://127.0.0.1:1/auth/callback?state=wrong&code=x");
 assert.equal((byTest("chatgpt-paste-submit") as HTMLButtonElement).disabled, false);
 await submitPaste();
 assert.deepEqual(f.calls.complete, ["http://127.0.0.1:1/auth/callback?state=wrong&code=x"]);
 assert.equal(byTest("chatgpt-paste").querySelector('[role="alert"]')?.textContent, wrongAddress);
 assert(document.body.textContent?.includes("Waiting for browser sign-in"), "a refused paste leaves sign-in pending");
 assert.equal(pasteField().value, "http://127.0.0.1:1/auth/callback?state=wrong&code=x", "the field keeps its text to fix");
 reject = false;
 await submitPaste();
 assert.equal(f.calls.complete.length, 2);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'), "verified paste completes like the redirect");
 assert(button("Manage…"));
});

test("web sign-in from another device shows paste-back open and finishes over the existing subscriptions route", async () => {
 const original = Object.getOwnPropertyDescriptor(window, "location");
 Object.defineProperty(window, "location", { configurable: true, value: { hostname: "100.64.0.5" } });
 const originalOpen = window.open;
 const tab = { opener: {}, closed: false, location: { href: "" }, close() { this.closed = true; } };
 (window as unknown as { open: () => unknown }).open = () => tab;
 let status: ChatGPTStatus = disconnected();
 const posts: Record<string, unknown>[] = [];
 globalThis.fetch = async (input, init) => {
  assert.equal(input, "/api/subscriptions");
  if (!init?.method) return Response.json({ chatgpt: status, native: [] });
  const body = JSON.parse(String(init.body)); posts.push(body);
  assert.equal(new Headers(init.headers).get("x-learnharness-subscriptions"), "1");
  if (body.op === "login") { status = { ...status, pending: true }; return Response.json({ value: status, browserAction: "/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000000" }); }
  if (body.op === "complete") { status = connected(); return Response.json({ value: status }); }
  throw new Error(`unexpected op ${body.op}`);
 };
 try {
  await mount(); await begin();
  assert.equal(tab.location.href, "/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000000");
  assert(!document.querySelector('[data-testid="chatgpt-paste-reveal"]'));
  assert(byTest("chatgpt-paste").textContent?.includes(CHATGPT_PASTE_COPY.remote));
  await typeInto(pasteField(), " http://127.0.0.1:5555/auth/callback?state=s&code=c ");
  await submitPaste();
  assert.deepEqual(posts.at(-1), { providerId: "chatgpt", op: "complete", url: " http://127.0.0.1:5555/auth/callback?state=s&code=c " });
  assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
  assert(button("Manage…"));
 } finally {
  if (original) Object.defineProperty(window, "location", original); else delete (window as unknown as { location?: unknown }).location;
  window.open = originalOpen;
 }
});

test("a paste-completed sign-in applies the background-use draft like the redirect does", async () => {
 const f = fixture(disconnected(true)); await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
 await click(byTest("chatgpt-paste-reveal")); await typeInto(pasteField(), "http://127.0.0.1:1/auth/callback?state=s&code=c"); await submitPaste();
 assert.deepEqual(f.calls.consent, [false]); assert.equal(f.status.allowBackgroundUse, false);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

test("after a reload, Connect reopens a pending sign-in with paste-back and a working Cancel", async () => {
 const pending = { ...disconnected(), pending: true };
 const f = fixture(pending); await mount();
 assert.equal((byTest("chatgpt-login") as HTMLButtonElement).disabled, false, "a page that did not start the sign-in can still reach it");
 await click(byTest("chatgpt-login"));
 assert(document.body.textContent?.includes("Waiting for browser sign-in"));
 assert.equal((byTest("chatgpt-proceed") as HTMLButtonElement).disabled, true, "no second sign-in while one is pending");
 await click(byTest("chatgpt-paste-reveal")); assert(byTest("chatgpt-paste"));
 await click(button("Cancel", byTest("chatgpt-account-dialog")));
 assert.equal(f.calls.cancel, 1); assert.equal(f.calls.login.length, 0);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 await act(async () => root!.unmount()); host?.remove(); root = undefined;
 const g = fixture(pending); await mount();
 await click(byTest("chatgpt-login")); await click(byTest("chatgpt-paste-reveal"));
 await typeInto(pasteField(), "http://127.0.0.1:1/auth/callback?state=s&code=c"); await submitPaste();
 assert.equal(g.calls.complete.length, 1);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'), "an adopted sign-in completes and closes");
 assert(button("Manage…"));
});

test("web page on a loopback host folds paste-back", async () => {
 const original = Object.getOwnPropertyDescriptor(window, "location");
 Object.defineProperty(window, "location", { configurable: true, value: { hostname: "127.0.0.1" } });
 const originalOpen = window.open;
 (window as unknown as { open: () => unknown }).open = () => ({ opener: {}, closed: false, location: { href: "" }, close() {} });
 let status: ChatGPTStatus = disconnected();
 globalThis.fetch = async (_input, init) => {
  if (!init?.method) return Response.json({ chatgpt: status, native: [] });
  status = { ...status, pending: true };
  return Response.json({ value: status, browserAction: "/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000000" });
 };
 try {
  await mount(); await begin();
  assert(document.body.textContent?.includes("Waiting for browser sign-in"));
  assert.equal(byTest("chatgpt-paste-reveal").textContent, CHATGPT_PASTE_COPY.reveal);
  assert(!document.querySelector('[data-testid="chatgpt-paste"]'));
 } finally {
  if (original) Object.defineProperty(window, "location", original); else delete (window as unknown as { location?: unknown }).location;
  window.open = originalOpen;
 }
});

// Polish (docs/specs/chatgpt-signin-polish.md).
function withClipboard(readText: (() => Promise<string>) | undefined, secure: boolean) {
 const view = window as unknown as { isSecureContext?: boolean }, hadSecure = Object.getOwnPropertyDescriptor(view, "isSecureContext");
 const hadClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
 Object.defineProperty(view, "isSecureContext", { configurable: true, value: secure });
 Object.defineProperty(navigator, "clipboard", { configurable: true, value: readText ? { readText } : undefined });
 return () => {
  if (hadSecure) Object.defineProperty(view, "isSecureContext", hadSecure); else delete view.isSecureContext;
  if (hadClipboard) Object.defineProperty(navigator, "clipboard", hadClipboard); else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
 };
}
/** The web bridge over a fake /api/subscriptions, on a page at `hostname`. */
function webPage(hostname: string) {
 const original = Object.getOwnPropertyDescriptor(window, "location"), originalOpen = window.open;
 Object.defineProperty(window, "location", { configurable: true, value: { hostname } });
 (window as unknown as { open: () => unknown }).open = () => ({ opener: {}, closed: false, location: { href: "" }, close() {} });
 let status: ChatGPTStatus = disconnected();
 const ops: { op: string; url?: string }[] = [];
 globalThis.fetch = async (_input, init) => {
  if (!init?.method) return Response.json({ chatgpt: status, native: [] });
  const body = JSON.parse(String(init.body)); ops.push({ op: body.op, url: body.url });
  if (body.op === "login") { status = { ...status, pending: true }; return Response.json({ value: status, browserAction: "/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000000" }); }
  if (body.op === "cancel") { status = { ...status, pending: false }; return Response.json({ value: status }); }
  status = connected(); return Response.json({ value: status });
 };
 return { ops, restore() { if (original) Object.defineProperty(window, "location", original); else delete (window as unknown as { location?: unknown }).location; window.open = originalOpen; } };
}
async function remount() { await act(async () => root!.unmount()); host?.remove(); root = undefined; }
const pasteButton = () => document.querySelector<HTMLButtonElement>('[data-testid="chatgpt-paste-clipboard"]');

test("another device is told up front that the last page won't load; loopback and desktop are not", async () => {
 let page = webPage("100.64.0.5");
 try {
  await mount(); await click(byTest("chatgpt-login"));
  assert(byTest("chatgpt-privacy-notice").textContent?.includes("on the machine running LearnHarness"));
  assert.equal(byTest("chatgpt-remote-ahead").textContent, CHATGPT_PASTE_COPY.ahead);
  await click(byTest("chatgpt-proceed"));
  assert(document.body.textContent?.includes("Waiting for browser sign-in"));
  assert(!document.querySelector('[data-testid="chatgpt-remote-ahead"]'));
  assert(byTest("chatgpt-paste"), "the open paste panel takes over once pending");
 } finally { page.restore(); }
 await remount();
 page = webPage("127.0.0.1");
 try {
  await mount(); await click(byTest("chatgpt-login"));
  assert(byTest("chatgpt-privacy-notice").textContent?.includes("on the machine running LearnHarness"), "the web dialog opened");
  assert(!document.querySelector('[data-testid="chatgpt-remote-ahead"]'), "loopback page");
 } finally { page.restore(); }
 await remount();
 fixture(); await mount(); await click(byTest("chatgpt-login"));
 assert.equal(byTest("chatgpt-privacy-notice").textContent, CHATGPT_NOTICE, "the desktop dialog opened");
 assert(!document.querySelector('[data-testid="chatgpt-remote-ahead"]'), "desktop app");
});

test("Paste appears only in the web app with a secure context and the clipboard API", async () => {
 for (const [secure, api] of [[false, true], [true, false]] as const) {
  const restore = withClipboard(api ? async () => "x" : undefined, secure); const page = webPage("100.64.0.5");
  try { await mount(); await begin(); assert(byTest("chatgpt-paste")); assert(!pasteButton(), `secure=${secure} api=${api}`); assert(pasteField(), "manual paste stays"); }
  finally { page.restore(); restore(); await remount(); }
 }
 const restore = withClipboard(async () => "x", true);
 try {
  fixture(); await mount(); await begin(); await click(byTest("chatgpt-paste-reveal"));
  assert(!pasteButton(), "the desktop window never grants clipboard reads");
 } finally { restore(); }
});

test("web Paste fills the trimmed address without submitting; an empty clipboard leaves the field", async () => {
 let clipboard = "  http://127.0.0.1:1/auth/callback?state=s&code=c\n";
 const restore = withClipboard(async () => clipboard, true); const page = webPage("100.64.0.5");
 try {
  await mount(); await begin();
  assert.equal(pasteButton()!.textContent, CHATGPT_PASTE_COPY.clipboard);
  assert.equal(pasteButton()!.getAttribute("aria-label"), CHATGPT_PASTE_COPY.clipboardLabel);
  await click(pasteButton()!);
  assert.equal(pasteField().value, "http://127.0.0.1:1/auth/callback?state=s&code=c");
  assert(!page.ops.some((o) => o.op === "complete"), "Paste does not submit");
  clipboard = "   ";
  await click(pasteButton()!);
  assert.equal(pasteField().value, "http://127.0.0.1:1/auth/callback?state=s&code=c", "empty clipboard changes nothing");
  await submitPaste();
  assert.deepEqual(page.ops.at(-1), { op: "complete", url: "http://127.0.0.1:1/auth/callback?state=s&code=c" });
  assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 } finally { page.restore(); restore(); }
});

test("a refused read disables Paste, announces the fallback, focuses the field; manual paste completes; a new attempt resets", async () => {
 const restore = withClipboard(async () => { throw new Error("NotAllowedError"); }, true); const page = webPage("100.64.0.5");
 try {
  await mount(); await begin();
  await click(pasteButton()!);
  assert.equal(pasteButton()!.disabled, true);
  assert.equal(byTest("chatgpt-clipboard-denied").getAttribute("role"), "status");
  assert.equal(byTest("chatgpt-clipboard-denied").textContent, CHATGPT_PASTE_COPY.clipboardDenied);
  assert.equal(document.activeElement, pasteField(), "focus moves to the field the note points to");
  await click(button("Cancel", byTest("chatgpt-account-dialog")));
  await begin();
  assert.equal(pasteButton()!.disabled, false, "a new attempt allows Paste again");
  assert(!document.querySelector('[data-testid="chatgpt-clipboard-denied"]'));
  await typeInto(pasteField(), "http://127.0.0.1:1/auth/callback?state=s&code=c"); await submitPaste();
  assert.equal(page.ops.filter((o) => o.op === "complete").length, 1);
  assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 } finally { page.restore(); restore(); }
});

test("a slow read never overwrites typing and never reaches a later attempt; one read at a time", async () => {
 let reads = 0; let release!: (text: string) => void;
 const restore = withClipboard(() => { reads++; return new Promise<string>((resolve) => { release = resolve; }); }, true); const page = webPage("100.64.0.5");
 try {
  await mount(); await begin();
  await click(pasteButton()!);
  assert.equal(pasteButton()!.disabled, true, "disabled while a read is in flight");
  await click(pasteButton()!); assert.equal(reads, 1);
  await typeInto(pasteField(), "typed by hand");
  await act(async () => release("http://127.0.0.1:1/auth/callback?state=late&code=c"));
  assert.equal(pasteField().value, "typed by hand", "typing wins over a late read");
  assert.equal(pasteButton()!.disabled, false);
  await click(pasteButton()!);
  await click(button("Cancel", byTest("chatgpt-account-dialog")));
  await begin();
  await act(async () => release("http://127.0.0.1:1/auth/callback?state=old&code=c"));
  assert.equal(pasteField().value, "", "a read from an ended attempt changes nothing");
 } finally { page.restore(); restore(); }
});

test("Settings in the desktop app's window onto a server signs in through the desktop bridge, without paste-back", async () => {
 const page = webPage("desktop.tail1234.ts.net");
 const calls: (string | undefined)[] = [];
 let finish!: (result: { ok: true } | { error: string }) => void;
 window.lh = { chatgptSignIn: { start: (accountId?: string) => { calls.push(accountId); return new Promise((resolve) => { finish = resolve; }); }, cancel: async () => ({ ok: true, ended: false }) } };
 window.open = () => assert.fail("no sign-in tab in the desktop app");
 try {
  await mount(); await click(byTest("chatgpt-login"));
  assert(byTest("chatgpt-privacy-notice").textContent?.includes("on the machine running LearnHarness"), "credentials still live on the server");
  assert(!document.querySelector('[data-testid="chatgpt-remote-ahead"]'), "no paste-back warning: the callback reaches this computer");
  await click(byTest("chatgpt-proceed"));
  assert.deepEqual(calls, [undefined], "one click starts the desktop's sign-in");
  assert.deepEqual(page.ops, [], "the page doesn't start the server's login itself");
  assert(!document.querySelector('[data-testid="chatgpt-paste"]'));
  await act(async () => finish({ error: "ChatGPT sign-in ended. Try again." }));
  assert.equal(document.querySelector('[data-testid="chatgpt-account-dialog"] [role="alert"]')?.textContent, "ChatGPT sign-in ended. Try again.");
 } finally { page.restore(); }
});

/** Mounts with a server-events source the test can fire "subscriptions-changed" on. */
async function mountWithEvents() {
 let changed = () => {};
 const source: NotifySource = { onEvent: (name, cb) => { if (name === "subscriptions-changed") changed = () => cb("{}"); }, onOpen() {}, close() {} };
 host = document.createElement("div"); document.body.append(host); root = createRoot(host);
 await act(async () => root!.render(<InteractionLayersProvider><ServerEventsProvider connect={() => source}><ChatGPTUIProvider><ChatGPTConnection /></ChatGPTUIProvider></ServerEventsProvider></InteractionLayersProvider>));
 return { fire: () => act(async () => { changed(); await new Promise((resolve) => setTimeout(resolve, 0)); }) };
}

test("paste-back is hidden only while this page's own desktop sign-in runs; it returns once that ends", async () => {
 const page = webPage("desktop.tail1234.ts.net");
 let pending = false;
 globalThis.fetch = async (_input, init) => {
  if (init?.method) { page.ops.push({ op: JSON.parse(String(init.body)).op }); return Response.json({ value: { ...disconnected(), pending } }); }
  return Response.json({ chatgpt: { ...disconnected(), pending }, native: [] });
 };
 let finish!: (result: { ok: true } | { error: string }) => void;
 const cancels: string[] = [];
 window.lh = { chatgptSignIn: {
  start: () => new Promise((resolve) => { finish = resolve; }),
  cancel: async () => { cancels.push("desktop"); finish({ error: "ChatGPT sign-in ended. Try again." }); return { ok: true, ended: true }; },
 } };
 try {
  const events = await mountWithEvents();
  await click(byTest("chatgpt-login")); await click(byTest("chatgpt-proceed"));
  pending = true; await events.fire();
  assert(document.body.textContent?.includes("Waiting for browser sign-in"));
  assert(!document.querySelector('[data-testid="chatgpt-paste-reveal"]'), "no paste-back while the bridge's own attempt runs");
  assert(!document.querySelector('[data-testid="chatgpt-paste"]'));
  // The desktop's attempt fails while another device's sign-in waits on the server: the open
  // dialog shows why, and paste-back for that attempt, at once.
  await act(async () => { finish({ error: "Couldn’t reserve the local ChatGPT callback port." }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(document.querySelector('[data-testid="chatgpt-account-dialog"] [role="alert"]')?.textContent, "Couldn’t reserve the local ChatGPT callback port.");
  assert.equal(byTest("chatgpt-paste-reveal").textContent, CHATGPT_PASTE_COPY.reveal, "no reopening Settings needed");
  await click(byTest("chatgpt-paste-reveal")); assert(byTest("chatgpt-paste"));
 } finally { page.restore(); }
});

test("a sign-in adopted from another device keeps paste-back in the desktop app, and Cancel there cancels it on the server", async () => {
 const page = webPage("desktop.tail1234.ts.net");
 const cancels: string[] = [];
 window.lh = { chatgptSignIn: { start: async () => ({ ok: true }), cancel: async () => { cancels.push("desktop"); return { ok: true, ended: false }; } } };
 const ops: string[] = [];
 globalThis.fetch = async (_input, init) => {
  if (init?.method) { ops.push(JSON.parse(String(init.body)).op); return Response.json({ value: disconnected() }); }
  return Response.json({ chatgpt: { ...disconnected(), pending: true }, native: [] });
 };
 try {
  await mount(); await click(byTest("chatgpt-login"));
  assert(document.body.textContent?.includes("Waiting for browser sign-in"));
  assert.equal(byTest("chatgpt-paste-reveal").textContent, CHATGPT_PASTE_COPY.reveal, "the phone's attempt can be finished here");
  await click(byTest("chatgpt-paste-reveal")); assert(byTest("chatgpt-paste"));
  await click(button("Cancel", byTest("chatgpt-account-dialog")));
  assert.deepEqual(cancels, ["desktop"]);
  assert.deepEqual(ops, ["cancel"], "the desktop had none of its own, so the page cancels the adopted one");
 } finally { page.restore(); }
});

test("Cancel of this page's desktop sign-in, with another device's sign-in now pending, takes that one up: paste-back, no error", async () => {
 const page = webPage("desktop.tail1234.ts.net");
 let pending = false;
 const ops: string[] = [];
 globalThis.fetch = async (_input, init) => {
  if (init?.method) { ops.push(JSON.parse(String(init.body)).op); return Response.json({ value: { ...disconnected(), pending } }); }
  return Response.json({ chatgpt: { ...disconnected(), pending }, native: [] });
 };
 let finish!: (result: { ok: true } | { error: string }) => void;
 window.lh = { chatgptSignIn: {
  start: () => new Promise((resolve) => { finish = resolve; }),
  // The desktop ends its own attempt (scoped); meanwhile a phone started one, so the server still waits.
  cancel: async () => { finish({ error: "ChatGPT sign-in ended. Try again." }); pending = true; return { ok: true, ended: true }; },
 } };
 try {
  const events = await mountWithEvents();
  await click(byTest("chatgpt-login")); await click(byTest("chatgpt-proceed"));
  pending = true; await events.fire();
  assert(!document.querySelector('[data-testid="chatgpt-paste-reveal"]'));
  await click(button("Cancel", byTest("chatgpt-account-dialog")));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(ops, [], "no unscoped cancel of the phone's sign-in");
  assert(byTest("chatgpt-account-dialog"), "the dialog stays for the pending sign-in");
  assert.equal(document.querySelector('[data-testid="chatgpt-account-dialog"] [role="alert"]'), null, "no error for a cancel the user asked for");
  assert(document.body.textContent?.includes("Waiting for browser sign-in"));
  assert.equal(byTest("chatgpt-paste-reveal").textContent, CHATGPT_PASTE_COPY.reveal, "paste-back for the phone's attempt at once");
 } finally { page.restore(); }
});

test("in the desktop app Connect alone starts the sign-in; a browser still asks for Continue first", async () => {
 let page = webPage("desktop.tail1234.ts.net");
 let pending = false;
 globalThis.fetch = async (_input, init) => {
  if (init?.method) { page.ops.push({ op: JSON.parse(String(init.body)).op }); return Response.json({ value: { ...disconnected(), pending } }); }
  return Response.json({ chatgpt: { ...disconnected(), pending }, native: [] });
 };
 const started: (string | undefined)[] = [];
 let finish!: (result: { ok: true } | { error: string }) => void;
 window.lh = { chatgptSignIn: { start: (accountId?: string) => { started.push(accountId); return new Promise((resolve) => { finish = resolve; }); }, cancel: async () => ({ ok: true, ended: true }) } };
 window.open = () => assert.fail("no tab in the desktop app");
 try {
  const events = await mountWithEvents();
  await click(byTest("chatgpt-login"));
  assert.deepEqual(started, [undefined], "one click: no Continue step");
  assert.deepEqual(page.ops, [], "the server's login comes from the desktop, not the page");
  assert(byTest("chatgpt-account-dialog"), "the dialog shows the attempt");
  pending = true; await events.fire();
  assert(document.body.textContent?.includes("Waiting for browser sign-in"));
  assert(button("Cancel", byTest("chatgpt-account-dialog")), "Cancel stays");
  pending = false;
  await act(async () => { finish({ error: "Couldn’t reserve the local ChatGPT callback port." }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(document.querySelector('[data-testid="chatgpt-account-dialog"] [role="alert"]')?.textContent, "Couldn’t reserve the local ChatGPT callback port.", "the same failure handling");
 } finally { page.restore(); }
 await remount();
 delete window.lh;
 page = webPage("100.64.0.5");
 try {
  await mount(); await click(byTest("chatgpt-login"));
  assert.equal(page.ops.length, 0, "a browser opens the dialog and waits");
  assert(byTest("chatgpt-remote-ahead"), "with its paste-back warning");
  await click(byTest("chatgpt-proceed"));
  assert.deepEqual(page.ops.map((op) => op.op), ["login"]);
  assert(byTest("chatgpt-paste"), "and paste-back once pending");
 } finally { page.restore(); }
});

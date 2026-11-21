/*
 * The ONLY bridges the desktop app's window onto a self-hosted server gets
 * (docs/specs/desktop-server-list.md), each answered only for this window's
 * main frame at the selected origin:
 * - desktopUpdate: this app's own update, five methods, no arguments. The page
 *   can't name a version, URL or file (electron/update-everything-ipc.cjs), and
 *   main asks in its own native dialog before install() (Update everything) or
 *   installApp() (Settings' This app Install, only this app) changes anything.
 * - chatgptSignIn: start() runs this desktop's verified ChatGPT sign-in for this
 *   window's server and resolves { ok: true } or { error }; its one optional
 *   argument is a saved-account id the server issued. cancel() ends it
 *   (electron/remote-chatgpt-ipc.cjs).
 * Nothing else of the local preload (filesystem, providers, zoom, appearance) is exposed here.
 */
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "lh:desktop-update";
const SIGN_IN = "lh:chatgpt-sign-in";

// The ghost dashboard paints in this window's own page first (file:). It gets nothing.
if (location.protocol === "https:") {
	contextBridge.exposeInMainWorld("lh", Object.freeze({
		desktopUpdate: Object.freeze({
			getStatus: () => ipcRenderer.invoke(CHANNEL, "status"),
			check: () => ipcRenderer.invoke(CHANNEL, "check"),
			download: () => ipcRenderer.invoke(CHANNEL, "download"),
			install: () => ipcRenderer.invoke(CHANNEL, "install"),
			installApp: () => ipcRenderer.invoke(CHANNEL, "install-app"),
		}),
		chatgptSignIn: Object.freeze({
			start: (accountId) => (accountId === undefined ? ipcRenderer.invoke(SIGN_IN, "start") : ipcRenderer.invoke(SIGN_IN, "start", accountId)),
			cancel: () => ipcRenderer.invoke(SIGN_IN, "cancel"),
		}),
	}));
}

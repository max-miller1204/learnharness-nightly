/*
 * The ONLY bridges the desktop app's window onto a self-hosted server gets
 * (docs/specs/desktop-server-list.md), each answered only for this window's
 * main frame at the selected origin:
 * - desktopUpdate: this app's own update. The page can't name a version, URL or
 *   file (electron/update-everything-ipc.cjs checks every argument). install()
 *   with no choice and installApp() (Settings' This app Install, only this app)
 *   make main ask in its own native dialog first. plan() gives the page's own
 *   Update everything dialog its rows, and install({ planId }) starts exactly that
 *   plan, once; it and the capsule's retry() go out only during a real click or
 *   key press (the page's script can't fake one). later(), dismiss() and
 *   takeResult() take nothing.
 * - chatgptSignIn: start() runs this desktop's verified ChatGPT sign-in for this
 *   window's server and resolves { ok: true } or { error }; its one optional
 *   argument is a saved-account id the server issued. cancel() ends it
 *   (electron/remote-chatgpt-ipc.cjs).
 * Nothing else of the local preload (filesystem, providers, zoom, appearance) is exposed here.
 */
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "lh:desktop-update";
const SIGN_IN = "lh:chatgpt-sign-in";

// A user's click or key press within the last few seconds, as the browser tracks it.
const userActed = () => globalThis.navigator?.userActivation?.isActive === true;
const needsClick = () => Promise.reject(new Error("Update everything starts only from a click."));

// The ghost dashboard paints in this window's own page first (file:). It gets nothing.
if (location.protocol === "https:") {
	contextBridge.exposeInMainWorld("lh", Object.freeze({
		desktopUpdate: Object.freeze({
			getStatus: () => ipcRenderer.invoke(CHANNEL, "status"),
			check: () => ipcRenderer.invoke(CHANNEL, "check"),
			download: () => ipcRenderer.invoke(CHANNEL, "download"),
			install: (choice) => {
				if (choice === undefined) return ipcRenderer.invoke(CHANNEL, "install");
				if (!userActed()) return needsClick();
				// Only the id goes on, as a string, never the page's own object.
				const planId = typeof choice === "object" && choice !== null && typeof choice.planId === "string" ? choice.planId : "";
				return ipcRenderer.invoke(CHANNEL, "install", { planId });
			},
			installApp: () => ipcRenderer.invoke(CHANNEL, "install-app"),
			plan: () => ipcRenderer.invoke(CHANNEL, "plan"),
			later: () => ipcRenderer.invoke(CHANNEL, "later"),
			retry: () => (userActed() ? ipcRenderer.invoke(CHANNEL, "retry") : needsClick()),
			dismiss: () => ipcRenderer.invoke(CHANNEL, "dismiss"),
			takeResult: () => ipcRenderer.invoke(CHANNEL, "take-result"),
		}),
		chatgptSignIn: Object.freeze({
			start: (accountId) => (accountId === undefined ? ipcRenderer.invoke(SIGN_IN, "start") : ipcRenderer.invoke(SIGN_IN, "start", accountId)),
			cancel: () => ipcRenderer.invoke(SIGN_IN, "cancel"),
		}),
	}));
}

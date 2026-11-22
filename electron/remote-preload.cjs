/*
 * The ONLY bridges the desktop app's window onto a self-hosted server gets
 * (docs/specs/desktop-server-list.md), each answered only for this window's
 * main frame at the selected origin:
 * - desktopUpdate: this app's own update, every method with no argument. The
 *   page can't name a version, URL or file (electron/update-everything-ipc.cjs
 *   refuses any argument), and it can't start a run: install() (an older page)
 *   and installApp() (Settings' This app Install) make main ask in its own
 *   native dialog, and everything() and retry() make main show its own Update
 *   everything dialog (electron/update-everything-dialog.cjs), a surface over
 *   this window that the page can't script. Only that dialog's Update starts a
 *   run. Asking at all needs a real click or key press in the page, so a script
 *   can't keep putting the dialog up (main also refuses a repeat ask just after
 *   a Cancel). ready() tells main the capsule shows what it waits on; later(),
 *   dismiss() and takeResult() act on the run and its result toast.
 * - chatgptSignIn: start() runs this desktop's verified ChatGPT sign-in for this
 *   window's server and resolves { ok: true } or { error }; its one optional
 *   argument is a saved-account id the server issued. cancel() ends it
 *   (electron/remote-chatgpt-ipc.cjs).
 * Nothing else of the local preload (filesystem, providers, zoom, appearance) is exposed here.
 */
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "lh:desktop-update";
const SIGN_IN = "lh:chatgpt-sign-in";

// Asking main for a dialog needs the user's own click or key press in the page, within the last
// few seconds as the browser tracks it: a script alone can't.
const asked = (action) => (globalThis.navigator?.userActivation?.isActive === true
	? ipcRenderer.invoke(CHANNEL, action)
	: Promise.reject(new Error("Update everything opens only from a click.")));

// The ghost dashboard paints in this window's own page first (file:). It gets nothing.
if (location.protocol === "https:") {
	contextBridge.exposeInMainWorld("lh", Object.freeze({
		desktopUpdate: Object.freeze({
			getStatus: () => ipcRenderer.invoke(CHANNEL, "status"),
			check: () => ipcRenderer.invoke(CHANNEL, "check"),
			download: () => ipcRenderer.invoke(CHANNEL, "download"),
			install: () => asked("install"),
			installApp: () => ipcRenderer.invoke(CHANNEL, "install-app"),
			everything: () => asked("everything"),
			ready: () => ipcRenderer.invoke(CHANNEL, "ready"),
			later: () => ipcRenderer.invoke(CHANNEL, "later"),
			retry: () => asked("retry"),
			dismiss: () => ipcRenderer.invoke(CHANNEL, "dismiss"),
			takeResult: () => ipcRenderer.invoke(CHANNEL, "take-result"),
		}),
		chatgptSignIn: Object.freeze({
			start: (accountId) => (accountId === undefined ? ipcRenderer.invoke(SIGN_IN, "start") : ipcRenderer.invoke(SIGN_IN, "start", accountId)),
			cancel: () => ipcRenderer.invoke(SIGN_IN, "cancel"),
		}),
	}));
}

/*
 * The ONLY bridge the desktop app's window onto a self-hosted server gets
 * (roadmap item 23 PR 2, docs/specs/desktop-server-list.md): this app's own
 * update, four methods, no arguments. The page can't name a version, URL or
 * file. Main answers only this window's main frame at the selected origin
 * (electron/update-everything-ipc.cjs) and asks in its own native dialog
 * before install() changes anything. Nothing else of the local preload
 * (filesystem, providers, zoom, appearance) is exposed here.
 */
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "lh:desktop-update";

// The ghost dashboard paints in this window's own page first (file:). It gets nothing.
if (location.protocol === "https:") {
	contextBridge.exposeInMainWorld("lh", Object.freeze({
		desktopUpdate: Object.freeze({
			getStatus: () => ipcRenderer.invoke(CHANNEL, "status"),
			check: () => ipcRenderer.invoke(CHANNEL, "check"),
			download: () => ipcRenderer.invoke(CHANNEL, "download"),
			install: () => ipcRenderer.invoke(CHANNEL, "install"),
		}),
	}));
}

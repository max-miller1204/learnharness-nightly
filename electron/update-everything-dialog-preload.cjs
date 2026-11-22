"use strict";

// Main's own Update everything dialog (update-everything-dialog.cjs): its plan, and its answer.
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "lh:update-everything-dialog";
if (process.isMainFrame) {
	contextBridge.exposeInMainWorld("updateEverything", Object.freeze({
		plan: () => ipcRenderer.invoke(CHANNEL, "plan"),
		update: () => ipcRenderer.invoke(CHANNEL, "update"),
		cancel: () => ipcRenderer.invoke(CHANNEL, "cancel"),
	}));
}

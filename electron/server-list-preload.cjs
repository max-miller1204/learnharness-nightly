"use strict";

const { contextBridge, ipcRenderer } = require("electron");
if (process.isMainFrame) {
	contextBridge.exposeInMainWorld("servers", {
		state: () => ipcRenderer.invoke("lh:server-list", "state"),
		reset: () => ipcRenderer.invoke("lh:server-list", "reset"),
		parseLink: (text) => ipcRenderer.invoke("lh:server-list", "link", text),
		connect: (server) => ipcRenderer.invoke("lh:server-list", "connect", server),
		pair: (origin, code) => ipcRenderer.invoke("lh:server-list", "pair", { origin, code }),
		setDefault: (server) => ipcRenderer.invoke("lh:server-list", "default", server),
		remove: (server) => ipcRenderer.invoke("lh:server-list", "remove", server),
		onChange: (listener) => {
			ipcRenderer.on("lh:server-list:changed", (_event, state) => listener(state));
		},
	});
}

"use strict";

// Opt-in first-frame diagnostics for packaged runs: LH_DEBUG_FIRST_FRAME=1.
// Times are milliseconds since process start.
const enabled = process.env.LH_DEBUG_FIRST_FRAME === "1";
let sink = (line) => console.log(line);

function setTraceSink(write) { sink = write; }

function trace(event, detail) {
	if (!enabled) return;
	try { sink(`first-frame ${Math.round(performance.now())}ms ${event}${detail ? ` ${detail}` : ""}`); } catch { /* best effort */ }
}

/** Log a window's native show and the frames its own page produces. */
function traceWindow(win, name) {
	if (!enabled) return;
	trace("window created", name);
	win.on("show", () => trace("native show event", name));
	win.once("ready-to-show", () => trace("ready-to-show", name));
	win.webContents.on("did-finish-load", () => trace("own page did-finish-load", `${name} ${win.webContents.getURL().split("?")[0].split("/").pop()}`));
}

module.exports = { enabled, trace, traceWindow, setTraceSink };

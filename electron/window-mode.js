"use strict";
// Main passes the app theme's mode: a dark theme can run on a light OS.
document.documentElement.dataset.mode = new URLSearchParams(location.search).get("mode") === "light" ? "light" : "dark";

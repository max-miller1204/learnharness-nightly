"use strict";

const query = new URLSearchParams(location.search);
document.getElementById("status").textContent = query.get("status") ?? "";
if (["inset", "hidden"].includes(query.get("frame"))) document.documentElement.dataset.frame = query.get("frame");

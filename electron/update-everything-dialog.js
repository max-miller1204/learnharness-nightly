"use strict";

/*
 * Main's own Update everything dialog (update-everything-dialog.cjs), ported from T3 Code's
 * apps/web/src/components/sidebar/UpdateEverythingDialog.tsx at df09ced7 (MIT, Copyright (c)
 * 2026 T3 Tools Inc.): the "Update N machines?" title (:136-140), the version line (:142-158),
 * the Machine, LearnHarness and Providers table (:168-223), the skipped list (:224-245), the
 * running-work line (:249-273) and Cancel focused first (:79-82, :274-279). Differences:
 * - "This app" is the table's last row (owner, docs/specs/desktop-server-list.md), with T3's
 *   "restarts last"; T3 lists this app's machines first (updateEverything.logic.ts:891-898).
 * - LearnHarness has no provider updates, so that column is empty.
 * - An app-only update shows no running work (owner, revision PR 3: no "Running now:" list).
 * Main plans every row; this page only shows them and answers. All text goes in as text.
 */

const api = window.updateEverything;
const $ = (id) => document.getElementById(id);

const plural = (count, one, other) => `${count} ${count === 1 ? one : other}`;

function cell(text, className) {
	const span = document.createElement("span");
	span.setAttribute("role", "cell");
	if (className) span.className = className;
	if (text) span.textContent = text;
	return span;
}

function render(plan) {
	$("title").textContent = `Update ${plural(plan.rows.length, "machine", "machines")}?`;
	const version = $("version");
	version.textContent = "LearnHarness ";
	const code = document.createElement("code");
	code.textContent = plan.version;
	version.append(code);
	const table = $("table");
	for (const row of plan.rows) {
		const line = document.createElement("div");
		line.className = "row";
		line.setAttribute("role", "row");
		line.dataset.app = row.app;
		const machine = cell(row.label, "machine");
		machine.title = row.label;
		const app = cell(row.app === "this-app" ? "This app" : "Server");
		if (row.app === "this-app") {
			const note = document.createElement("span");
			note.className = "note";
			note.textContent = "restarts last";
			app.append(note);
		}
		const running = cell("", "running");
		if (row.running > 0) running.textContent = `${row.running} running`;
		line.append(machine, app, cell(""), running);
		table.append(line);
	}
	if (plan.skipped.length > 0) {
		$("skipped-section").hidden = false;
		$("skipped-toggle").textContent = `${plan.skipped.length} skipped`;
		const list = $("skipped");
		for (const row of plan.skipped) {
			const name = document.createElement("span");
			name.textContent = row.label;
			const reason = document.createElement("span");
			reason.className = "reason";
			reason.textContent = row.reason;
			list.append(name, reason);
		}
	}
	const warning = $("warning");
	const text = plan.disabledReason ?? (plan.running > 0 ? `${plural(plan.running, "running task", "running tasks")} will be interrupted.` : null);
	warning.hidden = !text;
	warning.textContent = text ?? "";
	warning.classList.toggle("blocking", !!plan.disabledReason);
	$("update").disabled = true;
	$("dialog").hidden = false;
	$("cancel").focus();
	setTimeout(() => {
		armed = true;
		$("update").disabled = !!plan.disabledReason;
	}, ARM_MS);
}

let answered = false;
// Update counts only after this, as main's own check (UPDATE_ARM_MS): a click the page lured to
// where Update appears isn't an answer.
const ARM_MS = 500;
let armed = false;
function answer(update) {
	if (answered || (update && !armed)) return;
	answered = true;
	void (update ? api.update() : api.cancel());
}

$("cancel").addEventListener("click", () => answer(false));
$("update").addEventListener("click", () => { if (!$("update").disabled) answer(true); });
$("skipped-toggle").addEventListener("click", () => {
	const toggle = $("skipped-toggle");
	const open = toggle.getAttribute("aria-expanded") !== "true";
	toggle.setAttribute("aria-expanded", String(open));
	$("skipped").hidden = !open;
});

// The dialog keeps focus: Tab and Shift+Tab cycle its buttons, Escape is Cancel, and Enter or
// Space presses the focused button (T3's AlertDialog).
document.addEventListener("keydown", (event) => {
	if (event.isComposing) return;
	if (event.key === "Escape") {
		event.preventDefault();
		answer(false);
		return;
	}
	// A shortcut with Meta, Ctrl or Alt is not the dialog's.
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	const buttons = [...document.querySelectorAll("#dialog button")].filter((button) => !button.disabled && !button.closest("[hidden]"));
	if (event.key === "Tab") {
		event.preventDefault();
		if (buttons.length === 0) return;
		const at = buttons.indexOf(document.activeElement);
		// From outside the buttons, Tab goes to the first and Shift+Tab to the last.
		const next = at < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
		buttons[next].focus();
		return;
	}
	if ((event.key === "Enter" || event.key === " ") && buttons.includes(document.activeElement)) {
		event.preventDefault();
		document.activeElement.click();
	}
});

void api.plan().then((plan) => {
	if (plan && Array.isArray(plan.rows) && plan.rows.length > 0 && typeof plan.version === "string") render(plan);
	else answer(false);
}, () => answer(false));

/**
 * Update everything in the window onto a server (docs/specs/t3-style-updates.md, revision
 * PR 7): the ported capsule and toast logic, the dialog and the capsule. No Electron: the
 * run is main's (tests/update-everything.test.ts); these get its reports as data.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { installModalDom } from "./modal-dom.ts";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import {
	describeUpdateCapsule, formatUpdateElapsed, getUpdateEverythingToastView, readUpdateEverythingPlan, readUpdateEverythingResult,
	readUpdateEverythingRun, UPDATE_SLOW_AFTER_MS, type UpdateEverythingPlan, type UpdateEverythingRun,
} from "../components/update-everything-logic.ts";
import { UpdateEverythingDialog } from "../components/update-everything-dialog.tsx";
import { SidebarUpdateCapsule } from "../components/sidebar-update-capsule.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent });
const restoreModalDom = installModalDom(dom);
after(restoreModalDom);
const roots: { root: Root; host: HTMLElement }[] = [];
afterEach(async () => {
	for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
	document.body.innerHTML = "";
});
async function mount(element: React.ReactElement) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => { root.render(<InteractionLayersProvider>{element}</InteractionLayersProvider>); });
	return host;
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`);
const press = async (target: Element | null, key: string, init: KeyboardEventInit = {}) => {
	assert.ok(target, `missing key target for ${key}`);
	// linkedom has no KeyboardEvent: a plain event carrying the key fields the handlers read.
	const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...init });
	await act(async () => { target.dispatchEvent(event); });
};
const click = async (target: HTMLElement | null) => {
	assert.ok(target, "missing click target");
	await act(async () => { target.click(); });
};

const V72 = "0.6.1-nightly.20261118.72";
const NOW = 1_800_000_000_000;
const run = (over: Partial<UpdateEverythingRun> = {}): UpdateEverythingRun => ({
	phase: "servers", localVersion: V72, restartAt: null,
	machines: [{ label: "max-desktop", status: "downloading", startedAt: NOW - 30_000, failure: null }],
	...over,
});
const machine = (over: Partial<UpdateEverythingRun["machines"][number]>) => ({ label: "max-desktop", status: "downloading" as const, startedAt: NOW - 30_000, failure: null, ...over });

describe("the capsule's words (T3's describeUpdateCapsule, updateEverything.logic.ts:553-625)", () => {
	it("N of M updated while a server runs, then Downloading NN% for this app", () => {
		assert.deepEqual(describeUpdateCapsule(run(), null, NOW), { tone: "default", label: "0 of 1 updated", action: null });
		assert.equal(describeUpdateCapsule(run({ machines: [machine({ status: "waiting" })] }), null, NOW).label, "0 of 1 updated", "a waiting server counts");
		const done = run({ machines: [machine({ status: "done" })] });
		assert.equal(describeUpdateCapsule(done, { status: "downloading", percent: 42.7 }, NOW).label, "Downloading 42%");
		assert.equal(describeUpdateCapsule(run({ machines: [] }), { status: "downloading", percent: null }, NOW).label, "Downloading");
		assert.equal(describeUpdateCapsule(done, { status: "waiting" }, NOW).label, "1 of 1 updated");
	});
	it("<machine> failed with Retry", () => {
		const view = describeUpdateCapsule(run({ localVersion: null, machines: [machine({ status: "failed", failure: "went back" })] }), null, NOW);
		assert.deepEqual(view, { tone: "failed", label: "max-desktop failed", action: "retry" });
		assert.equal(describeUpdateCapsule(run({ machines: [machine({ status: "failed", label: "a" }), machine({ status: "failed", label: "b" })] }), null, NOW).label, "2 failed");
	});
	it("Restart in Ns with Later, then Restarting…", () => {
		assert.deepEqual(describeUpdateCapsule(run({ phase: "countdown", restartAt: NOW + 4_200 }), null, NOW), { tone: "default", label: "Restart in 5s", action: "later" });
		assert.equal(describeUpdateCapsule(run({ phase: "countdown", restartAt: NOW - 50 }), null, NOW).label, "Restart in 0s");
		assert.deepEqual(describeUpdateCapsule(run({ phase: "installing" }), null, NOW), { tone: "default", label: "Restarting…", action: null });
	});
	it("the slow warning after 3 minutes names the machine, its step and how long", () => {
		const slow = run({ machines: [machine({ status: "restarting", startedAt: NOW - UPDATE_SLOW_AFTER_MS })] });
		assert.deepEqual(describeUpdateCapsule(slow, null, NOW), { tone: "slow", label: "max-desktop", slow: { status: "restarting", elapsed: "3m" }, action: null });
		assert.equal(describeUpdateCapsule(slow, null, NOW - 1).tone, "default", "not before 3 minutes");
		assert.equal(describeUpdateCapsule(run({ machines: [machine({ status: "waiting", startedAt: 0 })] }), null, NOW).tone, "default", "a waiting machine is never slow");
		assert.deepEqual([formatUpdateElapsed(59_999), formatUpdateElapsed(59 * 60_000), formatUpdateElapsed(65 * 60_000)], ["<1m", "59m", "1h 5m"]);
	});
	it("the result toast (T3's getUpdateEverythingToastView, :672-713)", () => {
		assert.deepEqual(getUpdateEverythingToastView({ localVersion: V72, updatedServers: 1, failures: [] }, V72), { type: "success", title: "Updated this app and 1 server" });
		assert.deepEqual(getUpdateEverythingToastView({ localVersion: V72, updatedServers: 0, failures: [] }, V72), { type: "success", title: "Updated this app" });
		assert.deepEqual(getUpdateEverythingToastView({ localVersion: null, updatedServers: 1, failures: [] }, V72), { type: "success", title: "Updated 1 server" });
		assert.deepEqual(getUpdateEverythingToastView({ localVersion: V72, updatedServers: 1, failures: [] }, "0.6.1-nightly.20261118.71"), { type: "success", title: "Updated 1 server" }, "this app counts only once it runs the version");
		assert.deepEqual(getUpdateEverythingToastView({ localVersion: null, updatedServers: 0, failures: ["max-desktop: went back"] }, V72), { type: "error", title: "Update failed", description: "max-desktop: went back" });
		assert.equal(getUpdateEverythingToastView({ localVersion: null, updatedServers: 0, failures: [] }, V72), null);
	});
	it("reads what the app sends tolerantly: anything malformed is no run, no result, or an error", () => {
		assert.equal(readUpdateEverythingRun({ phase: "evil", localVersion: null, restartAt: null, machines: [] }), null);
		assert.equal(readUpdateEverythingRun({ ...run(), machines: [{ ...machine({}), status: "rm -rf" }] }), null);
		assert.equal(readUpdateEverythingRun({ ...run(), machines: Array.from({ length: 9 }, () => machine({})) }), null);
		assert.equal(readUpdateEverythingRun({ ...run(), machines: [{ ...machine({}), label: "x".repeat(121) }] }), null);
		assert.equal(readUpdateEverythingRun({ ...run(), restartAt: "soon" })!.restartAt, null);
		assert.equal(readUpdateEverythingRun({ ...run(), machines: [{ ...machine({}), failure: "y".repeat(1000) }] })!.machines[0]!.failure!.length, 400);
		assert.equal(readUpdateEverythingResult({ localVersion: null, updatedServers: -1, failures: [] }), null);
		assert.deepEqual(readUpdateEverythingResult({ localVersion: 5, updatedServers: 1, failures: ["a", 3] }), { localVersion: null, updatedServers: 1, failures: ["a"] });
		const broken = { error: { title: "Couldn’t update everything.", detail: "The app sent an unexpected answer. Try again." } };
		assert.deepEqual(readUpdateEverythingPlan({ planId: "not-a-uuid", version: V72, rows: [] }), broken);
		assert.deepEqual(readUpdateEverythingPlan({ planId: "123e4567-e89b-42d3-a456-426614174000", version: V72, rows: [{ label: "x", app: "evil" }] }), broken);
		assert.deepEqual(readUpdateEverythingPlan(null), broken);
		assert.deepEqual(readUpdateEverythingPlan({ error: { title: "LearnHarness is up to date.", detail: "No newer version of this app was found." } }), { error: { title: "LearnHarness is up to date.", detail: "No newer version of this app was found." } });
	});
});

const PLAN: UpdateEverythingPlan = {
	planId: "123e4567-e89b-42d3-a456-426614174000", version: V72, running: 2, disabledReason: null,
	rows: [{ label: "max-desktop", app: "server", running: 2 }, { label: "This app", app: "this-app", running: 0 }],
	skipped: [],
};

describe("the Update everything dialog (T3's UpdateEverythingDialog.tsx at df09ced7)", () => {
	it("Update 2 machines?: the server, then This app last; the running work; Cancel focused, and it changes nothing", async () => {
		const calls: string[] = [];
		await mount(<UpdateEverythingDialog plan={PLAN} onClose={() => calls.push("close")} onConfirm={() => calls.push("confirm")} />);
		assert.equal(q("update-everything-title")!.textContent, "Update 2 machines?");
		assert.equal(q("update-everything-version")!.textContent, `LearnHarness ${V72}`);
		const rows = [...q("update-everything-table")!.querySelectorAll("[role=row]")].slice(1);
		assert.deepEqual(rows.map((row) => row.getAttribute("data-testid")), ["update-everything-row-server", "update-everything-row-this-app"], "This app is last");
		assert.deepEqual([...rows[1]!.querySelectorAll("[role=cell]")].slice(0, 2).map((cell) => cell.textContent), ["This app", "This apprestarts last"]);
		assert.match(rows[0]!.textContent ?? "", /2 running/);
		assert.deepEqual([...q("update-everything-table")!.querySelectorAll("[role=columnheader]")].map((cell) => cell.textContent), ["Machine", "LearnHarness", "Providers", "Running"]);
		assert.equal(q("update-everything-warning")!.textContent, "2 running tasks will be interrupted.");
		assert.equal(document.activeElement, q("update-everything-cancel"), "Cancel is focused first");
		await click(q("update-everything-cancel"));
		assert.deepEqual(calls, ["close"]);
	});
	it("an app-only update shows no running work; Update confirms", async () => {
		const calls: string[] = [];
		await mount(<UpdateEverythingDialog plan={{ ...PLAN, running: 0, rows: [{ label: "This app", app: "this-app", running: 0 }] }} onClose={() => calls.push("close")} onConfirm={() => calls.push("confirm")} />);
		assert.equal(q("update-everything-title")!.textContent, "Update 1 machine?");
		assert.equal(q("update-everything-warning"), null);
		await click(q("update-everything-confirm"));
		assert.deepEqual(calls, ["confirm"]);
	});
	it("the skipped list opens from the keyboard and shows why; a disabled reason blocks Update", async () => {
		await mount(<UpdateEverythingDialog plan={{ ...PLAN, rows: [{ label: "This app", app: "this-app", running: 0 }], skipped: [{ label: "max-desktop", reason: "Installed with Docker: update the image." }], disabledReason: "Update max-desktop from its own Settings first." }} onClose={() => {}} onConfirm={() => assert.fail("disabled")} />);
		const toggle = q("update-everything-skipped-toggle")!;
		assert.equal(toggle.textContent, "1 skipped");
		assert.equal(toggle.getAttribute("aria-expanded"), "false");
		assert.equal(q("update-everything-skipped"), null);
		await click(toggle);
		assert.equal(toggle.getAttribute("aria-expanded"), "true");
		assert.match(q("update-everything-skipped")!.textContent ?? "", /max-desktopInstalled with Docker: update the image\./);
		assert.equal(q("update-everything-warning")!.textContent, "Update max-desktop from its own Settings first.");
		assert.equal((q("update-everything-confirm") as HTMLButtonElement).disabled, true);
	});
});

describe("the capsule (T3's SidebarUpdateCapsule.tsx at df09ced7)", () => {
	const actions = () => {
		const calls: string[] = [];
		return { calls, actions: { later: () => calls.push("later"), retry: () => calls.push("retry"), dismiss: () => calls.push("dismiss") } };
	};
	it("Restart in 5s with Later", async () => {
		const { calls, actions: a } = actions();
		await mount(<SidebarUpdateCapsule run={run({ phase: "countdown", restartAt: NOW + 5_000, machines: [machine({ status: "done" })] })} local={{ status: "waiting" }} icon={null} actions={a} clock={() => NOW} />);
		assert.equal(q("update-capsule-label")!.textContent, "Restart in 5s");
		assert.equal(q("update-capsule-button")!.getAttribute("aria-label"), "Restart in 5s");
		assert.equal(q("update-capsule-action")!.textContent, "Later");
		await click(q("update-capsule-action"));
		assert.deepEqual(calls, ["later"]);
	});
	it("<machine> failed with Retry, and the details list it and offer Dismiss", async () => {
		const { calls, actions: a } = actions();
		await mount(<SidebarUpdateCapsule run={run({ localVersion: null, machines: [machine({ status: "failed", failure: "max-desktop went back to 0.6.1." })] })} local={null} icon={null} actions={a} clock={() => NOW} />);
		assert.equal(q("update-capsule")!.getAttribute("data-tone"), "failed");
		assert.equal(q("update-capsule-label")!.textContent, "max-desktop failed");
		await click(q("update-capsule-action"));
		assert.deepEqual(calls, ["retry"]);
		await click(q("update-capsule-button"));
		assert.match(q("update-capsule-machine")!.textContent ?? "", /max-desktopfailedmax-desktop went back to 0\.6\.1\./);
		await click(q("update-capsule-dismiss"));
		assert.deepEqual(calls, ["retry", "dismiss"]);
	});
	it("from the keyboard: Enter opens the details onto their first button, Tab stays in them, Escape closes onto the capsule", async () => {
		const { calls, actions: a } = actions();
		await mount(<SidebarUpdateCapsule run={run({ localVersion: null, machines: [machine({ status: "failed", failure: "no" })] })} local={null} icon={null} actions={a} clock={() => NOW} />);
		const capsule = q("update-capsule-button")!;
		capsule.focus();
		await press(capsule, "Enter");
		assert.equal(capsule.getAttribute("aria-expanded"), "true");
		assert.equal(document.activeElement, q("update-capsule-details-action"), "focus is on Retry");
		await press(document.activeElement, "Tab");
		assert.equal(document.activeElement, q("update-capsule-dismiss"));
		await press(document.activeElement, "Tab", { shiftKey: true });
		assert.equal(document.activeElement, q("update-capsule-details-action"));
		await press(document.activeElement, "Escape");
		assert.equal(q("update-capsule-details"), null);
		assert.equal(document.activeElement, capsule);
		assert.deepEqual(calls, [], "keys alone did nothing to the run");
	});
	it("the slow warning, Downloading NN% and Restarting… with no action", async () => {
		await mount(<SidebarUpdateCapsule run={run({ machines: [machine({ status: "restarting", startedAt: NOW - 4 * 60_000 })] })} local={{ status: "waiting" }} icon={null} actions={actions().actions} clock={() => NOW} />);
		assert.equal(q("update-capsule")!.getAttribute("data-tone"), "slow");
		assert.equal(q("update-capsule-button")!.getAttribute("aria-label"), "max-desktop restarting 4m");
		assert.equal(q("update-capsule-action"), null);
		for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
		await mount(<SidebarUpdateCapsule run={run({ machines: [] })} local={{ status: "downloading", percent: 61.2 }} icon={null} actions={actions().actions} clock={() => NOW} />);
		assert.equal(q("update-capsule-label")!.textContent, "Downloading 61%");
		for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
		await mount(<SidebarUpdateCapsule run={run({ phase: "installing" })} local={null} icon={null} actions={actions().actions} clock={() => NOW} />);
		assert.equal(q("update-capsule-label")!.textContent, "Restarting…");
		assert.equal(q("update-capsule-action"), null);
	});
});

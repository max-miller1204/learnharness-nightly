/**
 * Update everything in the window onto a server (docs/specs/t3-style-updates.md, revision
 * PR 7): the ported capsule and toast logic, and the capsule. No Electron: the run is main's
 * (tests/update-everything.test.ts) and so is its dialog (tests/update-everything-dialog.test.ts);
 * these get its reports as data.
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
	describeUpdateCapsule, formatUpdateElapsed, getUpdateEverythingToastView, readBridgeError, readUpdateEverythingResult,
	readUpdateEverythingRun, runIsLive, UPDATE_SLOW_AFTER_MS, type UpdateEverythingRun,
} from "../components/update-everything-logic.ts";
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
	phase: "servers", localVersion: V72, restartAt: null, awaitingPage: false, keyboard: false,
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
		// This app alone, waiting for its countdown to show: never "0 of 0 updated".
		assert.deepEqual(describeUpdateCapsule(run({ machines: [], phase: "countdown", restartAt: null }), { status: "waiting" }, NOW), { tone: "default", label: "Updating this app", action: null });
		assert.equal(describeUpdateCapsule(run({ machines: [], localVersion: null }), null, NOW).label, "0 of 0 updated", "no app and no server is not a run main starts");
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
		assert.equal(readUpdateEverythingRun({ ...run(), awaitingPage: "yes" })!.awaitingPage, false);
		assert.equal(readBridgeError({ started: false }), null, "the dialog closed: nothing to tell");
		assert.equal(readBridgeError(null), null);
		assert.deepEqual(readBridgeError({ error: { title: "LearnHarness is up to date.", detail: "No newer version of this app was found." } }), { title: "LearnHarness is up to date.", detail: "No newer version of this app was found." });
		assert.deepEqual(readBridgeError({ error: { title: 5, detail: "x".repeat(700) } }), { title: "Couldn’t update everything.", detail: "x".repeat(600) });
	});
	it("only a run that moves keeps the page polling fast: a failure kept for Retry doesn't", () => {
		assert.equal(runIsLive(null), false);
		assert.equal(runIsLive(run()), true, "a server updating");
		assert.equal(runIsLive(run({ phase: "countdown", restartAt: NOW })), true);
		assert.equal(runIsLive(run({ localVersion: null, machines: [machine({ status: "failed" })] })), false, "kept for Retry");
		assert.equal(runIsLive(run({ localVersion: null, machines: [machine({ status: "failed" })], awaitingPage: true })), true, "main waits on the page");
	});
});

describe("the capsule (T3's SidebarUpdateCapsule.tsx at df09ced7)", () => {
	const actions = () => {
		const calls: string[] = [];
		return { calls, actions: { later: () => { calls.push("later"); }, retry: () => { calls.push("retry"); }, dismiss: () => { calls.push("dismiss"); } } };
	};
	it("the countdown's first label is the full 5s, whatever the clock read before it started (a fake clock)", async () => {
		// The capsule mounted 400 ms into a second, with no deadline yet; main then sets one 5 s on.
		let t = NOW + 400;
		const clock = () => t;
		const waiting = run({ phase: "countdown", restartAt: null, awaitingPage: true, machines: [machine({ status: "done" })] });
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		roots.push({ root, host });
		const draw = async (value: UpdateEverythingRun) => { await act(async () => { root.render(<InteractionLayersProvider><SidebarUpdateCapsule run={value} local={null} icon={null} actions={actions().actions} clock={clock} /></InteractionLayersProvider>); }); };
		await draw(waiting);
		t += 1_234;
		const counting = { ...waiting, awaitingPage: false, restartAt: t + 5_000 };
		await draw(counting);
		assert.equal(q("update-capsule-label")!.textContent, "Restart in 5s", "not 6s from a rounded or stale reading");
		assert.equal(q("update-capsule-icon")!.textContent, "5s");
		// The next tick is due as the next whole second to the deadline begins (here 1 s on).
		t = counting.restartAt - 4_000;
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_050)); });
		assert.equal(q("update-capsule-label")!.textContent, "Restart in 4s", "the next second's label");
		assert.equal(q("update-capsule-announcement")!.textContent, "Restart in 5s.", "the announcement isn't redone each second");
	});
	it("during the countdown in a sidebar narrower than 12rem, Later is still reachable from the keyboard, in the details", async () => {
		const { calls, actions: a } = actions();
		await mount(<SidebarUpdateCapsule run={run({ phase: "countdown", restartAt: NOW + 5_000, machines: [machine({ status: "done" })] })} local={{ status: "waiting" }} icon={null} actions={a} clock={() => NOW} />);
		// Narrower than 12rem the inline Later is hidden (only @min-[12rem] shows it): the details have it.
		assert.match(q("update-capsule-action")!.getAttribute("class") ?? "", /\bhidden\b.*@min-\[12rem\]\/sidebar-update:block/);
		const capsule = q("update-capsule-button")!;
		capsule.focus();
		await press(capsule, "Enter");
		const later = q("update-capsule-details-action");
		assert.equal(later?.textContent, "Later");
		assert.equal(document.activeElement === later, true, "focus lands on it");
		await click(later);
		assert.deepEqual(calls, ["later"]);
	});
	it("after main's dialog: a keyboard Update focuses the capsule, a keyboard Cancel the Retry pressed, a click neither (T3's finalFocus)", async () => {
		const failed = run({ localVersion: null, machines: [machine({ status: "failed", failure: "no" })] });
		for (const [answer, expect] of [
			[{ error: null, started: true, keyboard: true, dialog: true }, "capsule"],
			[{ error: null, started: false, keyboard: true, dialog: true }, "retry"],
			[{ error: null, started: false, keyboard: false, dialog: true }, "none"],
			// Refused before any dialog (main's cooldown): focus stays on Retry, to press it again.
			[{ error: { title: "Update everything", detail: "Try again in a moment." }, started: false, keyboard: false, dialog: false }, "retry"],
		] as const) {
			let answered: (value: typeof answer) => void = () => {};
			await mount(<SidebarUpdateCapsule run={failed} local={null} icon={null} clock={() => NOW} actions={{ later: () => {}, dismiss: () => {}, retry: () => new Promise((resolve) => { answered = resolve; }) }} />);
			const retry = q("update-capsule-action")!;
			let blurred = false;
			retry.blur = () => { blurred = true; };
			retry.focus();
			await click(retry);
			await act(async () => { answered(answer); await Promise.resolve(); });
			const active = document.activeElement;
			assert.equal(active === q("update-capsule-button"), expect === "capsule", `${expect}: on the capsule`);
			if (expect !== "none") assert.equal(active === retry, expect === "retry", `${expect}: on Retry`);
			assert.equal(blurred, expect === "none", `${expect}: a click lets go of Retry, so no focus ring or tooltip comes back`);
			for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
		}
	});
	it("Restart in 5s with Later", async () => {
		const { calls, actions: a } = actions();
		await mount(<SidebarUpdateCapsule run={run({ phase: "countdown", restartAt: NOW + 5_000, machines: [machine({ status: "done" })] })} local={{ status: "waiting" }} icon={null} actions={a} clock={() => NOW} />);
		assert.equal(q("update-capsule-label")!.textContent, "Restart in 5s");
		assert.equal(q("update-capsule-button")!.getAttribute("aria-label"), "Restart countdown. Later is in the details.", "a name that doesn't change every second");
		assert.equal(q("update-capsule-announcement")!.getAttribute("role"), "status");
		assert.equal(q("update-capsule-announcement")!.textContent, "Restart in 5s.", "said once, as it starts");
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
		assert.equal(document.activeElement === q("update-capsule-details-action"), true, "focus is on Retry");
		await press(document.activeElement, "Tab");
		assert.equal(document.activeElement === q("update-capsule-dismiss"), true);
		await press(document.activeElement, "Tab", { shiftKey: true });
		assert.equal(document.activeElement === q("update-capsule-details-action"), true);
		await press(document.activeElement, "Escape");
		assert.equal(q("update-capsule-details"), null);
		assert.equal(document.activeElement === capsule, true);
		assert.deepEqual(calls, [], "keys alone did nothing to the run");
	});
	it("T3's narrow-sidebar fits: it grows from the icon, its label from 5rem, the countdown's only from 12rem, the icon kept", async () => {
		const classes = (id: string) => q(id)?.getAttribute("class") ?? "";
		await mount(<SidebarUpdateCapsule run={run({ localVersion: null, machines: [machine({ status: "failed" })] })} local={null} icon={null} actions={actions().actions} clock={() => NOW} />);
		assert.match(classes("update-capsule"), /\bw-8\b/, "a circle by default (dea657a0)");
		assert.match(classes("update-capsule"), /@min-\[5rem\]\/sidebar-update:w-full/, "full width from 5rem (5aae5578)");
		assert.match(classes("update-capsule"), /transition-\[width\] duration-200/, "a short grow-in (dea657a0)");
		assert.match(classes("update-capsule"), /justify-end/, "the icon stays at the end while it shrinks (4be39cf0)");
		assert.match(classes("update-capsule-label"), /\bhidden\b.*@min-\[5rem\]\/sidebar-update:block/, "the label from 5rem (5aae5578)");
		assert.match(classes("update-capsule-action"), /@min-\[5rem\]\/sidebar-update:block/);
		assert.match(classes("update-capsule-icon"), /@min-\[5rem\]\/sidebar-update:hidden/, "the icon gives way to the action only where it fits");
		for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
		await mount(<SidebarUpdateCapsule run={run({ phase: "countdown", restartAt: NOW + 5_000, machines: [machine({ status: "done" })] })} local={null} icon={null} actions={actions().actions} clock={() => NOW} />);
		assert.match(classes("update-capsule"), /@min-\[12rem\]\/sidebar-update:w-full/, "the countdown expands only from 12rem (1425613b)");
		assert.match(classes("update-capsule-label"), /@min-\[12rem\]\/sidebar-update:block/);
		assert.match(classes("update-capsule-icon"), /@min-\[12rem\]\/sidebar-update:hidden/);
		assert.equal(q("update-capsule-icon")!.textContent, "5s", "narrower, its seconds stay visible");
		assert.doesNotMatch(classes("update-capsule"), /amber/);
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

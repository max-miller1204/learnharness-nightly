import { beforeEach, describe, test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";
import * as fs from "node:fs";
import { dockAcceptsAnswers } from "./support/dock.ts";
import { answersReceived, instance } from "./support/instance.ts";

// The version the page was built with, which the server must report or the pill offers a reload instead.
const pageVersion = (JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string }).version;

// The sidebar footer's keyboard order and its update pill and capsule
// (components/sidebar-update-pill.tsx, sidebar-update-capsule.tsx), as the
// desktop app shows them: `window.lh.desktopUpdate` is stubbed by an init
// script and /api/updates answers "idle", so the pill offers "Update
// everything" and the test sets the run state the capsule shows.
describe("sidebar update pill and capsule", { session: "learner" }, () => {
	beforeEach(async ({ browser }) => {
		await browser.addInitScript(() => {
			const w = window as unknown as { calls: string[]; testStatus: Record<string, unknown>; lh: unknown };
			w.calls = [];
			w.testStatus = { version: "0.7.0", target: "9.0.0", phase: "available", error: null, run: null };
			w.lh = {
				desktopUpdate: {
					getStatus: async () => w.testStatus,
					everything: async () => { w.calls.push("everything"); return { started: false }; },
					retry: async () => { w.calls.push("retry"); return { started: false }; },
					later: async () => { w.calls.push("later"); w.testStatus = { ...w.testStatus, run: null }; document.dispatchEvent(new Event("visibilitychange")); },
					dismiss: async () => {},
					ready: async () => {},
					takeResult: async () => null,
				},
			};
		});
		await browser.route("**/api/updates", (route) => route.fulfill({ json: { status: "idle", version: null, revision: 1, runningVersion: pageVersion } }));
	});

	// Which footer control has focus: its test id, or "none".
	const focused = (browser: Browser) => browser.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? "none");
	// Sets the update run the stubbed desktop app reports, and tells the page to re-read it.
	const setRun = (browser: Browser, run: Record<string, unknown>) => browser.evaluate((next) => {
		const w = window as unknown as { testStatus: Record<string, unknown> };
		w.testStatus = { ...w.testStatus, run: next };
		document.dispatchEvent(new Event("visibilitychange"));
		return null;
	}, run as never);
	const calls = (browser: Browser) => browser.evaluate(() => (window as unknown as { calls: string[] }).calls);
	const toggleSidebar = (browser: Browser) => browser.keyboard.press("Control+b");
	// Search, then Tab twice (Settings, then the update control), as a keyboard user reaches the footer.
	const tabToFooter = async (screen: Screen, browser: Browser) => {
		await screen.getByTestId("session-search").click();
		await browser.keyboard.press("Tab");
		await browser.keyboard.press("Tab");
	};
	const countdown = { phase: "countdown", localVersion: "1.0.0", restartAt: Date.now() + 600_000, machines: [], awaitingPage: false, keyboard: false };

	test("keyboard focus stays in the footer through the pill, the capsule and its details", async ({ app, screen, browser }) => {
		await app.open("/chat/new");
		await expect(screen.getByTestId("update-pill")).toBeVisible({ timeout: 60_000 });
		await expect(screen.getByTestId("update-pill")).toHaveAttribute("data-action", "everything");

		// An empty search, then forward and reverse Tab order across the footer.
		await screen.getByTestId("session-search").click();
		expect(await focused(browser)).toBe("session-search");
		await browser.keyboard.type("zz-no-sessions");
		await browser.keyboard.press("Tab");
		expect(await focused(browser)).toBe("settings-entry");
		await browser.keyboard.press("Shift+Tab");
		expect(await focused(browser)).toBe("session-search");
		await browser.keyboard.press("Tab");
		await browser.keyboard.press("Tab");
		expect(await focused(browser)).toBe("update-pill");

		// Closing the sidebar takes focus off the pill, so Space does nothing.
		await toggleSidebar(browser);
		await expect.poll(() => browser.evaluate(() => !!document.querySelector("aside")?.inert)).toBe(true);
		await browser.keyboard.press("Space");
		expect(await calls(browser)).toEqual([]);
		expect(await focused(browser)).not.toBe("update-pill");

		// An update run replaces the pill with the capsule, and focus follows.
		await toggleSidebar(browser);
		await expect.poll(() => browser.evaluate(() => !document.querySelector("aside")?.inert)).toBe(true);
		await tabToFooter(screen, browser);
		expect(await focused(browser)).toBe("update-pill");
		await setRun(browser, countdown);
		await expect.poll(() => focused(browser)).toBe("update-capsule-button");

		// The capsule's details open on Enter; closing the sidebar closes them and Space stays inert.
		await browser.keyboard.press("Enter");
		await expect.poll(() => focused(browser)).toBe("update-capsule-details-action");
		await expect(screen.getByTestId("update-capsule-details-action")).toHaveText("Later");
		await toggleSidebar(browser);
		await expect.poll(() => browser.evaluate(() => !!document.querySelector("aside")?.inert && !document.querySelector('[data-testid="update-capsule-details"]'))).toBe(true);
		await browser.keyboard.press("Space");
		expect(await calls(browser)).toEqual([]);
		expect(await focused(browser)).not.toBe("update-capsule-details-action");

		// A failed run offers Retry. In the portaled details, Tab and arrow keys stay inside.
		await toggleSidebar(browser);
		await expect.poll(() => browser.evaluate(() => !document.querySelector("aside")?.inert)).toBe(true);
		await setRun(browser, { phase: "servers", localVersion: null, restartAt: null, machines: [{ label: "Server", status: "failed", startedAt: Date.now(), failure: "failed" }], awaitingPage: false, keyboard: false });
		await expect(screen.getByTestId("update-capsule-action")).toHaveText("Retry");
		await tabToFooter(screen, browser);
		await browser.keyboard.press("Enter");
		await expect.poll(() => focused(browser)).toBe("update-capsule-details-action");
		await browser.evaluate(() => {
			const w = window as unknown as { leaks: string[] };
			w.leaks = [];
			document.body.addEventListener("keydown", (event) => w.leaks.push(event.key));
			return null;
		});
		await browser.keyboard.press("Tab");
		expect(await focused(browser)).toBe("update-capsule-dismiss");
		await browser.keyboard.press("ArrowDown");
		expect(await browser.evaluate(() => (window as unknown as { leaks: string[] }).leaks)).toEqual([]);

		// Escape returns to the capsule; "Later" ends the run and returns focus to the pill.
		await browser.keyboard.press("Escape");
		await expect.poll(() => focused(browser)).toBe("update-capsule-button");
		await setRun(browser, { ...countdown, restartAt: Date.now() + 600_000 });
		await expect(screen.getByTestId("update-capsule-button")).toHaveAttribute("aria-label", /countdown/);
		await browser.keyboard.press("Enter");
		await expect.poll(() => focused(browser)).toBe("update-capsule-details-action");
		await browser.keyboard.press("Space");
		await expect.poll(() => focused(browser)).toBe("update-pill");
		expect(await calls(browser)).toEqual(["later"]);
	});

	test("Enter on the question dock after a click on the pill submits the answer, not the pill", async ({ app, screen, browser }) => {
		await app.open("/chat/new");
		await expect(screen.getByTestId("update-pill")).toBeVisible({ timeout: 60_000 });
		const state = await instance(app.baseUrl);
		const goal = `zz-e2e ${Date.now().toString(36)} why is the sky blue`;
		const input = screen.getByTestId("composer").getByRole("textbox");
		await input.fill(goal);
		await input.press("Enter");
		const dock = screen.getByTestId("question-dock");
		await dock.getByRole("radio").first().waitFor({ timeout: 90_000 });
		await dockAcceptsAnswers(browser);
		await dock.getByRole("radio", /Blue$/).check();
		await expect(dock.getByRole("button", "Submit answer")).toBeEnabled();

		// The pointer click gives the pill focus, as it does for a mouse user.
		await screen.getByTestId("update-pill").click();
		await expect.poll(async () => (await calls(browser)).includes("everything")).toBe(true);
		const before = (await calls(browser)).filter((c) => c === "everything").length;
		// Enter must submit the answer and never activate the pill. A loaded machine can drop a
		// press the dock was not ready for, which is harmless, so press again; a press the pill
		// took shows as a second "everything" call, and that fails at once.
		const answered = async () => (await browser.evaluate(() => document.body.innerText.includes("zz-e2e acknowledged your answer")));
		for (let press = 0; press < 5 && !(await answered()); press++) {
			// The pill owns focus when Enter goes in: the pointer click gave it, nothing took it back.
			expect(await focused(browser), "focus is on the pill").toBe("update-pill");
			await browser.keyboard.press("Enter");
			await expect.poll(async () => (await answered()) || (await calls(browser)).filter((c) => c === "everything").length !== before, { timeout: 4000 }).toBe(true).catch(() => {});
			expect((await calls(browser)).filter((c) => c === "everything").length, "Enter activated the pill").toBe(before);
		}

		await expect(screen.getByText(/zz-e2e acknowledged your answer/, { visible: true })).toBeVisible({ timeout: 60_000 });
		await expect(dock).not.toBeVisible();
		expect((await calls(browser)).filter((c) => c === "everything").length).toBe(before);
		// Pressing Enter again (above) must not have sent the answer twice.
		await expect.poll(() => answersReceived(state, goal), { timeout: 10_000 }).toBe(1);
	});
});

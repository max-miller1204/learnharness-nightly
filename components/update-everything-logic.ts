/**
 * Update everything in the desktop app's window onto a self-hosted server
 * (docs/specs/t3-style-updates.md, revision PR 7): what the page's capsule and
 * result toast say about the run main reports through window.lh.desktopUpdate.
 *
 * Ported from T3 Code's apps/web/src/components/sidebar/updateEverything.logic.ts
 * at df09ced7 (MIT, Copyright (c) 2026 T3 Tools Inc.): formatUpdateElapsed and
 * describeUpdateCapsule (:525-625), RUN_STATUS_LABELS (:628-635),
 * getUpdateEverythingToastView (:672-713) and updateTargetsSentence and joinList
 * (:742-849), for this app and its one server. LearnHarness has no provider
 * updates, so the providers cases are left out. Main decides each machine's
 * status, so the page doesn't resolve it from server states (T3's
 * resolveUpdateRunMachineStatus, :497-509).
 */

export type UpdateRunMachineStatus = "waiting" | "downloading" | "restarting" | "done" | "failed";

/** One machine of the run, as main reports it. */
export type UpdateRunMachine = {
	label: string;
	status: UpdateRunMachineStatus;
	startedAt: number;
	failure: string | null;
};

/** The run as main reports it (T3's UpdateEverythingRun, :488-494, without providers). */
export type UpdateEverythingRun = {
	phase: "servers" | "countdown" | "installing";
	/** The version this app restarts into, or null once it won't in this run. */
	localVersion: string | null;
	restartAt: number | null;
	machines: UpdateRunMachine[];
};

export type UpdateRunLocalState = { status: "downloading"; percent: number | null } | { status: "waiting" } | null;

export type UpdateCapsuleView = {
	tone: "default" | "slow" | "failed";
	label: string;
	slow?: { status: string; elapsed: string };
	action: "later" | "retry" | "dismiss" | null;
};

/** T3's UPDATE_SLOW_AFTER_MS (:523). */
export const UPDATE_SLOW_AFTER_MS = 3 * 60 * 1000;

export const RUN_STATUS_LABELS: Record<UpdateRunMachineStatus, string> = {
	waiting: "waiting",
	downloading: "downloading",
	restarting: "restarting",
	done: "done",
	failed: "failed",
};

export function formatUpdateElapsed(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Seconds left before this app restarts, or null outside the countdown (SidebarUpdateCapsule.tsx:49-53). */
export function restartSecondsLeft(run: UpdateEverythingRun, now: number): number | null {
	return run.phase === "countdown" && run.restartAt !== null ? Math.max(0, Math.ceil((run.restartAt - now) / 1000)) : null;
}

const isActive = (status: UpdateRunMachineStatus) => status !== "done" && status !== "failed";

export function describeUpdateCapsule(run: UpdateEverythingRun, local: UpdateRunLocalState, now: number): UpdateCapsuleView {
	const machines = run.machines;
	if (run.phase === "countdown" && run.restartAt !== null) {
		const seconds = Math.max(0, Math.ceil((run.restartAt - now) / 1000));
		return { tone: "default", label: `Restart in ${seconds}s`, action: "later" };
	}
	if (run.phase === "installing") return { tone: "default", label: "Restarting…", action: null };
	const active = machines.filter(({ status }) => isActive(status) && status !== "waiting");
	const slowest = active.toSorted((a, b) => a.startedAt - b.startedAt)[0];
	if (slowest && now - slowest.startedAt >= UPDATE_SLOW_AFTER_MS) {
		return {
			tone: "slow",
			label: slowest.label,
			slow: { status: RUN_STATUS_LABELS[slowest.status], elapsed: formatUpdateElapsed(now - slowest.startedAt) },
			action: null,
		};
	}
	const done = machines.filter(({ status }) => status === "done").length;
	if (machines.some(({ status }) => isActive(status))) {
		return { tone: "default", label: `${done} of ${machines.length} updated`, action: null };
	}
	if (local?.status === "downloading") {
		return { tone: "default", label: local.percent === null ? "Downloading" : `Downloading ${Math.floor(local.percent)}%`, action: null };
	}
	const failed = machines.filter(({ status }) => status === "failed");
	if (failed.length > 0) {
		// Every failed machine here is a server main can try again.
		return { tone: "failed", label: failed.length === 1 ? `${failed[0]!.label} failed` : `${failed.length} failed`, action: "retry" };
	}
	return { tone: "default", label: `${done} of ${machines.length} updated`, action: null };
}

/** The popover's line for this app (SidebarUpdateCapsule.tsx:55-70). */
export function localStatusLabel(run: UpdateEverythingRun, local: UpdateRunLocalState, now: number): string {
	const seconds = restartSecondsLeft(run, now);
	if (seconds !== null) return `restarts in ${seconds}s`;
	if (run.phase === "installing") return "restarting";
	if (local?.status === "downloading") return local.percent === null ? "downloading" : `downloading ${Math.floor(local.percent)}%`;
	return "restarts after the servers";
}

/** The run's result, as main hands it to the page once (also after the restart). */
export type UpdateEverythingResult = {
	localVersion: string | null;
	updatedServers: number;
	failures: string[];
};

const servers = (count: number) => `${count} ${count === 1 ? "server" : "servers"}`;

/** "Updated this app and 1 server", one sentence per combination; null when nothing. */
export function updateTargetsSentence(verb: "update" | "updated", { app, servers: count }: { app: boolean; servers: number }): string | null {
	const lead = verb === "update" ? "Update" : "Updated";
	if (app && count > 0) return `${lead} this app and ${servers(count)}`;
	if (app) return `${lead} this app`;
	if (count > 0) return `${lead} ${servers(count)}`;
	return null;
}

export function getUpdateEverythingToastView(result: UpdateEverythingResult, appVersion: string): { type: "success" | "error"; title: string; description?: string } | null {
	const updated = updateTargetsSentence("updated", {
		app: result.localVersion !== null && result.localVersion === appVersion,
		servers: result.updatedServers,
	});
	if (result.failures.length === 0) return updated === null ? null : { type: "success", title: updated };
	return { type: "error", title: updated ?? "Update failed", description: result.failures.join("\n") };
}

const MACHINE_STATUSES = new Set<UpdateRunMachineStatus>(["waiting", "downloading", "restarting", "done", "failed"]);
const MAX_LABEL = 120;
const MAX_FAILURE = 400;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Tolerant read of the bridge's run: anything malformed reads as no run, never a broken capsule. */
export function readUpdateEverythingRun(value: unknown): UpdateEverythingRun | null {
	if (typeof value !== "object" || value === null) return null;
	const run = value as Record<string, unknown>;
	if (run.phase !== "servers" && run.phase !== "countdown" && run.phase !== "installing") return null;
	if (!Array.isArray(run.machines) || run.machines.length > 8) return null;
	const machines: UpdateRunMachine[] = [];
	for (const item of run.machines as unknown[]) {
		const machine = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
		if (typeof machine.label !== "string" || !machine.label || machine.label.length > MAX_LABEL) return null;
		if (!MACHINE_STATUSES.has(machine.status as UpdateRunMachineStatus) || !finite(machine.startedAt)) return null;
		const failure = typeof machine.failure === "string" ? machine.failure.slice(0, MAX_FAILURE) : null;
		machines.push({ label: machine.label, status: machine.status as UpdateRunMachineStatus, startedAt: machine.startedAt, failure });
	}
	return {
		phase: run.phase,
		localVersion: typeof run.localVersion === "string" && run.localVersion.length <= 64 ? run.localVersion : null,
		restartAt: finite(run.restartAt) ? run.restartAt : null,
		machines,
	};
}

/** Tolerant read of the result toast's data. */
export function readUpdateEverythingResult(value: unknown): UpdateEverythingResult | null {
	if (typeof value !== "object" || value === null) return null;
	const result = value as Record<string, unknown>;
	const updatedServers = result.updatedServers;
	if (!Array.isArray(result.failures) || !Number.isInteger(updatedServers) || (updatedServers as number) < 0 || (updatedServers as number) > 8) return null;
	return {
		localVersion: typeof result.localVersion === "string" && result.localVersion.length <= 64 ? result.localVersion : null,
		updatedServers: updatedServers as number,
		failures: (result.failures as unknown[]).filter((line): line is string => typeof line === "string").slice(0, 8).map((line) => line.slice(0, MAX_FAILURE)),
	};
}

/** One row of the dialog's table, as main plans it (T3's UpdateEverythingRow, :733-739). */
export type UpdateEverythingRow = { label: string; app: "server" | "this-app"; running: number };

/** The dialog's content from main's plan(): T3's describeUpdateEverything (:851-920) already
 *  applied by main, which knows the server. */
export type UpdateEverythingPlan = {
	planId: string;
	version: string;
	rows: UpdateEverythingRow[];
	skipped: { label: string; reason: string }[];
	running: number;
	disabledReason: string | null;
};

export type UpdateEverythingPlanResult = { plan: UpdateEverythingPlan } | { error: { title: string; detail: string } };

const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const count = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? Math.min(value as number, 10_000) : 0);
const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** Tolerant read of main's plan(): a malformed plan reads as an error, never a broken dialog. */
export function readUpdateEverythingPlan(value: unknown): UpdateEverythingPlanResult {
	const broken = { error: { title: "Couldn’t update everything.", detail: "The app sent an unexpected answer. Try again." } };
	if (typeof value !== "object" || value === null) return broken;
	const raw = value as Record<string, unknown>;
	if (typeof raw.error === "object" && raw.error !== null) {
		const error = raw.error as Record<string, unknown>;
		return { error: { title: text(error.title, 200) ?? broken.error.title, detail: text(error.detail, 600) ?? "" } };
	}
	if (typeof raw.planId !== "string" || !PLAN_ID.test(raw.planId) || typeof raw.version !== "string" || raw.version.length > 64 || !Array.isArray(raw.rows)) return broken;
	const rows: UpdateEverythingRow[] = [];
	for (const item of raw.rows as unknown[]) {
		const row = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
		const label = text(row.label, MAX_LABEL);
		if (!label || (row.app !== "server" && row.app !== "this-app")) return broken;
		rows.push({ label, app: row.app, running: count(row.running) });
	}
	if (rows.length === 0 || rows.length > 8) return broken;
	const skipped = (Array.isArray(raw.skipped) ? raw.skipped : []).flatMap((item: unknown) => {
		const row = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
		const label = text(row.label, MAX_LABEL);
		const reason = text(row.reason, 200);
		return label && reason ? [{ label, reason }] : [];
	}).slice(0, 8);
	return { plan: { planId: raw.planId, version: raw.version, rows, skipped, running: count(raw.running), disabledReason: text(raw.disabledReason, 300) } };
}

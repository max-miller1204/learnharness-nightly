"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import { WaypointsIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { IMPORT_ACCEPT, importKind } from "@/lib/notes-import-limits.ts";
import { useInteractionLayer, useInteractionLayers } from "@/components/interaction-layers";
import { INTERACTION_LAYER_Z_BASE } from "@/components/host-dialog";
import { createNotesImportQueue, EMPTY_IMPORT_QUEUE, notesPath } from "./notes-import-queue";
import { planFolder, planSummaries, type FolderPlan } from "./notes-import-folder";
import { HostDialog } from "@/components/host-dialog";
import type { ImportEstimate } from "@/lib/notes-import-estimate";

export { MAX_IMPORT_BYTES } from "@/lib/notes-import-limits.ts";
export { notesPath } from "./notes-import-queue";

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
	notice?: string;
}

/** Contributor's strict attribution: validate the complete response before
 * applying any row, even when several files have identical basenames. */
export function parseNotesImportResults(body: unknown, files: readonly File[], group?: string): NotesImportResult[] {
	const invalid = () => new Error("Invalid import response. Check the graph before retrying.");
	// A folder's grouped code answers with one row named after the folder (item 26).
	const paths = group === undefined ? files.map(notesPath) : [group];
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== paths.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= paths.length || seen.has(r.requestIndex) || r.filePath !== paths[r.requestIndex]) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.ok && !r.stats) throw invalid();
		if (!r.ok && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider", "notice"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

export async function postNotesImport(files: readonly File[], group?: string): Promise<NotesImportResult[]> {
	const form = new FormData();
	for (const file of files) {
		form.append("files", file);
		form.append("paths", notesPath(file));
	}
	if (group !== undefined) form.append("group", group);
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error("Invalid import response. Check the graph before retrying."); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(`Import request failed (HTTP ${response.status})${detail}${/[.!?]$/.test(detail) ? "" : "."} Check the graph before retrying.`);
	}
	return parseNotesImportResults(body, files, group);
}

// Client module singleton: shared by both home views and successive selections.
// SSR never appends Files, and uses the immutable empty server snapshot.
const pageImportQueue = createNotesImportQueue(postNotesImport);

/** A folder pick waiting for Extract / Cancel (item 26): its plan, then its estimate. */
export interface FolderReview {
	plan: FolderPlan;
	estimate: ImportEstimate | "loading" | "failed";
	onStart?: () => void;
}
const reviewListeners = new Set<() => void>();
let folderReview: FolderReview | null = null;
let reviewSequence = 0;
const setFolderReview = (next: FolderReview | null) => {
	folderReview = next;
	for (const listener of [...reviewListeners]) listener();
};
const subscribeReview = (listener: () => void) => { reviewListeners.add(listener); return () => { reviewListeners.delete(listener); }; };

async function fetchEstimate(plan: FolderPlan): Promise<ImportEstimate | "failed"> {
	try {
		const response = await fetch("/api/graph/import/estimate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(plan.measures) });
		if (!response.ok) return "failed";
		const body = await response.json() as ImportEstimate;
		return typeof body.tokens === "number" && (body.usd === null || typeof body.usd === "number") ? body : "failed";
	} catch { return "failed"; }
}

/** Sort the pick, show the dialog, then ask for the estimate. A newer pick replaces an older review. */
async function reviewFolder(files: readonly File[], onStart?: () => void): Promise<void> {
	const sequence = ++reviewSequence;
	const plan = await planFolder(files);
	if (sequence !== reviewSequence) return;
	const empty = plan.files.length === 0 && plan.code.length === 0;
	setFolderReview({ plan, estimate: empty ? "failed" : "loading", onStart });
	if (empty) return;
	const estimate = await fetchEstimate(plan);
	if (sequence === reviewSequence && folderReview?.plan === plan) setFolderReview({ plan, estimate, onStart });
}

export function confirmFolderReview(): void {
	const review = folderReview;
	// Nothing runs before the estimate is shown (spec: estimate, then Extract / Cancel).
	if (!review || review.estimate === "loading") return;
	reviewSequence++;
	setFolderReview(null);
	const { plan } = review;
	if (plan.files.length === 0 && plan.code.length === 0) return;
	review.onStart?.();
	if (plan.files.length > 0) pageImportQueue.append(plan.files);
	if (plan.code.length > 0) pageImportQueue.appendGroup(plan.root, plan.code);
	pageImportQueue.report(planSummaries(plan));
}
/** Test seam: the review the dialog is showing. */
export const folderReviewSnapshot = (): FolderReview | null => folderReview;
export function cancelFolderReview(): void {
	reviewSequence++;
	setFolderReview(null);
}
export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const snapshot = useSyncExternalStore(pageImportQueue.subscribe, pageImportQueue.getSnapshot, () => EMPTY_IMPORT_QUEUE);
	const latest = useRef(callbacks);
	latest.current = callbacks;
	const seenCompletion = useRef(snapshot.completion);
	useEffect(() => {
		if (seenCompletion.current !== snapshot.completion) {
			seenCompletion.current = snapshot.completion;
			latest.current.onFinish?.();
		}
	}, [snapshot.completion]);
	return {
		errors: snapshot.errors, notices: snapshot.notices, importing: snapshot.importing,
		onImportFiles: (files: FileList | null) => {
			if (!files || files.length === 0) return;
			const picked = Array.from(files);
			// A folder pick (relative paths) is reviewed first: estimate, then Extract / Cancel.
			if (picked[0]!.webkitRelativePath) { void reviewFolder(picked, () => latest.current.onStart?.()); return; }
			latest.current.onStart?.();
			pageImportQueue.append(picked);
		},
	};
}

/** PR198's shared Files / Folder native picker. Unlike the donor, it remains
 * available while work is running; later selections join the SAME queue. */
export function NotesImportControl({ importing, onImportFiles }: { importing: boolean; onImportFiles: (files: FileList | null) => void }) {
	const filesRef = useRef<HTMLInputElement>(null);
	const folderRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const hintId = useId();
	const onChange = (event: ChangeEvent<HTMLInputElement>) => {
		onImportFiles(event.target.files);
		event.target.value = "";
	};
	const rootRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const interactions = useInteractionLayers();
	const popupLayer = useInteractionLayer({ kind: "popup", enabled: open, rootRef: panelRef, anchorRef: rootRef,
		onClose: () => { setOpen(false); return "closed"; } });
	const choices = [["Files", filesRef], ["Folder", folderRef]] as const;
	return (
		<div ref={rootRef} className="relative shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur"
			onBlur={(event) => { if (interactions.isElementEligible(panelRef.current) && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
			<input ref={filesRef} type="file" multiple accept={IMPORT_ACCEPT} className="hidden" onChange={onChange} />
			<input ref={folderRef} type="file" {...{ webkitdirectory: "" }} className="hidden" onChange={onChange} />
			<FolderReviewDialog />
			<Hint label="Extract files into the graph" side="bottom">
				<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" data-testid="import-notes"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent">
					<WaypointsIcon className="size-3" />{importing ? "Extracting…" : "Extract files…"}
				</button>
			</Hint>
			{open && (
				<div ref={panelRef} role="menu" aria-label="Extract files into the graph" aria-describedby={hintId} style={{ zIndex: INTERACTION_LAYER_Z_BASE + popupLayer.order }} className="absolute right-0 top-full mt-1 w-52 rounded-lg border bg-card p-1 shadow-lg">
					<div role="none"><p id={hintId} className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">For lessons, attach material to a session instead.</p></div>
					{choices.map(([label, input]) => <button key={label} type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
						onClick={() => { setOpen(false); input.current?.click(); }}>{label}</button>)}
				</div>
			)}
		</div>
	);
}

export function NotesImportErrors({ errors }: { errors: readonly string[] }) {
	return <>{errors.map((error, i) => <p key={i} role="alert" className="max-w-full whitespace-pre-wrap break-words text-xs text-error">{error}</p>)}</>;
}
export function NotesImportNotices({ notices }: { notices: readonly string[] }) {
	return <>{notices.map((notice, i) => <p key={i} role="status" className="max-w-full whitespace-pre-wrap break-words text-xs text-muted-foreground">{notice}</p>)}</>;
}

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
function dollars(usd: number): string {
	return usd < 0.01 ? "less than $0.01" : `$${usd.toFixed(2)}`;
}

/** The dialog's lines, pure for tests (spec "Folder picks in the browser"). */
export function folderReviewLines(review: FolderReview): { title: string; contents?: string; skipped?: string; codeSkipped?: string; estimate?: string; empty: boolean } {
	const { plan, estimate } = review;
	const images = plan.files.filter((file) => importKind(file.name) === "image").length;
	const documents = plan.files.length - images;
	const contents = [
		...(documents > 0 ? [plural(documents, "note or document", "notes and documents")] : []),
		...(images > 0 ? [plural(images, "image", "images")] : []),
		...(plan.code.length > 0 ? [`${plural(plan.code.length, "code file", "code files")} (one source)`] : []),
	].join(", ");
	const tooLarge = plan.oversized.length + plan.codeTooLarge;
	const skipped = [
		...(plan.ignored > 0 ? [`${count(plan.ignored)} ignored or excluded`] : []),
		...(tooLarge > 0 ? [`${count(tooLarge)} too large`] : []),
		...(plan.codeNotText > 0 ? [`${count(plan.codeNotText)} not text`] : []),
		...(plan.unsupported.length > 0 ? [`${count(plan.unsupported.length)} unsupported`] : []),
		...(plan.unsafe > 0 ? [`${count(plan.unsafe)} with unusable names`] : []),
	].join(", ");
	const empty = plan.files.length === 0 && plan.code.length === 0;
	const estimateLine = empty ? undefined
		: estimate === "loading" ? "Estimating the cost..."
			: estimate === "failed" ? "Could not estimate the cost."
				: estimate.usd === null ? `About ${count(estimate.tokens)} tokens; cost not estimated for ${estimate.unpriced ?? "this model"}.`
					: `About ${count(estimate.tokens)} tokens, about ${dollars(estimate.usd)}${estimate.rough ? " (rough)" : ""}`;
	return {
		title: empty ? `Nothing to extract in ${plan.root}` : `Extract ${plan.root}?`,
		...(contents ? { contents } : {}),
		...(skipped ? { skipped: `Skipped: ${skipped}` } : {}),
		...(plan.codeSkipped ? { codeSkipped: plan.codeSkipped } : {}),
		...(estimateLine ? { estimate: estimateLine } : {}),
		empty,
	};
}

export function FolderReviewBody({ review, onCancel, onConfirm, renderFrame }: {
	review: FolderReview; onCancel: () => void; onConfirm: () => void;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}) {
	const lines = folderReviewLines(review);
	const frame = (
		<div role="dialog" aria-modal="true" aria-label={lines.title} data-testid="folder-review-dialog" onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl">
			<h2 className="break-words text-sm font-semibold">{lines.title}</h2>
			{lines.contents && <p className="mt-2 text-sm" data-testid="folder-review-contents">{lines.contents}</p>}
			{lines.skipped && <p className="mt-1.5 text-xs text-muted-foreground" data-testid="folder-review-skipped">{lines.skipped}</p>}
			{lines.codeSkipped && <p className="mt-1.5 text-xs text-error" data-testid="folder-review-code-skipped">{lines.codeSkipped}</p>}
			{lines.estimate && <p className="mt-2 text-xs text-muted-foreground" data-testid="folder-review-estimate">{lines.estimate}</p>}
			<div className="mt-4 flex justify-end gap-2">
				<button type="button" data-testid="folder-review-cancel" onClick={onCancel}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
					{lines.empty ? "Close" : "Cancel"}
				</button>
				{!lines.empty && <button type="button" data-testid="folder-review-confirm" onClick={onConfirm} disabled={review.estimate === "loading"}
					className="rounded-sm border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-40">Extract</button>}
			</div>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}

/** The folder review, shown by whichever Extract files control is on screen. */
export function FolderReviewDialog() {
	const review = useSyncExternalStore(subscribeReview, () => folderReview, () => null);
	if (!review) return null;
	return <FolderReviewBody review={review} onCancel={cancelFolderReview} onConfirm={confirmFolderReview}
		renderFrame={(frame) => <HostDialog open frame={frame} onClose={() => { cancelFolderReview(); return "closed"; }}
			backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}>{frame.props.children}</HostDialog>} />;
}

// The full lesson view's pure rules (mobile follow-up 1): which phase seams,
// helper cards and plan statuses a session shows. Each mirrors the web's
// own derivation (components/chat.tsx and the artifact cards) on the shared
// core, so phone and browser agree.
import type { JobKind, JobRecord, LhMessage, QuestionAnswerData } from "../../../src/client-protocol/index.ts";
import { derivedNodeStatus, derivePlanStatuses, type PlanNodeStatus, type PlanTree } from "../../../src/core/contracts/plan.ts";
import { phaseAt3Lh, phaseTimeline, teachStepIndex, type Phase3 } from "../../../src/core/phases.ts";
import { latestTree } from "../../../src/core/plan-layout.ts";
import { toolQuestionKind, type PendingQuestion } from "../../../src/core/pending.ts";
import { dismissedAnswer, questionNeedsReveal } from "../../../src/core/question-core.ts";
import type { LhViewMessage, LhViewPart } from "../../../src/core/view.ts";

/** The phase chip's words (components/phase-divider.tsx). */
export const PHASE_LABEL: Record<Phase3, string> = { probe: "Probing", plan: "Planning", teach: "Teaching" };

export const sessionPhase = (messages: readonly LhMessage[]): Phase3 => phaseAt3Lh(messages);

/** Where teaching begins: the message whose phase flips to teach, and the
 * step-start part the divider replaces (-1 means before the whole message). */
export function teachSeam(messages: readonly LhViewMessage[]): { messageId: string; stepIndex: number } | null {
  const phases = phaseTimeline(messages);
  for (let i = 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "assistant" && phases[i] === "teach" && phases[i - 1] !== "teach") {
      return { messageId: message.id, stepIndex: teachStepIndex(message.parts) };
    }
  }
  return null;
}

/** A sub-agent delivery: a user-role marker that renders as a card, never as the learner's words. */
export const isSubagentSteer = (message: LhViewMessage) =>
  (message.metadata as { subagentResult?: unknown } | undefined)?.subagentResult != null;

/** A teach-phase check waits behind "Check your understanding" (question-core.ts). */
export const checkNeedsReveal = (question: PendingQuestion, messages: readonly LhMessage[]) =>
  questionNeedsReveal(question.tool, question.input, sessionPhase(messages));

/** The web's skip (chat.tsx confirmAbort): a dismissed answer, carrying any thinking while reading. */
export function skipAnswer(question: PendingQuestion, reading: string): QuestionAnswerData {
  const text = (question.input as { question?: string } | null)?.question ?? "";
  const answer = dismissedAnswer(toolQuestionKind(question.tool), text);
  const thoughts = reading.trim();
  return thoughts ? { ...answer, readingThinking: thoughts } : answer;
}

// ─── Background helpers (components/artifacts/dispatch-card.tsx) ─────────────

export const JOB_LABEL: Record<JobKind, string> = {
  research: "Research agent",
  demo: "Demo agent",
  visual: "Figure agent",
  pdf: "PDF reader",
  plugin: "Plugin worker",
};

export function jobLabel(kind: JobKind, job?: JobRecord): string {
  return kind === "plugin" ? job?.plugin?.label || job?.plugin?.toolName || JOB_LABEL.plugin : JOB_LABEL[kind];
}

const DISPATCH_TOOLS: Record<string, JobKind> = { "tool-research": "research", "tool-pdf": "pdf", "tool-demo": "demo", "tool-visual": "visual" };

/** The helper a settled tool part dispatched, if any. A plugin tool counts
 * when the jobs list knows it or its acknowledgement says so
 * (components/plugin-renderers.tsx). */
export function dispatchedKind(part: LhViewPart, jobs: readonly JobRecord[]): JobKind | undefined {
  if (part.state !== "output-available" || !part.type.startsWith("tool-")) return;
  const native = DISPATCH_TOOLS[part.type];
  if (native) return native;
  if (part.background) return;
  const result = part.result as { details?: { jobId?: unknown; dispatched?: unknown }; isError?: boolean } | undefined;
  if (result?.isError) return;
  const ack = result?.details;
  const known = jobs.some((job) => job.kind === "plugin" && job.toolCallId === part.toolCallId);
  return known || (typeof ack?.jobId === "string" && ack.dispatched === true) ? "plugin" : undefined;
}

export function elapsedSeconds(job: JobRecord, now: number): number | null {
  const started = Date.parse(job.createdAt);
  return Number.isNaN(started) ? null : Math.max(0, Math.round((now - started) / 1000));
}

/** True when a job the phone saw running has stopped since the last list. */
export function jobSettled(previous: ReadonlyMap<string, string>, jobs: readonly JobRecord[]): boolean {
  return jobs.some((job) => previous.get(job.id) === "running" && job.status !== "running");
}

// ─── The live plan (components/plan-block.tsx PlanPopup) ─────────────────────

export function livePlan(messages: readonly LhViewMessage[]): { tree: PlanTree; current: string | null; statusOf: (id: string) => PlanNodeStatus } | null {
  const tree = latestTree(messages);
  if (!tree) return null;
  const statuses = derivePlanStatuses(tree, messages);
  return { tree, current: statuses.current, statusOf: (id) => derivedNodeStatus(statuses, id) };
}

/** Where a path ends and the direction it arrives from: the head docks there,
 * as the web's orient="auto" marker does (refX 27.2, refY 52). */
export function pathEnd(d: string): { x: number; y: number; angle: number } | null {
  const nums = d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)?.map(Number) ?? [];
  if (nums.length < 4) return null;
  const x = nums[nums.length - 2]!, y = nums[nums.length - 1]!;
  for (let i = nums.length - 4; i >= 0; i -= 2) {
    const dx = x - nums[i]!, dy = y - nums[i + 1]!;
    if (Math.hypot(dx, dy) > 1e-6) return { x, y, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
  }
  return null;
}

// ─── Pan and zoom (the web's components/pan-zoom.ts semantics) ──────────────

export const ZOOM_MAX = 4;
const FIT_PAD = 16;
const FIT_ZOOM_MAX = 1.5;

export interface View { zoom: number; x: number; y: number }
type Size = { w: number; h: number };

/** The fit is the zoom floor: never below a true fit, never above 1.5. */
export function fitZoomFor(box: Size, viewport: Size): number {
  if (!viewport.w || !viewport.h || box.w === 0) return 1;
  return Math.max(0.02, Math.min((viewport.w - FIT_PAD) / box.w, (viewport.h - FIT_PAD) / box.h, FIT_ZOOM_MAX));
}

export function fitView(box: Size, viewport: Size, zoom = fitZoomFor(box, viewport)): View {
  return { zoom, x: (viewport.w - box.w * zoom) / 2, y: (viewport.h - box.h * zoom) / 2 };
}

/** Zoom by `factor` around `focus`, clamped to [fit, ZOOM_MAX]. At the fit the view re-centers. */
export function zoomView(view: View, factor: number, focus: { x: number; y: number }, box: Size, viewport: Size): View {
  const floor = fitZoomFor(box, viewport);
  const zoom = Math.min(Math.max(view.zoom * factor, floor), ZOOM_MAX);
  if (zoom === view.zoom) return view;
  if (zoom <= floor) return fitView(box, viewport, floor);
  const k = zoom / view.zoom;
  return { zoom, x: focus.x - (focus.x - view.x) * k, y: focus.y - (focus.y - view.y) * k };
}

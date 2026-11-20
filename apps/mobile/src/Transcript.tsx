import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, Pressable, Text, useWindowDimensions, View, type HostInstance, type LayoutRectangle } from "react-native";
import { BatchContext, MathWindowContext } from "./math-window";
import type { Batch } from "./session-open";
import { PROTOCOL_ROUTES, type AttachmentReference, type ImageSnapshot, type JobRecord, type LhMessage } from "../../../src/client-protocol/index.ts";
import type { PlanBlockData } from "../../../src/core/contracts/chat.ts";
import { blockLayout, GRAPH_PAD, TEXT_CAP_SCALE } from "../../../src/core/plan-layout.ts";
import { projectView, type LhViewMessage, type LhViewPart } from "../../../src/core/view.ts";
import type { QuestionAnswerData } from "../../../src/core/question-core.ts";
import type { MobileApi } from "./protocol";
import { helperCard, isSubagentSteer, teachSeam } from "./lesson";
import { CompactionCut, CompactionNote, DispatchCard, GraphContextCard, ReasoningRow, SeamDivider, SteerCard, ThinkingRow } from "./LessonParts";
import { Markdown } from "./Markdown";
import { AnswerLine } from "./AnswerLine";
import { SavedChips } from "./Attachments";
import { PlanDiagram } from "./PlanDiagram";
import { Label } from "./ui";
import { space, useTheme } from "./theme";

function Snapshot({ api, chatId, snapshotId, caption }: {
  api: MobileApi; chatId: string; snapshotId: string; caption?: string;
}) {
  const { s } = useTheme();
  const [image, setImage] = useState<ImageSnapshot>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const scope = new AbortController();
    api.get<ImageSnapshot>(PROTOCOL_ROUTES.image(chatId, snapshotId), scope.signal)
      .then((result) => { if (!scope.signal.aborted) setImage(result); })
      .catch(() => { if (!scope.signal.aborted) setFailed(true); });
    return () => scope.abort();
  }, [api, chatId, snapshotId]);
  if (!image) return <Text style={s.muted}>{failed ? "Image unavailable" : "Loading image…"}</Text>;
  return (
    <View style={{ gap: space.xs }}>
      <Image accessibilityLabel={caption || "Session image"} source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
        resizeMode="contain" style={{ width: "100%", aspectRatio: image.width / image.height, maxHeight: 360 }} />
      {caption && <Text style={s.meta}>{caption}</Text>}
    </View>
  );
}

/** The in-chat plan (plan-block.tsx PlanBlock): the snapshot as carried,
 * monochrome, column-wide but never past prose size. Tap opens the live plan. */
function PlanBlock({ data, openPlan }: { data: PlanBlockData; openPlan: () => void }) {
  const { width } = useWindowDimensions();
  const statuses = useMemo(() => new Map(data.nodes.map(({ id, status }) => [id, status] as const)), [data]);
  const cap = useMemo(() => Math.round(planWidth(data) * TEXT_CAP_SCALE), [data]);
  const [natural, setNatural] = useState(0);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Open the full plan" onPress={openPlan} style={{ alignItems: "center" }}
      onLayout={({ nativeEvent }) => setNatural(nativeEvent.layout.width)}>
      <PlanDiagram nodes={data.nodes} edges={data.edges} statusOf={(id) => statuses.get(id) ?? "upcoming"} monochrome pad={GRAPH_PAD}
        width={Math.min(natural || width - 2 * space.lg, cap)} />
    </Pressable>
  );
}

/** The block's viewBox width, for the prose-size cap. */
function planWidth(data: PlanBlockData) {
  return Math.max(blockLayout(data.nodes, data.edges).width, 1) + 2 * GRAPH_PAD;
}

/** The texts a message shows through Markdown when it first appears, matching Part, so
 * their math can be drawn before the message is shown. Folded rows (reasoning, briefs)
 * draw theirs when opened. */
export function markdownTexts(message: LhViewMessage): string[] {
  if (isSubagentSteer(message)) return [];
  return message.parts.flatMap((part): (string | undefined)[] => {
    if (part.type === "text") return [part.text];
    if (part.pluginQuestion?.status === "posed") return [part.pluginQuestion.snapshot.input.question];
    if (part.pluginProblem || (part.type === "tool-problem" && part.state === "input-available")) return [(part.input as { statement?: string } | undefined)?.statement];
    if (part.type === "tool-conclude" && part.state === "output-available") {
      const input = part.input as { outcome?: string; verdict?: string; solutionReveal?: string } | undefined;
      return [input?.verdict, typeof part.reveal === "string" ? part.reveal : input?.solutionReveal];
    }
    if (part.type === "data-practice-thinking") return [(part.data as { text?: string } | undefined)?.text];
    if (part.state === "output-available") {
      const answer = part.output as Partial<QuestionAnswerData> | undefined;
      if (answer?.questionText) return [answer.questionText, answer.explanation, answer.committed];
    }
    return [];
  }).filter((text): text is string => typeof text === "string" && text.length > 0);
}

/** A batch of settled messages (session-open.ts), the view its blocks of math place
 * themselves in (math-window.ts). An older batch is measured far above the content, where
 * maintainVisibleContentPosition never takes it for what is on screen, then placed at a
 * whole-pixel height. */
function BatchView({ batch, eager, width, onBatchLayout, children }: {
  batch: Batch; eager: boolean; width: number; onBatchLayout?: (batch: Batch, layout: LayoutRectangle) => void; children: ReactNode;
}) {
  const window = useContext(MathWindowContext);
  const ref = useRef<HostInstance | null>(null);
  const eagerNow = useRef(eager);
  useLayoutEffect(() => { eagerNow.current = eager; }, [eager]);
  const scope = useMemo(() => ({ id: batch.id, ref, eager: eagerNow }), [batch.id]);
  useEffect(() => () => window?.setBatch(batch.id, undefined), [window, batch.id]);
  const measuring = !batch.placed;
  return (
    <BatchContext.Provider value={scope}>
      <View ref={ref} onLayout={({ nativeEvent }) => onBatchLayout?.(batch, nativeEvent.layout)}
        pointerEvents={measuring ? "none" : "auto"} accessibilityElementsHidden={measuring} importantForAccessibility={measuring ? "no-hide-descendants" : "auto"}
        style={[{ gap: space.lg }, measuring ? { position: "absolute", top: -1e6, left: 0, width, opacity: 0 } : { minHeight: batch.height }]}>
        {children}
      </View>
    </BatchContext.Provider>
  );
}

type PartContext = { api: MobileApi; chatId: string; jobs: readonly JobRecord[]; liveHelpers: boolean; openPlan: () => void };

function Part({ part, context }: { part: LhViewPart; context: PartContext }) {
  const { c, s } = useTheme();
  const { api, chatId } = context;
  if (part.type === "text" && part.text) return <Markdown text={part.text} />;
  if (part.type === "reasoning") return <ReasoningRow text={part.text ?? ""} streaming={false} />;
  if (part.type === "data-plan-block") return <PlanBlock data={part.data as PlanBlockData} openPlan={context.openPlan} />;
  if (part.type === "data-compaction") return <CompactionNote />;
  if (part.type === "data-compaction-cut") return <CompactionCut tokensBefore={(part.data as { details?: { tokensBefore?: number } } | undefined)?.details?.tokensBefore} />;
  if (part.type === "image" && typeof part.data === "string" && /^image\/(png|jpeg|gif|webp)$/.test(String(part.mimeType))) {
    return <Image accessibilityLabel="Image in message" source={{ uri: `data:${part.mimeType};base64,${part.data}` }}
      resizeMode="contain" style={{ width: "100%", height: 240 }} />;
  }
  if (part.pluginQuestion?.status === "posed") {
    return <Markdown text={part.pluginQuestion.snapshot.input.question} />;
  }
  if (part.pluginProblem || (part.type === "tool-problem" && part.state === "input-available")) {
    const problem = part.input as { statement?: string } | undefined;
    if (problem?.statement) return <View style={s.card}><Label>Problem</Label><Markdown text={problem.statement} /></View>;
  }
  if (part.type === "tool-conclude" && part.state === "output-available") {
    const input = part.input as { outcome?: string; verdict?: string; solutionReveal?: string } | undefined;
    if (input?.outcome === "dismissed") return <Text style={s.muted}>Problem dismissed</Text>;
    const solution = typeof part.reveal === "string" ? part.reveal : input?.solutionReveal;
    return (
      <View style={s.card}>
        <Label>Concluded</Label>
        {!!input?.verdict && <Markdown text={input.verdict} />}
        {!!solution && <View style={[s.divider, { marginTop: space.xs, paddingTop: space.md, gap: space.xs }]}><Label>Model solution</Label><Markdown text={solution} /></View>}
      </View>
    );
  }
  if (part.type === "data-practice-thinking") {
    const data = part.data as { text?: string } | undefined;
    return data?.text ? <View style={s.band}><Label>Your thinking</Label><Markdown text={data.text} /></View> : null;
  }
  if (part.type === "data-practice-next") return <Text style={s.muted}>Next problem</Text>;
  if (part.type === "data-graph-context") return <GraphContextCard data={part.data as Parameters<typeof GraphContextCard>[0]["data"]} />;
  if (part.type === "tool-show_image" && part.state === "output-available") {
    const image = part.output as { snapshotId?: string; caption?: string } | undefined;
    if (image?.snapshotId && /^[a-f0-9]{64}$/.test(image.snapshotId)) {
      return <Snapshot api={api} chatId={chatId} snapshotId={image.snapshotId} caption={image.caption} />;
    }
  }
  if (part.state === "output-available") {
    const answer = part.output as Partial<QuestionAnswerData> | undefined;
    if (answer?.questionText && (answer.kind === "quiz" || answer.kind === "ask" || answer.kind === "explain")) {
      const thinking = answer.thinking ?? answer.note;
      return (
        <View style={{ gap: space.sm }}>
          {/* The thinking while reading came first, so it sits above the card (answered-card.tsx). */}
          {!answer.dismissed && !!answer.readingThinking && <ThinkingRow label="Your thinking" text={answer.readingThinking} />}
          <View style={s.card}>
            <Markdown text={answer.questionText} />
            <AnswerLine answer={answer} />
            {typeof answer.correct === "boolean" && !answer.dismissed && !answer.dontKnow &&
              <Text style={[s.label, { color: answer.correct ? c.success : c.error }]}>{answer.correct ? "Correct" : "Incorrect"}</Text>}
            {!!answer.explanation && <Markdown text={answer.explanation} />}
            {!!answer.committed && <Markdown text={answer.committed} />}
            {!answer.dismissed && !!thinking && <ThinkingRow label="Your thinking" text={thinking} inCard />}
          </View>
        </View>
      );
    }
  }
  const helper = helperCard(part, context.jobs, context.liveHelpers);
  return helper ? <DispatchCard kind={helper.kind} job={helper.job} /> : null;
}

export function Transcript({ settled, batches, eager, batchWidth = 0, onBatchLayout, tail, api, chatId, jobs, liveHelpers, openPlan, files, unavailableFiles }: {
  /** The batches shown, oldest first (session-open.ts); messages before the first are still
   * being drawn. Without them every settled message shows. */
  settled: LhViewMessage[]; batches?: readonly Batch[]; eager?: (batch: Batch) => boolean; batchWidth?: number;
  onBatchLayout?: (batch: Batch, layout: LayoutRectangle) => void;
  tail: LhMessage[]; api: MobileApi; chatId: string; jobs: readonly JobRecord[]; liveHelpers: boolean; openPlan: () => void;
  /** Saved user messages' uploaded files, by message ID. */
  files: ReadonlyMap<string, readonly AttachmentReference[]>; unavailableFiles: ReadonlySet<string>;
}) {
  const { s } = useTheme();
  const live = useMemo(() => projectView(tail), [tail]);
  const seam = useMemo(() => teachSeam(settled), [settled]);
  const context = { api, chatId, jobs, liveHelpers, openPlan };

  function message(message: LhViewMessage) {
    if (isSubagentSteer(message)) return <SteerCard key={message.id} message={message} />;
    if (message.parts.some(({ type }) => type === "data-probe-handoff")) return <SeamDivider key={message.id} label="Planning" />;
    const teachAt = seam?.messageId === message.id ? seam.stepIndex : null;
    const parts = message.parts.map((part, index) => index === teachAt && part.type === "step-start"
      ? <SeamDivider key={part.id ?? index} label="Teaching" />
      : <Part key={part.id ?? index} part={part} context={context} />);
    // The learner's words sit in the web's band: card fill, left rail, YOU label.
    if (message.role === "user" && message.parts.some(({ type }) => type === "text")) {
      const attached = files.get(message.id);
      return <View key={message.id} style={s.band}><Label>You</Label>{parts}
        {attached && <View style={{ paddingVertical: space.xs }}><SavedChips files={attached} unavailable={unavailableFiles} /></View>}</View>;
    }
    return (
      <View key={message.id} style={{ gap: space.sm }}>
        {teachAt === -1 && <SeamDivider label="Teaching" />}
        {parts}
      </View>
    );
  }

  // Placed batches in order; one being measured goes last, so it is never the view
  // maintainVisibleContentPosition keeps still.
  const ordered = batches ? [...batches.filter((batch) => batch.placed), ...batches.filter((batch) => !batch.placed)] : [];
  return (
    <>
      {batches ? ordered.map((batch) => {
        const next = batches[batches.indexOf(batch) + 1]?.start;
        if (!batch.placed && !batchWidth) return null;
        return (
          <BatchView key={batch.id} batch={batch} eager={eager?.(batch) ?? true} width={batchWidth} onBatchLayout={onBatchLayout}>
            {settled.slice(batch.start, next).map(message)}
          </BatchView>
        );
      }) : settled.map(message)}
      {live.map((message, messageIndex) => (
        <View key={message.id} style={{ gap: space.sm }}>
          {message.parts.map((part, index) => {
            if (part.type === "reasoning") {
              const last = messageIndex === live.length - 1 && index === message.parts.length - 1;
              return <ReasoningRow key={part.id ?? index} text={part.text ?? ""} streaming={last} />;
            }
            return part.type === "text" && !!part.text ? <Text key={part.id ?? index} selectable style={s.prose}>{part.text}</Text> : null;
          })}
        </View>
      ))}
    </>
  );
}

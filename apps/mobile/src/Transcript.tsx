import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, PixelRatio, Pressable, Text, useWindowDimensions, View, type HostInstance, type LayoutRectangle } from "react-native";
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
import { confirmExternalLink, Markdown } from "./Markdown";
import { NativeMarkdown } from "./NativeMarkdown";
import { blocksOf, equationsIn, equationsInTokens, type Equation } from "./message-math";
import { AnswerLine } from "./AnswerLine";
import { ConfidenceRecord } from "./ConfidenceRail";
import { SavedChips } from "./Attachments";
import { PlanDiagram } from "./PlanDiagram";
import { Label } from "./ui";
import { space, useTheme } from "./theme";

/** A saved image's box when its size isn't known: the whole column, this tall. */
export const SNAPSHOT_HEIGHT = 360;
/** The web shows a saved image at most this share of the screen's height (image-card.tsx,
 * max-h-[60vh]). */
const SNAPSHOT_MAX_SCREEN = 0.6;

/** The box a saved image takes, from the width and height its show_image result carries: its
 * own shape, as the web shows it, never enlarged and never wider than the column or taller than
 * 60% of the screen. Undefined when the size is missing or invalid. */
export function snapshotBox(width: unknown, height: unknown, column: number, screen: number): { width: number; height: number } | undefined {
  if (typeof width !== "number" || typeof height !== "number" || !(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return;
  const scale = Math.min(1, column / width, (screen * SNAPSHOT_MAX_SCREEN) / height);
  return { width: width * scale, height: height * scale };
}

export function Snapshot({ api, chatId, snapshotId, caption, width, height }: {
  api: MobileApi; chatId: string; snapshotId: string; caption?: string; width?: unknown; height?: unknown;
}) {
  const { s } = useTheme();
  const window = useWindowDimensions();
  const [image, setImage] = useState<ImageSnapshot>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const scope = new AbortController();
    api.get<ImageSnapshot>(PROTOCOL_ROUTES.image(chatId, snapshotId), scope.signal)
      .then((result) => { if (!scope.signal.aborted) setImage(result); })
      .catch(() => { if (!scope.signal.aborted) setFailed(true); });
    return () => scope.abort();
  }, [api, chatId, snapshotId]);
  // Loading, shown or failed, the image takes the same box, so nothing around it moves: its
  // own shape when the saved result gives its size, otherwise a fixed column-wide box. The
  // transcript's column is the screen less its padding on each side.
  const box = snapshotBox(width, height, window.width - 2 * space.lg, window.height);
  return (
    <View style={{ gap: space.xs }}>
      <View style={[{ alignItems: "center", justifyContent: "center" }, box ? { ...box, alignSelf: "center" } : { height: SNAPSHOT_HEIGHT }]}>
        {image
          ? <Image accessibilityLabel={caption || "Session image"} source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
            resizeMode="contain" style={{ width: "100%", height: "100%" }} />
          : <Text style={s.muted}>{failed ? "Image unavailable" : "Loading image…"}</Text>}
      </View>
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

/** The texts a part shows through Markdown when it first appears, matching Part. Folded
 * rows (reasoning, briefs) draw theirs when opened. */
function partTexts(part: LhViewPart): (string | undefined)[] {
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
}

const present = (text: string | undefined): text is string => typeof text === "string" && text.length > 0;

/** The texts a message shows through Markdown when it first appears, so their math can be
 * drawn before the message is shown. */
export function markdownTexts(message: LhViewMessage): string[] {
  if (isSubagentSteer(message)) return [];
  return message.parts.flatMap(partTexts).filter(present);
}

/** One thing a message shows: a part, or one top-level block of a text part. */
interface Item { part: number; block?: number }
/** Items `from` up to `to`, the equations they show, and where a batch may start. */
export interface Segment { from: number; to: number; equations: Equation[] }
/** A place in the transcript: a message, and the first of its items there. */
export interface Position { message: number; item: number }

const segmentsCache = new WeakMap<LhViewMessage, { items: Item[]; segments: Segment[] }>();

/** A message's items and segments. Between batches an assistant's message may be split only
 * between two top-level blocks of one text part, so a long reply comes in a few paragraphs at
 * a time; a learner's band, a steer card and a seam stay whole. */
export function messageSegments(message: LhViewMessage): { items: Item[]; segments: Segment[] } {
  const cached = segmentsCache.get(message);
  if (cached) return cached;
  const items: Item[] = [];
  const equations: Equation[][] = [];
  const steer = isSubagentSteer(message);
  message.parts.forEach((part, index) => {
    const blocks = part.type === "text" && part.text ? blocksOf(part.text) : [];
    if (blocks.length) {
      blocks.forEach((tokens, block) => {
        items.push({ part: index, block });
        equations.push(steer ? [] : equationsInTokens(tokens));
      });
    } else {
      items.push({ part: index });
      equations.push(steer ? [] : partTexts(part).filter(present).flatMap(equationsIn));
    }
  });
  const whole = steer || message.parts.some(({ type }) => type === "data-probe-handoff")
    || (message.role === "user" && message.parts.some(({ type }) => type === "text"));
  const segments: Segment[] = [];
  items.forEach((item, index) => {
    const last = segments.at(-1);
    if (!last || (!whole && (item.block ?? 0) > 0)) segments.push({ from: index, to: index + 1, equations: [...(equations[index] ?? [])] });
    else {
      last.to = index + 1;
      last.equations.push(...(equations[index] ?? []));
    }
  });
  if (!segments.length) segments.push({ from: 0, to: 0, equations: [] });
  const result = { items, segments };
  segmentsCache.set(message, result);
  return result;
}

/** A text part's top-level blocks `from` up to `to`, each drawn on its own so blocks added
 * above leave those already shown untouched. Laid out as one Markdown would be. */
function MarkdownBlocks({ text, from = 0, to }: { text: string; from?: number; to?: number }) {
  // The parse is cached by text, but the cache can drop it: keep this text's blocks, so the
  // memoized blocks below keep the same tokens across renders.
  const blocks = useMemo(() => blocksOf(text), [text]);
  const shown = blocks.slice(from, to);
  if (!shown.length) return null;
  return (
    <View style={{ gap: space.md }}>
      {shown.map((tokens, index) => <NativeMarkdown key={from + index} tokens={tokens} openLink={confirmExternalLink} />)}
    </View>
  );
}

/** The rest of a message split between batches sits this much closer to its start than the
 * batches' own gap, so the two halves are spaced as one message's blocks are. Rounded to whole
 * pixels: on half a pixel (4 points is 10.5 on a 2.625 screen), layout rounding can flip by a
 * pixel when content is placed above, and everything below it would move. */
const continued = () => PixelRatio.roundToNearestPixel(space.md - space.lg);

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
  const measuring = !batch.placed;
  useLayoutEffect(() => { window?.setMeasuring(batch.id, measuring); }, [window, batch.id, measuring]);
  useEffect(() => () => {
    window?.setMeasuring(batch.id, false);
    window?.setBatch(batch.id, undefined);
  }, [window, batch.id]);
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

function Part({ part, context, blocks }: { part: LhViewPart; context: PartContext; blocks?: [number, number] }) {
  const { c, s } = useTheme();
  const { api, chatId } = context;
  if (part.type === "text" && part.text) return <MarkdownBlocks text={part.text} from={blocks?.[0]} to={blocks?.[1]} />;
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
    const image = part.output as { snapshotId?: string; caption?: string; width?: unknown; height?: unknown } | undefined;
    if (image?.snapshotId && /^[a-f0-9]{64}$/.test(image.snapshotId)) {
      return <Snapshot api={api} chatId={chatId} snapshotId={image.snapshotId} caption={image.caption} width={image.width} height={image.height} />;
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
            {answer.kind === "quiz" && typeof answer.confidence === "number" && <ConfidenceRecord value={answer.confidence} />}
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

  /** A message, or its items `from` up to `to` when it is split between batches. */
  function message(message: LhViewMessage, from = 0, to = Infinity) {
    if (isSubagentSteer(message)) return <SteerCard key={message.id} message={message} />;
    if (message.parts.some(({ type }) => type === "data-probe-handoff")) return <SeamDivider key={message.id} label="Planning" />;
    const teachAt = seam?.messageId === message.id ? seam.stepIndex : null;
    const { items } = messageSegments(message);
    // Each part shown, with the range of its blocks shown when it is a split text.
    const shown = new Map<number, [number, number]>();
    items.slice(from, to).forEach(({ part, block }) => {
      const range = shown.get(part);
      shown.set(part, block === undefined ? [0, Infinity] : [range?.[0] ?? block, block + 1]);
    });
    const parts = message.parts.flatMap((part, index) => {
      const blocks = shown.get(index);
      if (!blocks) return [];
      return [index === teachAt && part.type === "step-start"
        ? <SeamDivider key={part.id ?? index} label="Teaching" />
        : <Part key={part.id ?? index} part={part} context={context} blocks={blocks} />];
    });
    // The learner's words sit in the web's band: card fill, left rail, YOU label.
    if (message.role === "user" && message.parts.some(({ type }) => type === "text")) {
      const attached = files.get(message.id);
      return <View key={message.id} style={s.band}><Label>You</Label>{parts}
        {attached && <View style={{ paddingVertical: space.xs }}><SavedChips files={attached} unavailable={unavailableFiles} /></View>}</View>;
    }
    return (
      <View key={message.id} style={[{ gap: space.sm }, from > 0 && { marginTop: continued() }]}>
        {from === 0 && teachAt === -1 && <SeamDivider label="Teaching" />}
        {parts}
      </View>
    );
  }

  /** The messages from `start` up to `end`, the first and last perhaps in part. */
  function between(start: Position, end: Position) {
    const shown: ReactNode[] = [];
    for (let index = start.message; index < settled.length && (index < end.message || (index === end.message && end.item > 0)); index++) {
      shown.push(message(settled[index] as LhViewMessage, index === start.message ? start.item : 0, index === end.message ? end.item : Infinity));
    }
    return shown;
  }

  // Placed batches in order; one being measured goes last, so it is never the view
  // maintainVisibleContentPosition keeps still.
  const ordered = batches ? [...batches.filter((batch) => batch.placed), ...batches.filter((batch) => !batch.placed)] : [];
  const end: Position = { message: settled.length, item: 0 };
  return (
    <>
      {batches ? ordered.map((batch) => {
        const next = batches[batches.indexOf(batch) + 1]?.start ?? end;
        if (!batch.placed && !batchWidth) return null;
        return (
          <BatchView key={batch.id} batch={batch} eager={eager?.(batch) ?? true} width={batchWidth} onBatchLayout={onBatchLayout}>
            {between(batch.start, next)}
          </BatchView>
        );
      }) : settled.map((each) => message(each))}
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

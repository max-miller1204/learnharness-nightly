import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, Text, useWindowDimensions, View } from "react-native";
import { PROTOCOL_ROUTES, type ImageSnapshot, type JobRecord, type LhMessage } from "../../../src/client-protocol/index.ts";
import type { PlanBlockData } from "../../../src/core/contracts/chat.ts";
import { blockLayout, GRAPH_PAD, TEXT_CAP_SCALE } from "../../../src/core/plan-layout.ts";
import { projectView, type LhViewMessage, type LhViewPart } from "../../../src/core/view.ts";
import type { QuestionAnswerData } from "../../../src/core/question-core.ts";
import type { MobileApi } from "./protocol";
import { helperCard, isSubagentSteer, teachSeam } from "./lesson";
import { CompactionCut, CompactionNote, DispatchCard, GraphContextCard, ReasoningRow, SeamDivider, SteerCard, ThinkingRow } from "./LessonParts";
import { Markdown } from "./Markdown";
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
      const response = answer.dismissed ? "Skipped" : answer.dontKnow ? "I don’t know" :
        [answer.text, ...answer.answers?.map(({ label }) => label) ?? [], answer.other].filter(Boolean).join(", ");
      const thinking = answer.thinking ?? answer.note;
      return (
        <View style={{ gap: space.sm }}>
          {/* The thinking while reading came first, so it sits above the card (answered-card.tsx). */}
          {!answer.dismissed && !!answer.readingThinking && <ThinkingRow label="Your thinking" text={answer.readingThinking} />}
          <View style={s.card}>
            <Markdown text={answer.questionText} />
            {!!response && <Text selectable style={s.prose}>{response}</Text>}
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

export function Transcript({ settled, tail, api, chatId, jobs, liveHelpers, openPlan }: {
  settled: LhViewMessage[]; tail: LhMessage[]; api: MobileApi; chatId: string;
  jobs: readonly JobRecord[]; liveHelpers: boolean; openPlan: () => void;
}) {
  const { s } = useTheme();
  const live = useMemo(() => projectView(tail), [tail]);
  const seam = useMemo(() => teachSeam(settled), [settled]);
  const context = { api, chatId, jobs, liveHelpers, openPlan };
  return (
    <>
      {settled.map((message) => {
        if (isSubagentSteer(message)) return <SteerCard key={message.id} message={message} />;
        if (message.parts.some(({ type }) => type === "data-probe-handoff")) return <SeamDivider key={message.id} label="Planning" />;
        const teachAt = seam?.messageId === message.id ? seam.stepIndex : null;
        const parts = message.parts.map((part, index) => index === teachAt && part.type === "step-start"
          ? <SeamDivider key={part.id ?? index} label="Teaching" />
          : <Part key={part.id ?? index} part={part} context={context} />);
        // The learner's words sit in the web's band: card fill, left rail, YOU label.
        if (message.role === "user" && message.parts.some(({ type }) => type === "text")) {
          return <View key={message.id} style={s.band}><Label>You</Label>{parts}</View>;
        }
        return (
          <View key={message.id} style={{ gap: space.sm }}>
            {teachAt === -1 && <SeamDivider label="Teaching" />}
            {parts}
          </View>
        );
      })}
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

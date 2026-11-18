import { useEffect, useMemo, useState } from "react";
import { Image, Text, View } from "react-native";
import { PROTOCOL_ROUTES, type ImageSnapshot, type LhMessage } from "../../../src/client-protocol/index.ts";
import { projectView, type LhViewPart } from "../../../src/core/view.ts";
import type { QuestionAnswerData } from "../../../src/core/question-core.ts";
import type { MobileApi } from "./protocol";
import { Markdown } from "./Markdown";
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

function Part({ part, api, chatId }: { part: LhViewPart; api: MobileApi; chatId: string }) {
  const { c, s } = useTheme();
  if (part.type === "text" && part.text) return <Markdown text={part.text} />;
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
  if (part.type === "data-graph-context") {
    const data = part.data as { propositions?: { name: string }[] } | undefined;
    return <Text style={s.muted}>Graph material · {data?.propositions?.map(({ name }) => name).join(", ")}</Text>;
  }
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
      return (
        <View style={s.card}>
          <Markdown text={answer.questionText} />
          {!!response && <Text selectable style={s.prose}>{response}</Text>}
          {typeof answer.correct === "boolean" && !answer.dismissed && !answer.dontKnow &&
            <Text style={[s.label, { color: answer.correct ? c.success : c.error }]}>{answer.correct ? "Correct" : "Incorrect"}</Text>}
          {!!answer.explanation && <Markdown text={answer.explanation} />}
          {!!answer.committed && <Markdown text={answer.committed} />}
        </View>
      );
    }
  }
  return null;
}

export function Transcript({ messages, tail, api, chatId }: {
  messages: LhMessage[]; tail: LhMessage[]; api: MobileApi; chatId: string;
}) {
  const { s } = useTheme();
  const settled = useMemo(() => projectView(messages), [messages]);
  const live = useMemo(() => projectView(tail), [tail]);
  return (
    <>
      {settled.map((message) => {
        const parts = message.parts.map((part, index) => <Part key={part.id ?? index} part={part} api={api} chatId={chatId} />);
        // The learner's words sit in the web's band: card fill, left rail, YOU label.
        return message.role === "user" && message.parts.some(({ type }) => type === "text")
          ? <View key={message.id} style={s.band}><Label>You</Label>{parts}</View>
          : <View key={message.id} style={{ gap: space.sm }}>{parts}</View>;
      })}
      {live.map((message) => (
        <View key={message.id} style={{ gap: space.sm }}>
          {message.parts.map((part, index) => part.type === "text" && !!part.text
            ? <Text key={part.id ?? index} selectable style={s.prose}>{part.text}</Text> : null)}
        </View>
      ))}
    </>
  );
}

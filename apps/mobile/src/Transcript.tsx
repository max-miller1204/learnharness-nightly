import { useEffect, useMemo, useState } from "react";
import { Image, Text, View } from "react-native";
import { PROTOCOL_ROUTES, type ImageSnapshot, type LhMessage } from "../../../src/client-protocol/index.ts";
import { projectView, type LhViewPart } from "../../../src/core/view.ts";
import type { QuestionAnswerData } from "../../../src/core/question-core.ts";
import type { MobileApi } from "./protocol";
import { Markdown } from "./Markdown";
import { styles } from "./ui";

function Snapshot({ api, chatId, snapshotId, caption }: {
  api: MobileApi; chatId: string; snapshotId: string; caption?: string;
}) {
  const [image, setImage] = useState<ImageSnapshot>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const scope = new AbortController();
    api.get<ImageSnapshot>(PROTOCOL_ROUTES.image(chatId, snapshotId), scope.signal)
      .then((result) => { if (!scope.signal.aborted) setImage(result); })
      .catch(() => { if (!scope.signal.aborted) setFailed(true); });
    return () => scope.abort();
  }, [api, chatId, snapshotId]);
  if (!image) return <Text style={styles.muted}>{failed ? "Image unavailable" : "Loading image…"}</Text>;
  return (
    <View style={{ gap: 5 }}>
      <Image accessibilityLabel={caption || "Session image"} source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
        resizeMode="contain" style={{ width: "100%", aspectRatio: image.width / image.height, maxHeight: 360 }} />
      {caption && <Text style={styles.muted}>{caption}</Text>}
    </View>
  );
}

function Part({ part, api, chatId }: { part: LhViewPart; api: MobileApi; chatId: string }) {
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
    if (problem?.statement) return <View style={styles.card}><Text style={styles.subtitle}>Problem</Text><Markdown text={problem.statement} /></View>;
  }
  if (part.type === "tool-conclude" && part.state === "output-available") {
    const input = part.input as { outcome?: string; verdict?: string; solutionReveal?: string } | undefined;
    if (input?.outcome === "dismissed") return <Text style={styles.muted}>Problem dismissed</Text>;
    const solution = typeof part.reveal === "string" ? part.reveal : input?.solutionReveal;
    return (
      <View style={styles.card}>
        <Text style={styles.subtitle}>Concluded</Text>
        {!!input?.verdict && <Markdown text={input.verdict} />}
        {!!solution && <><Text style={styles.muted}>Model solution</Text><Markdown text={solution} /></>}
      </View>
    );
  }
  if (part.type === "data-practice-thinking") {
    const data = part.data as { text?: string } | undefined;
    return data?.text ? <View style={{ gap: 4 }}><Text style={styles.muted}>Your thinking</Text><Markdown text={data.text} /></View> : null;
  }
  if (part.type === "data-practice-next") return <Text style={styles.muted}>Next problem</Text>;
  if (part.type === "data-graph-context") {
    const data = part.data as { propositions?: { name: string }[] } | undefined;
    return <Text style={styles.muted}>Graph material · {data?.propositions?.map(({ name }) => name).join(", ")}</Text>;
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
        <View style={styles.card}>
          <Markdown text={answer.questionText} />
          {!!response && <Text style={styles.text}>{response}</Text>}
          {typeof answer.correct === "boolean" && !answer.dismissed && !answer.dontKnow &&
            <Text style={styles.muted}>{answer.correct ? "Correct" : "Incorrect"}</Text>}
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
  const settled = useMemo(() => projectView(messages), [messages]);
  const live = useMemo(() => projectView(tail), [tail]);
  return (
    <>
      {settled.map((message) => (
        <View key={message.id} style={{ gap: 6 }}>
          {message.role === "user" && message.parts.some(({ type }) => type === "text") &&
            <Text style={styles.muted}>You</Text>}
          {message.parts.map((part, index) => <Part key={part.id ?? index} part={part} api={api} chatId={chatId} />)}
        </View>
      ))}
      {live.map((message) => (
        <View key={message.id} style={{ gap: 6 }}>
          {message.parts.map((part, index) => part.type === "text" && !!part.text
            ? <Text key={part.id ?? index} selectable style={styles.text}>{part.text}</Text> : null)}
        </View>
      ))}
    </>
  );
}

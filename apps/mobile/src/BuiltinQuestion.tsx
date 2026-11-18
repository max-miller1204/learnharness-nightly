import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { PendingQuestion } from "../../../src/core/pending.ts";
import { toolQuestionKind } from "../../../src/core/pending.ts";
import {
  buildAnswer, CONFIDENCE_STOPS, DEFAULT_CONFIDENCE_INDEX,
  emptyDockSelection, normalizeOptions, normalizeQuizType, resolveCorrect,
  seededRandom, shuffleOptions, toggleOption, toggleOther, type QuestionData,
} from "../../../src/core/question-core.ts";
import { parseQuestionInput } from "../../../src/core/tool-parts.ts";
import type { ChatInput } from "../../../src/client-protocol/index.ts";
import { Markdown } from "./Markdown";
import { Button, Field, styles } from "./ui";

export function questionData(pending: PendingQuestion): QuestionData | undefined {
  const raw = parseQuestionInput(pending.tool, pending.input);
  if (!raw) return;
  const kind = toolQuestionKind(pending.tool);
  const options = normalizeOptions("options" in raw ? raw.options ?? [] : []);
  const ordered = kind === "quiz" ? shuffleOptions(options, seededRandom(pending.toolCallId)) : options;
  const data: QuestionData = {
    id: pending.toolCallId,
    kind,
    questionType: kind === "quiz" && "type" in raw ? normalizeQuizType(raw.type) : undefined,
    question: raw.question,
    context: raw.details,
    mode: ordered.length === 0 ? "text" : "multiSelect" in raw && raw.multiSelect ? "multi-select" : "single-select",
    options: ordered,
    createdAt: new Date().toISOString(),
  };
  if (kind === "quiz" && "correctAnswer" in raw) {
    data.correctIndices = resolveCorrect(raw.correctAnswer, ordered).indices;
    if ("explanation" in raw) data.explanation = raw.explanation;
  }
  if (kind === "explain" && "correctAnswer" in raw && typeof raw.correctAnswer === "string") data.committedAnswer = raw.correctAnswer;
  return data;
}

export function BuiltinQuestion({ question, disabled, submit }: {
  question: PendingQuestion; disabled: boolean; submit: (input: ChatInput) => void;
}) {
  const data = useMemo(() => questionData(question), [question]);
  const [selection, setSelection] = useState(emptyDockSelection);
  const [answer, setAnswer] = useState("");
  const [other, setOther] = useState("");
  const [thinking, setThinking] = useState("");
  const [confidence, setConfidence] = useState(CONFIDENCE_STOPS[DEFAULT_CONFIDENCE_INDEX]);

  if (!data) return null;
  const { mode } = data;
  const ready = mode === "text" ? !!answer.trim()
    : (selection.selected.size > 0 || (selection.otherSelected && !!other.trim())) && (!selection.otherSelected || !!other.trim());

  function send(dontKnow = false) {
    if (!data) return;
    const values = [...selection.selected].flatMap((index) => data.options[index]?.value ?? []);
    submit({
      type: "answer",
      toolCallId: question.toolCallId,
      answer: buildAnswer(data, {
        dontKnow,
        values: dontKnow ? [] : values,
        text: !dontKnow && mode === "text" ? answer : undefined,
        other: !dontKnow && selection.otherSelected ? other : undefined,
        confidence,
        thinking,
      }, question.tool),
    });
  }

  return (
    <View style={styles.card}>
      <Text style={styles.subtitle}>{data.kind === "quiz" ? "Quiz" : "Question"}</Text>
      <Markdown text={data.question} />
      {!!data.context && <Markdown text={data.context} />}
      {mode === "text" ? (
        <Field label="Your answer" value={answer} onChangeText={setAnswer} editable={!disabled} multiline />
      ) : (
        <>
          {data.options.map((option, index) => (
            <Button key={index} selected={selection.selected.has(index)} disabled={disabled}
              onPress={() => setSelection((value) => toggleOption(mode, value, index))}>{option.label}</Button>
          ))}
          {data.kind === "ask" && (
            <>
              <Button selected={selection.otherSelected} disabled={disabled}
                onPress={() => setSelection((value) => toggleOther(mode, value))}>Other</Button>
              {selection.otherSelected && <Field label="Other answer" value={other} onChangeText={setOther} editable={!disabled} />}
            </>
          )}
        </>
      )}
      {data.kind === "quiz" && (
        <>
          <Text style={styles.muted}>Confidence</Text>
          <View style={styles.row}>
            {CONFIDENCE_STOPS.map((stop) =>
              <Button key={stop} disabled={disabled} selected={confidence === stop} onPress={() => setConfidence(stop)}>{`${stop}%`}</Button>
            )}
          </View>
        </>
      )}
      <Field label="Your thinking (optional)" value={thinking} onChangeText={setThinking} editable={!disabled} multiline />
      <View style={styles.row}>
        <Button disabled={disabled || !ready} primary onPress={() => send()}>Submit answer</Button>
        {data.kind !== "ask" && <Button disabled={disabled} onPress={() => send(true)}>I don’t know</Button>}
      </View>
    </View>
  );
}
